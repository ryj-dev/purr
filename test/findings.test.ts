import { sh, tempRepo } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/server/db.ts';
import { addRepo } from '../src/server/http.ts';
import { currentFindings, isActive, resolvedBy, sameRepoIds, waitForRun } from '../src/server/lookup.ts';
import { applyLedger } from '../src/server/ledger.ts';
import type { Finding, Run } from '../src/shared/types.ts';

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

test('waitForRun waits for a run to appear and finish, and gives up at the timeout', async () => {
  let calls = 0;
  const seen: (string | null)[] = [];
  const run = await waitForRun(() => {
    calls++;
    return calls < 2 ? null : fakeRun({ id: 'w', status: calls < 4 ? 'running' : 'passed' });
  }, { timeoutMs: 5000, intervalMs: 5, onChange: (r) => seen.push(r?.status ?? null) });
  assert.equal(run?.status, 'passed');
  assert.deepEqual(seen, ['running', 'passed']);
  assert.equal(await waitForRun(() => null, { timeoutMs: 30, intervalMs: 5 }), null);
  assert.equal((await waitForRun(() => fakeRun({ status: 'queued' }), { timeoutMs: 30, intervalMs: 5 }))?.status, 'queued');
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
