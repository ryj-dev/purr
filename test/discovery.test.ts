import { sh, tempRepo } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync } from 'node:fs';
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

test('project folders that differ only in letter case count once (case-insensitive disks)', async (t) => {
  const { uniqueFolders } = await import('../src/server/db.ts');
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR!, 'purr-Case-')));
  const upper = dir.replace(/purr-Case-/, 'PURR-CASE-');
  if (!existsSync(upper)) return t.skip('this disk is case-sensitive: the two names are two folders');
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
  const watcher = new PostPushWatcher(db, mgr, { fetchPrs: async () => ({ prs, answered: [...new Set(prs.map((p) => p.account))] }) });

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

test('a push made before its PR is opened is reviewed when the PR opens; one review per push across clones', async () => {
  const db = openDb(); ensureDefaults(db);
  const mgr = new RunManager(db, new ClaudeRunner(db));
  const scheduled: RunRequest[] = [];
  mgr.schedulePostPush = (req: RunRequest) => { scheduled.push(req); };
  const { root, a } = projectsFolder();
  sh(a, 'remote', 'add', 'origin', 'https://github.com/work-org/app-c.git');
  db.setSettings({ ...db.getSettings(), projectFolders: [root], postPushPrsOnly: true });
  // a second clone of the same GitHub repo, as a separate registered repo (a worktree a commit came from)
  const wt = join(root, 'app-a-wt');
  const { addRepo } = await import('../src/server/http.ts');
  await addRepo(db, wt);
  let prs: OpenPr[] = [];
  let openPr: OpenPr | null = null;   // what `gh pr view <branch>` finds
  const watcher = new PostPushWatcher(db, mgr, {
    fetchPrs: async () => ({ prs, answered: ['work'] }),
    lsRemote: async () => pushed,    // the push has landed
    ghAuthed: async () => true,
    prForBranch: async () => openPr,
  });
  let pushed = '';
  await watcher.poll();   // discover + prime

  // the push hook reports c1 before any PR exists: nothing is reviewed yet...
  pushed = 'c1';
  await watcher.pushIntent({ repoPath: a, branch: 'feat', sha: 'c1' });
  await watcher.settled();
  assert.equal(scheduled.length, 0, 'no PR, no review');
  // ...and when the PR is opened, the poller reviews c1, because the hook didn't mark it as handled
  prs = [{ repo: 'work-org/app-c', number: 5, headRefOid: 'c1', headRefName: 'feat', baseRefName: 'main', title: 't', body: '',
    url: 'u', isDraft: false, account: 'work', createdAt: new Date().toISOString() }];
  await watcher.poll();
  assert.deepEqual(scheduled.map((r) => r.head), ['c1']);

  // the next push comes through the hook from the worktree clone; the poller then sees the same sha via the main
  // checkout and must not review it a second time
  openPr = prs[0];
  pushed = 'c2';
  await watcher.pushIntent({ repoPath: wt, branch: 'feat', sha: 'c2' });
  await watcher.settled();
  assert.deepEqual(scheduled.map((r) => r.head), ['c1', 'c2'], 'the hook reviews a push to an open PR');
  prs = [{ ...prs[0], headRefOid: 'c2' }];
  await watcher.poll();
  assert.deepEqual(scheduled.map((r) => r.head), ['c1', 'c2'], 'no duplicate review');

  // the poller sees c3 first (pushed from another machine), then this machine's hook reports the same push
  prs = [{ ...prs[0], headRefOid: 'c3' }];
  await watcher.poll();
  pushed = 'c3';
  await watcher.pushIntent({ repoPath: a, branch: 'feat', sha: 'c3' });
  await watcher.settled();
  assert.deepEqual(scheduled.map((r) => r.head), ['c1', 'c2', 'c3'], 'hook after poller: one review');

  // the same push reported by the hooks of two clones (main checkout, then the worktree)
  pushed = 'c4';
  await watcher.pushIntent({ repoPath: a, branch: 'feat', sha: 'c4' });
  await watcher.pushIntent({ repoPath: wt, branch: 'feat', sha: 'c4' });
  await watcher.settled();
  assert.deepEqual(scheduled.map((r) => r.head), ['c1', 'c2', 'c3', 'c4'], 'hook from each clone: one review');

  // post-push is off for the worktree's repo row only: its hook mustn't claim the push, so the poller reviews it
  // through the main checkout (main checkouts come before worktrees)
  db.setTrigger({ trigger: 'post-push', repoId: db.getRepoByPath(wt)!.id, flowId: null });
  pushed = 'c5';
  await watcher.pushIntent({ repoPath: wt, branch: 'feat', sha: 'c5' });
  await watcher.settled();
  assert.equal(scheduled.length, 4, 'the disabled clone schedules nothing');
  prs = [{ ...prs[0], headRefOid: 'c5' }];
  await watcher.poll();
  assert.deepEqual(scheduled.map((r) => r.head), ['c1', 'c2', 'c3', 'c4', 'c5']);
  assert.equal(scheduled[4].repoPath, a, 'reviewed in the main checkout');

  // and the other way round: off for the main checkout, on for the worktree, so the poller reviews there
  db.deleteTrigger('post-push', db.getRepoByPath(wt)!.id);
  db.setTrigger({ trigger: 'post-push', repoId: db.getRepoByPath(a)!.id, flowId: null });
  prs = [{ ...prs[0], headRefOid: 'c6' }];
  await watcher.poll();
  assert.deepEqual(scheduled.map((r) => r.head), ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
  assert.equal(scheduled[5].repoPath, wt, 'the first clone with post-push on');
  db.deleteTrigger('post-push', db.getRepoByPath(a)!.id);
  db.close();
});

test('project folders: the common ones by default, an emptied list stays empty, and Settings tidies what it saves', async () => {
  const { openDb: open, defaultProjectFolders } = await import('../src/server/db.ts');
  const { startHttp } = await import('../src/server/http.ts');
  const db = open(join(mkdtempSync(join(process.env.TMPDIR!, 'purr-db-')), 'purr.db'));
  assert.deepEqual(db.getSettings().projectFolders, defaultProjectFolders(), 'fresh: the common folders on this machine');
  db.setSettings({ ...db.getSettings(), projectFolders: [] });
  assert.deepEqual(db.getSettings().projectFolders, [], 'emptied on purpose: not refilled');

  const mgr = new RunManager(db, new ClaudeRunner(db));
  const server = startHttp(db, mgr, new PostPushWatcher(db, mgr), 0);
  await new Promise((r) => server.once('listening', r));
  try {
    const home = realpathSync(process.env.HOME!);
    const put = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/settings`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectFolders: ['~', '  ', '', ` ${home} `] }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual(db.getSettings().projectFolders, [home], '~ expanded, blanks dropped (not the cwd), duplicates merged');
  } finally { server.close(); db.close(); }
});

test('a PR opened during a gh outage longer than ten minutes is still reviewed; one that predates the last poll is not', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const db = openDb(); ensureDefaults(db);
  const mgr = new RunManager(db, new ClaudeRunner(db));
  const scheduled: string[] = [];
  mgr.schedulePostPush = (req: RunRequest) => { scheduled.push(req.head!); };
  const { root, a } = projectsFolder();
  sh(a, 'remote', 'add', 'origin', 'https://github.com/work-org/app-d.git');
  db.setSettings({ ...db.getSettings(), projectFolders: [root] });
  let prs: OpenPr[] = [];
  let answered = ['me'];
  const watcher = new PostPushWatcher(db, mgr, { fetchPrs: async () => ({ prs, answered }) });
  const pr = (n: number, sha: string, opened: number): OpenPr => ({ repo: 'work-org/app-d', number: n, headRefOid: sha, headRefName: `b${n}`,
    baseRefName: 'main', title: 't', body: '', url: 'u', isDraft: false, account: 'me', createdAt: new Date(opened).toISOString() });
  try {
    await watcher.poll();                      // a good poll
    answered = [];                             // offline: every account's query fails, and the list is empty...
    t.mock.timers.tick(5 * 60_000);
    const openedInOutage = Date.now();
    t.mock.timers.tick(20 * 60_000);
    await watcher.poll();
    answered = ['me'];
    prs = [pr(1, 's1', openedInOutage)];       // ...and back, 25 minutes on
    await watcher.poll();
    assert.deepEqual(scheduled, ['s1']);
    t.mock.timers.tick(60_000);
    prs = [pr(1, 's1', openedInOutage), pr(2, 's2', openedInOutage)];   // first seen now (say its repo was just cloned)
    await watcher.poll();
    assert.deepEqual(scheduled, ['s1'], 'opened before the last good poll: already open, not new');
  } finally { t.mock.timers.reset(); db.close(); }
});
