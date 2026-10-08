#!/usr/bin/env node
// purr command line: the daemon, the git hook entry points, manual runs and setup.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Finding, type Run, type TriggerKind, TRIGGERS } from '../shared/types.ts';
import { ClaudeRunner } from './claude.ts';
import { type DB, type RunQuery, openDb } from './db.ts';
import { ensureDefaults } from './flows/store.ts';
import { exportFlow, importFlow, previewImport } from './flows/share.ts';
import { readFileSync } from 'node:fs';
import { currentBranch, defaultBaseRef, headSha, repoRoot, upstreamBranch } from './git.ts';
import { ReviewWatch, blockSessions, currentFindings, isActive, isFinished, resolvedBy, sameRepoIds, waitForReview } from './lookup.ts';
import { addRepo, startHttp } from './http.ts';
import { installGlobalHooks, removePidFile, uninstallGlobalHooks, writePidFile } from './globalHooks.ts';
import { type RunRequest, RunManager } from './manager.ts';
import { PostPushWatcher } from './triggers.ts';
import { exec, paths } from './util.ts';
import { SHIM } from './runtime.ts';

type HookName = 'pre-commit' | 'pre-push';
const ZERO = /^0+$/;
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function setup() {
  const db = openDb();
  ensureDefaults(db);
  const claude = new ClaudeRunner(db);
  const mgr = new RunManager(db, claude);
  claude.onUsage = (usage) => mgr.emit({ type: 'usage', usage });
  return { db, claude, mgr };
}

async function daemonPost(path: string, body: unknown, timeoutMs = 2000): Promise<any> {
  const db = openDb();
  const port = db.getSettings().port;
  db.close();
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const C = process.stderr.isTTY ? { red: '\x1b[31m', yel: '\x1b[33m', grn: '\x1b[32m', dim: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { red: '', yel: '', grn: '', dim: '', b: '', x: '' };

/** `all` also lists dismissed and tracked findings; `detail` adds each finding's scenario. Fixed ones are always listed, marked. */
function report(run: Run, findings: Finding[], opts: { all?: boolean; detail?: boolean } = {}) {
  const muted = (f: Finding) => f.ledger === 'dismissed' || f.ledger === 'tracked';
  const shown = opts.all ? findings : findings.filter((f) => !muted(f));
  const status = run.status === 'blocked' ? `${C.red}${C.b}BLOCKED${C.x}` : run.status === 'passed' ? `${C.grn}passed${C.x}`
    : `${C.yel}${run.status}${C.x}`;
  process.stderr.write(`purr · ${run.trigger} · ${run.flowName}: ${status}${run.error ? ` ${C.dim}(${run.error})${C.x}` : ''}\n`);
  for (const f of shown) {
    const sev = f.severity === 'must_fix' ? `${C.red}must_fix${C.x}` : f.severity === 'consider' ? `${C.yel}consider${C.x}` : 'minor   ';
    const src = f.source.scanner ? ` ${C.dim}(${f.source.scanner} ${f.source.rule})${C.x}` : '';
    const tag = muted(f) ? ` ${C.dim}[${f.ledger}]${C.x}` : f.ledger === 'fixed' ? ` ${C.grn}[fixed since]${C.x}` : '';
    process.stderr.write(`  ${sev}  ${f.file}${f.line ? `:${f.line}` : ''}${f.lines && f.lines.length > 1 ? ` (+${f.lines.length - 1} more)` : ''}  ${f.title}${src}${tag}\n`);
    if (opts.detail && f.scenario) process.stderr.write(`            ${f.scenario.replace(/\n/g, '\n            ')}\n`);
    if (f.fix) process.stderr.write(`            ${C.dim}fix: ${f.fix}${C.x}\n`);
  }
}

/** Runs a hook flow in this process (fast, no daemon needed), then tells the daemon so the UI updates. */
async function runHookFlow(req: RunRequest): Promise<Run | null> {
  const { db, mgr } = setup();
  const run = mgr.createRun(req);
  if (!run) { db.close(); return null; }
  const done = await mgr.execute(req, run);
  report(done, db.getRunFindings(done.id));
  await daemonPost('/api/hooks/notify', { runId: done.id });
  db.close();
  return done;
}

async function hook(name: HookName) {
  const repoPath = await repoRoot(process.cwd());
  if (!repoPath) return 0;
  try {
    // PuRR covers every repo: the first commit or push through it registers the repo (for the poller, ledger and settings)
    { const db = openDb(); try { await addRepo(db, repoPath); } finally { db.close(); } }
    if (name === 'pre-commit') {
      const run = await runHookFlow({ trigger: 'pre-commit', repoPath, mode: 'staged' });
      if (run?.status === 'blocked') {
        process.stderr.write(`${C.dim}Commit blocked by purr. Fix the above, dismiss a false positive in the purr UI (Findings), or skip once with PURR_SKIP=1.${C.x}\n`);
        return 1;
      }
      return 0;
    }
    // pre-push: stdin lines "<local ref> <local sha> <remote ref> <remote sha>"; argv: <remote name> <url>
    const remote = args[2] || 'origin';
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    const refs = Buffer.concat(chunks).toString().split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 4);
    const pushed: Array<{ branch: string; sha: string; from: string | null }> = [];
    for (const [localRef, localSha, remoteRef, remoteSha] of refs) {
      if (ZERO.test(localSha) || !remoteRef.startsWith('refs/heads/')) continue; // branch deletion or tag
      const branch = remoteRef.slice('refs/heads/'.length);
      const run = await runHookFlow({
        trigger: 'pre-push', repoPath, mode: 'range', head: localSha, base: ZERO.test(remoteSha) ? null : remoteSha,
        branch: localRef.startsWith('refs/heads/') ? localRef.slice(11) : branch,
      });
      if (run?.status === 'blocked') {
        process.stderr.write(`${C.dim}Push blocked by purr. Fix the above, dismiss a false positive in the purr UI (Findings), or skip once with PURR_SKIP=1.${C.x}\n`);
        return 1;
      }
      pushed.push({ branch, sha: localSha, from: ZERO.test(remoteSha) ? null : remoteSha });
    }
    for (const p of pushed) {
      const r = await daemonPost('/api/hooks/push-intent', { repoPath, branch: p.branch, sha: p.sha, from: p.from, remote });
      if (r?.queued) {
        process.stderr.write(`${C.dim}purr: ${p.branch} will be reviewed once the push lands${r.prOnly ? ' (if it has an open PR)' : ''}. `
          + `For the results: purr findings --sha ${p.sha.slice(0, 12)} --wait${C.x}\n`);
      }
    }
    return 0;
  } catch (e: any) {
    // PuRR must never stop you committing because of its own bug
    process.stderr.write(`purr: hook error, not blocking: ${e?.message ?? e}\n`);
    return 0;
  }
}

async function daemon() {
  const { db, mgr } = setup();
  if (!process.env.PURR_NO_GLOBAL_HOOKS) {
    try {
      const g = await installGlobalHooks();
      if (g.changed) console.log(`purr: git hooks now run for every repo (core.hooksPath)${g.previous ? `; your previous hooks path ${g.previous} still runs` : ''}`);
    } catch (e: any) {
      console.error(`purr: couldn't install the global git hooks: ${e?.message ?? e}`);
    }
  }
  const watcher = new PostPushWatcher(db, mgr);
  const port = Number(flag('port') ?? db.getSettings().port);
  const server = startHttp(db, mgr, watcher, port);
  server.on('error', (e: any) => {
    console.error(e.code === 'EADDRINUSE' ? `purr: port ${port} is in use (is the daemon already running?)` : e);
    process.exit(1);
  });
  server.on('listening', () => {
    writePidFile();
    // only the daemon that got the port tidies up after the last one: a second `purr daemon` started by mistake
    // must not fail the live one's runs or give up on the pushes it's about to review
    const orphans = db.failOrphanRuns();
    db.expirePendingPushes();
    console.log(`purr daemon ${orphans ? `(marked ${orphans} interrupted run(s) failed) ` : ''}listening on http://127.0.0.1:${port}`);
    watcher.start();
  });
  const stop = () => { removePidFile(); watcher.stop(); server.close(); db.close(); process.exit(0); };
  process.on('exit', removePidFile);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function manualRun() {
  const repoPath = await repoRoot(flag('repo') ?? process.cwd());
  if (!repoPath) { console.error('Not inside a git repository'); return 2; }
  const { db, mgr } = setup();
  const req: RunRequest = { trigger: 'manual', repoPath, mode: 'range', flowId: flag('flow') ?? null, base: flag('base') ?? null, head: flag('head') ?? null };
  const run = mgr.createRun(req);
  if (!run) { console.error('The manual trigger is disabled for this repo; pass --flow <id>'); return 2; }
  process.stderr.write(`purr: running "${run.flowName}" (${run.id})…\n`);
  const done = await mgr.execute(req, run);
  const findings = db.getRunFindings(done.id);
  if (args.includes('--json')) console.log(JSON.stringify({ run: { ...done, flow: undefined }, findings }, null, 2));
  else report(done, findings);
  await daemonPost('/api/hooks/notify', { runId: done.id });
  db.close();
  if (done.status === 'failed' || done.status === 'cancelled') return 2;
  return done.counts.must_fix > 0 ? 1 : 0;
}

/** `purr flow export <id> [--json]` prints a flow as share text; `purr flow import [file|-] [--yes]` reads one back. */
async function flowCmd(sub: string | undefined, arg: string | undefined): Promise<number> {
  const db = openDb();
  ensureDefaults(db);
  try {
    if (sub === 'list') {
      for (const f of db.listFlows()) console.log(`${f.id.padEnd(22)} ${f.name}${f.isDefault ? '  (default)' : ''}`);
      return 0;
    }
    if (sub === 'export') {
      const f = arg && !arg.startsWith('--') ? db.getFlow(arg) : null;
      if (!f) { console.error('Usage: purr flow export <flow id> [--json]   (ids: purr flow list)'); return 2; }
      const e = exportFlow(f);
      console.log(args.includes('--json') ? e.json : e.text);
      return 0;
    }
    if (sub === 'import') {
      const src = arg && !arg.startsWith('--') && arg !== '-' ? readFileSync(arg, 'utf8') : await new Promise<string>((res) => {
        let t = ''; process.stdin.on('data', (d) => { t += d; }).on('end', () => res(t));
      });
      const p = previewImport(src);
      process.stderr.write(`${C.b}${p.name}${C.x}: ${p.blocks.length} blocks, ${p.edges.length} connections\n`);
      for (const n of p.notes) process.stderr.write(`  ${C.dim}note: ${n}${C.x}\n`);
      for (const r of p.risks) process.stderr.write(`  ${r.level === 'danger' ? C.red : r.level === 'warn' ? C.yel : C.dim}${r.level}${C.x}  ${r.label}: ${r.message}${r.detail ? `\n           ${C.dim}${r.detail}${C.x}` : ''}\n`);
      const errors = p.issues.filter((i) => i.level === 'error');
      if (errors.length) process.stderr.write(`  ${C.yel}${errors.length} validation error(s): fix them in the editor before assigning it to a trigger${C.x}\n`);
      if (p.risks.some((r) => r.level !== 'info') && !args.includes('--yes')) {
        process.stderr.write(`Read the above, then run again with --yes to import it.\n`);
        return 1;
      }
      const f = importFlow(db, src);
      console.log(`Imported "${f.name}" (${f.id}). It isn't assigned to any trigger yet.`);
      return 0;
    }
    console.error('Usage: purr flow list | export <id> [--json] | import [file|-] [--yes]');
    return 2;
  } catch (e: any) {
    console.error(`purr: ${e?.message ?? e}`);
    return 2;
  } finally {
    db.close();
  }
}

class UsageError extends Error {}
/** A flag's value: undefined when the flag is absent, a usage error when it's given without one. */
function value(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v == null || v.startsWith('--')) throw new UsageError(`--${name} needs a value`);
  return v;
}
function positiveInt(name: string): number | undefined {
  const v = value(name);
  if (v == null) return undefined;
  if (!/^\d+$/.test(v) || Number(v) < 1 || !Number.isSafeInteger(Number(v))) throw new UsageError(`--${name} takes a whole number above 0, not "${v}"`);
  return Number(v);
}

/**
 * Filters shared by `purr findings` and `purr runs`: every clone of the repo at --repo (default: here), full reviews
 * (post-push and manual) unless --trigger says otherwise, and the current branch if `currentBranchByDefault` and no
 * --pr, --branch or --sha narrows it. null when PuRR doesn't know the repo.
 */
async function runQuery(db: DB, currentBranchByDefault: boolean): Promise<RunQuery | null> {
  const cwd = value('repo') ?? process.cwd();
  const pr = positiveInt('pr') ?? null;
  const sha = value('sha') ?? null;
  if (sha != null && !/^[0-9a-f]{4,40}$/i.test(sha)) throw new UsageError(`--sha takes 4 to 40 hex digits of a commit, not "${sha}"`);
  const trigger = value('trigger');
  if (trigger && trigger !== 'all' && !TRIGGERS.includes(trigger as TriggerKind)) throw new UsageError(`--trigger is one of ${TRIGGERS.join(', ')} or all`);
  const repoIds = await sameRepoIds(db, cwd);
  if (!repoIds.length) return null;
  const q: RunQuery = {
    repoIds, pr, branch: value('branch') ?? null, sha,
    triggers: trigger === 'all' ? undefined : trigger ? [trigger as TriggerKind] : ['post-push', 'manual'],
  };
  if (currentBranchByDefault && pr == null && !q.branch && !q.sha) {
    const local = await currentBranch(cwd);
    q.branch = local;
    // reviews are recorded under the name it was pushed as (git push -u origin foo:bar is reviewed as bar): the
    // upstream's name, if nothing is recorded under the local one (a branch made from origin/main tracks main)
    if (local && !db.findRuns({ ...q, limit: 1 }).length) {
      const up = await upstreamBranch(cwd, local);
      // but not the default branch: a branch made from origin/main tracks main, and main's review isn't its review
      const dflt = (await defaultBaseRef(cwd))?.replace(/^[^/]+\//, '');
      if (up && up !== dflt) q.branch = up;
    }
    // detached (a review worktree, CI): the commit checked out, not every branch's latest review
    if (!q.branch) q.sha = await headSha(cwd);
    if (!q.branch && !q.sha) throw new UsageError('nothing is checked out here: pass --pr, --branch or --sha');
  }
  return q;
}

const describe = (q: RunQuery) => q.pr != null ? `PR #${q.pr}` : q.sha ? `commit ${q.sha.slice(0, 12)}` : q.branch ? `branch ${q.branch}` : 'this repo';
const unknownRepo = () => `PuRR hasn't seen the repo at ${value('repo') ?? process.cwd()} yet (commit or push through it, or run: purr repo add)`;
/** Local time, to the minute. */
const localTime = (iso: string) => {
  const d = new Date(iso), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * `purr findings`: the latest review's findings, optionally waiting for one in progress or about to start.
 * Exit 0 clean, 1 must-fix, 2 the review failed / was cancelled / superseded, 3 no finished review (none, unknown
 * repo, still running, won't be reviewed, or the wait timed out), 4 usage error.
 */
async function findingsCmd(): Promise<number> {
  const db = openDb();
  try {
    const runId = value('run');
    const q = runId ? {} : await runQuery(db, true);
    if (!q) { console.error(`purr: ${unknownRepo()}`); return 3; }
    const wait = args.includes('--wait');
    const timeoutSec = positiveInt('timeout') ?? 1800;
    let run: Run | null;
    if (wait && !runId) {
      // with nothing to narrow it, wait for the review of the commit checked out here (the one just pushed), under
      // whatever name it was pushed as
      if (q.pr == null && !q.sha && !value('branch')) {
        q.sha = await headSha(value('repo') ?? process.cwd());
        if (!q.sha) throw new UsageError('nothing is committed here yet: pass --pr, --branch or --sha');
        q.branch = null;
      }
      const watch = new ReviewWatch(db, q);
      const label = describe(q);
      let notes = 0;
      const st = await waitForReview(watch, {
        timeoutMs: timeoutSec * 1000,
        onChange: (r) => {
          for (; notes < watch.notes.length; notes++) process.stderr.write(`${C.dim}purr: ${watch.notes[notes]}${C.x}\n`);
          if (!r) process.stderr.write(`${C.dim}purr: no review of ${label} yet; waiting (a review starts about a minute after the push lands)…${C.x}\n`);
          else if (!isFinished(r)) process.stderr.write(`${C.dim}purr: review ${r.id} is ${r.status}…${C.x}\n`);
        },
      });
      for (; notes < watch.notes.length; notes++) process.stderr.write(`${C.dim}purr: ${watch.notes[notes]}${C.x}\n`);
      if (st.stop) { console.error(`purr: ${st.stop}`); return 3; }
      run = st.run;
      if (!run) { console.error(`purr: no review of ${label} appeared within ${timeoutSec}s`); return 3; }
      if (!st.done) { console.error(`purr: review ${run.id} is still ${run.status} after ${timeoutSec}s`); return 3; }
    } else {
      const find = () => runId ? db.getRun(runId) : db.findRuns({ ...q, limit: 1 })[0] ?? null;
      // waits for a review that isn't queued yet, too (the PR's first, still in its debounce)
      run = wait ? (await waitForReview({ check: async () => { const r = find(); return { run: r, done: !!r && isFinished(r) }; } }, {
        timeoutMs: timeoutSec * 1000,
        onChange: (r) => {
          if (!r) process.stderr.write(`${C.dim}purr: no review of ${runId ? `run ${runId}` : describe(q)} yet; waiting…${C.x}\n`);
          else if (!isFinished(r)) process.stderr.write(`${C.dim}purr: review ${r.id} is ${r.status}…${C.x}\n`);
        },
      })).run : find();
      if (!run) { console.error(`purr: no review of ${runId ? `run ${runId}` : describe(q)} found (purr runs lists them)`); return 3; }
    }
    const findings = currentFindings(db, run);
    const sessions = blockSessions(db, run.id);
    const resolved = resolvedBy(db, run);
    if (args.includes('--json')) {
      console.log(JSON.stringify({ run: { ...run, flow: undefined }, findings, resolved, sessions }, null, 2));
    } else {
      const ref = [run.pr ? `PR #${run.pr.number} ${run.pr.url}` : run.branch, run.headSha?.slice(0, 12), localTime(run.finishedAt ?? run.queuedAt)].filter(Boolean);
      process.stderr.write(`${C.dim}${run.id} · ${ref.join(' · ')}${C.x}\n`);
      report(run, findings, { all: args.includes('--all'), detail: true });
      if (resolved.length) {
        process.stderr.write(`${C.grn}Resolved by this review${C.x} ${C.dim}(raised before on ${run.branch}, gone now)${C.x}\n`);
        for (const f of resolved) process.stderr.write(`  ${C.grn}fixed${C.x}     ${f.file}${f.line ? `:${f.line}` : ''}  ${f.title}\n`);
      }
      const asked = [...new Set(findings.filter((f) => f.source.kind === 'model' && sessions[f.source.blockId]).map((f) => f.source.blockId))];
      if (run.workdir && existsSync(run.workdir) && asked.length) {
        process.stderr.write(`${C.dim}Ask the reviewer behind a finding: cd ${run.workdir} && claude --resume <session>${C.x}\n`);
        for (const b of asked) process.stderr.write(`  ${C.dim}${b}: ${sessions[b]}${C.x}\n`);
      }
    }
    if (!isFinished(run)) return 3;
    if (run.status === 'failed' || run.status === 'cancelled' || run.status === 'superseded') return 2;
    return findings.some((f) => f.severity === 'must_fix' && isActive(f)) ? 1 : 0;
  } catch (e) {
    if (e instanceof UsageError) { console.error(`purr: ${e.message}`); return 4; }
    throw e;
  } finally {
    db.close();
  }
}

/** `purr runs`: recent reviews of this repo, newest first. Exit 3 for an unknown repo, 4 for a usage error. */
async function runsCmd(): Promise<number> {
  const db = openDb();
  try {
    const q = await runQuery(db, false);
    if (!q) { console.error(`purr: ${unknownRepo()}`); return 3; }
    const runs = db.findRuns({ ...q, limit: positiveInt('limit') ?? 20 });
    if (args.includes('--json')) { console.log(JSON.stringify(runs.map((r) => ({ ...r, flow: undefined })), null, 2)); return 0; }
    if (!runs.length) { console.error(`purr: no reviews of ${describe(q)} found`); return 0; }
    for (const r of runs) {
      const c = r.counts;
      console.log([r.id, r.status.padEnd(10), r.trigger.padEnd(10), (r.headSha ?? '').slice(0, 7).padEnd(7),
        `${c.must_fix}/${c.consider}/${c.minor}`.padEnd(8), localTime(r.queuedAt),
        [r.branch, r.pr ? `#${r.pr.number}` : null].filter(Boolean).join(' ')].join('  '));
    }
    return 0;
  } catch (e) {
    if (e instanceof UsageError) { console.error(`purr: ${e.message}`); return 4; }
    throw e;
  } finally {
    db.close();
  }
}

const PLIST = join(homedir(), 'Library/LaunchAgents/com.purr.daemon.plist');
async function agent(action: string | undefined) {
  if (action === 'install' && process.env.PURR_APP_BUNDLE) {
    console.error('PuRR.app starts the service itself: use "Start at login" in its tray menu instead.');
    return 2;
  }
  if (action === 'install') {
    mkdirSync(join(homedir(), 'Library/LaunchAgents'), { recursive: true });
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.purr.daemon</string>
  <key>ProgramArguments</key><array>
    <string>${esc(SHIM)}</string><string>daemon</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(process.env.PATH ?? '/usr/bin:/bin')}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(join(paths.logs, 'daemon.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(join(paths.logs, 'daemon.log'))}</string>
</dict></plist>
`);
    await exec('launchctl', ['unload', PLIST]).catch(() => null);
    const r = await exec('launchctl', ['load', '-w', PLIST]);
    console.log(r.code === 0 ? `Installed and started: ${PLIST}` : `Wrote ${PLIST} but launchctl failed: ${r.stderr}`);
    return r.code === 0 ? 0 : 1;
  }
  if (action === 'uninstall') {
    await exec('launchctl', ['unload', '-w', PLIST]).catch(() => null);
    rmSync(PLIST, { force: true });
    console.log('Removed the launch agent');
    return 0;
  }
  console.error('Usage: purr agent install|uninstall');
  return 2;
}

const USAGE = `PuRR: Pull Request Reviewer

  purr daemon [--port N]          run the background daemon + UI (http://127.0.0.1:7878)
  purr open                       open the UI in your browser
  purr run [--repo P] [--flow ID] [--base REF] [--head REF] [--json]
                                 run a flow now on the current branch (exit 0 clean, 1 must-fix, 2 failed)
  purr findings [--pr N | --branch B | --sha S | --run ID] [--wait [--timeout SECS]] [--all] [--json]
                                 the latest review's findings (default: this branch; with --wait, the review
                                 of the commit checked out here). Exit 0 clean, 1 must-fix, 2 failed or
                                 superseded, 3 no finished review, 4 usage error
  purr runs [--pr N | --branch B | --sha S] [--limit N] [--json]
                                 recent reviews of this repo (must-fix/consider/minor counts)
                                 both take --repo P, and --trigger post-push|manual|pre-push|pre-commit|all
                                 (default: full reviews, post-push and manual)
  purr repo add [PATH]            register a repository (default: current)
  purr hooks install|uninstall    git hooks for every repo (the service installs them on start);
                                 uninstall restores your previous core.hooksPath
  purr flow list | export <id> [--json] | import [file|-] [--yes]
                                 share flows as text
  purr agent install|uninstall    start the daemon at login (macOS launchd)
  purr hook pre-commit|pre-push   (called by the installed git hooks)
`;

async function main(): Promise<number> {
  const [cmd, sub] = args;
  switch (cmd) {
    case 'daemon': await daemon(); return -1;
    case 'hook': return hook(sub as HookName);
    case 'run': return manualRun();
    case 'findings': return findingsCmd();
    case 'runs': return runsCmd();
    case 'open': {
      const db = openDb();
      await exec('open', [`http://127.0.0.1:${db.getSettings().port}`]);
      return 0;
    }
    case 'repo': {
      if (sub !== 'add') break;
      const db = openDb();
      const r = await addRepo(db, args[2] ?? process.cwd());
      console.log(`Registered ${r.path}`);
      return 0;
    }
    case 'hooks': {
      if (sub === 'uninstall') { console.log(await uninstallGlobalHooks()); return 0; }
      if (sub === 'install') { const g = await installGlobalHooks(); console.log(`purr hooks run for every repo (${g.changed ? 'installed' : 'already installed'})`); return 0; }
      break;
    }
    case 'flow': return flowCmd(sub, args[2]);
    case 'agent': return agent(sub);
  }
  process.stdout.write(USAGE);
  return cmd ? 2 : 0;
}

main().then((code) => { if (code >= 0) process.exit(code); }, (e) => { console.error(e); process.exit(2); });
