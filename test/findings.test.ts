import { sh, tempRepo } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { type PushOutcome, openDb } from '../src/server/db.ts';
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
  const pr = { number: 7, title: 't', body: '', url: 'u', account: 'me' };
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
  assert.deepEqual(ids({ repoIds: ['r1'], sha: 'a_c1' }), [], "'_' isn't a wildcard: it would have matched abc111");
  assert.deepEqual(ids({ repoIds: ['r1'], sha: 'abc1%' }), ['old'], "nor is '%': only the true prefix abc1 matches");
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
  assert.deepEqual(seen, [null, 'running', 'passed'], 'reports at once, before any review exists');
  assert.equal((await waitForReview(watch(() => null), { timeoutMs: 30, intervalMs: 5 })).run, null);
  assert.equal((await waitForReview(watch(() => fakeRun({ status: 'queued' })), { timeoutMs: 30, intervalMs: 5 })).run?.status, 'queued');
  await assert.rejects(waitForReview(watch(() => null), { timeoutMs: NaN }), /Bad timeout/);
});

test('ReviewWatch follows a newer push that took a commit\'s place, and stops when no review will come', async () => {
  const db = openDb(join(mkdtempSync(join(process.env.TMPDIR!, 'purr-db-')), 'purr.db'));
  const repo = await addRepo(db, tempRepo());
  const repoPath = repo.path;
  const q = { repoIds: [repo.id], triggers: ['post-push' as const, 'manual' as const] };
  const outcome = (sha: string, kind: PushOutcome['kind'], nextSha: string | null = null, path = repoPath) =>
    db.setPushOutcome({ sha, kind, reason: kind, repoPath: path, branch: 'feat', nextSha });
  const at = (over: Partial<Run>) => fakeRun({ repoId: repo.id, branch: 'feat', ...over });

  // a re-push in the debounce: no run for A ever, B's review covers it
  outcome('aaaa01', 'superseded', 'bbbb01');
  const openPr = async () => ({ number: 9, isDraft: false }) as any;
  const w1 = new ReviewWatch(db, { ...q, sha: 'aaaa01' }, openPr);
  assert.deepEqual(await w1.check(), { run: null, done: false }, 'waits for B\'s review to exist');
  db.putRun(at({ id: 'rb', headSha: 'bbbb01', status: 'passed' }));
  const st1 = await w1.check();
  assert.equal(st1.run?.id, 'rb');
  assert.equal(st1.done, true);
  assert.match(w1.notes[0], /following the review of bbbb01/);

  // overtaken by a push nothing here noted (CI, another machine): its branch's PR decides
  outcome('fafa01', 'superseded', 'fafa02');
  assert.deepEqual(await new ReviewWatch(db, { ...q, sha: 'fafa01' }, openPr).check(), { run: null, done: false }, 'PR open: its review is coming');
  assert.match((await new ReviewWatch(db, { ...q, sha: 'fafa01' }, async () => null).check()).stop ?? '', /no open PR/);

  // gh couldn't say whether there's a PR (offline, a timeout): keep waiting, don't conclude "won't be reviewed"
  outcome('fbfb01', 'no-pr');
  assert.deepEqual(await new ReviewWatch(db, { ...q, sha: 'fbfb01' }, async () => undefined).check(), { run: null, done: false });

  // waiting on A: pushed B (A superseded), then A again (B superseded, A pending): back to A, then A's review
  outcome('a0a001', 'superseded', 'a0a002');
  const wa = new ReviewWatch(db, { ...q, sha: 'a0a001' }, openPr);
  assert.deepEqual(await wa.check(), { run: null, done: false }, 'followed to B');
  outcome('a0a002', 'superseded', 'a0a001');
  outcome('a0a001', 'pending');
  assert.deepEqual(await wa.check(), { run: null, done: false }, 'back to A, pending');
  db.putRun(at({ id: 'rA', headSha: 'a0a001', status: 'passed' }));
  assert.equal((await wa.check()).run?.id, 'rA');

  // pushes bouncing between two commits: no endless following, just waiting for the review that's coming
  outcome('baba01', 'superseded', 'baba02');
  outcome('baba02', 'superseded', 'baba01');
  assert.deepEqual(await new ReviewWatch(db, { ...q, sha: 'baba01' }, openPr).check(), { run: null, done: false });

  // pushed A, then B, then A again: A's first review was superseded by B's, and B's by A's second
  db.putRun(at({ id: 'rA1', headSha: 'acab01', status: 'superseded' }));
  const rB = at({ id: 'rB', headSha: 'acab02', status: 'running' });
  db.putRun(rB);
  const wb = new ReviewWatch(db, { ...q, sha: 'acab01' }, openPr);
  assert.equal((await wb.check()).run?.id, 'rB', 'followed to B');
  db.putRun({ ...rB, status: 'superseded' });
  db.putRun(at({ id: 'rA2', headSha: 'acab01', status: 'passed' }));
  assert.equal((await wb.check()).run?.id, 'rA2', "back to A's new review, not a wait on B's superseded one");

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

  // pending on one branch, overtaken on another: follow the newer push rather than wait on the pending one
  outcome('cdcd01', 'superseded', 'cdcd02');
  db.setPushOutcome({ sha: 'cdcd01', kind: 'pending', reason: 'pending', repoPath, branch: 'other' });
  db.putRun(at({ id: 'rcd', headSha: 'cdcd02', status: 'passed' }));
  assert.equal((await new ReviewWatch(db, { ...q, sha: 'cdcd01' }).check()).run?.id, 'rcd');

  // left to another clone's review of the PR: wait while it's open, stop if it's a draft
  outcome('dede01', 'elsewhere');
  assert.deepEqual(await new ReviewWatch(db, { ...q, sha: 'dede01' }, async () => ({ number: 9, isDraft: false, headRefOid: 'dede01' }) as any).check(),
    { run: null, done: false });
  assert.match((await new ReviewWatch(db, { ...q, sha: 'dede01' }, async () => ({ number: 9, isDraft: true }) as any).check()).stop ?? '', /draft/);

  // a review of the commit on one branch leaves what it's owed on another
  outcome('efef01', 'no-pr');
  db.setPushOutcome({ sha: 'efef01', kind: 'pending', reason: 'pending', repoPath, branch: 'feat-a' });
  db.setPushOutcome({ sha: 'efef01', kind: 'no-pr', reason: 'no-pr', repoPath: '/a/fork', branch: 'feat-a' });
  db.clearPushOutcome('efef01', 'feat-a', [repoPath]);
  assert.deepEqual(db.getPushOutcomes('efef01', [repoPath, '/a/fork']).map((o) => [o.repoPath === repoPath ? 'here' : 'fork', o.branch, o.kind]).sort(),
    [['fork', 'feat-a', 'no-pr'], ['here', 'feat', 'no-pr']], "the other branch's note, and a fork's on the same branch, stay");

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

  // what actually got scheduled, not just the note (which says pending before confirming starts)
  const sched: string[] = [];
  const realSchedule = mgr.schedulePostPush.bind(mgr);
  mgr.schedulePostPush = (r: any) => { sched.push(r.head); realSchedule(r); };
  const kindOf = (sha: string) => one(db, sha, [repoPath])?.kind ?? null;
  let tips: (string | null)[] = [], pr: any = null;
  let line: 'yes' | 'no' | 'unknown' = 'unknown';
  const watcher = new PostPushWatcher(db, mgr, {
    lsRemote: async () => (tips.length > 1 ? tips.shift()! : tips[0]) ?? null, ghAuthed: async () => true, prForBranch: async () => pr,
    inHistoryOf: async () => line, confirmEveryMs: 5,
  });
  const push = async (sha: string, from: string | null, seen: (string | null)[]) => {
    tips = seen;
    await watcher.pushIntent({ repoPath, branch: 'feat', sha, from });
    assert.equal(kindOf(sha), 'pending', 'pending while it lands');
    await watcher.settled();
  };
  db.setSettings({ ...db.getSettings(), postPushPrsOnly: true });
  await push('ddd1', 'ddd0', ['ddd0', 'ddd1']);
  assert.equal(kindOf('ddd1'), 'no-pr');

  // the branch moves past the push before it's seen: superseded by what's there, whether or not it's local, when
  // something will review that (here its own hook reported it)...
  db.setPushOutcome({ sha: 'eee2', kind: 'pending', reason: 'its hook reported it', repoPath, branch: 'feat' });
  await push('eee1', 'eee0', ['eee0', 'eee2']);
  assert.deepEqual(kind('eee1'), ['superseded', 'eee2']);
  // ...and when nothing will (a bot's push, no PR), this push isn't left out: here PR-only, so it waits for a PR
  line = 'yes';   // the bot's push is on top of this one
  await push('efe1', 'efe0', ['efe0', 'efe2']);
  assert.equal(kindOf('efe1'), 'no-pr');
  line = 'unknown';

  // A lands, but while gh is asked about its PR, B is pushed on top: A mustn't take B's place in the debounce
  pr = { number: 3, title: 't', body: '', url: 'u', baseRefName: 'main', headRefName: 'feat', headRefOid: 'aba1', isDraft: false };
  db.setSettings({ ...db.getSettings(), debounceSec: 3600 });
  const slow = new PostPushWatcher(db, mgr, {
    lsRemote: async () => (tips.length > 1 ? tips.shift()! : tips[0]) ?? null, ghAuthed: async () => true,
    prForBranch: async () => { tips = ['aba2']; return pr; }, inHistoryOf: async () => 'yes', confirmEveryMs: 5,
  });
  tips = ['aba0', 'aba1'];
  await slow.pushIntent({ repoPath, branch: 'feat', sha: 'aba1', from: 'aba0' });
  await slow.settled();
  assert.deepEqual(kind('aba1'), ['superseded', 'aba2'], 'covered by B');
  assert.ok(!sched.includes('aba1'), 'A is not scheduled over B');

  // seen on the remote, then ls-remote has no answer after asking gh: it still landed, so it's scheduled
  const blip = new PostPushWatcher(db, mgr, {
    lsRemote: async () => (tips.length > 1 ? tips.shift()! : tips[0]) ?? null, ghAuthed: async () => true,
    prForBranch: async () => { tips = [null]; return pr; }, confirmEveryMs: 5,
  });
  tips = ['bcd0', 'bcd1'];
  await blip.pushIntent({ repoPath, branch: 'feat', sha: 'bcd1', from: 'bcd0' });
  await blip.settled();
  assert.equal(kindOf('bcd1'), 'pending', 'scheduled, not "never showed up"');
  assert.ok(sched.includes('bcd1'));

  // landed, then amended and force-pushed before it was scheduled: the amend's own hook reported it, so its review
  // replaces this one's
  line = 'no';
  db.setPushOutcome({ sha: 'cde2', kind: 'pending', reason: 'its hook reported it', repoPath, branch: 'feat' });
  const amend = new PostPushWatcher(db, mgr, {
    lsRemote: async () => (tips.length > 1 ? tips.shift()! : tips[0]) ?? null, ghAuthed: async () => true,
    prForBranch: async () => { tips = ['cde2']; return pr; }, inHistoryOf: async () => line, confirmEveryMs: 5,
  });
  tips = ['cde0', 'cde1'];
  await amend.pushIntent({ repoPath, branch: 'feat', sha: 'cde1', from: 'cde0' });
  await amend.settled();
  assert.deepEqual(kind('cde1'), ['superseded', 'cde2']);
  line = 'unknown';

  // a quick second push landing while gh is asked about this one: covered by it
  const quick2 = new PostPushWatcher(db, mgr, {
    lsRemote: async () => (tips.length > 1 ? tips.shift()! : tips[0]) ?? null, ghAuthed: async () => true,
    prForBranch: async () => { tips = ['dcd2']; return pr; }, inHistoryOf: async () => 'yes', confirmEveryMs: 5,   // on top of this one
  });
  tips = ['dcd1'];
  await quick2.pushIntent({ repoPath, branch: 'feat', sha: 'dcd1', from: 'dcd0' });
  await quick2.settled();
  assert.deepEqual(kind('dcd1'), ['superseded', 'dcd2'], 'the newer push takes its place');

  // gh can't be asked whether there's a PR (offline), reviews PR-only: noted no-pr, and --wait keeps waiting
  const offline = new PostPushWatcher(db, mgr, { lsRemote: async () => 'aef1', ghAuthed: async () => true, prForBranch: async () => null, confirmEveryMs: 5 });
  db.setSettings({ ...db.getSettings(), postPushPrsOnly: true });
  await offline.pushIntent({ repoPath, branch: 'feat', sha: 'aef1', from: 'aef0' });
  await offline.settled();
  assert.equal(kindOf('aef1'), 'no-pr');
  assert.deepEqual(await new ReviewWatch(db, { repoIds: [repo.id], sha: 'aef1' }, async () => undefined).check(), { run: null, done: false });

  // reviews not PR-only, no PR: a bot pushes on top (through no hook here) while gh is asked: this push is still reviewed
  db.setSettings({ ...db.getSettings(), postPushPrsOnly: false });
  pr = null;
  const bot = new PostPushWatcher(db, mgr, {
    lsRemote: async () => (tips.length > 1 ? tips.shift()! : tips[0]) ?? null, ghAuthed: async () => true,
    prForBranch: async () => { tips = ['bbb9']; return null; }, inHistoryOf: async () => 'yes', confirmEveryMs: 5,
  });
  tips = ['bbb0', 'bbb1'];
  sched.length = 0;
  await bot.pushIntent({ repoPath, branch: 'feat', sha: 'bbb1', from: 'bbb0' });
  await bot.settled();
  assert.deepEqual(sched, ['bbb9'], "the bot's push had no review coming: it's reviewed here, which covers this one");
  assert.deepEqual(kind('bbb1'), ['superseded', 'bbb9'], '--wait on this push follows it there');

  // the branch moves to a commit pushed to another branch long ago (its old note there promises nothing here), by CI,
  // with no PR and reviews not PR-only: this push is reviewed
  db.setSettings({ ...db.getSettings(), postPushPrsOnly: false });
  db.setPushOutcome({ sha: 'cab9', kind: 'no-pr', reason: 'old', repoPath, branch: 'elsewhere' });
  pr = null;
  sched.length = 0;
  line = 'yes';   // CI's push is on top of this one
  await push('cab1', 'cab0', ['cab0', 'cab9']);
  assert.deepEqual(sched, ['cab9'], "cab9's old note on another branch promises nothing: it's reviewed here, covering cab1");
  line = 'unknown';
  db.setSettings({ ...db.getSettings(), postPushPrsOnly: true });

  // a remote that isn't on GitHub, reviews PR-only: no PR can come, so it says so rather than wait for one
  const plain = await addRepo(db, tempRepo());
  sh(plain.path, 'remote', 'add', 'origin', 'https://gitlab.example.com/org/app.git');
  const gl = new PostPushWatcher(db, mgr, { lsRemote: async () => 'abe1', ghAuthed: async () => true, prForBranch: async () => null, confirmEveryMs: 5 });
  db.setSettings({ ...db.getSettings(), postPushPrsOnly: true });
  await gl.pushIntent({ repoPath: plain.path, branch: 'feat', sha: 'abe1', from: null });
  await gl.settled();
  assert.match(one(db, 'abe1', [plain.path])?.reason ?? '', /isn't on GitHub/);

  // an open PR covers a newer push only if some clone has post-push on (the poller reviews it through one): with it off
  // everywhere, nothing will review this push
  db.setTrigger({ trigger: 'post-push', repoId: repo.id, flowId: null });
  pr = { number: 3, title: 't', body: '', url: 'u', baseRefName: 'main', headRefName: 'feat', headRefOid: 'x', isDraft: false };
  line = 'yes';
  await push('ace1', 'ace0', ['ace0', 'ace2']);
  assert.equal(kindOf('ace1'), 'skipped');
  assert.match(one(db, 'ace1', [repoPath])!.reason, /post-push trigger is off/);
  line = 'unknown';
  db.deleteTrigger('post-push', repo.id);

  // amended and force-pushed before the first push was even seen: the amend's own hook reported it, so its review
  // replaces this one's, not "rejected"
  line = 'no';
  db.setPushOutcome({ sha: 'cad2', kind: 'pending', reason: 'its hook reported it', repoPath, branch: 'feat' });
  await push('cad1', 'cad0', ['cad0', 'cad2']);
  assert.deepEqual(kind('cad1'), ['superseded', 'cad2']);
  line = 'unknown';

  // the branch moved to something that doesn't include the push (rejected: a teammate's went in instead)
  line = 'no';
  await push('eee3', 'eee0', ['eee0', 'eee4']);
  assert.equal(kindOf('eee3'), 'skipped');
  assert.match(one(db, 'eee3', [repoPath])!.reason, /doesn't include this push/);
  line = 'unknown';

  // a force-push back to an older commit: the old tip is still there at first, which is not "moved past"
  pr = { number: 3, title: 't', body: '', url: 'u', baseRefName: 'main', headRefName: 'feat', headRefOid: 'fff1', isDraft: false };
  db.setSettings({ ...db.getSettings(), debounceSec: 3600 });
  await push('fff1', 'fff9', ['fff9', 'fff9', 'fff1']);
  assert.equal(kindOf('fff1'), 'pending', 'scheduled: its review is on the way');
  assert.ok(sched.includes('fff1'));

  db.setSettings({ ...db.getSettings(), postPushPrsOnly: false });

  // something going wrong while confirming the push is reported, not left pending
  const broken = new PostPushWatcher(db, mgr, { lsRemote: async () => { throw new Error('git crashed'); }, confirmMs: 60, confirmEveryMs: 10 });
  await broken.pushIntent({ repoPath, branch: 'feat', sha: 'bad001', from: null });
  await broken.settled();
  assert.match(one(db, 'bad001', [repoPath])!.reason, /couldn't confirm the push: git crashed/);

  // a push that never lands is given up on, and says so
  const quick = new PostPushWatcher(db, mgr, { lsRemote: async () => 'old0', ghAuthed: async () => true, prForBranch: async () => null,
    confirmMs: 60, confirmEveryMs: 10 });
  await quick.pushIntent({ repoPath, branch: 'feat', sha: 'dead01', from: 'old0' });
  await quick.settled();
  assert.equal(kindOf('dead01'), 'skipped');
  assert.match(one(db, 'dead01', [repoPath])!.reason, /never showed up/);

  // post-push off here, and on in no other clone: no review is coming
  db.setTrigger({ trigger: 'post-push', repoId: repo.id, flowId: null });
  await push('cab1', 'fff1', ['fff1', 'cab1']);
  assert.equal(kindOf('cab1'), 'skipped');
  db.deleteTrigger('post-push', repo.id);
  db.close();
});

test("a fix recorded by an earlier review of the branch doesn't mark a later review's finding fixed", () => {
  const db = openDb(join(mkdtempSync(join(process.env.TMPDIR!, 'purr-db-')), 'purr.db'));
  const earlier = fakeRun({ id: 'e1', repoId: 'r1', branch: 'feat' });
  const viewed = fakeRun({ id: 'v1', repoId: 'r1', branch: 'feat' });
  db.putRun(earlier);
  db.putRun(viewed);
  db.setRunFindings(viewed.id, [finding('fp')]);
  db.putLedger({ fingerprint: 'fp', repoId: 'r1', branch: 'feat', state: 'fixed', flowId: null, finding: finding('fp'),
    firstRunId: 'e1', lastRunId: 'e1', updatedAt: 'x' });
  assert.notEqual(currentFindings(db, viewed)[0].ledger, 'fixed');
  db.close();
});

test('pushes across clones: left to the clone with post-push on, one note per report, and a PR first seen late still owed its review', async () => {
  const { ClaudeRunner } = await import('../src/server/claude.ts');
  const { RunManager } = await import('../src/server/manager.ts');
  const { PostPushWatcher } = await import('../src/server/triggers.ts');
  const { ensureDefaults } = await import('../src/server/flows/store.ts');
  const db = openDb(join(mkdtempSync(join(process.env.TMPDIR!, 'purr-db-')), 'purr.db'));
  ensureDefaults(db);
  const main = tempRepo();
  sh(main, 'remote', 'add', 'origin', 'https://github.com/work-org/app-x.git');
  const wtPath = join(realpathSync(mkdtempSync(join(process.env.TMPDIR!, 'purr-wt-'))), 'wt');
  sh(main, 'worktree', 'add', '-q', wtPath, '-b', 'wt');
  const a = await addRepo(db, main), w = await addRepo(db, wtPath);
  const mgr = new RunManager(db, new ClaudeRunner(db));
  const scheduled: string[] = [];
  mgr.schedulePostPush = (req: any) => { scheduled.push(`${req.head}@${req.repoPath === a.path ? 'main' : 'wt'}`); };
  let pushed = '', pr: any = null, prs: any[] = [];
  const watcher = new PostPushWatcher(db, mgr, {
    lsRemote: async () => pushed, ghAuthed: async () => true, prForBranch: async () => pr, fetchPrs: async () => ({ prs, answered: ['me'] }),
  });
  const note = (sha: string, path: string) => db.getPushOutcomes(sha, [path])[0]?.kind ?? null;
  // projectFolders []: the poll's discovery mustn't scan this machine's real project folders
  db.setSettings({ ...db.getSettings(), postPushPrsOnly: true, projectFolders: [] });
  await watcher.poll();

  pr = { number: 5, title: 't', body: '', url: 'u', baseRefName: 'main', headRefName: 'feat', headRefOid: 'aa01', isDraft: false };
  db.setTrigger({ trigger: 'post-push', repoId: w.id, flowId: null });
  pushed = 'aa01';
  await watcher.pushIntent({ repoPath: wtPath, branch: 'feat', sha: 'aa01', from: null });
  await watcher.settled();
  assert.equal(note('aa01', w.path), 'elsewhere', 'off here, on in the main checkout: left to its review of the PR');
  db.deleteTrigger('post-push', w.id);

  pushed = 'aa02';
  await watcher.pushIntent({ repoPath: main, branch: 'feat', sha: 'aa02', from: 'aa01' });
  await watcher.pushIntent({ repoPath: wtPath, branch: 'feat', sha: 'aa02', from: 'aa01' });
  await watcher.settled();
  assert.deepEqual(scheduled, ['aa02@main'], 'one review for the push both clones reported');
  assert.equal(note('aa02', w.path), null, "the second clone's note is cleared: the first one's review covers it");
  assert.equal(note('aa02', a.path), 'pending');

  // post-push off in the worktree, and no PR yet: noted as waiting for a PR; once one is opened, the main checkout
  // (post-push on) reviews it
  db.setTrigger({ trigger: 'post-push', repoId: w.id, flowId: null });
  pr = null;
  pushed = 'aa05';
  await watcher.pushIntent({ repoPath: wtPath, branch: 'early', sha: 'aa05', from: null });
  await watcher.settled();
  assert.equal(note('aa05', w.path), 'no-pr');
  prs = [{ repo: 'work-org/app-x', number: 8, headRefOid: 'aa05', headRefName: 'early', baseRefName: 'main', title: 't', body: '', url: 'u',
    isDraft: false, account: 'me', createdAt: new Date(Date.now() - 86_400_000).toISOString() }];
  await watcher.poll();
  assert.deepEqual(scheduled.slice(-1), ['aa05@main'], 'owed its review, given by the clone with post-push on');
  db.deleteTrigger('post-push', w.id);
  prs = [];

  // pushed with no PR; the PR is then opened while PuRR is down, so the poller first sees it as an old PR
  pr = null;
  pushed = 'aa03';
  await watcher.pushIntent({ repoPath: main, branch: 'late', sha: 'aa03', from: null });
  await watcher.settled();
  assert.equal(note('aa03', a.path), 'no-pr');
  prs = [{ repo: 'work-org/app-x', number: 6, headRefOid: 'aa03', headRefName: 'late', baseRefName: 'main', title: 't', body: '', url: 'u',
    isDraft: false, account: 'me', createdAt: new Date(Date.now() - 86_400_000).toISOString() }];
  await watcher.poll();
  assert.deepEqual(scheduled.slice(-1), ['aa03@main'], 'still owed its review');
  db.close();
});

test("a review's creation clears its commit's notes on that branch in every clone; scheduling it again clears its own superseded note", async () => {
  const { ClaudeRunner } = await import('../src/server/claude.ts');
  const { RunManager } = await import('../src/server/manager.ts');
  const { ensureDefaults } = await import('../src/server/flows/store.ts');
  const db = openDb(join(mkdtempSync(join(process.env.TMPDIR!, 'purr-db-')), 'purr.db'));
  ensureDefaults(db);
  const mainPath = tempRepo(), otherPath = tempRepo();
  for (const p of [mainPath, otherPath]) sh(p, 'remote', 'add', 'origin', 'https://github.com/work-org/app-z.git');
  const repo = await addRepo(db, mainPath);
  const other = await addRepo(db, otherPath);   // another clone of the same GitHub repo
  const mgr = new RunManager(db, new ClaudeRunner(db));
  (mgr as any).start = () => {};                     // the run is created, not run
  const note = (sha: string, kind: PushOutcome['kind'], path: string, branch: string) => db.setPushOutcome({ sha, kind, reason: kind, repoPath: path, branch });
  const left = (sha: string) => db.getPushOutcomes(sha, [repo.path, other.path]).map((o) => `${o.branch}@${o.repoPath === repo.path ? 'here' : 'other'}`).sort();
  note('abc1', 'pending', repo.path, 'feat');
  note('abc1', 'pending', other.path, 'feat');
  note('abc1', 'no-pr', repo.path, 'elsewhere');
  db.setSettings({ ...db.getSettings(), debounceSec: 0 });
  mgr.schedulePostPush({ trigger: 'post-push', repoPath: repo.path, mode: 'range', head: 'abc1', branch: 'feat' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(left('abc1'), ['elsewhere@here'], 'both clones cleared on feat; the other branch still owed');

  db.setPushOutcome({ sha: 'abc2', kind: 'superseded', reason: 'took its place', repoPath: repo.path, branch: 'feat', nextSha: 'abc3' });
  db.setSettings({ ...db.getSettings(), debounceSec: 3600 });
  mgr.schedulePostPush({ trigger: 'post-push', repoPath: repo.path, mode: 'range', head: 'abc2', branch: 'feat' });
  assert.deepEqual(left('abc2'), [], 'pushed back to it: no longer superseded');
  db.close();
});

test('a push handed to another clone, whose PR the poller first sees late, is still owed its review', async () => {
  const { ClaudeRunner } = await import('../src/server/claude.ts');
  const { RunManager } = await import('../src/server/manager.ts');
  const { PostPushWatcher } = await import('../src/server/triggers.ts');
  const { ensureDefaults } = await import('../src/server/flows/store.ts');
  const db = openDb(join(mkdtempSync(join(process.env.TMPDIR!, 'purr-db-')), 'purr.db'));
  ensureDefaults(db);
  const main = tempRepo();
  sh(main, 'remote', 'add', 'origin', 'https://github.com/work-org/app-y.git');
  const a = await addRepo(db, main);
  const mgr = new RunManager(db, new ClaudeRunner(db));
  const scheduled: string[] = [];
  mgr.schedulePostPush = (req: any) => { scheduled.push(req.head); };
  let prs: any[] = [];
  const watcher = new PostPushWatcher(db, mgr, { fetchPrs: async () => ({ prs, answered: ['me'] }) });
  db.setSettings({ ...db.getSettings(), projectFolders: [] });   // no scan of this machine's real project folders
  await watcher.poll();
  db.setPushOutcome({ sha: 'ee01', kind: 'elsewhere', reason: 'elsewhere', repoPath: a.path, branch: 'feat' });
  prs = [{ repo: 'work-org/app-y', number: 3, headRefOid: 'ee01', headRefName: 'feat', baseRefName: 'main', title: 't', body: '', url: 'u',
    isDraft: false, account: 'me', createdAt: new Date(Date.now() - 86_400_000).toISOString() }];
  await watcher.poll();
  assert.deepEqual(scheduled, ['ee01']);
  db.close();
});

test("the service's events wake a waiting --wait at once, even one that came while it was busy looking", async () => {
  const { ServiceEvents } = await import('../src/server/lookup.ts');
  const { ClaudeRunner } = await import('../src/server/claude.ts');
  const { RunManager } = await import('../src/server/manager.ts');
  const { PostPushWatcher } = await import('../src/server/triggers.ts');
  const { startHttp } = await import('../src/server/http.ts');
  const db = openDb(join(mkdtempSync(join(process.env.TMPDIR!, 'purr-db-')), 'purr.db'));
  const mgr = new RunManager(db, new ClaudeRunner(db));
  const server = startHttp(db, mgr, new PostPushWatcher(db, mgr), 0);
  await new Promise((r) => server.once('listening', r));
  const ev = (await ServiceEvents.connect((server.address() as { port: number }).port))!;
  try {
    const timed = async (fn: () => void) => { const t0 = Date.now(); const w = ev.wait(60_000); fn(); await w; return Date.now() - t0; };
    assert.ok(await timed(() => mgr.emit({ type: 'run', run: fakeRun({}) })) < 2_000, 'a run event wakes it');
    assert.ok(await timed(() => mgr.emit({ type: 'push', sha: 'abc' })) < 2_000, 'so does a push note');
    mgr.emit({ type: 'run', run: fakeRun({}) });      // while nobody waits (looking at the database, say)
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await ev.wait(60_000);
    assert.ok(Date.now() - t0 < 500, 'not lost: the next wait returns at once');
    server.closeAllConnections();
    await ev.wait(60_000);
    assert.equal(ev.down, true, 'the stream ending says the service stopped');
  } finally { ev.close(); server.close(); db.close(); }
});

test("a newer push covered by an open PR the poller lists, or by a review already created, supersedes; with post-push off everywhere it doesn't", async () => {
  const { ClaudeRunner } = await import('../src/server/claude.ts');
  const { RunManager } = await import('../src/server/manager.ts');
  const { PostPushWatcher } = await import('../src/server/triggers.ts');
  const { ensureDefaults } = await import('../src/server/flows/store.ts');
  const db = openDb(join(mkdtempSync(join(process.env.TMPDIR!, 'purr-db-')), 'purr.db'));
  ensureDefaults(db);
  db.setSettings({ ...db.getSettings(), projectFolders: [], postPushPrsOnly: true });
  const main = tempRepo();
  sh(main, 'remote', 'add', 'origin', 'https://github.com/work-org/app-w.git');
  const a = await addRepo(db, main);
  const mgr = new RunManager(db, new ClaudeRunner(db));
  const sched: string[] = [];
  mgr.schedulePostPush = (r: any) => { sched.push(r.head); };
  let tips: string[] = [];
  const pr = { number: 4, title: 't', body: '', url: 'u', baseRefName: 'main', headRefName: 'feat', headRefOid: 'x', isDraft: false };
  const watcher = new PostPushWatcher(db, mgr, {
    fetchPrs: async () => ({ prs: [{ ...pr, repo: 'work-org/app-w', account: 'me', createdAt: new Date(Date.now() - 86_400_000).toISOString() }], answered: ['me'] }),
    lsRemote: async () => (tips.length > 1 ? tips.shift()! : tips[0]) ?? null, ghAuthed: async () => true, prForBranch: async () => ({ ...pr, account: 'me' }),
    inHistoryOf: async () => 'yes', confirmEveryMs: 5,
  });
  const kind = (sha: string) => db.getPushOutcomes(sha, [a.path])[0]?.kind ?? null;
  await watcher.poll();                             // the poller lists PR 4 (an old PR: recorded, not reviewed)
  tips = ['fa0', 'fa2'];
  await watcher.pushIntent({ repoPath: main, branch: 'feat', sha: 'fa1', from: 'fa0' });
  await watcher.settled();
  assert.equal(kind('fa1'), 'superseded', 'the poller reviews the PR at wa2');
  assert.deepEqual(sched, [], 'and this hook schedules nothing');

  // a newer push whose review is already created (its notes cleared): it covers this one
  db.putRun({ ...fakeRun({ id: 'rw', repoId: a.id, branch: 'feat', headSha: 'fb2' }) });
  tips = ['fb0', 'fb2'];
  await watcher.pushIntent({ repoPath: main, branch: 'feat', sha: 'fb1', from: 'fb0' });
  await watcher.settled();
  assert.equal(kind('fb1'), 'superseded');

  // post-push off in every clone: the PR won't be reviewed, so it covers nothing, and nothing here reviews either
  db.setTrigger({ trigger: 'post-push', repoId: a.id, flowId: null });
  tips = ['fc0', 'fc2'];
  await watcher.pushIntent({ repoPath: main, branch: 'feat', sha: 'fc1', from: 'fc0' });
  await watcher.settled();
  assert.equal(kind('fc1'), 'skipped');
  assert.deepEqual(sched, []);
  db.close();
});

test('pushes judged by the remote pushed to, and post-push off everywhere; a slow gh holds --wait no longer than its timeout', async () => {
  const { ClaudeRunner } = await import('../src/server/claude.ts');
  const { RunManager } = await import('../src/server/manager.ts');
  const { PostPushWatcher } = await import('../src/server/triggers.ts');
  const { ensureDefaults } = await import('../src/server/flows/store.ts');
  const db = openDb(join(mkdtempSync(join(process.env.TMPDIR!, 'purr-db-')), 'purr.db'));
  ensureDefaults(db);
  db.setSettings({ ...db.getSettings(), projectFolders: [], postPushPrsOnly: true });
  const main = tempRepo();
  sh(main, 'remote', 'add', 'origin', 'https://gitlab.example.com/org/app.git');
  sh(main, 'remote', 'add', 'hub', 'https://github.com/work-org/app-v.git');
  const a = await addRepo(db, main);
  const mgr = new RunManager(db, new ClaudeRunner(db));
  const sched: string[] = [];
  mgr.schedulePostPush = (r: any) => { sched.push(r.head); };
  const pr = { number: 2, title: 't', body: '', url: 'u', baseRefName: 'main', headRefName: 'feat', headRefOid: 'x', isDraft: false };
  let thePr: any = pr;
  const watcher = new PostPushWatcher(db, mgr, { lsRemote: async () => 'eaa1', ghAuthed: async () => true, prForBranch: async () => thePr, confirmEveryMs: 5 });
  const kind = (sha: string) => db.getPushOutcomes(sha, [a.path])[0]?.kind ?? null;

  // origin is GitLab, but this push went to a GitHub remote with an open PR: reviewed, not "isn't on GitHub"
  await watcher.pushIntent({ repoPath: main, branch: 'feat', sha: 'eaa1', from: null, remote: 'hub' });
  await watcher.settled();
  assert.deepEqual(sched, ['eaa1']);

  // post-push off in every clone, no PR yet: nothing will ever review it, so not "waiting for a PR"
  db.setTrigger({ trigger: 'post-push', repoId: a.id, flowId: null });
  thePr = null;
  const off = new PostPushWatcher(db, mgr, { lsRemote: async () => 'eab1', ghAuthed: async () => true, prForBranch: async () => null, confirmEveryMs: 5 });
  await off.pushIntent({ repoPath: main, branch: 'feat', sha: 'eab1', from: null, remote: 'hub' });
  await off.settled();
  assert.equal(kind('eab1'), 'skipped');
  db.deleteTrigger('post-push', a.id);

  // a gh that never answers: --wait gives up at its timeout, not 15-30s per account later
  db.setPushOutcome({ sha: 'eac1', kind: 'no-pr', reason: 'r', repoPath: a.path, branch: 'feat' });
  const watch = new ReviewWatch(db, { repoIds: [a.id], sha: 'eac1' }, () => new Promise(() => {}));
  const t0 = Date.now();
  const st = await waitForReview(watch, { timeoutMs: 300, intervalMs: 50 });
  assert.equal(st.done, false);
  assert.ok(Date.now() - t0 < 2_000, `stopped near its timeout (${Date.now() - t0}ms)`);
  db.close();
});

test("without gh, a push to a remote not on GitHub is reviewed; a bot's commit found on top stays the one reviewed; a post-push-off clone's note promises nothing", async () => {
  const { ClaudeRunner } = await import('../src/server/claude.ts');
  const { RunManager } = await import('../src/server/manager.ts');
  const { PostPushWatcher } = await import('../src/server/triggers.ts');
  const { ensureDefaults } = await import('../src/server/flows/store.ts');
  const db = openDb(join(mkdtempSync(join(process.env.TMPDIR!, 'purr-db-')), 'purr.db'));
  ensureDefaults(db);
  db.setSettings({ ...db.getSettings(), projectFolders: [], postPushPrsOnly: true });
  const mgr = new RunManager(db, new ClaudeRunner(db));
  const sched: string[] = [];
  mgr.schedulePostPush = (r: any) => { sched.push(r.head); };

  // gh signed out, PR-only on: PR-only can't apply, so every push is reviewed, GitLab included
  const gl = tempRepo();
  sh(gl, 'remote', 'add', 'origin', 'https://gitlab.example.com/org/app.git');
  await addRepo(db, gl);
  const noGh = new PostPushWatcher(db, mgr, { lsRemote: async () => 'dab1', ghAuthed: async () => false, prForBranch: async () => null, confirmEveryMs: 5 });
  await noGh.pushIntent({ repoPath: gl, branch: 'feat', sha: 'dab1', from: null });
  await noGh.settled();
  assert.deepEqual(sched, ['dab1']);

  // a bot's commit found on top before this push was seen, then no answer from the remote: still the bot's reviewed
  db.setSettings({ ...db.getSettings(), postPushPrsOnly: false });
  const hub = tempRepo();
  sh(hub, 'remote', 'add', 'origin', 'https://github.com/work-org/app-u.git');
  const h = await addRepo(db, hub);
  const looks: (string | null)[] = ['dac0', 'dac9', null];
  const bot = new PostPushWatcher(db, mgr, {
    lsRemote: async () => (looks.length > 1 ? looks.shift()! : looks[0]) ?? null, ghAuthed: async () => true, prForBranch: async () => null,
    inHistoryOf: async () => 'yes', confirmEveryMs: 5,
  });
  sched.length = 0;
  await bot.pushIntent({ repoPath: hub, branch: 'feat', sha: 'dac1', from: 'dac0' });
  await bot.settled();
  assert.deepEqual(sched, ['dac9'], 'not the older dac1');
  assert.deepEqual([db.getPushOutcomes('dac1', [h.path])[0]?.kind, db.getPushOutcomes('dac1', [h.path])[0]?.nextSha], ['superseded', 'dac9']);

  // a newer push from a worktree with post-push off: its pending note promises no review, so this push's hook reviews it
  const wtPath = join(realpathSync(mkdtempSync(join(process.env.TMPDIR!, 'purr-wt-'))), 'wt');
  sh(hub, 'worktree', 'add', '-q', wtPath, '-b', 'wt');
  const w = await addRepo(db, wtPath);
  db.setTrigger({ trigger: 'post-push', repoId: w.id, flowId: null });
  db.setPushOutcome({ sha: 'dad9', kind: 'pending', reason: 'its hook reported it', repoPath: w.path, branch: 'feat' });
  const mixed = new PostPushWatcher(db, mgr, {
    lsRemote: async () => 'dad9', ghAuthed: async () => true, prForBranch: async () => null, inHistoryOf: async () => 'yes', confirmEveryMs: 5,
  });
  sched.length = 0;
  await mixed.pushIntent({ repoPath: hub, branch: 'feat', sha: 'dad1', from: 'dad0' });
  await mixed.settled();
  assert.deepEqual(sched, ['dad9']);
  db.close();
});
