import { sh, tempRepo } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/server/db.ts';
import { addRepo, startHttp } from '../src/server/http.ts';
import { PostPushWatcher } from '../src/server/triggers.ts';
import { RunManager } from '../src/server/manager.ts';
import { ClaudeRunner } from '../src/server/claude.ts';
import { ReviewWatch, commitElsewhere } from '../src/server/lookup.ts';
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
  const listed = purr(herePath, 'runs', '--sha', theirs, '--json');
  assert.deepEqual([listed.status, JSON.parse(listed.stdout)], [0, []], 'a listing: still [] and exit 0');
  assert.match(listed.stderr, /PuRR reviewed commit/);
  assert.equal(purr(herePath, 'findings', '--sha', theirs, '--wait', '--timeout', '10m').status, 4, 'a bad --timeout is a usage error first');
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

  // a quick manual run, then the push: --wait (the push hint) waits for the post-push review, not the manual one
  const db5 = openDb();
  const quick = run({ repoId: repo.id, repoPath: repo.path, headSha: 'cafe0000e5', trigger: 'manual' });
  db5.putRun(quick);
  const full = run({ repoId: repo.id, repoPath: repo.path, headSha: 'cafe0000e5', trigger: 'post-push', status: 'running' });
  db5.putRun(full);
  db5.close();
  const hinted = purr(repoPath, 'findings', '--sha', 'cafe0000e5', '--json');
  assert.equal(hinted.status, 3, 'the post-push review, still running');
  assert.equal(JSON.parse(hinted.stdout).run.id, full.id);
  assert.match(hinted.stderr, new RegExp(`the last finished review of commit cafe0000e5 is ${quick.id}`));

  // pushed, then a `purr run` of the same commit Ctrl-C'd while the post-push review runs: that review, not exit 2
  const db7 = openDb();
  const pp = run({ repoId: repo.id, repoPath: repo.path, headSha: 'cafe0000f6', trigger: 'post-push', status: 'running' });
  db7.putRun(pp);
  db7.putRun(run({ repoId: repo.id, repoPath: repo.path, headSha: 'cafe0000f6', trigger: 'manual', status: 'cancelled' }));
  db7.close();
  const afterCtrlC = purr(repoPath, 'findings', '--sha', 'cafe0000f6', '--json');
  assert.equal(afterCtrlC.status, 3);
  assert.equal(JSON.parse(afterCtrlC.stdout).run.id, pp.id);

  // an old run left 'running' (its CLI was killed) doesn't hide a newer one of the commit that failed
  const db4 = openDb();
  db4.putRun(run({ repoId: repo.id, repoPath: repo.path, headSha: 'cafe0000c3', trigger: 'manual', status: 'running' }));
  db4.putRun(run({ repoId: repo.id, repoPath: repo.path, headSha: 'cafe0000c3', status: 'failed', error: 'boom' }));
  // a complete review, then a newer one superseded: the complete one, done (ReviewWatch, as --wait uses it)
  const kept = run({ repoId: repo.id, repoPath: repo.path, headSha: 'cafe0000d4' });
  db4.putRun(kept);
  db4.putRun(run({ repoId: repo.id, repoPath: repo.path, headSha: 'cafe0000d4', status: 'superseded' }));
  const st = await new ReviewWatch(db4, { repoIds: [repo.id], sha: 'cafe0000d4', triggers: ['post-push', 'manual'] }).check();
  assert.deepEqual([st.run?.id, st.done], [kept.id, true]);
  db4.close();
  assert.equal(purr(repoPath, 'findings', '--sha', 'cafe0000c3', '--wait', '--timeout', '5').status, 2, 'the failure, not a wait on the orphan');

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
  const pidFile = join(mkdtempSync(join(process.env.TMPDIR!, 'purr-test-pid-')), 'pid');
  db.putFlow({ id: 'hang', name: 'Hang', description: '', isDefault: false, createdAt: ts, updatedAt: ts, edges: [],
    blocks: [{ id: 'wait', type: 'command', label: 'Wait', position: { x: 0, y: 0 }, config: { command: 'sleep 60', timeoutSec: 120, failOnNonZero: true } }] });
  db.putFlow({ id: 'stubborn', name: 'Stubborn', description: '', isDefault: false, createdAt: ts, updatedAt: ts, edges: [],
    blocks: [{ id: 'wait', type: 'command', label: 'Wait', position: { x: 0, y: 0 }, config: { command: `trap '' TERM; echo $$ > ${pidFile}; sleep 20`, timeoutSec: 120, failOnNonZero: true } }] });
  db.setTrigger({ trigger: 'pre-commit', repoId: repo.id, flowId: 'hang' });
  db.close();
  writeFileSync(join(repoPath, 'b.txt'), 'b\n');
  sh(repoPath, 'add', '-A');
  sh(repoPath, 'commit', '-q', '-m', 'b', '--no-verify');
  const status = (id: string) => { const d = openDb(); try { return d.getRun(id)!; } finally { d.close(); } };

  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    const t0 = Date.now();
    // SIGHUP as a closed terminal sends it: nothing reads its output any more, so writes to it fail
    const out = await midRun(repoPath, ['run', '--flow', 'hang'], (p) => {
      if (sig === 'SIGHUP') { p.stdout!.destroy(); p.stderr!.destroy(); }
      p.kill(sig);
    });
    assert.equal(out.code, 128 + { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[sig], out.stderr);
    assert.ok(Date.now() - t0 < 30_000, 'stopped well before its 60s command');
    assert.equal(status(out.id).status, 'cancelled', `${sig}: not left running`);
  }

  // twice, while the cancel is still going (the command ignores SIGTERM, so it takes 3s to kill): quits at once, the
  // run and its running block recorded cancelled
  let first = 0;
  const twice = await midRun(repoPath, ['run', '--flow', 'stubborn'], (p) => {
    // once its shell has set its trap (it writes its pid after)
    const t = setInterval(() => {
      if (!existsSync(pidFile)) return;
      clearInterval(t);
      first = Date.now(); p.kill('SIGINT'); setTimeout(() => p.kill('SIGINT'), 300);
    }, 20);
  });
  assert.equal(twice.code, 130, twice.stderr);
  assert.ok(Date.now() - first < 2_500, `quit at once, not after the 3s kill (${Date.now() - first}ms)`);
  assert.deepEqual([status(twice.id).status, status(twice.id).error], ['cancelled', 'Stopped before it finished cancelling']);
  const stubborn = Number(readFileSync(pidFile, 'utf8'));
  const alive = () => { try { process.kill(stubborn, 0); return true; } catch { return false; } };
  for (const t = Date.now(); alive() && Date.now() - t < 2_000;) await new Promise((r) => setTimeout(r, 50));
  assert.ok(!alive(), 'its command, ignoring SIGTERM, was killed before it quit');
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

  // the pre-push hook, Ctrl-C'd: its run cancelled, exit 130, and no push reported for refs it never finished checking
  const head = sh(repoPath, 'rev-parse', 'HEAD');
  const db4 = openDb();
  db4.setTrigger({ trigger: 'pre-push', repoId: repo.id, flowId: 'hang' });
  db4.close();
  const newestPush = () => { const d = openDb(); try { return d.findRuns({ repoIds: [repo.id], triggers: ['pre-push'], limit: 1 })[0]?.id ?? ''; } finally { d.close(); } };
  const push = await midRun(repoPath, ['hook', 'pre-push', 'origin', 'url'], (p) => p.kill('SIGINT'),
    { input: `refs/heads/main ${head} refs/heads/main ${'0'.repeat(40)}\n`, idFrom: newestPush });
  assert.equal(push.code, 130, push.stderr);
  assert.doesNotMatch(push.stderr, /will be reviewed once the push lands/);
  assert.equal(status(push.id).status, 'cancelled');
  const db5 = openDb();
  assert.deepEqual(db5.getPushOutcomes(head, [repo.path]), []);
  db5.close();

  // cancelled from outside before its first save (between creating the run and running it): the save doesn't write it
  // back to running; it stops, and ends cancelled
  const db6 = openDb();
  const m6 = new RunManager(db6, new ClaudeRunner(db6));
  const req = { trigger: 'manual' as const, repoPath, mode: 'range' as const, flowId: 'hang' };
  const early = m6.createRun(req)!;
  new RunManager(db6, new ClaudeRunner(db6)).cancel(early.id);   // as the service would, owning nothing
  const t6 = Date.now();
  const ended = await m6.execute(req, early);
  assert.equal(ended.status, 'cancelled');
  assert.equal(db6.getRun(early.id)!.status, 'cancelled');
  assert.ok(Date.now() - t6 < 20_000, 'stopped, not run to the end of its 60s command');
  db6.close();

  // Cancel in the UI while the CLI runs it: the CLI notices and cancels it for real (exit 2), and it stays cancelled
  let cancelledAt = 0;
  const ui = await midRun(repoPath, ['run', '--flow', 'hang'], (_p, id) => {
    cancelledAt = Date.now();
    const d = openDb();
    new RunManager(d, new ClaudeRunner(d)).cancel(id);
    d.close();
  });
  assert.equal(ui.code, 2, ui.stderr);
  assert.ok(Date.now() - cancelledAt < 10_000, 'the CLI noticed and stopped, not ran its 60s command to the end');
  assert.equal(status(ui.id).status, 'cancelled');

  // a run whose process died outright (SIGKILL), left 'running': cancelling it (the UI's Cancel) records it cancelled
  const db2 = openDb();
  const orphan = run({ repoPath, headSha: 'abc0000001', trigger: 'manual', status: 'running' });
  db2.putRun(orphan);
  db2.putBlockRun({ runId: orphan.id, blockId: 'lens', status: 'running', startedAt: null, finishedAt: null, error: null, output: null });
  const mgr = new RunManager(db2, new ClaudeRunner(db2));
  mgr.cancel(orphan.id);
  assert.equal(db2.getRun(orphan.id)!.status, 'cancelled');
  assert.equal(db2.listBlockRuns(orphan.id)[0].status, 'cancelled', 'its blocks too');
  // a newer push supersedes only the reviews its own process runs: a run another process owns is left to it
  const other = run({ repoPath, headSha: 'abc0000002', trigger: 'manual', status: 'running' });
  db2.putRun(other);
  mgr.cancel(other.id, 'superseded');
  assert.equal(db2.getRun(other.id)!.status, 'running');

  // cancelled from outside just before its end (its command does it, then exits 0): recorded cancelled with why,
  // nothing posted, nothing it would have marked fixed
  const script = join(mkdtempSync(join(process.env.TMPDIR!, 'purr-test-script-')), 'cancel.mjs');
  writeFileSync(script, `import { openDb } from ${JSON.stringify(new URL('../src/server/db.ts', import.meta.url).pathname)};
const d = openDb();
const row = d.raw.prepare("SELECT data FROM runs WHERE status = 'running' AND json_extract(data, '$.flowId') = 'cancelme'").get();
const r = JSON.parse(row.data);
d.cancelActiveRun({ ...r, status: 'cancelled', error: 'Cancelled outside the process running it' });
d.close();
`);
  db2.putFlow({ id: 'cancelme', name: 'Cancel me', description: '', isDefault: false, createdAt: ts, updatedAt: ts, edges: [],
    blocks: [{ id: 'c', type: 'command', label: 'C', position: { x: 0, y: 0 }, config: { command: `${JSON.stringify(process.execPath)} --no-warnings ${script}`, timeoutSec: 60, failOnNonZero: true } }] });
  let posted = 0;
  (mgr as any).sideEffects = async () => { posted++; };
  const lateReq = { trigger: 'manual' as const, repoPath, mode: 'range' as const, flowId: 'cancelme' };
  const late = await mgr.execute(lateReq, mgr.createRun(lateReq)!);
  assert.deepEqual([late.status, db2.getRun(late.id)!.status, db2.getRun(late.id)!.error, posted],
    ['cancelled', 'cancelled', 'Cancelled outside the process running it', 0]);

  // the UI's Cancel (POST /api/runs/:id/cancel) on a run another process left running: answered with it cancelled
  const server = startHttp(db2, mgr, new PostPushWatcher(db2, mgr), 0);
  await new Promise((r) => server.once('listening', r));
  try {
    const port = (server.address() as { port: number }).port;
    const left = run({ repoPath, headSha: 'abc0000003', trigger: 'manual', status: 'running' });
    db2.putRun(left);
    db2.putBlockRun({ runId: left.id, blockId: 'lens', status: 'pending', startedAt: null, finishedAt: null, error: null, output: null });
    const res = await fetch(`http://127.0.0.1:${port}/api/runs/${left.id}/cancel`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'cancelled');
    assert.equal(db2.listBlockRuns(left.id)[0].status, 'cancelled');
  } finally { server.closeAllConnections(); server.close(); }
  db2.close();
});

test('commitElsewhere: with a fetch that works and brings nothing, only a commit no clone has is called stray', async () => {
  const db = openDb();
  const remote = 'https://github.com/acme/widget-direct.git';
  const a = tempRepo(), b = tempRepo({ 'b.md': 'b\n' });
  for (const p of [a, b]) sh(p, 'remote', 'add', 'origin', remote);
  const ra = await addRepo(db, a), rb = await addRepo(db, b);
  const unreg = mkdtempSync(join(process.env.TMPDIR!, 'purr-test-unreg-'));
  execFileSync('git', ['clone', '-q', a, unreg]);
  sh(unreg, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'local', '--no-verify');
  db.setPushOutcome({ sha: 'feed000009', kind: 'skipped', reason: 'paused', repoPath: ra.path, branch: 'feat' });
  const fetched: string[] = [];
  const fetch = async (p: string) => { fetched.push(p); return true; };
  const ids = [ra.id, rb.id];
  assert.equal(await commitElsewhere(db, ids, sh(b, 'rev-parse', 'HEAD'), a, fetch), null, 'in a registered clone');
  assert.equal(await commitElsewhere(db, ids, sh(unreg, 'rev-parse', 'HEAD'), unreg, fetch), null, 'in the checkout asked from');
  assert.equal(await commitElsewhere(db, ids, 'feed000009', a, fetch), null, 'noted as pushed');
  assert.deepEqual(await commitElsewhere(db, ids, 'deadbeef00', a, fetch), [], 'nowhere: stray');
  assert.ok(fetched.length > 0, 'it fetched before saying so');
  assert.equal(await commitElsewhere(db, ids, 'deadbeef00', a, null), null, 'without a fetch: can\'t tell');
  // a short prefix another repo's review shares, without a fetch: can't tell either (it may be this repo's, unfetched)
  const other = tempRepo({ 'o.md': 'o\n' });
  const ro = await addRepo(db, other);
  db.putRun(run({ repoId: ro.id, repoPath: ro.path, headSha: `abcdef1${'0'.repeat(33)}` }));
  assert.equal(await commitElsewhere(db, ids, 'abcdef1', a, null), null);
  assert.equal((await commitElsewhere(db, ids, `abcdef1${'0'.repeat(5)}`, a, null))?.length, 1, '12 digits: that repo');
  assert.equal(await commitElsewhere(db, ids, 'deadbeef00', a, async () => false), null, 'a fetch that failed: can\'t tell');
  db.close();
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
  // only in this checkout, a clone PuRR hasn't registered (same remote as a registered one)
  const unreg = mkdtempSync(join(process.env.TMPDIR!, 'purr-test-unreg-'));
  execFileSync('git', ['clone', '-q', a, unreg]);
  sh(unreg, 'remote', 'set-url', 'origin', remote);
  sh(unreg, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'local', '--no-verify');
  notStray(unreg, sh(unreg, 'rev-parse', 'HEAD'));
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
  // the same by a short prefix that another repo's review happens to share: fetched, not pinned on that repo
  const pushed = tempRepo({ 'p.md': 'p\n' });
  sh(pushed, 'remote', 'add', 'origin', bare);
  sh(pushed, 'push', '-q', 'origin', 'main:feat2', '--no-verify');
  const short = sh(pushed, 'rev-parse', 'HEAD').slice(0, 7);
  const dbS = openDb();
  dbS.putRun(run({ repoId: ra.id, repoPath: ra.path, headSha: `${short}${'0'.repeat(33)}` }));
  dbS.close();
  notStray(c, short);

  // offline (the fetch fails): can't tell, so waited for as before
  const offline = tempRepo();
  sh(offline, 'remote', 'add', 'origin', 'http://127.0.0.1:1/nothing.git');
  const db3 = openDb();
  await addRepo(db3, offline);
  db3.close();
  notStray(offline, 'deadbeef00');

  // a short prefix that's ambiguous here: blobs until two share the first 4 hex digits, then that prefix
  const seen = new Map<string, string>();
  let prefix = '';
  for (let i = 0; !prefix; i++) {
    const id = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: c, input: `blob ${i}\n` }).toString().trim().slice(0, 4);
    if (seen.has(id)) prefix = id; else seen.set(id, id);
  }
  notStray(c, prefix);
});
