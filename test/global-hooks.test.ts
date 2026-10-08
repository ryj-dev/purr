import { FAKE_SECRET, sh, tempRepo } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// helpers.ts points GIT_CONFIG_GLOBAL at a throwaway file, so the real ~/.gitconfig is never touched
const gitGlobal = process.env.GIT_CONFIG_GLOBAL!;
const userHooks = mkdtempSync(join(process.env.TMPDIR!, 'purr-userhooks-'));

import { installGlobalHooks, uninstallGlobalHooks, GLOBAL_HOOKS_DIR, PID_FILE } from '../src/server/globalHooks.ts';
import { openDb } from '../src/server/db.ts';

const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8', env: process.env });
const globalHooksPath = () => spawnSync('git', ['config', '--global', '--get', 'core.hooksPath'], { encoding: 'utf8' }).stdout.trim();

test('global hooks: every repo gets purr while it runs, existing hooks keep running, uninstall restores', async () => {
  writeFileSync(gitGlobal, `[core]\n\thooksPath = ${userHooks}\n`);
  // the user already had a global hooks path with a commit-msg hook
  writeFileSync(join(userHooks, 'commit-msg'), '#!/bin/sh\necho USER-GLOBAL-HOOK-RAN >&2\n');
  chmodSync(join(userHooks, 'commit-msg'), 0o755);

  const g = await installGlobalHooks();
  assert.equal(g.changed, true);
  assert.equal(g.previous, userHooks);
  assert.equal(globalHooksPath(), GLOBAL_HOOKS_DIR);
  assert.equal((await installGlobalHooks()).changed, false, 'idempotent');

  const repo = tempRepo();
  // a repo-local hook (e.g. git-lfs) must still run even though core.hooksPath is global
  writeFileSync(join(repo, '.git/hooks/post-commit'), '#!/bin/sh\necho REPO-HOOK-RAN >&2\n');
  chmodSync(join(repo, '.git/hooks/post-commit'), 0o755);

  // purr not running (no live pid file): the secret goes through, other hooks still run
  rmSync(PID_FILE, { force: true });
  writeFileSync(join(repo, 'a.txt'), `key ${FAKE_SECRET}\n`);
  git(repo, 'add', '-A');
  let r = git(repo, 'commit', '-m', 'one');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /REPO-HOOK-RAN/);
  assert.match(r.stderr, /USER-GLOBAL-HOOK-RAN/);
  assert.doesNotMatch(r.stderr, /purr/);

  // purr running: the same kind of change is blocked, and the repo is registered automatically
  writeFileSync(PID_FILE, String(process.pid));
  writeFileSync(join(repo, 'b.txt'), `key2 ${FAKE_SECRET}\n`);
  git(repo, 'add', '-A');
  r = git(repo, 'commit', '-m', 'two');
  assert.notEqual(r.status, 0, 'blocked while PuRR runs');
  assert.match(r.stderr, /BLOCKED/);
  const db = openDb();
  assert.ok(db.listRepos().some((x) => x.path === sh(repo, 'rev-parse', '--show-toplevel') || existsSync(x.path)), 'repo registered on first commit');
  db.close();

  // PURR_SKIP skips PuRR only
  r = spawnSync('git', ['commit', '-m', 'two'], { cwd: repo, encoding: 'utf8', env: { ...process.env, PURR_SKIP: '1' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /USER-GLOBAL-HOOK-RAN/);

  // uninstall puts the user's own global hooks path back
  const msg = await uninstallGlobalHooks();
  assert.match(msg, /restored/);
  assert.equal(globalHooksPath(), userHooks);
  assert.equal(existsSync(GLOBAL_HOOKS_DIR), false);
  rmSync(PID_FILE, { force: true });
  assert.ok(readFileSync(gitGlobal, 'utf8').includes(userHooks));
  writeFileSync(gitGlobal, '');   // leave the shared test config empty for the other tests
});
