import { FAKE_AWS, FAKE_CLAUDE, sh, tempRepo } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

// async: the daemon under test lives in this process and must keep serving while git runs the hook
const run = (cwd: string, ...args: string[]) => new Promise<{ status: number | null; stderr: string }>((res) => {
  const p = spawn('git', args, { cwd });
  let stderr = '';
  p.stderr.on('data', (d) => { stderr += d; });
  p.on('close', (status) => res({ status, stderr }));
});
const CLI = new URL('../src/server/cli.ts', import.meta.url).pathname;
const cli = (cwd: string, ...args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((res) => {
  const p = spawn(process.execPath, [CLI, ...args], { cwd });
  let stdout = '', stderr = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });
  p.on('close', (status) => res({ status, stdout, stderr }));
});
import { openDb } from '../src/server/db.ts';
import { ensureDefaults } from '../src/server/flows/store.ts';
import { ClaudeRunner } from '../src/server/claude.ts';
import { RunManager } from '../src/server/manager.ts';
import { addRepo, startHttp } from '../src/server/http.ts';
import { PostPushWatcher } from '../src/server/triggers.ts';
import { PID_FILE, installGlobalHooks, uninstallGlobalHooks } from '../src/server/globalHooks.ts';
import { rmSync } from 'node:fs';

test('git push: pre-push scan blocks a secret; a clean push lands and queues the post-push review in the daemon', async () => {
  const db = openDb();
  ensureDefaults(db);
  const claude = new ClaudeRunner(db);
  const mgr = new RunManager(db, claude);
  const server = startHttp(db, mgr, new PostPushWatcher(db, mgr), 0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as any).port;
  db.setSettings({ ...db.getSettings(), port, debounceSec: 0, postPushPrsOnly: false, claudeBin: FAKE_CLAUDE, claudeExtraArgs: [], notifications: false });

  const remote = mkdtempSync(join(process.env.TMPDIR!, 'purr-test-remote-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const repo = tempRepo({ 'app.js': 'export const x = 1;\n' });
  sh(repo, 'remote', 'add', 'origin', remote);
  sh(repo, 'push', '-q', 'origin', 'main', '--no-verify');
  const registered = await addRepo(db, repo);
  await installGlobalHooks();                      // writes the throwaway GIT_CONFIG_GLOBAL from helpers.ts
  writeFileSync(PID_FILE, String(process.pid));   // the service "runs" in this process
  try {
    sh(repo, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(repo, 'app.js'), `export const x = 1;\nconst k = "${FAKE_AWS}";\n`);
    sh(repo, 'commit', '-qam', 'leak', '--no-verify');
    const blocked = await run(repo, 'push', '-u', 'origin', 'feature');
    assert.notEqual(blocked.status, 0, 'push with a secret is blocked');
    assert.match(blocked.stderr, /Push blocked by purr/);

    writeFileSync(join(repo, 'app.js'), 'export const x = 1;\nexport function avg(t, n) {\n  return t / n;\n}\n');
    sh(repo, 'commit', '-qam', 'fix: no secret; add avg', '--no-verify');
    // history still contains the secret commit; pre-push scans the whole range being pushed, so squash it away first
    sh(repo, 'reset', '--soft', 'main');
    sh(repo, 'commit', '-qm', 'add avg', '--no-verify');
    const ok = await run(repo, 'push', '-u', 'origin', 'feature');
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stderr, /feature will be reviewed once the push lands/);
    const head = sh(repo, 'rev-parse', 'HEAD');
    assert.ok(ok.stderr.includes(`purr findings --sha ${head.slice(0, 12)} --wait`), 'the hook says how to get the results');
    // a session asks straight after pushing, before the review exists: --wait covers the gap
    const waited = cli(repo, 'findings', '--wait', '--json', '--timeout', '30');

    // the daemon confirms the remote moved, then runs the post-push flow in the background
    let post;
    for (let i = 0; i < 100 && !post; i++) {
      await new Promise((r) => setTimeout(r, 200));
      post = db.listRuns(50).find((r) => r.trigger === 'post-push' && r.headSha === head && ['passed', 'failed', 'blocked'].includes(r.status));
    }
    assert.ok(post, 'post-push run finished');
    assert.equal(post!.status, 'passed', post!.error ?? '');
    assert.equal(post!.branch, 'feature');
    assert.equal(post!.headSha, sh(repo, 'rev-parse', 'HEAD'));
    const findings = db.getRunFindings(post!.id);
    assert.ok(Array.isArray(findings));
    const w = await waited;
    const out = JSON.parse(w.stdout);
    assert.equal(out.run.id, post!.id);
    assert.equal(out.findings.length, findings.length);
    assert.equal(w.status, findings.some((f) => f.severity === 'must_fix') ? 1 : 0, 'exit 1 on a must-fix, like purr run');
    const prePush = db.listRuns(50).filter((r) => r.trigger === 'pre-push' && r.repoId === registered.id);
    assert.deepEqual(prePush.map((r) => r.status).sort(), ['blocked', 'passed']);
  } finally {
    await uninstallGlobalHooks();
    rmSync(PID_FILE, { force: true });
    server.close();
    db.close();
  }
});
