import { sh, tempRepo } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/server/db.ts';
import { addRepo } from '../src/server/http.ts';
import { RunManager } from '../src/server/manager.ts';
import { ClaudeRunner } from '../src/server/claude.ts';
import type { Run } from '../src/shared/types.ts';

const CLI = new URL('../src/server/cli.ts', import.meta.url).pathname;
const purr = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: process.env, timeout: 30_000 });

let n = 0;
const run = (over: Partial<Run>): Run => ({
  id: `run-s${++n}`, flowId: 'full', flowName: 'Full review', flow: { blocks: [], edges: [] } as any, trigger: 'post-push',
  repoId: null, repoPath: '/x', branch: 'feat', baseSha: null, headSha: null, mode: 'range', workdir: null, pr: null,
  status: 'passed', queuedAt: new Date(Date.UTC(2026, 1, 1, 0, 0, n)).toISOString(), startedAt: null, finishedAt: null,
  counts: { must_fix: 0, consider: 0, minor: 0 }, error: null, ...over,
});

test("--sha for another repo's commit fails at once, naming the repo that reviewed it, instead of waiting out the timeout", async () => {
  const db = openDb();
  const herePath = tempRepo(), therePath = tempRepo({ 'other.md': 'x\n' });
  await addRepo(db, herePath);
  const there = await addRepo(db, therePath);
  const theirs = sh(therePath, 'rev-parse', 'HEAD');
  db.putRun(run({ repoId: there.id, repoPath: there.path, headSha: theirs, branch: 'feature', pr: { number: 127, title: 't', body: '', url: 'u', account: 'me' } }));
  db.close();

  const t0 = Date.now();
  const w = purr(herePath, 'findings', '--sha', theirs.slice(0, 12), '--wait', '--timeout', '1200', '--all');
  assert.equal(w.status, 3, w.stderr);
  assert.match(w.stderr, new RegExp(`commit ${theirs.slice(0, 12)} isn't in .*, so it won't be reviewed here`));
  assert.match(w.stderr, new RegExp(`PuRR reviewed commit ${theirs.slice(0, 12)} in ${there.path} \\(PR #127, run-s\\d+\\).*--repo ${there.path}`));
  assert.ok(Date.now() - t0 < 15_000, 'at once');
  assert.equal(purr(herePath, 'findings', '--sha', theirs).status, 3, 'without --wait too');
  assert.match(purr(herePath, 'runs', '--sha', theirs).stderr, /PuRR reviewed commit/);
  assert.equal(purr(herePath, 'findings', '--sha', theirs, '--repo', therePath).status, 0, '--repo looks there');

  // a commit no repo PuRR knows has: the same, without a repo to name
  const none = purr(herePath, 'findings', '--sha', 'deadbeef00', '--wait');
  assert.equal(none.status, 3);
  assert.match(none.stderr, /isn't in .*Run this from the repo it's in, or pass --repo <path>/);

  // run from a repo PuRR has never seen: says where the commit was reviewed
  const unseen = purr(tempRepo(), 'findings', '--sha', theirs);
  assert.equal(unseen.status, 3);
  assert.match(unseen.stderr, /hasn't seen the repo.*PuRR reviewed commit .* in /);

  // this repo's own commit, not reviewed yet: still waited for (until the timeout, or at once if no service runs)
  const ours = sh(herePath, 'rev-parse', 'HEAD');
  const mine = purr(herePath, 'findings', '--sha', ours, '--wait', '--timeout', '1');
  assert.equal(mine.status, 3);
  assert.doesNotMatch(mine.stderr, /isn't in/);
  assert.match(mine.stderr, /appeared within 1s|service isn't running/);
});

test("for one commit, findings shows the complete review over a newer one still running or cut short, and says the newer one exists", async () => {
  const db = openDb();
  const repoPath = tempRepo();
  const repo = await addRepo(db, repoPath);
  const at = (over: Partial<Run>) => { const r = run({ repoId: repo.id, repoPath: repo.path, ...over }); db.putRun(r); db.setRunFindings(r.id, []); return r; };
  const passed = at({ headSha: 'cafe000001', trigger: 'post-push' });
  const stale = at({ headSha: 'cafe000001', trigger: 'manual', status: 'running' });
  const failed = at({ headSha: 'cafe000002', status: 'failed', error: 'boom' });
  const retry = at({ headSha: 'cafe000002', trigger: 'manual', status: 'running' });
  at({ headSha: 'cafe000003' });
  const cut = at({ headSha: 'cafe000003', trigger: 'manual', status: 'cancelled' });
  db.close();

  const r = purr(repoPath, 'findings', '--sha', 'cafe000001', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).run.id, passed.id);
  assert.match(r.stderr, new RegExp(`a newer review of commit cafe000001, ${stale.id} \\(manual\\), is running; showing the last one that ran to the end`));
  const waited = purr(repoPath, 'findings', '--sha', 'cafe000001', '--wait', '--json');
  assert.equal(waited.status, 0, 'not waiting on the stale run');
  assert.equal(JSON.parse(waited.stdout).run.id, passed.id);
  assert.equal(purr(repoPath, 'findings', '--sha', 'cafe000003').status, 0, 'cancelled after a complete review: the complete one');
  assert.match(purr(repoPath, 'findings', '--sha', 'cafe000003').stderr, new RegExp(`${cut.id} \\(manual\\), is cancelled`));
  const rerun = purr(repoPath, 'findings', '--sha', 'cafe000002', '--json');
  assert.equal(rerun.status, 3, 'a rerun of a failed review: the rerun, still running');
  assert.equal(JSON.parse(rerun.stdout).run.id, retry.id);
  assert.notEqual(failed.id, retry.id);

  // --wait that follows a newer push which took the commit's place: the notes are about the commit it followed to
  const db3 = openDb();
  db3.setPushOutcome({ sha: 'cafe0000a1', kind: 'superseded', reason: 'a newer push to the branch took its place', repoPath: repo.path, branch: 'feat', nextSha: 'cafe0000b2' });
  db3.putRun(run({ repoId: repo.id, repoPath: repo.path, headSha: 'cafe0000b2' }));
  const staleB = run({ repoId: repo.id, repoPath: repo.path, headSha: 'cafe0000b2', trigger: 'manual', status: 'running' });
  db3.putRun(staleB);
  db3.close();
  const followed = purr(repoPath, 'findings', '--sha', 'cafe0000a1', '--wait', '--timeout', '5');
  assert.equal(followed.status, 0, followed.stderr);
  assert.match(followed.stderr, new RegExp(`a newer review of commit cafe0000b2, ${staleB.id} \\(manual\\), is running`));

  // a branch's newest review still running (a newer commit): that one, and where the last finished one is
  const db2 = openDb();
  const done = run({ repoId: repo.id, repoPath: repo.path, headSha: 'f00d000001', branch: 'live' });
  db2.putRun(done);
  const live = run({ repoId: repo.id, repoPath: repo.path, headSha: 'f00d000002', branch: 'live', status: 'running' });
  db2.putRun(live);
  db2.close();
  const b = purr(repoPath, 'findings', '--branch', 'live');
  assert.equal(b.status, 3);
  assert.match(b.stderr, new RegExp(`${live.id} is still running; the last finished review of branch live is ${done.id} \\(f00d000001, passed, .*purr findings --run ${done.id}`));
});

/**
 * Starts `purr <args>` in `cwd` and, once the run's block 'wait' is running, calls `act` with the child and the run id.
 * Resolves with the exit code, stderr and run id; the polling is cleared however the child ends.
 */
function midRun(cwd: string, args: string[], act: (p: ReturnType<typeof spawn>, id: string) => void, opts: { input?: string; idFrom?: () => string } = {}) {
  return new Promise<{ code: number | null; stderr: string; id: string }>((res) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, env: process.env });
    if (opts.input != null) p.stdin.end(opts.input);
    let stderr = '', id = '';
    p.stderr.on('data', (d) => { stderr += d; });
    const t = setInterval(() => {
      id ||= stderr.match(/\((run-[0-9a-f]+)\)/)?.[1] ?? opts.idFrom?.() ?? '';
      if (!id) return;
      const db = openDb();
      const block = db.listBlockRuns(id).find((x) => x.blockId === 'wait');
      db.close();
      if (block?.status === 'running') { clearInterval(t); act(p, id); }
    }, 100);
    p.on('close', (code) => { clearInterval(t); res({ code, stderr, id }); });
  });
}

test("a purr run or hook that's told to stop cancels its run instead of leaving it running; so does Cancel in the UI", { timeout: 120_000 }, async () => {
  const db = openDb();
  const repoPath = tempRepo();
  const repo = await addRepo(db, repoPath);
  const ts = new Date().toISOString();
  db.putFlow({ id: 'hang', name: 'Hang', description: '', isDefault: false, createdAt: ts, updatedAt: ts, edges: [],
    blocks: [{ id: 'wait', type: 'command', label: 'Wait', position: { x: 0, y: 0 }, config: { command: 'sleep 60', timeoutSec: 120, failOnNonZero: true } }] });
  db.setTrigger({ trigger: 'pre-commit', repoId: repo.id, flowId: 'hang' });
  db.close();
  writeFileSync(join(repoPath, 'b.txt'), 'b\n');
  sh(repoPath, 'add', '-A');
  sh(repoPath, 'commit', '-q', '-m', 'b', '--no-verify');
  const status = (id: string) => { const d = openDb(); try { return d.getRun(id)!; } finally { d.close(); } };

  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    const t0 = Date.now();
    const out = await midRun(repoPath, ['run', '--flow', 'hang'], (p) => p.kill(sig));
    assert.equal(out.code, 128 + { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[sig], out.stderr);
    assert.ok(Date.now() - t0 < 30_000, 'stopped well before its 60s command');
    assert.equal(status(out.id).status, 'cancelled', `${sig}: not left running`);
  }

  // twice: quits at once, the run and its running block recorded cancelled
  const twice = await midRun(repoPath, ['run', '--flow', 'hang'], (p) => { p.kill('SIGINT'); setTimeout(() => p.kill('SIGINT'), 20); });
  assert.equal(twice.code, 130, twice.stderr);
  assert.equal(status(twice.id).status, 'cancelled');
  const blocks = (() => { const d = openDb(); try { return d.listBlockRuns(twice.id); } finally { d.close(); } })();
  assert.ok(blocks.every((b) => b.status !== 'running'), JSON.stringify(blocks));

  // the pre-commit hook, Ctrl-C'd: its run cancelled, the hook exits 130
  writeFileSync(join(repoPath, 'c.txt'), 'c\n');
  sh(repoPath, 'add', '-A');
  const newest = () => { const d = openDb(); try { return d.findRuns({ repoIds: [repo.id], triggers: ['pre-commit'], limit: 1 })[0]?.id ?? ''; } finally { d.close(); } };
  const before = newest();
  const hook = await midRun(repoPath, ['hook', 'pre-commit'], (p) => p.kill('SIGINT'), { idFrom: () => { const id = newest(); return id !== before ? id : ''; } });
  assert.equal(hook.code, 130, hook.stderr);
  assert.equal(status(hook.id).status, 'cancelled');

  // Cancel in the UI while the CLI runs it: the CLI notices and cancels it for real (exit 2), and it stays cancelled
  const ui = await midRun(repoPath, ['run', '--flow', 'hang'], (_p, id) => {
    const d = openDb();
    new RunManager(d, new ClaudeRunner(d)).cancel(id);
    d.close();
  });
  assert.equal(ui.code, 2, ui.stderr);
  assert.equal(status(ui.id).status, 'cancelled');

  // a run whose process died outright (SIGKILL), left 'running': cancelling it (the UI's Cancel) records it cancelled
  const db2 = openDb();
  const orphan = run({ repoPath, headSha: 'abc0000001', trigger: 'manual', status: 'running' });
  db2.putRun(orphan);
  const mgr = new RunManager(db2, new ClaudeRunner(db2));
  mgr.cancel(orphan.id);
  assert.equal(db2.getRun(orphan.id)!.status, 'cancelled');
  // a newer push supersedes only the reviews its own process runs: a run another process owns is left to it
  const other = run({ repoPath, headSha: 'abc0000002', trigger: 'manual', status: 'running' });
  db2.putRun(other);
  mgr.cancel(other.id, 'superseded');
  assert.equal(db2.getRun(other.id)!.status, 'running');
  db2.close();
});

test("a commit that may still be reviewed here isn't called another repo's: in another clone, noted as pushed, ambiguous, or brought by a fetch", async () => {
  const db = openDb();
  const remote = 'https://github.com/acme/widget-stray.git';
  const a = tempRepo(), b = tempRepo({ 'b.md': 'b\n' });
  for (const p of [a, b]) sh(p, 'remote', 'add', 'origin', remote);
  const ra = await addRepo(db, a);
  await addRepo(db, b);
  db.setPushOutcome({ sha: 'feed000001', kind: 'skipped', reason: 'reviews are paused', repoPath: ra.path, branch: 'feat' });
  db.close();
  const notStray = (cwd: string, sha: string) => {
    const r = purr(cwd, 'findings', '--sha', sha, '--wait', '--timeout', '1');
    assert.equal(r.status, 3);
    assert.doesNotMatch(r.stderr, /isn't in/, `${sha}: ${r.stderr}`);
    return r.stderr;
  };
  notStray(a, sh(b, 'rev-parse', 'HEAD'));   // only in the other clone
  assert.match(notStray(a, 'feed000001'), /reviews are paused/);   // only a push note

  // pushed from elsewhere to the remote, not fetched here yet: the fetch brings it, so it's waited for
  const bare = mkdtempSync(join(process.env.TMPDIR!, 'purr-test-remote-'));
  sh(bare, 'init', '-q', '--bare');
  const c = tempRepo(), elsewhere = tempRepo({ 'e.md': 'e\n' });
  sh(c, 'remote', 'add', 'origin', bare);
  sh(elsewhere, 'remote', 'add', 'origin', bare);
  sh(elsewhere, 'push', '-q', 'origin', 'main:feat', '--no-verify');
  const db2 = openDb();
  await addRepo(db2, c);
  db2.close();
  notStray(c, sh(elsewhere, 'rev-parse', 'HEAD'));

  // a short prefix that's ambiguous here: blobs until two share the first 4 hex digits, then that prefix
  const seen = new Map<string, string>();
  let prefix = '';
  for (let i = 0; !prefix; i++) {
    const id = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: c, input: `blob ${i}\n` }).toString().trim().slice(0, 4);
    if (seen.has(id)) prefix = id; else seen.set(id, id);
  }
  notStray(c, prefix);
});
