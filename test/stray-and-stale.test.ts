import { sh, tempRepo } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
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

test("a manual purr run that's told to stop cancels its run instead of leaving it running; a run nothing runs any more can be cancelled", async () => {
  const db = openDb();
  const repoPath = tempRepo();
  await addRepo(db, repoPath);
  const ts = new Date().toISOString();
  db.putFlow({ id: 'hang', name: 'Hang', description: '', isDefault: false, createdAt: ts, updatedAt: ts, edges: [],
    blocks: [{ id: 'wait', type: 'command', label: 'Wait', position: { x: 0, y: 0 }, config: { command: 'sleep 60', timeoutSec: 120, failOnNonZero: true } }] });
  db.close();
  writeFileSync(join(repoPath, 'b.txt'), 'b\n');
  sh(repoPath, 'add', '-A');
  sh(repoPath, 'commit', '-q', '-m', 'b', '--no-verify');

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    const t0 = Date.now();
    const out = await new Promise<{ code: number | null; stderr: string; id: string }>((res) => {
      const p = spawn(process.execPath, [CLI, 'run', '--flow', 'hang'], { cwd: repoPath, env: process.env });
      let stderr = '', id = '', sent = false;
      p.stderr.on('data', (d) => {
        stderr += d;
        id ||= stderr.match(/\((run-[0-9a-f]+)\)/)?.[1] ?? '';
        if (!id || sent) return;
        // once its command is running: the run is 'running' in the database, with a process under it
        const t = setInterval(() => {
          const db = openDb();
          const block = db.listBlockRuns(id).find((x) => x.blockId === 'wait');
          db.close();
          if (block?.status === 'running') { clearInterval(t); p.kill(sig); }
        }, 100);
        sent = true;
      });
      p.on('close', (code) => res({ code, stderr, id }));
    });
    assert.equal(out.code, sig === 'SIGTERM' ? 143 : 130, out.stderr);
    assert.ok(Date.now() - t0 < 30_000, 'stopped well before its 60s command');
    const after = openDb();
    assert.equal(after.getRun(out.id)!.status, 'cancelled', `${sig}: not left running`);
    after.close();
  }

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
