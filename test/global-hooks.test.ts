import { FAKE_AWS, sh, tempRepo } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// helpers.ts points GIT_CONFIG_GLOBAL at a throwaway file, so the real ~/.gitconfig is never touched
const gitGlobal = process.env.GIT_CONFIG_GLOBAL!;
const userHooks = mkdtempSync(join(process.env.TMPDIR!, 'purr-userhooks-'));

import { installGlobalHooks, uninstallGlobalHooks, GLOBAL_HOOKS_DIR, PID_FILE, repoOwnHooksPath } from '../src/server/globalHooks.ts';
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
  writeFileSync(join(repo, 'a.txt'), `key ${FAKE_AWS}\n`);
  git(repo, 'add', '-A');
  let r = git(repo, 'commit', '-m', 'one');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /REPO-HOOK-RAN/);
  assert.match(r.stderr, /USER-GLOBAL-HOOK-RAN/);
  assert.doesNotMatch(r.stderr, /purr/);

  // purr running: the same kind of change is blocked, and the repo is registered automatically
  writeFileSync(PID_FILE, String(process.pid));
  writeFileSync(join(repo, 'b.txt'), `key2 ${FAKE_AWS}\n`);
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

test('repos with their own core.hooksPath are spotted; global and PuRR paths are not', async () => {
  writeFileSync(gitGlobal, `[core]\n\thooksPath = ${GLOBAL_HOOKS_DIR}\n`);
  const repo = tempRepo();
  assert.equal(await repoOwnHooksPath(repo), null, 'inherits the global setting');
  git(repo, 'config', 'core.hooksPath', '.githooks');
  assert.equal(await repoOwnHooksPath(repo), '.githooks');
  git(repo, 'config', 'core.hooksPath', `${GLOBAL_HOOKS_DIR}/`);
  assert.equal(await repoOwnHooksPath(repo), null, "pointing at PuRR's own folder still runs PuRR");
  git(repo, 'config', '--unset', 'core.hooksPath');
  assert.equal(await repoOwnHooksPath(repo), null);
  // set for one worktree only (husky can do this)
  git(repo, 'config', 'extensions.worktreeConfig', 'true');
  git(repo, 'config', '--worktree', 'core.hooksPath', '.husky/_');
  assert.equal(await repoOwnHooksPath(repo), '.husky/_', 'worktree scope counts');
  assert.equal(await repoOwnHooksPath(join(repo, 'missing')), null, 'a repo that is gone is not flagged');
  writeFileSync(gitGlobal, '');
});

test('own-hooks flags refresh in the background: never awaited, one refresh at a time, change announced once', async () => {
  const { ownHooksTracker } = await import('../src/server/http.ts');
  writeFileSync(gitGlobal, `[core]\n\thooksPath = ${GLOBAL_HOOKS_DIR}\n`);
  const a = tempRepo();
  const b = tempRepo();
  git(a, 'config', 'core.hooksPath', '.githooks');
  const repos = [a, b].map((path, i) => ({ id: `r${i}`, path, name: `r${i}`, remoteUrl: null, addedAt: '' }));
  let changes = 0;
  const t = ownHooksTracker(() => changes++, 50);
  assert.deepEqual(t.get(repos), {}, 'the first call answers at once, before git has');
  const first = t.settled();
  t.get(repos);
  assert.equal(t.settled(), first, 'a second call while refreshing shares the same refresh');
  await first;
  assert.deepEqual(t.get(repos), { r0: '.githooks' });
  assert.equal(changes, 1, 'the change is announced so open windows refetch');
  await new Promise((r) => setTimeout(r, 60));
  t.get(repos);
  await t.settled();
  assert.equal(changes, 1, 'a refresh with the same answer stays quiet');
  git(a, 'config', '--unset', 'core.hooksPath');
  await new Promise((r) => setTimeout(r, 60));
  t.get(repos);
  await t.settled();
  assert.deepEqual(t.get(repos), {});
  assert.equal(changes, 2);
  writeFileSync(gitGlobal, '');
});
