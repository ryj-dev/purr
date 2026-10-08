import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { BlockRun, Finding, Flow, OutputConfig, Run, ServerEvent, TriggerKind } from '../shared/types.ts';
import type { ClaudeRunner } from './claude.ts';
import type { DB } from './db.ts';
import { DEFAULT_TRIGGERS } from './flows/defaults.ts';
import { HttpError } from './flows/store.ts';
import { validateFlow } from './flows/validate.ts';
import { executeFlow } from './engine/executor.ts';
import { countBySeverity } from './engine/findings.ts';
import { Material } from './engine/material.ts';
import {
  type ChangeSpec, branchNamed, changedFiles, currentBranch, defaultBaseRef, ensureWorktree, git, headSha, isAncestor, mergeBase,
  pruneWorktrees, resolveBase, resolveRef,
} from './git.ts';
import { type PrInfo, commentOnPr, ghAuthed, prForBranch } from './gh.ts';
import { active, applyLedger, fingerprintAll } from './ledger.ts';
import { notify } from './notify.ts';
import { APP_MANAGED } from './runtime.ts';
import { newId, now, paths } from './util.ts';

export interface RunRequest {
  trigger: TriggerKind;
  repoPath: string;
  flowId?: string | null;     // explicit flow; otherwise the trigger's assignment
  mode: 'staged' | 'range';
  base?: string | null;
  head?: string | null;
  branch?: string | null;
  pr?: PrInfo | null;
}

const TERMINAL = new Set(['passed', 'blocked', 'failed', 'cancelled', 'superseded']);
const SESSION_BLOCKS = new Set(['context', 'prompt', 'verify', 'command']);

export class RunManager {
  db: DB;
  claude: ClaudeRunner;
  bus = new EventEmitter();
  private controllers = new Map<string, AbortController>();
  private pending = new Map<string, { req: RunRequest; run: Run }>();   // queued while paused
  private debounces = new Map<string, NodeJS.Timeout>();
  private pauseTimer: NodeJS.Timeout | null = null;

  constructor(db: DB, claude: ClaudeRunner) {
    this.db = db;
    this.claude = claude;
    this.bus.setMaxListeners(100);
  }

  emit(e: ServerEvent) { this.bus.emit('event', e); }

  /** The flow a trigger runs for a repo: repo override, else global, else the shipped default. null = disabled. */
  resolveFlow(trigger: TriggerKind, repoId: string | null, flowId?: string | null): Flow | null {
    if (flowId) {
      const f = this.db.getFlow(flowId);
      if (!f) throw new HttpError(404, `Flow ${flowId} not found`);
      return f;
    }
    const assigned = this.db.resolveTrigger(trigger, repoId);
    if (assigned === null) return null;
    return this.db.getFlow(assigned ?? DEFAULT_TRIGGERS[trigger]) ?? this.db.getFlow(DEFAULT_TRIGGERS[trigger]);
  }

  /** Creates the run record. Returns null when the trigger is disabled for this repo. */
  createRun(req: RunRequest): Run | null {
    if (existsSync(req.repoPath)) req.repoPath = realpathSync(req.repoPath); // git reports /private/var, not /var
    const repo = this.db.getRepoByPath(req.repoPath);
    const flow = this.resolveFlow(req.trigger, repo?.id ?? null, req.flowId);
    if (!flow) return null;
    const errors = validateFlow(flow.blocks, flow.edges).filter((i) => i.level === 'error');
    const run: Run = {
      id: newId('run-'), flowId: flow.id, flowName: flow.name, flow: structuredClone(flow), trigger: req.trigger,
      repoId: repo?.id ?? null, repoPath: req.repoPath, branch: req.branch ?? null, baseSha: req.base ?? null, headSha: req.head ?? null,
      mode: req.mode, pr: req.pr ? { number: req.pr.number, title: req.pr.title, body: req.pr.body, url: req.pr.url, account: req.pr.account } : null,
      workdir: null, status: 'queued', queuedAt: now(), startedAt: null, finishedAt: null, counts: { must_fix: 0, consider: 0, minor: 0 },
      error: errors.length ? `Flow "${flow.name}" is invalid: ${errors.map((e) => e.message).join('; ')}` : null,
    };
    this.save(run);
    return run;
  }

  private save(run: Run) {
    this.db.putRun(run);
    this.emit({ type: 'run', run: { ...run, flow: { ...run.flow, blocks: [], edges: [] } } });
  }

  private onBlock = (b: BlockRun) => {
    this.db.putBlockRun(b);
    this.emit({ type: 'block', runId: b.runId, block: b });
  };

  /** Starts a run in the background (daemon). Waits in the queue while PuRR is paused for a usage limit. */
  start(req: RunRequest, run: Run): void {
    const paused = this.db.getUsage().pausedUntil;
    const needsClaude = run.flow.blocks.some((b) => ['context', 'prompt', 'verify'].includes(b.type));
    if (needsClaude && paused && new Date(paused) > new Date()) {
      this.pending.set(run.id, { req, run });
      this.schedulePauseCheck();
      return;
    }
    void this.execute(req, run);
  }

  private schedulePauseCheck() {
    if (this.pauseTimer) return;
    this.pauseTimer = setInterval(() => {
      const paused = this.db.getUsage().pausedUntil;
      if (paused && new Date(paused) > new Date()) return;
      if (this.pauseTimer) clearInterval(this.pauseTimer);
      this.pauseTimer = null;
      const items = [...this.pending.values()];
      this.pending.clear();
      for (const { req, run } of items) void this.execute(req, run);
    }, 30_000);
    this.pauseTimer.unref();
  }

  cancel(runId: string, reason: 'cancelled' | 'superseded' = 'cancelled'): Run | null {
    const run = this.db.getRun(runId);
    if (!run) return null;
    if (this.pending.has(runId)) {
      this.pending.delete(runId);
      run.status = reason; run.finishedAt = now();
      this.save(run);
      return run;
    }
    const c = this.controllers.get(runId);
    if (c) { (c as any).reason = reason; c.abort(); }
    return run;
  }

  /** Cancels queued/running background runs for the same repo + branch (a newer push supersedes them). */
  supersede(repoPath: string, branch: string | null, except?: string) {
    for (const r of this.db.listRuns(200)) {
      if (r.id === except || r.repoPath !== repoPath || r.branch !== branch || TERMINAL.has(r.status)) continue;
      if (r.trigger !== 'post-push' && r.trigger !== 'manual') continue;
      this.cancel(r.id, 'superseded');
    }
  }

  /** Debounced post-push: a burst of pushes to one branch produces one review of the latest. */
  schedulePostPush(req: RunRequest) {
    if (this.db.getSettings().reviewsPaused) return; // paused from the tray or Settings
    const key = `${req.repoPath}\u0000${req.branch}`;
    const prev = this.debounces.get(key);
    if (prev) clearTimeout(prev);
    const delay = this.db.getSettings().debounceSec * 1000;
    const t = setTimeout(() => {
      this.debounces.delete(key);
      const run = this.createRun(req);
      if (!run) return;
      this.supersede(req.repoPath, req.branch ?? null, run.id);
      this.start(req, run);
    }, delay);
    t.unref();
    this.debounces.set(key, t);
  }

  /** Prepares the change, runs the flow, applies the ledger and side effects. Resolves with the final run. */
  async execute(req: RunRequest, run: Run): Promise<Run> {
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    run.status = 'running';
    run.startedAt = now();
    this.save(run);
    try {
      if (run.error?.startsWith('Flow "')) throw new Error(run.error);
      const { change, cwd } = await this.prepare(req, run);
      this.save(run);
      const files = await changedFiles(change);
      if (!files.length) {
        run.status = 'passed';
        run.error = 'No changes to review';
        return run;
      }
      const material = new Material(change, files, run);
      const isSuppressed = async (f: Finding) => {
        if (!run.repoId || !f.fingerprint) return false;
        const st = this.db.getLedger(f.fingerprint, run.repoId)?.state;
        return st === 'dismissed' || st === 'tracked';
      };
      const result = await executeFlow(
        { run, flow: run.flow, change, files, cwd },
        { claude: this.claude, signal: controller.signal, onBlock: this.onBlock, isSuppressed, fingerprint: (fs) => fingerprintAll(fs, material) },
      );
      await fingerprintAll(result.findings, material);
      const complete = result.failedBlocks.length === 0 && !controller.signal.aborted
        ? new Set(run.flow.blocks.filter((b) => result.blocks.get(b.id)?.status === 'done').map((b) => b.id)) : null;
      applyLedger(this.db, run, result.findings, complete);
      this.db.setRunFindings(run.id, result.findings);
      run.counts = countBySeverity(active(result.findings));
      if (controller.signal.aborted) {
        run.status = ((controller as any).reason as Run['status']) ?? 'cancelled';
      } else if (result.gateFailed) {
        run.status = 'blocked';
      } else if (result.failedBlocks.length) {
        run.status = 'failed';
        const quota = result.failedBlocks.find((x) => x.startsWith('quota:'));
        const names = result.failedBlocks.filter((x) => !x.startsWith('quota:')).map((id) => run.flow.blocks.find((b) => b.id === id)?.label ?? id);
        run.error = quota ? quota.slice(6) : `${names.length} block(s) failed: ${names.join(', ')}`;
      } else {
        run.status = 'passed';
      }
      if (!controller.signal.aborted) await this.sideEffects(run, result.findings);
      return run;
    } catch (e: any) {
      run.status = controller.signal.aborted ? (((controller as any).reason as Run['status']) ?? 'cancelled') : 'failed';
      run.error = controller.signal.aborted ? null : String(e?.message ?? e);
      return run;
    } finally {
      run.finishedAt = now();
      this.controllers.delete(run.id);
      this.save(run);
    }
  }

  /** Works out base/head and the directory blocks run in. Background reviews get their own detached worktree at head. */
  private async prepare(req: RunRequest, run: Run): Promise<{ change: ChangeSpec; cwd: string }> {
    const repo = req.repoPath;
    if (req.mode === 'staged') {
      run.branch = run.branch ?? (await currentBranch(repo));
      run.headSha = await headSha(repo);
      return { change: { mode: 'staged', cwd: repo, base: null, head: null }, cwd: repo };
    }
    let head = req.head ? await resolveRef(repo, req.head) : await headSha(repo);
    if (!head && req.head) {
      await git(repo, ['fetch', '--quiet', '--all'], { allowFail: true });
      head = await resolveRef(repo, req.head);
    }
    if (!head) throw new Error(`Can't resolve head ${req.head ?? 'HEAD'}`);
    if (!run.branch) {
      // the branch being reviewed, not whatever is checked out: an explicit head that names a branch, else HEAD's
      const named = req.head ? await branchNamed(repo, req.head) : null;
      run.branch = named ?? (!req.head || head === await headSha(repo) ? await currentBranch(repo) : null);
    }
    if (!run.pr && run.branch && (run.trigger === 'post-push' || run.trigger === 'manual') && await ghAuthed()) {
      const pr = await prForBranch(repo, run.branch);
      if (pr && pr.headRefOid === head) {
        run.pr = { number: pr.number, title: pr.title, body: pr.body, url: pr.url };
        if (!req.base) req.base = pr.baseRefName;
      }
    }
    let base: string | null = null;
    const b = req.base ? await resolveBase(repo, req.base) : null;
    if (req.base && !b && run.trigger !== 'pre-push') throw new Error(`Can't resolve base ${req.base}`);
    if (b && run.trigger === 'pre-push' && await isAncestor(repo, b, head)) {
      base = b; // a fast-forward push: exactly the commits being sent
    } else if (b && run.trigger !== 'pre-push') {
      base = (await mergeBase(repo, b, head)) ?? b;
    } else {
      // new branch, or a force-push after a rebase (old tip not an ancestor): only this branch's own commits,
      // never the other people's commits the rebase pulled in
      const ref = await defaultBaseRef(repo);
      base = ref ? await mergeBase(repo, ref, head) : null;
    }
    if (!base || base === head) base = await resolveRef(repo, `${head}~1`); // nothing ahead of base: review the last commit
    run.baseSha = base;
    run.headSha = head;
    const needsCheckout = run.flow.blocks.some((b) => SESSION_BLOCKS.has(b.type));
    let cwd = repo;
    if (needsCheckout && (run.trigger === 'post-push' || run.trigger === 'manual')) {
      // one worktree per run: concurrent runs (daemon + CLI, manual + post-push) never share a checkout
      const repoKey = run.repoId ?? createHash('sha1').update(repo).digest('hex').slice(0, 12);
      cwd = await ensureWorktree(repo, join(paths.worktrees, repoKey, run.id), head);
      run.workdir = cwd;
      void pruneWorktrees(repo, join(paths.worktrees, repoKey), run.id);
    }
    return { change: { mode: 'range', cwd, base, head }, cwd };
  }

  private async sideEffects(run: Run, findings: Finding[]) {
    const outputs = run.flow.blocks.filter((b) => b.type === 'output').map((b) => b.config as OutputConfig);
    const counted = active(findings);
    const where = `${run.repoPath.split('/').pop()}${run.branch ? `/${run.branch}` : ''}`;
    if (outputs.some((o) => o.notify) && this.db.getSettings().notifications) {
      const c = countBySeverity(counted);
      const msg = run.status === 'failed' ? `Review failed: ${run.error ?? ''}`
        : counted.length ? `${c.must_fix} must-fix · ${c.consider} consider · ${c.minor} minor` : 'Nothing to fix';
      if (APP_MANAGED) this.emit({ type: 'notify', title: `purr · ${where}`, body: msg, runId: run.id });
      else await notify(`purr · ${where}`, msg);
    }
    if (outputs.some((o) => o.postPrComment) && run.pr && counted.length) {
      await commentOnPr(run.repoPath, run.pr.number, renderComment(run, counted), run.pr.account);
    }
  }
}

export function renderComment(run: Run, findings: Finding[]): string {
  const c = countBySeverity(findings);
  const head = c.must_fix ? `**Fix before merging:** ${c.must_fix} must-fix finding(s).` : 'Nothing blocking.';
  const lines = [`### PuRR review · ${run.flowName}`, '', head, ''];
  for (const sev of ['must_fix', 'consider', 'minor'] as const) {
    const fs = findings.filter((f) => f.severity === sev);
    if (!fs.length) continue;
    lines.push(`**${{ must_fix: 'Must fix', consider: 'Consider', minor: 'Minor' }[sev]}**`, '');
    for (const f of fs) {
      lines.push(`- \`${f.file}${f.line ? `:${f.line}` : ''}\` **${f.title}**. ${f.scenario}${f.fix ? ` Fix: ${f.fix}` : ''}`);
    }
    lines.push('');
  }
  lines.push(`<sub>Reviewed ${run.baseSha?.slice(0, 7)}…${run.headSha?.slice(0, 7)} locally by purr.</sub>`);
  return lines.join('\n');
}
