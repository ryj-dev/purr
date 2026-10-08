import { tempRepo } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { openDb } from '../src/server/db.ts';
import { addRepo } from '../src/server/http.ts';
import type { Finding, Run } from '../src/shared/types.ts';

const CLI = new URL('../src/server/cli.ts', import.meta.url).pathname;
const purr = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: process.env });

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

test('purr findings: exit codes, usage errors, --json and purr runs', async () => {
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
  assert.equal(code('--sha', 'aaaa000005'), 0, 'its must-fix was dismissed since');
  assert.equal(code('--sha', 'bbbb'), 3, 'no such review');
  assert.equal(code('--run', 'run-nope'), 3);
  const skipped = purr(repoPath, 'findings', '--sha', 'aaaa000006', '--wait', '--timeout', '30');
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
  const waitFor = (args: string[], id: string) => new Promise<{ status: number | null; stdout: string; sawRunning: boolean }>((res) => {
    const p = spawn(process.execPath, [CLI, 'findings', ...args, '--wait', '--json', '--timeout', '30'], { cwd: repoPath });
    let stdout = '', sawRunning = false;
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => {
      if (!sawRunning && String(d).includes(`review ${id} is running`)) {
        sawRunning = true;
        const db = openDb();
        db.putRun({ ...db.getRun(id)!, status: 'passed' });
        db.close();
      }
    });
    p.on('close', (status) => res({ status, stdout, sawRunning }));
  });
  // --branch --wait before the branch's first review is queued: waits for it to appear
  const later = await new Promise<{ status: number | null; sawWaiting: boolean }>((res) => {
    const p = spawn(process.execPath, [CLI, 'findings', '--branch', 'later', '--wait', '--json', '--timeout', '30'], { cwd: repoPath });
    let sawWaiting = false;
    p.stderr.on('data', (d) => {
      if (!sawWaiting && String(d).includes('no review of branch later yet')) {
        sawWaiting = true;
        const db = openDb();
        db.putRun(run({ repoId: repo.id, repoPath, headSha: 'cccc000009', branch: 'later' }));
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
  const never = purr(repoPath, 'findings', '--sha', 'abab00ff', '--wait', '--timeout', '1');
  assert.equal(never.status, 3);
  assert.match(never.stderr, /no review of commit abab00ff appeared within 1s/);
  const db8 = openDb();
  db8.putRun(run({ repoId: repo.id, repoPath, headSha: 'abab00fe', branch: 'slow', status: 'running' }));
  db8.close();
  const stuck = purr(repoPath, 'findings', '--sha', 'abab00fe', '--wait', '--timeout', '1');
  assert.equal(stuck.status, 3);
  assert.match(stuck.stderr, /is still running after 1s/);

  const runs = purr(repoPath, 'runs', '--branch', 'feat');
  assert.equal(runs.status, 0);
  assert.equal(runs.stdout.trim().split('\n').length, 5, runs.stdout);
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
