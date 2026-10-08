// Read side for `purr findings` / `purr runs`: lets a Claude session (or a person) look up a review's results.
import { existsSync, realpathSync } from 'node:fs';
import type { Finding, Run } from '../shared/types.ts';
import type { DB, RunQuery } from './db.ts';
import { githubRepo, prForBranch } from './gh.ts';
import { remoteUrl, repoRoot } from './git.ts';
import { TERMINAL } from './manager.ts';

/**
 * Registered repos that are the same project as the checkout at `path`: itself plus every other clone or worktree of
 * the same GitHub repo (the poller reviews a PR in the main checkout, wherever the push came from). Empty if unknown.
 */
export async function sameRepoIds(db: DB, path: string): Promise<string[]> {
  const top = await repoRoot(path);
  if (!top) return [];
  const root = existsSync(top) ? realpathSync(top) : top;
  const key = githubRepo(db.getRepoByPath(root)?.remoteUrl ?? await remoteUrl(root));
  return db.listRepos().filter((r) => r.path === root || (key && githubRepo(r.remoteUrl) === key)).map((r) => r.id);
}

/**
 * A run's findings with their ledger state as it is now: a finding dismissed since says so, and so does one a later
 * review of the same branch found fixed. The ledger keeps one row per finding for the whole repo, so a fix on another
 * branch (a stacked PR, say) says nothing about this one.
 */
export function currentFindings(db: DB, run: Run): Finding[] {
  return db.getRunFindings(run.id).map((f) => {
    const l = f.fingerprint && run.repoId ? db.getLedger(f.fingerprint, run.repoId) : null;
    if (!l) return f;
    if (l.state === 'dismissed' || l.state === 'tracked') return { ...f, ledger: l.state };
    if (l.state === 'fixed') {
      const by = db.getRun(l.lastRunId);
      if (run.branch && l.branch === run.branch && by && by.queuedAt > run.queuedAt) return { ...f, ledger: 'fixed' };
    }
    if (f.ledger === 'dismissed' || f.ledger === 'tracked') return { ...f, ledger: 'open' };   // reopened since
    return f;
  });
}

export const isFinished = (run: Run) => TERMINAL.has(run.status);

export interface ReviewState {
  run: Run | null;      // null until the review exists
  done: boolean;        // nothing more to wait for
  stop?: string;        // why no review will come
}

/**
 * What `purr findings --wait` waits on. A commit can lose its own review to a newer push (in the debounce, or a
 * running review superseded): the watch then follows the newer push's review, which covers it. It stops early when
 * PuRR recorded that the commit won't be reviewed, unless that was for want of a PR and one is open now.
 */
export class ReviewWatch {
  q: RunQuery;
  notes: string[] = [];
  private db: DB;
  private findPr: typeof prForBranch;
  private prChecked = new Map<string, { at: number; open: boolean }>();
  constructor(db: DB, q: RunQuery, findPr: typeof prForBranch = prForBranch) { this.db = db; this.q = q; this.findPr = findPr; }

  async check(): Promise<ReviewState> {
    for (let hops = 0; hops < 20; hops++) {
      const run = this.db.findRuns({ ...this.q, limit: 1 })[0] ?? null;
      if (run?.status === 'superseded') {
        const next = run.branch ? this.db.findRuns({ repoIds: this.q.repoIds, branch: run.branch, triggers: this.q.triggers, limit: 1 })[0] : null;
        if (next?.headSha && next.id !== run.id && next.queuedAt > run.queuedAt) { this.follow(next.headSha, `review ${run.id} was superseded by a newer push`); continue; }
        return { run, done: false };   // the newer push's review is still in its debounce
      }
      if (run) return { run, done: isFinished(run) };
      const out = this.q.sha ? this.db.getPushOutcome(this.q.sha) : null;
      if (out?.nextSha) { this.follow(out.nextSha, `commit ${out.sha.slice(0, 12)} wasn't reviewed on its own: ${out.reason}`); continue; }
      if (out?.kind === 'no-pr' && out.branch && await this.prOpen(out.repoPath, out.branch)) return { run: null, done: false };
      if (out) return { run: null, done: true, stop: `commit ${out.sha.slice(0, 12)} won't be reviewed: ${out.reason}` };
      return { run: null, done: false };
    }
    return { run: null, done: true, stop: 'gave up following newer pushes' };
  }

  private follow(sha: string, why: string) {
    this.notes.push(`${why}; following the review of ${sha.slice(0, 12)}, which covers it`);
    this.q = { ...this.q, sha, branch: null, pr: null };
  }

  /** Whether the branch has an open PR now (the poller then reviews it within a minute), asked of gh at most every 20s. */
  private async prOpen(repoPath: string, branch: string): Promise<boolean> {
    const c = this.prChecked.get(branch);
    if (c && Date.now() - c.at < 20_000) return c.open;
    const open = !!(await this.findPr(repoPath, branch).catch(() => null));
    this.prChecked.set(branch, { at: Date.now(), open });
    return open;
  }
}

/** Polls until the watch is done or the timeout passes, then returns its last state. */
export async function waitForReview(watch: { check: () => Promise<ReviewState> }, opts: { timeoutMs: number; intervalMs?: number; onChange?: (run: Run | null) => void }) {
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 0) throw new Error(`Bad timeout: ${opts.timeoutMs}`);
  const deadline = Date.now() + opts.timeoutMs;
  let lastKey = '';
  for (;;) {
    const st = await watch.check();
    const key = st.run ? `${st.run.id}:${st.run.status}` : '';
    if (key !== lastKey) { lastKey = key; opts.onChange?.(st.run); }
    if (st.done || Date.now() >= deadline) return st;
    await new Promise((r) => setTimeout(r, Math.min(opts.intervalMs ?? 3000, Math.max(0, deadline - Date.now()))));
  }
}

/** The Claude session behind each block of a run (the last one, for a block that ran several), by block id. */
export function blockSessions(db: DB, runId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of db.listBlockRuns(runId)) {
    const id = b.output?.sessions?.at(-1)?.sessionId ?? b.output?.sessionId;
    if (id) out[b.blockId] = id;
  }
  return out;
}

/** Findings this run closed: raised by an earlier review of the branch, gone from this one (see applyLedger). */
export function resolvedBy(db: DB, run: Run): Finding[] {
  if (!run.repoId) return [];
  return db.listFixedBy(run.repoId, run.id).map((l) => ({ ...l.finding, ledger: 'fixed' }));
}

/** Counts towards the exit code and the default listing: not dismissed, tracked or since fixed. */
export const isActive = (f: Finding) => f.ledger !== 'dismissed' && f.ledger !== 'tracked' && f.ledger !== 'fixed';
