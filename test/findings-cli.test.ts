import { tempRepo } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { openDb } from '../src/server/db.ts';
import { addRepo, startHttp } from '../src/server/http.ts';
import { RunManager } from '../src/server/manager.ts';
import { ClaudeRunner } from '../src/server/claude.ts';
import { PostPushWatcher } from '../src/server/triggers.ts';
import type { Finding, Run } from '../src/shared/types.ts';

const CLI = new URL('../src/server/cli.ts', import.meta.url).pathname;
const purr = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: process.env });
/** For --wait: doesn't block this process, so the service running in it can answer the command meanwhile. */
const purrA = (cwd: string, ...args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((res) => {
  const p = spawn(process.execPath, [CLI, ...args], { cwd, env: process.env });
  let stdout = '', stderr = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });
  p.on('close', (status) => res({ status, stdout, stderr }));
});

let n = 0;
const run = (over: Partial<Run>): Run => ({
  id: `run-c${++n}`, flowId: 'full', flowName: 'Full review', flow: { blocks: [], edges: [] } as any, trigger: 'post-push',
  repoId: null, repoPath: '/x', branch: 'feat', baseSha: null, headSha: null, mode: 'range', workdir: null, pr: null,
  status: 'passed', queuedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(), startedAt: null, finishedAt: null,
  counts: { must_fix: 0, consider: 0, minor: 0 }, error: null, ...over,
});
const mustFix = (fp: string): Finding => ({
  id: fp, file: 'a.ts', line: 1, category: 'logic', severity: 'must_fix', title: `bug ${fp}`, scenario: 's', fingerprint: fp,
  source: { blockId: 'lens', kind: 'model' }, ledger: 'new',
});

/** A PuRR service in this process on a free port, which the CLI finds through the settings, as it does the real one. */
async function service(home?: string) {
  const sdb = openDb(home ? join(home, 'purr.db') : undefined);
  const mgr = new RunManager(sdb, new ClaudeRunner(sdb));
  const server = startHttp(sdb, mgr, new PostPushWatcher(sdb, mgr), 0);
  await new Promise((r) => server.once('listening', r));
  sdb.setSettings({ ...sdb.getSettings(), port: (server.address() as { port: number }).port });
  return {
    /** as the service does when a run changes */
    announce: (run: Run) => mgr.emit({ type: 'run', run }),
    stop: () => { server.closeAllConnections(); server.close(); sdb.close(); },
  };
}

test('purr findings: exit codes, usage errors, --json and purr runs', async (tc) => {
  const svc = await service();
  tc.after(svc.stop);
  const db = openDb();
  const repoPath = tempRepo();
  const repo = await addRepo(db, repoPath);
  const seed = (sha: string, over: Partial<Run>, findings: Finding[] = []) => {
    const r = run({ repoId: repo.id, repoPath, headSha: sha, ...over });
    db.putRun(r);
    db.setRunFindings(r.id, findings);
    return r;
  };
  seed('aaaa000001', {}, [mustFix('m1')]);
  seed('aaaa000002', { status: 'failed', error: 'boom' });
  seed('aaaa000003', { status: 'superseded' });
  seed('aaaa000004', { status: 'running' });
  seed('aaaa000007', { status: 'cancelled' });
  seed('aaaa000005', {}, [mustFix('m5')]);
  db.putLedger({ fingerprint: 'm5', repoId: repo.id, branch: 'feat', state: 'dismissed', flowId: 'full', finding: mustFix('m5'),
    firstRunId: 'x', lastRunId: 'x', updatedAt: 'x' });
  db.setPushOutcome({ sha: 'aaaa000006', kind: 'skipped', reason: 'reviews are paused', repoPath: repo.path, branch: 'feat' });
  db.close();

  const code = (...a: string[]) => purr(repoPath, 'findings', ...a).status;
  assert.equal(code('--sha', 'aaaa000001'), 1, 'must-fix');
  assert.equal(code('--sha', 'aaaa000002'), 2, 'failed');
  assert.equal(code('--sha', 'aaaa000003'), 2, 'superseded');
  assert.equal(code('--sha', 'aaaa000004'), 3, 'still running, not waiting');
  assert.equal(code('--sha', 'aaaa000007'), 2, 'cancelled');
  assert.equal(code('--sha', 'aaaa000005'), 0, 'its must-fix was dismissed since');
  assert.equal(code('--sha', 'bbbb'), 3, 'no such review');
  assert.equal(code('--run', 'run-nope'), 3);
  const typo = await purrA(repoPath, 'findings', '--run', 'run-typo', '--wait');
  assert.deepEqual([typo.status, /no review of run run-typo found/.test(typo.stderr)], [3, true], 'a run that will never appear: no wait');
  const skipped = await purrA(repoPath, 'findings', '--sha', 'aaaa000006', '--wait', '--timeout', '30');
  assert.equal(skipped.status, 3);
  assert.match(skipped.stderr, /won't be reviewed: reviews are paused/);

  assert.equal(code('--sha', 'zz'), 4, 'not hex');
  assert.equal(code('--sha', '--wait'), 4, 'flag without a value');
  assert.equal(code('--wait', '--timeout', '10m'), 4, 'timeout in seconds only');
  assert.equal(code('--pr', '0'), 4);
  assert.equal(code('--wait', '--timeout', '9'.repeat(30)), 4, 'too big to be a number of seconds');
  assert.equal(purr(tempRepo(), 'findings').status, 3, 'a repo PuRR has never seen');

  const j = purr(repoPath, 'findings', '--sha', 'aaaa000001', '--json');
  const out = JSON.parse(j.stdout);
  assert.deepEqual(Object.keys(out).sort(), ['findings', 'resolved', 'run', 'sessions']);
  assert.equal(out.findings[0].title, 'bug m1');

  // detached HEAD: the review of the commit checked out, not any branch's latest
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();
  execFileSync('git', ['checkout', '-q', '--detach'], { cwd: repoPath });
  assert.equal(code(), 3, 'no review of this commit');
  const db2 = openDb();
  db2.putRun(run({ repoId: repo.id, repoPath, headSha: head, branch: 'other' }));
  db2.close();
  assert.equal(code(), 0, 'found by commit');

  // --wait with --branch or --run: waits for the running review, then reports it
  execFileSync('git', ['checkout', '-q', '-'], { cwd: repoPath });
  const db3 = openDb();
  // the child must be seen waiting before the run finishes, or this wouldn't test waiting at all
  const waitFor = (args: string[], id: string) => new Promise<{ status: number | null; stdout: string; sawRunning: boolean; after: number }>((res) => {
    const p = spawn(process.execPath, [CLI, 'findings', ...args, '--wait', '--json', '--timeout', '30'], { cwd: repoPath });
    let stdout = '', sawRunning = false, announced = 0;
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => {
      if (!sawRunning && String(d).includes(`review ${id} is running`)) {
        sawRunning = true;
        announced = Date.now();
        const db = openDb();
        db.putRun({ ...db.getRun(id)!, status: 'passed' });
        svc.announce(db.getRun(id)!);
        db.close();
      }
    });
    p.on('close', (status) => res({ status, stdout, sawRunning, after: Date.now() - announced }));
  });
  // --branch --wait before the branch's first review is queued: waits for it to appear
  const later = await new Promise<{ status: number | null; sawWaiting: boolean }>((res) => {
    const p = spawn(process.execPath, [CLI, 'findings', '--branch', 'later', '--wait', '--json', '--timeout', '30'], { cwd: repoPath });
    let sawWaiting = false;
    p.stderr.on('data', (d) => {
      if (!sawWaiting && String(d).includes('no review of branch later yet')) {
        sawWaiting = true;
        const db = openDb();
        const r = run({ repoId: repo.id, repoPath, headSha: 'cccc000009', branch: 'later' });
        db.putRun(r);
        svc.announce(r);
        db.close();
      }
    });
    p.on('close', (status) => res({ status, sawWaiting }));
  });
  assert.ok(later.sawWaiting);
  assert.equal(later.status, 0);

  for (const [args, branch] of [[['--branch', 'live'], 'live'], [['--run', 'RUN'], 'byid']] as const) {
    const live = run({ repoId: repo.id, repoPath, headSha: 'cccc000001', branch, status: 'running' });
    db3.putRun(live);
    db3.setRunFindings(live.id, []);
    const w = await waitFor(args.map((a) => a === 'RUN' ? live.id : a), live.id);
    assert.ok(w.sawRunning, `${args[0]}: waited while it ran`);
    assert.ok(w.after < 5_000, `${args[0]}: woken by the service's event, not a 30s slow look (${w.after}ms)`);
    assert.equal(w.status, 0);
    assert.equal(JSON.parse(w.stdout).run.status, 'passed', 'reported once finished');
  }
  db3.close();

  // the text report: dismissed hidden unless --all, fixed-since marked, resolved listed
  const t = openDb();
  const older = run({ repoId: repo.id, repoPath, headSha: 'dddd000001', branch: 'txt' });
  t.putRun(older);
  t.setRunFindings(older.id, [mustFix('t1'), mustFix('t2'), mustFix('t3')]);
  const newer = run({ repoId: repo.id, repoPath, headSha: 'dddd000002', branch: 'txt' });
  t.putRun(newer);
  t.setRunFindings(newer.id, []);
  const ledger = (fp: string, state: 'dismissed' | 'fixed', last: string) => t.putLedger({ fingerprint: fp, repoId: repo.id, branch: 'txt', state,
    flowId: 'full', finding: mustFix(fp), firstRunId: older.id, lastRunId: last, updatedAt: 'x' });
  ledger('t1', 'dismissed', older.id);
  ledger('t2', 'fixed', newer.id);
  t.close();
  const text = purr(repoPath, 'findings', '--sha', 'dddd000001').stderr;
  assert.doesNotMatch(text, /bug t1/, 'dismissed: hidden');
  assert.match(text, /bug t2.*\[fixed since\]/);
  assert.match(text, /bug t3/);
  assert.match(purr(repoPath, 'findings', '--sha', 'dddd000001', '--all').stderr, /bug t1.*\[dismissed\]/);
  assert.equal(purr(repoPath, 'findings', '--sha', 'dddd000001').status, 1, 't3 is still a must-fix');
  const t2 = openDb();
  const onlyFixed = run({ repoId: repo.id, repoPath, headSha: 'dddd000003', branch: 'txt', queuedAt: '2025-12-31T00:00:00.000Z' });   // before the review that fixed t2
  t2.putRun(onlyFixed);
  t2.setRunFindings(onlyFixed.id, [mustFix('t2')]);
  t2.close();
  assert.equal(purr(repoPath, 'findings', '--sha', 'dddd000003').status, 0, 'its only must-fix was fixed since');

  // --trigger: full reviews by default, hook runs on request
  const t3 = openDb();
  t3.putRun(run({ id: 'run-hook1', repoId: repo.id, repoPath, headSha: 'dddd000004', branch: 'hooked', trigger: 'pre-push' }));
  t3.close();
  const listed = (...a: string[]) => purr(repoPath, 'runs', '--branch', 'hooked', ...a).stdout;
  assert.doesNotMatch(listed(), /run-hook1/);
  assert.match(listed('--trigger', 'pre-push'), /run-hook1/);
  assert.match(listed('--trigger', 'all'), /run-hook1/);
  assert.equal(purr(repoPath, 'runs', '--trigger', 'bogus').status, 4);
  assert.match(purr(repoPath, 'findings', '--sha', 'dddd000002').stderr, /Resolved by this review[\s\S]*fixed\s+a\.ts:1\s+bug t2/);

  // pushed as another name (git push -u origin foo:renamed): found under the name it was reviewed as
  const bare = mkdtempSync(join(process.env.TMPDIR!, 'purr-test-remote-'));
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repoPath });
  execFileSync('git', ['checkout', '-q', '-b', 'foo'], { cwd: repoPath });
  execFileSync('git', ['push', '-q', '-u', 'origin', 'foo:renamed', '--no-verify'], { cwd: repoPath });
  const db4 = openDb();
  db4.putRun(run({ repoId: repo.id, repoPath, headSha: 'eeee000001', branch: 'renamed' }));
  db4.close();
  const renamed = purr(repoPath, 'findings', '--json');
  assert.equal(renamed.status, 0, renamed.stderr);
  assert.equal(JSON.parse(renamed.stdout).run.branch, 'renamed');

  // a branch made from the remote's (tracking it under another name) with reviews of its own: its own name wins
  execFileSync('git', ['checkout', '-q', '-b', 'feat2', '--track', 'origin/renamed'], { cwd: repoPath });
  const db5 = openDb();
  db5.putRun(run({ repoId: repo.id, repoPath, headSha: 'eeee000002', branch: 'feat2' }));
  db5.close();
  assert.equal(JSON.parse(purr(repoPath, 'findings', '--json').stdout).run.branch, 'feat2');

  // a branch made from origin/main tracks main: main's review isn't its review
  execFileSync('git', ['push', '-q', 'origin', 'main', '--no-verify'], { cwd: repoPath });
  execFileSync('git', ['checkout', '-q', '-b', 'feat3', '--track', 'origin/main'], { cwd: repoPath });
  const db6 = openDb();
  db6.putRun(run({ repoId: repo.id, repoPath, headSha: 'eeee000003', branch: 'main' }));
  db6.close();
  assert.equal(purr(repoPath, 'findings').status, 3, "no review of feat3 yet, and main's doesn't count");

  // nothing committed yet: --wait has no commit to wait for
  const empty = mkdtempSync(join(process.env.TMPDIR!, 'purr-empty-'));
  execFileSync('git', ['init', '-q', '-b', 'main', empty]);
  const db7 = openDb();
  await addRepo(db7, empty);
  db7.close();
  assert.equal(purr(empty, 'findings', '--wait').status, 4);

  // --wait gives up at its timeout: on a review that never appeared, and on one still running
  const never = await purrA(repoPath, 'findings', '--sha', 'abab00ff', '--wait', '--timeout', '1');
  assert.equal(never.status, 3);
  assert.match(never.stderr, /no review of commit abab00ff appeared within 1s/);
  const db8 = openDb();
  db8.putRun(run({ repoId: repo.id, repoPath, headSha: 'abab00fe', branch: 'slow', status: 'running' }));
  db8.close();
  const stuck = await purrA(repoPath, 'findings', '--sha', 'abab00fe', '--wait', '--timeout', '1');
  assert.equal(stuck.status, 3);
  assert.match(stuck.stderr, /is still running after 1s/);

  // --pr: that PR's review, waited for or not
  const db9 = openDb();
  db9.putRun(run({ repoId: repo.id, repoPath, headSha: 'abab0012', branch: 'prb', pr: { number: 12, title: 't', body: '', url: 'u' } }, ), );
  db9.setRunFindings(db9.findRuns({ repoIds: [repo.id], pr: 12, limit: 1 })[0].id, [mustFix('p12')]);
  db9.close();
  assert.equal(purr(repoPath, 'findings', '--pr', '12').status, 1);
  assert.equal((await purrA(repoPath, 'findings', '--pr', '12', '--wait', '--timeout', '5')).status, 1);
  assert.equal(purr(repoPath, 'findings', '--pr', '13').status, 3, 'no review of PR 13');

  // a branch that tracks a local branch (feat/x): not looked up under 'x'
  execFileSync('git', ['checkout', '-q', '-b', 'feat/x'], { cwd: repoPath });
  execFileSync('git', ['checkout', '-q', '-b', 'tracks-local', '--track', 'feat/x'], { cwd: repoPath });
  const db10 = openDb();
  db10.putRun(run({ repoId: repo.id, repoPath, headSha: 'abab0099', branch: 'x' }));
  db10.close();
  assert.equal(purr(repoPath, 'findings').status, 3, "no review of tracks-local; a branch named x's isn't its");

  // the reviewer sessions to resume: the last one of the block behind a model finding, with the run's workdir
  const dbS = openDb();
  const reviewed = run({ repoId: repo.id, repoPath, headSha: 'abab0077', branch: 'sess', workdir: mkdtempSync(join(process.env.TMPDIR!, 'purr-workdir-')) });
  dbS.putRun(reviewed);
  dbS.setRunFindings(reviewed.id, [{ ...mustFix('s1f'), source: { blockId: 'lens-x', kind: 'model' } }]);
  dbS.putBlockRun({ runId: reviewed.id, blockId: 'lens-x', status: 'done', startedAt: null, finishedAt: null, error: null,
    output: { sessions: [{ sessionId: 'old-session' }, { sessionId: 'last-session' }] as any } });
  dbS.close();
  assert.equal(JSON.parse(purr(repoPath, 'findings', '--sha', 'abab0077', '--json').stdout).sessions['lens-x'], 'last-session');
  const hint = purr(repoPath, 'findings', '--sha', 'abab0077').stderr;
  assert.match(hint, /claude --resume <session>/);
  assert.match(hint, /lens-x: last-session/);

  const runs = purr(repoPath, 'runs', '--branch', 'feat');
  assert.equal(runs.status, 0);
  assert.equal(runs.stdout.trim().split('\n').length, 6, runs.stdout);
  assert.equal(purr(repoPath, 'runs', '--limit', 'x').status, 4);
});

test('a second purr daemon, started by mistake, leaves the live one\'s runs and pending pushes alone', async () => {
  const db = openDb();
  const repoPath = tempRepo();
  const repo = await addRepo(db, repoPath);
  const live = run({ repoId: repo.id, repoPath, headSha: 'ffff000001', status: 'running' });
  db.putRun(live);
  db.setPushOutcome({ sha: 'ffff000002', kind: 'pending', reason: 'waiting', repoPath: repo.path, branch: 'feat' });
  db.close();
  const busy = createServer();
  await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()));
  const port = (busy.address() as { port: number }).port;
  try {
    const second = spawnSync(process.execPath, [CLI, 'daemon', '--port', String(port)], {
      encoding: 'utf8', env: { ...process.env, PURR_NO_GLOBAL_HOOKS: '1' }, timeout: 20_000,
    });
    assert.equal(second.status, 1, second.stderr);
    assert.match(second.stderr, /in use/);
  } finally { busy.close(); }
  const after = openDb();
  assert.equal(after.getRun(live.id)!.status, 'running', 'not failed as an orphan');
  assert.equal(after.getPushOutcomes('ffff000002', [repo.path])[0]?.kind, 'pending', 'not given up on');
  after.close();
});

test('the daemon that gets the port fails runs and gives up on pushes the last one left behind', async () => {
  const home = mkdtempSync(join(process.env.TMPDIR!, 'purr-test-home-'));
  const db = openDb(join(home, 'purr.db'));
  // a daemon in a test must not review anything: no project folders, reviews paused
  db.setSettings({ ...db.getSettings(), projectFolders: [], reviewsPaused: true });
  const repoPath = tempRepo();
  const repo = await addRepo(db, repoPath);
  const left = run({ repoId: repo.id, repoPath, headSha: 'abcd000001', status: 'running' });
  db.putRun(left);
  db.setPushOutcome({ sha: 'abcd000002', kind: 'pending', reason: 'waiting', repoPath: repo.path, branch: 'feat' });
  db.close();
  // a free port, and if something takes it before the daemon does, another
  const start = async (): Promise<ReturnType<typeof spawn>> => {
    const free = createServer();
    await new Promise<void>((r) => free.listen(0, '127.0.0.1', () => r()));
    const port = (free.address() as { port: number }).port;
    await new Promise<void>((r) => free.close(() => r()));
    const d = spawn(process.execPath, [CLI, 'daemon', '--port', String(port)], { env: { ...process.env, PURR_HOME: home, PURR_NO_GLOBAL_HOOKS: '1' } });
    let err = '';
    d.stderr!.on('data', (b) => { err += b; });
    const ok = await new Promise<boolean>((res, rej) => {
      const t = setTimeout(() => rej(new Error(`daemon never listened: ${err}`)), 20_000);
      d.stdout!.on('data', (b) => { if (String(b).includes('listening')) { clearTimeout(t); res(true); } });
      d.on('exit', () => { clearTimeout(t); if (/in use/.test(err)) res(false); else rej(new Error(`daemon exited: ${err}`)); });
    });
    return ok ? d : start();
  };
  const d = await start();
  try {
    const after = openDb(join(home, 'purr.db'));
    assert.equal(after.getRun(left.id)!.status, 'failed');
    assert.equal(after.getPushOutcomes('abcd000002', [repo.path])[0]?.kind, 'skipped');
    after.close();
  } finally { d.kill(); }
});

test("PuRR failing (its database won't open) exits 5, not 2 (a failed review)", async () => {
  const home = mkdtempSync(join(process.env.TMPDIR!, 'purr-test-home-'));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(home, 'purr.db'), 'this is not a database'.repeat(100));
  const r = spawnSync(process.execPath, [CLI, 'findings', '--sha', 'abcd'], { cwd: tempRepo(), encoding: 'utf8', env: { ...process.env, PURR_HOME: home } });
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /couldn't read the reviews/);
});

test("--wait doesn't wait on a PuRR service that isn't running, or that stops while it waits", async () => {
  const home = mkdtempSync(join(process.env.TMPDIR!, 'purr-test-home-'));
  const db = openDb(join(home, 'purr.db'));
  const repoPath = tempRepo();
  const repo = await addRepo(db, repoPath);
  db.putRun(run({ repoId: repo.id, repoPath, headSha: 'beef0001', status: 'running' }));
  const closed = createServer();
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
  const port = (closed.address() as { port: number }).port;
  await new Promise<void>((r) => closed.close(() => r()));
  db.setSettings({ ...db.getSettings(), port });   // nothing listens there
  db.close();
  const env = { ...process.env, PURR_HOME: home };
  const t0 = Date.now();
  const down = spawnSync(process.execPath, [CLI, 'findings', '--sha', 'beef0001', '--wait'], { cwd: repoPath, encoding: 'utf8', env });
  assert.equal(down.status, 3);
  assert.match(down.stderr, /service isn't running, so no review will come/);
  assert.ok(Date.now() - t0 < 15_000, 'at once, not after the 30-minute timeout');

  // --run on a running review, the service down: the same, at once
  const byRun = spawnSync(process.execPath, [CLI, 'findings', '--run', openDb(join(home, 'purr.db')).findRuns({ sha: 'beef0001', limit: 1 })[0].id, '--wait'],
    { cwd: repoPath, encoding: 'utf8', env });
  assert.equal(byRun.status, 3);
  assert.match(byRun.stderr, /service isn't running/);

  const svc = await service(home);
  const stopped = await new Promise<{ status: number | null; stderr: string }>((res) => {
    const p = spawn(process.execPath, [CLI, 'findings', '--sha', 'beef0001', '--wait'], { cwd: repoPath, env });
    let stderr = '', once = false;
    p.stderr.on('data', (d) => { stderr += d; if (!once && /is running/.test(stderr)) { once = true; svc.stop(); } });
    p.on('close', (status) => res({ status, stderr }));
  });
  assert.equal(stopped.status, 3);
  assert.match(stopped.stderr, /service stopped, so no review will come/);
});
