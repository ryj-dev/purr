import { sh, tempRepo } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/server/db.ts';
import { addRepo } from '../src/server/http.ts';
import { ReviewWatch, currentFindings, isActive, resolvedBy, sameRepoIds, waitForReview } from '../src/server/lookup.ts';
import { applyLedger } from '../src/server/ledger.ts';
import type { Finding, Run } from '../src/shared/types.ts';

const one = (db: ReturnType<typeof openDb>, sha: string, paths: string[]) => db.getPushOutcomes(sha, paths)[0] ?? null;

let n = 0;
function fakeRun(over: Partial<Run>): Run {
  n++;
  return {
    id: `run-t${n}`, flowId: 'f', flowName: 'Full review', flow: { blocks: [], edges: [] } as any, trigger: 'post-push',
    repoId: null, repoPath: '/x', branch: 'main', baseSha: null, headSha: 'aaaa', mode: 'range', workdir: null, pr: null,
    status: 'passed', queuedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(), startedAt: null, finishedAt: null,
    counts: { must_fix: 0, consider: 0, minor: 0 }, error: null, ...over,
  };
}
const finding = (fp: string, over: Partial<Finding> = {}): Finding => ({
  id: fp, file: 'a.ts', line: 1, category: 'logic', severity: 'must_fix', title: fp, scenario: 's', fingerprint: fp,
  source: { blockId: 'b', kind: 'model' }, ledger: 'new', ...over,
});

test('findRuns filters by repo, branch, PR, sha prefix and trigger, newest first', () => {
  const db = openDb(join(mkdtempSync(join(process.env.TMPDIR!, 'purr-db-')), 'purr.db'));
  const pr = { number: 7, title: 't', body: '', url: 'u' };
  db.putRun(fakeRun({ id: 'old', repoId: 'r1', branch: 'feat', pr, headSha: 'abc111' }));
  db.putRun(fakeRun({ id: 'new', repoId: 'r1', branch: 'feat', pr, headSha: 'abc222' }));
  db.putRun(fakeRun({ id: 'hook', repoId: 'r1', branch: 'feat', trigger: 'pre-push', headSha: 'abc333' }));
  db.putRun(fakeRun({ id: 'other', repoId: 'r2', branch: 'feat', headSha: 'abc444' }));
  const ids = (q: Parameters<typeof db.findRuns>[0]) => db.findRuns(q).map((r) => r.id);
  assert.deepEqual(ids({ repoIds: ['r1'], branch: 'feat', triggers: ['post-push', 'manual'] }), ['new', 'old']);
  assert.deepEqual(ids({ repoIds: ['r1'], pr: 7 }), ['new', 'old']);
  assert.deepEqual(ids({ repoIds: ['r1', 'r2'], sha: 'abc1' }), ['old']);
  assert.deepEqual(ids({ repoIds: ['r1'], triggers: ['pre-push'] }), ['hook']);
  assert.deepEqual(ids({ repoIds: [] }), [], 'no known repo matches nothing');
  assert.deepEqual(ids({ sha: "a%' OR 1=1 --" }), [], 'sha is a hex prefix, nothing else');
  assert.deepEqual(ids({ sha: '--zz' }), [], 'no hex at all matches nothing, not everything');
  db.close();
});

test('sameRepoIds covers every clone of one GitHub repo, and only that repo', async () => {
  const db = openDb(join(mkdtempSync(join(process.env.TMPDIR!, 'purr-db-')), 'purr.db'));
  const a = tempRepo(), b = tempRepo(), c = tempRepo();
  sh(a, 'remote', 'add', 'origin', 'git@github.com:Acme/app.git');
  sh(b, 'remote', 'add', 'origin', 'https://github.com/acme/app');
  sh(c, 'remote', 'add', 'origin', 'https://github.com/acme/other.git');
  const wt = join(realpathSync(mkdtempSync(join(process.env.TMPDIR!, 'purr-wt-'))), 'wt');
  sh(a, 'worktree', 'add', '-q', wt, '-b', 'wt');
  const [ra, rb] = [await addRepo(db, a), await addRepo(db, b)];
  await addRepo(db, c);
  assert.deepEqual((await sameRepoIds(db, a)).sort(), [ra.id, rb.id].sort());
  assert.deepEqual((await sameRepoIds(db, wt)).sort(), [ra.id, rb.id].sort(), 'an unregistered worktree finds its clones');
  const local = tempRepo();
  assert.deepEqual(await sameRepoIds(db, local), [], 'unknown repo, no remote');
  db.close();
});

test('currentFindings shows a dismissal made after the run, and a reopen', () => {
  const db = openDb(join(mkdtempSync(join(process.env.TMPDIR!, 'purr-db-')), 'purr.db'));
  const run = fakeRun({ repoId: 'r1' });
  db.putRun(run);
  db.setRunFindings(run.id, [finding('fp1'), finding('fp2', { ledger: 'dismissed' }), finding('fp3')]);
  const ledger = (fp: string, state: 'open' | 'dismissed') => db.putLedger({
    fingerprint: fp, repoId: 'r1', branch: 'main', state, flowId: null, finding: finding(fp), firstRunId: run.id, lastRunId: run.id, updatedAt: 'x',
  });
  ledger('fp1', 'dismissed');
  ledger('fp2', 'open');
  assert.deepEqual(currentFindings(db, run).map((f) => f.ledger), ['dismissed', 'open', 'new']);
  db.close();
});

test('waitForReview waits for the watch to finish, gives up at the timeout, and refuses a bad timeout', async () => {
  let calls = 0;
  const seen: (string | null)[] = [];
  const watch = (f: () => Run | null) => ({ check: async () => { const run = f(); return { run, done: !!run && run.status === 'passed' }; } });
  const st = await waitForReview(watch(() => {
    calls++;
    return calls < 2 ? null : fakeRun({ id: 'w', status: calls < 4 ? 'running' : 'passed' });
  }), { timeoutMs: 5000, intervalMs: 5, onChange: (r) => seen.push(r?.status ?? null) });
  assert.equal(st.run?.status, 'passed');
  assert.deepEqual(seen, ['running', 'passed']);
  assert.equal((await waitForReview(watch(() => null), { timeoutMs: 30, intervalMs: 5 })).run, null);
  assert.equal((await waitForReview(watch(() => fakeRun({ status: 'queued' })), { timeoutMs: 30, intervalMs: 5 })).run?.status, 'queued');
  await assert.rejects(waitForReview(watch(() => null), { timeoutMs: NaN }), /Bad timeout/);
});

test('ReviewWatch follows a newer push that took a commit\'s place, and stops when no review will come', async () => {
  const db = openDb(join(mkdtempSync(join(process.env.TMPDIR!, 'purr-db-')), 'purr.db'));
  const repo = await addRepo(db, tempRepo());
  const repoPath = repo.path;
  const q = { repoIds: [repo.id], triggers: ['post-push' as const, 'manual' as const] };
  const outcome = (sha: string, kind: 'pending' | 'no-pr' | 'superseded' | 'skipped', nextSha: string | null = null, path = repoPath) =>
    db.setPushOutcome({ sha, kind, reason: kind, repoPath: path, branch: 'feat', nextSha });
  const at = (over: Partial<Run>) => fakeRun({ repoId: repo.id, branch: 'feat', ...over });

  // a re-push in the debounce: no run for A ever, B's review covers it
  outcome('aaaa01', 'superseded', 'bbbb01');
  const w1 = new ReviewWatch(db, { ...q, sha: 'aaaa01' });
  assert.deepEqual(await w1.check(), { run: null, done: false }, 'waits for B\'s review to exist');
  db.putRun(at({ id: 'rb', headSha: 'bbbb01', status: 'passed' }));
  const st1 = await w1.check();
  assert.equal(st1.run?.id, 'rb');
  assert.equal(st1.done, true);
  assert.match(w1.notes[0], /following the review of bbbb01/);

  // a running review superseded by a newer push's review
  db.putRun(at({ id: 'rc', headSha: 'cccc01', status: 'superseded' }));
  const w2 = new ReviewWatch(db, { ...q, sha: 'cccc01' });
  assert.equal((await w2.check()).done, false, 'no newer review yet');
  db.putRun(at({ id: 'rd', headSha: 'dddd01', status: 'running' }));
  assert.equal((await w2.check()).run?.id, 'rd');

  // pending keeps waiting; skipped stops, unless it was another repo's commit with the same prefix
  outcome('eeee01', 'pending');
  assert.deepEqual(await new ReviewWatch(db, { ...q, sha: 'eeee01' }).check(), { run: null, done: false });
  outcome('eeee01', 'skipped');
  assert.match((await new ReviewWatch(db, { ...q, sha: 'eeee' }).check()).stop ?? '', /won't be reviewed: skipped/);
  outcome('9999aa', 'skipped', null, '/some/other/repo');
  assert.deepEqual(await new ReviewWatch(db, { ...q, sha: '9999' }).check(), { run: null, done: false }, 'not this repo\'s push');

  // for want of a PR: stop, unless one is open now; a draft is never reviewed
  outcome('ffff01', 'no-pr');
  assert.equal((await new ReviewWatch(db, { ...q, sha: 'ffff01' }, async () => null).check()).done, true);
  const prNow = await new ReviewWatch(db, { ...q, sha: 'ffff01' }, async () => ({ number: 9, isDraft: false }) as any).check();
  assert.deepEqual(prNow, { run: null, done: false }, 'a PR opened since: the poller reviews it, keep waiting');
  const draft = await new ReviewWatch(db, { ...q, sha: 'ffff01' }, async () => ({ number: 9, isDraft: true }) as any).check();
  assert.match(draft.stop ?? '', /draft/);

  // one commit, two branches: still waiting while one push is pending, whatever became of the other
  outcome('acac01', 'no-pr');
  db.setPushOutcome({ sha: 'acac01', kind: 'pending', reason: 'pending', repoPath, branch: 'other' });
  assert.deepEqual(await new ReviewWatch(db, { ...q, sha: 'acac01' }, async () => null).check(), { run: null, done: false });

  // pushed S then T with no PR; the PR then opened is reviewed at T, which covers S
  outcome('bcbc01', 'no-pr');
  const ws = new ReviewWatch(db, { ...q, sha: 'bcbc01' }, async () => ({ number: 9, isDraft: false, headRefOid: 'bcbc02' }) as any);
  assert.deepEqual(await ws.check(), { run: null, done: false });
  assert.match(ws.notes[0], /PR is at a later push now; following the review of bcbc02/);
  db.putRun(at({ id: 'rt', headSha: 'bcbc02', status: 'passed' }));
  assert.equal((await ws.check()).run?.id, 'rt');

  // a restart loses what was pending
  outcome('abab01', 'pending');
  db.expirePendingPushes();
  assert.equal(one(db, 'abab01', [repoPath])?.kind, 'skipped');
  db.close();
});

test('a fix on another branch, or by an earlier run, doesn\'t mark a run\'s finding fixed', () => {
  const db = openDb(join(mkdtempSync(join(process.env.TMPDIR!, 'purr-db-')), 'purr.db'));
  const review = (id: string, branch: string, raised: Finding[]) => {
    const run = fakeRun({ id, repoId: 'r1', branch, flowId: 'full' });
    db.putRun(run);
    applyLedger(db, run, raised, new Set(['b']));
    db.setRunFindings(run.id, raised);
    return run;
  };
  review('b1', 'stack-b', [finding('shared')]);
  const a = review('a1', 'stack-a', [finding('shared')]);   // the ledger row now belongs to stack-a
  review('a2', 'stack-a', []);                               // stack-a fixed it
  assert.equal(currentFindings(db, a)[0].ledger, 'fixed');
  const b = db.getRun('b1')!;
  assert.notEqual(currentFindings(db, b)[0].ledger, 'fixed', 'stack-b still has it');
  db.close();
});

test('a finding the next full review no longer raises is resolved by that review, and shows as fixed on the old run', () => {
  const db = openDb(join(mkdtempSync(join(process.env.TMPDIR!, 'purr-db-')), 'purr.db'));
  const review = (id: string, raised: Finding[]) => {
    const run = fakeRun({ id, repoId: 'r1', branch: 'feat', flowId: 'full' });
    db.putRun(run);
    applyLedger(db, run, raised, new Set(['b']));
    db.setRunFindings(run.id, raised);
    return run;
  };
  const first = review('first', [finding('fp1'), finding('fp2')]);
  assert.deepEqual(resolvedBy(db, first), []);
  const second = review('second', [finding('fp2')]);     // fp1 was fixed in between
  assert.deepEqual(resolvedBy(db, second).map((f) => [f.fingerprint, f.ledger]), [['fp1', 'fixed']]);
  const old = currentFindings(db, first);
  assert.deepEqual(old.map((f) => [f.fingerprint, f.ledger]), [['fp1', 'fixed'], ['fp2', 'new']]);
  assert.deepEqual(old.filter(isActive).map((f) => f.fingerprint), ['fp2'], 'a fixed must-fix no longer counts');
  const third = review('third', [finding('fp1'), finding('fp2')]);   // it came back
  assert.deepEqual(resolvedBy(db, third), []);
  assert.equal(currentFindings(db, third)[0].ledger, 'regression');
  db.close();
});

test('pushes that get no review of their own say why: superseded in the debounce, paused, trigger off, no PR, overtaken', async () => {
  const { ClaudeRunner } = await import('../src/server/claude.ts');
  const { RunManager } = await import('../src/server/manager.ts');
  const { PostPushWatcher } = await import('../src/server/triggers.ts');
  const { ensureDefaults } = await import('../src/server/flows/store.ts');
  const db = openDb(join(mkdtempSync(join(process.env.TMPDIR!, 'purr-db-')), 'purr.db'));
  ensureDefaults(db);
  const repo = await addRepo(db, tempRepo());
  const repoPath = repo.path;
  const mgr = new RunManager(db, new ClaudeRunner(db));
  const req = (head: string) => ({ trigger: 'post-push' as const, repoPath, mode: 'range' as const, head, branch: 'feat' });
  const kind = (sha: string) => { const o = one(db, sha, [repoPath]); return o && [o.kind, o.nextSha ?? null]; };

  db.setSettings({ ...db.getSettings(), debounceSec: 3600 });
  mgr.schedulePostPush(req('aaa1'));
  mgr.schedulePostPush(req('aaa2'));                 // a second push inside the debounce
  assert.deepEqual(kind('aaa1'), ['superseded', 'aaa2']);
  assert.equal(one(db, 'aaa2', [repoPath]), null, 'the newer one is still on its way');

  db.setSettings({ ...db.getSettings(), reviewsPaused: true });
  mgr.schedulePostPush(req('bbb1'));
  assert.deepEqual(kind('bbb1'), ['skipped', null]);
  assert.match(one(db, 'bbb1', [repoPath])!.reason, /paused/);

  db.setSettings({ ...db.getSettings(), reviewsPaused: false, debounceSec: 0 });
  db.setTrigger({ trigger: 'post-push', repoId: repo.id, flowId: null });
  mgr.schedulePostPush(req('ccc1'));
  await new Promise((r) => setTimeout(r, 20));
  assert.match(one(db, 'ccc1', [repoPath])!.reason, /trigger is off/);
  db.deleteTrigger('post-push', repo.id);

  const kindOf = (sha: string) => one(db, sha, [repoPath])?.kind ?? null;
  let tips: (string | null)[] = [], pr: any = null;
  const watcher = new PostPushWatcher(db, mgr, {
    lsRemote: async () => (tips.length > 1 ? tips.shift()! : tips[0]) ?? null, ghAuthed: async () => true, prForBranch: async () => pr,
  });
  const push = async (sha: string, from: string | null | undefined, seen: (string | null)[]) => {
    tips = seen;
    await watcher.pushIntent({ repoPath, branch: 'feat', sha, from });
    assert.equal(kindOf(sha), 'pending', 'pending while it lands');
    await watcher.settled();
  };
  db.setSettings({ ...db.getSettings(), postPushPrsOnly: true });
  await push('ddd1', 'ddd0', ['ddd0', 'ddd1']);
  assert.equal(kindOf('ddd1'), 'no-pr');

  // the branch moves past the push before it's seen: superseded by what's there, whether or not it's local
  await push('eee1', 'eee0', ['eee0', 'eee2']);
  assert.deepEqual(kind('eee1'), ['superseded', 'eee2']);

  // a force-push back to an older commit: the old tip is still there at first, which is not "moved past"
  pr = { number: 3, title: 't', body: '', url: 'u', baseRefName: 'main', headRefName: 'feat', headRefOid: 'fff1', isDraft: false };
  db.setSettings({ ...db.getSettings(), debounceSec: 3600 });
  await push('fff1', 'fff9', ['fff9', 'fff9', 'fff1']);
  assert.equal(kindOf('fff1'), 'pending', 'scheduled: its review is on the way');

  // a hook from before `from` existed: the tip seen first stands in for it, so a push landing isn't "overtaken"
  db.setSettings({ ...db.getSettings(), postPushPrsOnly: false });
  await push('acd1', undefined, ['acd0', 'acd1']);
  assert.equal(kindOf('acd1'), 'pending', 'landed and scheduled');
  await push('acd2', undefined, ['acd2']);
  assert.equal(kindOf('acd2'), 'pending', 'already there at first look');

  // post-push off here, and on in no other clone: no review is coming
  db.setTrigger({ trigger: 'post-push', repoId: repo.id, flowId: null });
  await push('cab1', 'fff1', ['fff1', 'cab1']);
  assert.equal(kindOf('cab1'), 'skipped');
  db.deleteTrigger('post-push', repo.id);
  db.close();
});
