import { sh, tempRepo } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/server/db.ts';
import { ensureDefaults } from '../src/server/flows/store.ts';
import { ClaudeRunner } from '../src/server/claude.ts';
import { RunManager, type RunRequest } from '../src/server/manager.ts';
import { PostPushWatcher } from '../src/server/triggers.ts';
import { findRepos, discoverRepos } from '../src/server/discovery.ts';
import { githubRepo, type OpenPr } from '../src/server/gh.ts';

function projectsFolder() {
  const root = realpathSync(mkdtempSync(join(process.env.TMPDIR!, 'purr-projects-')));
  const move = (repo: string, to: string) => { mkdirSync(join(root, to, '..'), { recursive: true }); renameSync(repo, join(root, to)); return join(root, to); };
  const a = move(tempRepo(), 'app-a');
  const b = move(tempRepo(), 'org/app-b');
  move(tempRepo(), 'node_modules/dep');                 // skipped
  sh(a, 'worktree', 'add', '-q', join(root, 'app-a-wt'), '-b', 'wt');   // a worktree: not a main checkout
  return { root, a, b };
}

test('discovery finds main checkouts one and two levels down, not worktrees or node_modules', async () => {
  const { root, a, b } = projectsFolder();
  assert.deepEqual(findRepos(root).sort(), [a, b].sort());
  const db = openDb();
  db.setSettings({ ...db.getSettings(), projectFolders: [root] });
  assert.equal(await discoverRepos(db), 2);
  assert.equal(await discoverRepos(db), 0, 'already known');
  assert.ok(db.listRepos().some((r) => r.path === a) && db.listRepos().some((r) => r.path === b));
  db.close();
});

test('project folders that differ only in letter case count once (case-insensitive disks)', async () => {
  const { uniqueFolders } = await import('../src/server/db.ts');
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR!, 'purr-Case-')));
  const upper = dir.replace(/purr-Case-/, 'PURR-CASE-');
  assert.deepEqual(uniqueFolders([dir, upper, dir]), [dir]);
});

test('githubRepo reads every remote form', () => {
  assert.equal(githubRepo('https://github.com/Org/Repo.git'), 'org/repo');
  assert.equal(githubRepo('https://someone@github.com/org/repo'), 'org/repo');
  assert.equal(githubRepo('git@github.com:org/repo.git'), 'org/repo');
  assert.equal(githubRepo('ssh://git@github.com/org/repo.git'), 'org/repo');
  assert.equal(githubRepo('https://gitlab.com/org/repo.git'), null);
  assert.equal(githubRepo(null), null);
});

test('the poller: reviews new PRs and new pushes, across accounts, never the backlog', async () => {
  const db = openDb(); ensureDefaults(db);
  const mgr = new RunManager(db, new ClaudeRunner(db));
  const scheduled: RunRequest[] = [];
  mgr.schedulePostPush = (req: RunRequest) => { scheduled.push(req); };
  const { root, a, b } = projectsFolder();
  sh(a, 'remote', 'add', 'origin', 'https://github.com/work-org/app-a.git');
  sh(b, 'remote', 'add', 'origin', 'git@github.com:me/app-b.git');
  db.setSettings({ ...db.getSettings(), projectFolders: [root] });

  const now = Date.now();
  let prs: OpenPr[] = [];
  const pr = (repo: string, number: number, sha: string, opts: Partial<OpenPr> = {}): OpenPr => ({
    repo, number, headRefOid: sha, headRefName: `branch-${number}`, baseRefName: 'main', title: `PR ${number}`, body: '',
    url: `https://github.com/${repo}/pull/${number}`, isDraft: false, account: 'work', createdAt: new Date(now - 86_400_000).toISOString(), ...opts,
  });
  const watcher = new PostPushWatcher(db, mgr, async () => prs);

  // already open when PuRR starts (or its repo is just discovered): recorded, not reviewed
  prs = [pr('work-org/app-a', 1, 'aaa1'), pr('me/app-b', 7, 'bbb1', { account: 'personal' }), pr('elsewhere/unknown', 3, 'ccc')];
  await watcher.poll();
  assert.equal(scheduled.length, 0, 'no review flood for the backlog');

  // a push to a PR it already knows: reviewed, in the main checkout (not the worktree), for either account
  prs = [pr('work-org/app-a', 1, 'aaa2'), pr('me/app-b', 7, 'bbb2', { account: 'personal' })];
  await watcher.poll();
  assert.deepEqual(scheduled.map((r) => [r.repoPath, r.head, r.branch, r.base]), [[a, 'aaa2', 'branch-1', 'main'], [b, 'bbb2', 'branch-7', 'main']]);

  // nothing new: nothing scheduled
  await watcher.poll();
  assert.equal(scheduled.length, 2);

  // a PR opened just now (after start): reviewed on first sight; a draft isn't
  prs = [...prs, pr('work-org/app-a', 9, 'aaa9', { createdAt: new Date().toISOString() }),
    pr('work-org/app-a', 10, 'aaa10', { createdAt: new Date().toISOString(), isDraft: true })];
  await watcher.poll();
  assert.deepEqual(scheduled.slice(2).map((r) => r.head), ['aaa9']);
  db.close();
});

test('the poller: a push without a PR still gets reviewed when the PR opens; one review per push across clones', async () => {
  const db = openDb(); ensureDefaults(db);
  const mgr = new RunManager(db, new ClaudeRunner(db));
  const scheduled: RunRequest[] = [];
  mgr.schedulePostPush = (req: RunRequest) => { scheduled.push(req); };
  const { root, a } = projectsFolder();
  sh(a, 'remote', 'add', 'origin', 'https://github.com/work-org/app-c.git');
  db.setSettings({ ...db.getSettings(), projectFolders: [root] });
  // a second clone of the same GitHub repo, as a separate registered repo (a worktree a commit came from)
  const wt = join(root, 'app-a-wt');
  const { addRepo } = await import('../src/server/http.ts');
  const wtRepo = await addRepo(db, wt);
  let prs: OpenPr[] = [];
  const watcher = new PostPushWatcher(db, mgr, async () => prs);
  await watcher.poll();   // discover + prime

  // pushed before the PR existed (the hook skipped it), then the PR is opened: the poller reviews it
  prs = [{ repo: 'work-org/app-c', number: 5, headRefOid: 'c1', headRefName: 'feat', baseRefName: 'main', title: 't', body: '',
    url: 'u', isDraft: false, account: 'work', createdAt: new Date().toISOString() }];
  await watcher.poll();
  assert.deepEqual(scheduled.map((r) => r.head), ['c1']);

  // the next push comes through the hook from the worktree clone; the poller then sees the same sha via the main
  // checkout and must not review it a second time
  watcher.markHandled(wtRepo, 'feat', 'c2');
  prs = [{ ...prs[0], headRefOid: 'c2' }];
  await watcher.poll();
  assert.deepEqual(scheduled.map((r) => r.head), ['c1'], 'no duplicate review');
  db.close();
});
