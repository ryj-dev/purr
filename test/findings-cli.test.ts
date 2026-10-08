import { tempRepo } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
  db.setPushOutcome({ sha: 'aaaa000006', kind: 'skipped', reason: 'reviews are paused', repoPath, branch: 'feat' });
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

  const runs = purr(repoPath, 'runs', '--branch', 'feat');
  assert.equal(runs.status, 0);
  assert.equal(runs.stdout.trim().split('\n').length, 5);
  assert.equal(purr(repoPath, 'runs', '--limit', 'x').status, 4);
});
