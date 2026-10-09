import { FAKE_SECRET, sh, tempRepo } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDb } from '../src/server/db.ts';
import { ensureDefaults } from '../src/server/flows/store.ts';
import { ClaudeRunner } from '../src/server/claude.ts';
import { RunManager } from '../src/server/manager.ts';
import { GLOBAL_HOOKS_DIR, PID_FILE, installGlobalHooks, uninstallGlobalHooks } from '../src/server/globalHooks.ts';
import { rmSync } from 'node:fs';
import { exec } from '../src/server/util.ts';

test('pre-push after a rebase only scans your own commits, not the base branch ones it pulled in', async () => {
  const db = openDb(); ensureDefaults(db);
  const mgr = new RunManager(db, new ClaudeRunner(db));
  const repo = tempRepo({ 'a.txt': 'a\n' });
  sh(repo, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(repo, 'f.txt'), 'feature work\n');
  sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', 'feature', '--no-verify');
  const oldTip = sh(repo, 'rev-parse', 'HEAD');
  sh(repo, 'checkout', '-q', 'main');
  writeFileSync(join(repo, 'teammate.txt'), `key ${FAKE_SECRET}\n`);   // someone else's commit on main
  sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', 'teammate', '--no-verify');
  sh(repo, 'checkout', '-q', 'feature'); sh(repo, 'rebase', '-q', 'main');
  const req = { trigger: 'pre-push' as const, repoPath: repo, mode: 'range' as const, head: sh(repo, 'rev-parse', 'HEAD'), base: oldTip, branch: 'feature' };
  const done = await mgr.execute(req, mgr.createRun(req)!);
  assert.equal(done.status, 'passed', 'the teammate\'s secret is not in your push');
  assert.equal(done.baseSha, sh(repo, 'rev-parse', 'main'));
  db.close();
});

test('a command that hangs with a grandchild holding stdout still times out', async () => {
  const t0 = Date.now();
  const r = await exec('/bin/sh', ['-c', 'sleep 30 & sleep 30'], { timeoutMs: 500 });
  assert.ok(r.timedOut);
  assert.ok(Date.now() - t0 < 6000, `took ${Date.now() - t0}ms`);
});

test('an already-cancelled signal never starts a process', async () => {
  const c = new AbortController(); c.abort();
  const r = await exec('/bin/sleep', ['5'], { signal: c.signal });
  assert.equal(r.code, -1);
});

test('the hook fails open when PuRR itself is broken, and blocks only on exit 1', async () => {
  const repo = tempRepo();
  await installGlobalHooks();
  writeFileSync(PID_FILE, String(process.pid));   // "PuRR is running", so the hook tries to call it
  const p = join(GLOBAL_HOOKS_DIR, 'pre-commit');
  // simulate purr having moved away, with no `purr` on PATH either
  writeFileSync(p, readFileSync(p, 'utf8').replace(/^(\s*)PURR_BIN=.*$/m, "$1PURR_BIN='/nonexistent/purr'"));
  writeFileSync(join(repo, 'leak.txt'), `token ${FAKE_SECRET}\n`);
  sh(repo, 'add', 'leak.txt');
  const r = spawnSync('git', ['commit', '-m', 'x'], { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin' } });
  assert.equal(r.status, 0, 'commit proceeds');
  assert.match(r.stderr, /purr: not found, skipping/);
  await uninstallGlobalHooks();
  rmSync(PID_FILE, { force: true });
});
