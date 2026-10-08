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

test('poll marks are per account: one account\'s outage loses none of its PRs, and a newly added account\'s old PRs aren\'t new', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const db = openDb(); ensureDefaults(db);
  const mgr = new RunManager(db, new ClaudeRunner(db));
  const scheduled: string[] = [];
  mgr.schedulePostPush = (req: RunRequest) => { scheduled.push(req.head!); };
  const { root, a } = projectsFolder();
  sh(a, 'remote', 'add', 'origin', 'https://github.com/work-org/app-e.git');
  db.setSettings({ ...db.getSettings(), projectFolders: [root] });
  let prs: OpenPr[] = [];
  let answered = ['me', 'work'];
  const watcher = new PostPushWatcher(db, mgr, { fetchPrs: async () => ({ prs, answered }) });
  const pr = (n: number, account: string, opened: number): OpenPr => ({ repo: 'work-org/app-e', number: n, headRefOid: `s${n}`, headRefName: `b${n}`,
    baseRefName: 'main', title: 't', body: '', url: 'u', isDraft: false, account, createdAt: new Date(opened).toISOString() });
  try {
    await watcher.poll();
    answered = ['me'];                               // work's token fails for a while; me keeps answering
    t.mock.timers.tick(60_000);
    const gap = Date.now();
    t.mock.timers.tick(20 * 60_000);
    await watcher.poll();
    answered = ['me', 'work'];
    prs = [pr(1, 'work', gap)];
    await watcher.poll();
    assert.deepEqual(scheduled, ['s1'], "opened during work's outage: still new to work");

    t.mock.timers.tick(60_000);
    const before = Date.now() - 30 * 60_000;         // opened long ago by an account signed in only now
    answered = ['me', 'work', 'personal'];
    prs = [...prs, pr(2, 'personal', before)];
    await watcher.poll();
    assert.deepEqual(scheduled, ['s1'], 'an account seen for the first time brings already-open PRs');
    t.mock.timers.tick(5 * 60_000);
    prs = [...prs, pr(3, 'personal', Date.now())];
    await watcher.poll();
    assert.deepEqual(scheduled, ['s1', 's3'], 'its new PRs are reviewed');
  } finally { t.mock.timers.reset(); db.close(); }
});

test('a push is reviewed by the hook when gh is signed out or reviews aren\'t PR-only, and the poller doesn\'t review it again', async () => {
  const db = openDb(); ensureDefaults(db);
  const mgr = new RunManager(db, new ClaudeRunner(db));
  const scheduled: RunRequest[] = [];
  mgr.schedulePostPush = (req: RunRequest) => { scheduled.push(req); };
  const { root, a } = projectsFolder();
  sh(a, 'remote', 'add', 'origin', 'https://github.com/work-org/app-f.git');
  db.setSettings({ ...db.getSettings(), projectFolders: [root], postPushPrsOnly: true });
  let authed = false, pushed = '';
  let prs: OpenPr[] = [];
  const watcher = new PostPushWatcher(db, mgr, {
    fetchPrs: async () => ({ prs, answered: ['me'] }), lsRemote: async () => pushed, ghAuthed: async () => authed, prForBranch: async () => null,
  });
  await watcher.poll();
  pushed = 'h1';
  await watcher.pushIntent({ repoPath: a, branch: 'feat', sha: 'h1' });
  await watcher.settled();
  assert.deepEqual(scheduled.map((r) => [r.head, r.pr]), [['h1', null]], 'no gh: reviewed against the default branch, no PR');

  authed = true;
  db.setSettings({ ...db.getSettings(), postPushPrsOnly: false });
  pushed = 'h2';
  await watcher.pushIntent({ repoPath: a, branch: 'feat', sha: 'h2' });
  await watcher.settled();
  assert.deepEqual(scheduled.map((r) => r.head), ['h1', 'h2'], 'not PR-only: reviewed without a PR');
  prs = [{ repo: 'work-org/app-f', number: 4, headRefOid: 'h2', headRefName: 'feat', baseRefName: 'main', title: 't', body: '', url: 'u',
    isDraft: false, account: 'me', createdAt: new Date().toISOString() }];
  await watcher.poll();
  assert.deepEqual(scheduled.map((r) => r.head), ['h1', 'h2'], 'the PR then opened on h2 is not reviewed twice');
  db.close();
});

test('a draft marked ready, a push made while post-push was off, and an account failing since startup all still get reviewed', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const db = openDb(); ensureDefaults(db);
  const mgr = new RunManager(db, new ClaudeRunner(db));
  const scheduled: string[] = [];
  mgr.schedulePostPush = (req: RunRequest) => { scheduled.push(req.head!); };
  const { root, a } = projectsFolder();
  sh(a, 'remote', 'add', 'origin', 'https://github.com/work-org/app-g.git');
  db.setSettings({ ...db.getSettings(), projectFolders: [root] });
  let prs: OpenPr[] = [];
  let answered = ['me'];
  const watcher = new PostPushWatcher(db, mgr, { fetchPrs: async () => ({ prs, answered, accounts: ['me', 'work'] }) });
  const t0 = Date.now();
  const pr = (n: number, sha: string, over: Partial<OpenPr> = {}): OpenPr => ({ repo: 'work-org/app-g', number: n, headRefOid: sha,
    headRefName: `b${n}`, baseRefName: 'main', title: 't', body: '', url: 'u', isDraft: false, account: 'me',
    createdAt: new Date().toISOString(), ...over });
  try {
    await watcher.poll();                          // work's query fails from the start
    t.mock.timers.tick(60_000);
    prs = [pr(1, 'd1', { isDraft: true })];
    await watcher.poll();
    assert.deepEqual(scheduled, [], 'a draft is not reviewed');
    t.mock.timers.tick(60_000);
    prs = [pr(1, 'd1')];                           // marked ready, same head
    await watcher.poll();
    assert.deepEqual(scheduled, ['d1'], 'marked ready: reviewed');

    // a PR opened long ago, first seen while post-push is off for every clone, is pushed to once it's back on
    const id = db.getRepoByPath(a)!.id;
    const old = new Date(Date.now() - 86_400_000).toISOString();
    db.setTrigger({ trigger: 'post-push', repoId: id, flowId: null });
    prs = [pr(1, 'd1'), pr(3, 'x1', { createdAt: old })];
    await watcher.poll();
    db.deleteTrigger('post-push', id);
    prs = [pr(1, 'd1'), pr(3, 'x2', { createdAt: old })];
    await watcher.poll();
    assert.deepEqual(scheduled, ['d1', 'x2'], 'a new head on a PR it already knew, not an old PR seen for the first time');
    prs = [pr(1, 'd3'), pr(3, 'x2', { createdAt: old })];
    await watcher.poll();
    assert.deepEqual(scheduled, ['d1', 'x2', 'd3']);

    t.mock.timers.tick(60_000);
    answered = ['me', 'work'];                     // work answers at last, with a PR it opened after startup
    // opened just after startup, long before "now minus the slack": only the since-startup mark lets it count
    prs = [pr(1, 'd3'), pr(2, 'w1', { account: 'work', createdAt: new Date(t0 + 10_000).toISOString() })];
    await watcher.poll();
    assert.deepEqual(scheduled, ['d1', 'x2', 'd3', 'w1'], 'listed since startup: its PRs from since then are new');
  } finally { t.mock.timers.reset(); db.close(); }
});

test('signing in to gh after startup brings no old PRs; a slow multi-account poll loses no new one; a newly added remote isn\'t reviewed twice', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const db = openDb(); ensureDefaults(db);
  const mgr = new RunManager(db, new ClaudeRunner(db));
  const scheduled: string[] = [];
  mgr.schedulePostPush = (req: RunRequest) => { scheduled.push(req.head!); };
  const { root, a } = projectsFolder();
  db.setSettings({ ...db.getSettings(), projectFolders: [root], postPushPrsOnly: false });
  let fetched: any = null;                         // gh signed out at startup
  let pushed = '';
  const watcher = new PostPushWatcher(db, mgr, {
    fetchPrs: async () => fetched, lsRemote: async () => pushed, ghAuthed: async () => true, prForBranch: async () => null,
  });
  const t0 = Date.now();
  const pr = (n: number, sha: string, opened: number): OpenPr => ({ repo: 'work-org/app-h', number: n, headRefOid: sha, headRefName: 'feat',
    baseRefName: 'main', title: 't', body: '', url: 'u', isDraft: false, account: 'me', createdAt: new Date(opened).toISOString() });
  try {
    await watcher.poll();
    t.mock.timers.tick(3 * 86_400_000);            // days later, signed in from the Toolchain popup
    fetched = { prs: [pr(2, 'old', t0 + 60_000)], answered: ['me'], askedAt: { me: Date.now() } };
    await watcher.poll();
    assert.deepEqual(scheduled, [], 'PR 2 was open before signing in');

    // registered with no remote, and its PR already known at k0: the hook adds origin's owner/name before marking
    // its push of k1, so the poller, seeing the PR move to k1, knows the hook has it
    t.mock.timers.tick(60_000);
    fetched = { ...fetched, prs: [pr(2, 'old', t0 + 60_000), pr(1, 'k0', Date.now())], askedAt: { me: Date.now() } };
    db.setSettings({ ...db.getSettings(), postPushPrsOnly: true });
    db.putRepo({ ...db.getRepoByPath(a)!, remoteUrl: null });
    await watcher.poll();                          // no clone matches work-org/app-h yet
    sh(a, 'remote', 'add', 'origin', 'https://github.com/work-org/app-h.git');
    db.setSettings({ ...db.getSettings(), postPushPrsOnly: false });
    pushed = 'k1';
    await watcher.pushIntent({ repoPath: a, branch: 'feat', sha: 'k1' });
    await watcher.settled();
    assert.deepEqual(scheduled, ['k1']);
    fetched = { ...fetched, prs: [pr(2, 'old', t0 + 60_000), pr(1, 'k1', Date.now() - 60_000)], askedAt: { me: Date.now() - 5 * 60_000 } };
    await watcher.poll();
    assert.deepEqual(scheduled, ['k1'], 'k1 reviewed once');

    // that poll asked "me" five minutes before it finished: a PR opened four minutes ago wasn't in its answer
    fetched = { ...fetched, prs: [...fetched.prs, pr(3, 'new', Date.now() - 4 * 60_000)], askedAt: { me: Date.now() } };
    await watcher.poll();
    assert.deepEqual(scheduled, ['k1', 'new']);
  } finally { t.mock.timers.reset(); db.close(); }
});

test('gh offline at login: accounts that turn up in the first quarter hour were there all along', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const db = openDb(); ensureDefaults(db);
  const mgr = new RunManager(db, new ClaudeRunner(db));
  const scheduled: string[] = [];
  mgr.schedulePostPush = (req: RunRequest) => { scheduled.push(req.head!); };
  const { root, a } = projectsFolder();
  sh(a, 'remote', 'add', 'origin', 'https://github.com/work-org/app-i.git');
  db.setSettings({ ...db.getSettings(), projectFolders: [root] });
  let fetched: any = null;                         // no network yet
  const watcher = new PostPushWatcher(db, mgr, { fetchPrs: async () => fetched });
  const t0 = Date.now();
  try {
    await watcher.poll();
    t.mock.timers.tick(8 * 60_000);                // network up eight minutes later; a PR was opened from the web meanwhile
    fetched = { prs: [{ repo: 'work-org/app-i', number: 1, headRefOid: 'n1', headRefName: 'x', baseRefName: 'main', title: 't', body: '', url: 'u',
      isDraft: false, account: 'me', createdAt: new Date(t0 + 4 * 60_000).toISOString() }], answered: ['me'] };
    await watcher.poll();
    assert.deepEqual(scheduled, ['n1']);
  } finally { t.mock.timers.reset(); db.close(); }
});
