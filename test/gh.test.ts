import './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { accountSignedInSince, commentOnPr, forgetGhAccounts, ghAccounts, openPrsForAllAccounts, parseGhStatus, prForBranch } from '../src/server/gh.ts';

const TWO = `github.com
  ✓ Logged in to github.com account work-me (keyring)
  - Active account: false
  - Git operations protocol: https
  ✓ Logged in to github.com account me (keyring)
  - Active account: true
`;

test('gh auth status: one or several accounts (active first), older gh, and nothing', () => {
  assert.deepEqual(parseGhStatus(TWO), { accounts: ['me', 'work-me'], multi: true });
  assert.deepEqual(parseGhStatus('  ✓ Logged in to github.com account me (keyring)\n  - Active account: true\n'), { accounts: ['me'], multi: true });
  assert.deepEqual(parseGhStatus('github.com\n  ✓ Logged in to github.com as old-me (oauth_token)\n'), { accounts: ['old-me'], multi: false });
  assert.deepEqual(parseGhStatus('You are not logged into any GitHub hosts.'), { accounts: [], multi: false });
});

/** A fake gh on PATH: accounts from `status`, a token per account, a PR per token, comments logged with their token. */
function fakeGh(status: string, prs: Record<string, object>, statusExit = 0, commentExit = 0) {
  const dir = mkdtempSync(join(process.env.TMPDIR!, 'purr-fake-gh-'));
  writeFileSync(join(dir, 'status'), status);
  for (const [token, pr] of Object.entries(prs)) writeFileSync(join(dir, `pr-${token}.json`), JSON.stringify(pr));
  writeFileSync(join(dir, 'gh'), `#!/bin/sh
D="${dir}"
case "$1 $2" in
  "auth status") cat "$D/status"; exit ${statusExit} ;;
  "auth token") [ "$6" = "no-token" ] && exit 1; echo "tok-$6" ;;
  "pr view") f="$D/pr-\${GH_TOKEN:-none}.json"; [ -f "$f" ] || exit 1; cat "$f" ;;
  "api graphql") f="$D/graphql-\${GH_TOKEN:-none}.json"; [ -f "$f" ] || exit 1; cat "$f" ;;
  "pr comment") cat > /dev/null; echo "\${GH_TOKEN:-none} $3" >> "$D/comments"; exit ${commentExit} ;;
  *) exit 2 ;;
esac
`);
  chmodSync(join(dir, 'gh'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  forgetGhAccounts();
  return { dir, setStatus: (s: string) => writeFileSync(join(dir, 'status'), s), comments: () => existsSync(join(dir, 'comments')) ? readFileSync(join(dir, 'comments'), 'utf8').trim().split('\n') : [],
    restore: () => { process.env.PATH = path; forgetGhAccounts(); } };
}

const pr = (state: string) => ({ number: 7, title: 't', body: '', url: 'u', baseRefName: 'main', headRefName: 'feat', headRefOid: 'abc', isDraft: false, state });

test('prForBranch tries each account, keeps only an open PR, and says which account found it', async () => {
  let gh = fakeGh(TWO, { 'tok-work-me': pr('OPEN') });
  try {
    assert.deepEqual(await ghAccounts(), ['me', 'work-me']);
    const found = await prForBranch(process.cwd(), 'feat');
    assert.equal(found?.number, 7);
    assert.equal(found?.account, 'work-me', 'me saw nothing, work-me found it');
  } finally { gh.restore(); }
  gh = fakeGh(TWO, { 'tok-me': pr('MERGED') });
  try { assert.equal(await prForBranch(process.cwd(), 'feat'), null, 'a merged PR is no PR'); } finally { gh.restore(); }
  gh = fakeGh(TWO.replace('account me', 'account no-token'), { 'tok-work-me': pr('OPEN') });
  try { assert.equal((await prForBranch(process.cwd(), 'feat'))?.account, 'work-me', 'an account gh has no token for is skipped'); } finally { gh.restore(); }
});

test('a review comment is posted once, as the account that found the PR', async () => {
  const gh = fakeGh(TWO, {});
  try {
    assert.equal(await commentOnPr(process.cwd(), 7, 'body', 'work-me'), true);
    assert.equal(await commentOnPr(process.cwd(), 8, 'body'), true);
    assert.deepEqual(gh.comments(), ['tok-work-me 7', 'tok-me 8'], 'the found-by account, else the active one');
  } finally { gh.restore(); }
});

test('an older gh (one login, no --user) is used as it is, without a token per account', async () => {
  const gh = fakeGh('  ✓ Logged in to github.com as old-me (oauth_token)\n', { none: pr('OPEN') });
  try {
    assert.deepEqual(await ghAccounts(), ['old-me']);
    assert.equal((await prForBranch(process.cwd(), 'feat'))?.number, 7);
    await commentOnPr(process.cwd(), 7, 'b');
    assert.deepEqual(gh.comments(), ['none 7']);
  } finally { gh.restore(); }
  const unknown = fakeGh('Signed in, in words from a future gh\n', { none: pr('OPEN') });
  try { assert.equal((await ghAccounts()).length, 1, 'exit 0 means signed in, even unparsed'); } finally { unknown.restore(); }
  const out = fakeGh('You are not logged into any GitHub hosts.\n', {}, 1);
  try { assert.deepEqual(await ghAccounts(), []); } finally { out.restore(); }
});

test('a run keeps the account that found its PR, from the poller and from a manual review alike', async () => {
  const { runPr } = await import('../src/server/manager.ts');
  assert.deepEqual(runPr({ ...pr('OPEN'), account: 'work-me' } as any), { number: 7, title: 't', body: '', url: 'u', account: 'work-me' });
});

test('a comment falls back, when the finding account has signed out, to an account that can see the PR', async () => {
  const gh = fakeGh(TWO, { 'tok-work-me': pr('OPEN') });
  try {
    assert.equal(await commentOnPr(process.cwd(), 7, 'b', 'no-token'), true);
    assert.deepEqual(gh.comments(), ['tok-work-me 7'], 'me can\'t see the PR, work-me can');
  } finally { gh.restore(); }
  const none = fakeGh(TWO, {});
  try {
    assert.equal(await commentOnPr(process.cwd(), 7, 'b', 'no-token'), false);
    assert.deepEqual(none.comments(), [], 'no account can see it: nothing posted');
  } finally { none.restore(); }
});

test('a review posts its PR comment as the account that found the PR', async () => {
  const { RunManager } = await import('../src/server/manager.ts');
  const { ClaudeRunner } = await import('../src/server/claude.ts');
  const { openDb } = await import('../src/server/db.ts');
  const db = openDb(join(mkdtempSync(join(process.env.TMPDIR!, 'purr-db-')), 'purr.db'));
  const mgr = new RunManager(db, new ClaudeRunner(db));
  const gh = fakeGh(TWO, {});
  try {
    const run = { id: 'r', flowName: 'Full review', repoPath: process.cwd(), branch: 'feat', status: 'passed', error: null,
      flow: { blocks: [{ id: 'out', type: 'output', config: { notify: false, postPrComment: true } }], edges: [] },
      pr: { number: 7, title: 't', body: '', url: 'u', account: 'work-me' } } as any;
    const finding = { id: 'f', file: 'a.ts', line: 1, category: 'logic', severity: 'consider', title: 'x', scenario: 's', source: { blockId: 'b', kind: 'model' } };
    await (mgr as any).sideEffects(run, [finding]);
    assert.deepEqual(gh.comments(), ['tok-work-me 7'], 'not gh\'s active account (me)');
  } finally { gh.restore(); db.close(); }
});

test("a gh status that fails says nothing about which gh this is: comments still go as the account that found the PR", async () => {
  let gh = fakeGh(TWO, {});
  try { assert.deepEqual(await ghAccounts(), ['me', 'work-me']); } finally { gh.restore(); }
  gh = fakeGh('error connecting to api.github.com\n', {}, 1);
  try {
    assert.deepEqual(await ghAccounts(), []);
    await commentOnPr(process.cwd(), 7, 'b', 'work-me');
    assert.deepEqual(gh.comments(), ['tok-work-me 7'], 'still multi-account: a token for that account');
  } finally { gh.restore(); }
});

test('a comment that fails (it may have been posted anyway) is not tried again as another account', async () => {
  const gh = fakeGh(TWO, {}, 0, 1);
  try {
    assert.equal(await commentOnPr(process.cwd(), 7, 'b', 'work-me'), false);
    assert.deepEqual(gh.comments(), ['tok-work-me 7'], 'one attempt, as the account that found the PR');
  } finally { gh.restore(); }
});

test('a signed-in gh in words PuRR can\'t parse is used through its own login, even after a multi-account gh', async () => {
  let gh = fakeGh(TWO, {});
  try { await ghAccounts(); } finally { gh.restore(); }    // PuRR has seen a multi-account gh
  gh = fakeGh('Signed in, in words from a future gh\n', { none: pr('OPEN') });
  try {
    assert.equal((await ghAccounts()).length, 1);
    assert.equal((await prForBranch(process.cwd(), 'feat'))?.number, 7, 'no token asked for the placeholder');
    await commentOnPr(process.cwd(), 7, 'b');
    assert.deepEqual(gh.comments(), ['none 7']);
  } finally { gh.restore(); }
});

test('the Toolchain popup shows gh signed in, but no made-up account name, when it can\'t read who', async () => {
  const { refreshToolchain, toolchainStatus } = await import('../src/server/toolchain.ts');
  const gh = fakeGh('Signed in, in words from a future gh\n', {});
  try {
    refreshToolchain();
    const auth = (await toolchainStatus()).tools.find((t) => t.name === 'gh')!.auth;
    assert.deepEqual(auth, { signedIn: true, accounts: [], detail: 'signed in' });
  } finally { gh.restore(); refreshToolchain(); }
});

test("the PR fetch says which accounts answered, when each was asked, and since when a newly listed one can have been signed in", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const one = (login: string) => `  ✓ Logged in to github.com account ${login} (keyring)\n  - Active account: true\n`;
  const gh = fakeGh(one('early-me'), {});
  writeFileSync(join(gh.dir, 'graphql-tok-early-me.json'), JSON.stringify({ data: { viewer: { pullRequests: { nodes: [
    { number: 1, title: 't', body: null, url: 'u', isDraft: false, createdAt: 'x', baseRefName: 'main', headRefName: 'f', headRefOid: 'a',
      repository: { nameWithOwner: 'Org/App' } }] } } } }));
  try {
    await ghAccounts();
    t.mock.timers.tick(6 * 60_000);              // the five-minute account cache runs out...
    gh.setStatus(one('early-me') + one('late-me').replace('true', 'false'));   // ...after late-me signed in, in a terminal
    const f = (await openPrsForAllAccounts())!;
    assert.deepEqual(f.accounts, ['early-me', 'late-me']);
    assert.deepEqual(f.answered, ['early-me'], "late-me's query failed");
    assert.deepEqual(f.prs.map((p) => [p.repo, p.account, p.body]), [['org/app', 'early-me', '']]);
    assert.equal(f.askedAt!['early-me'], 1_000_000 + 6 * 60_000);
    assert.equal(accountSignedInSince('late-me'), 1_000_000, 'not listed at the read before: signed in since then');
  } finally { t.mock.timers.reset(); gh.restore(); }
});

test('a manual review keeps the account that found its PR', async () => {
  const { RunManager } = await import('../src/server/manager.ts');
  const { ClaudeRunner } = await import('../src/server/claude.ts');
  const { openDb } = await import('../src/server/db.ts');
  const { tempRepo, sh } = await import('./helpers.ts');
  const db = openDb(join(mkdtempSync(join(process.env.TMPDIR!, 'purr-db-')), 'purr.db'));
  const repo = tempRepo();
  const head = sh(repo, 'rev-parse', 'HEAD');
  const gh = fakeGh(TWO, { 'tok-work-me': { ...pr('OPEN'), headRefName: 'main', headRefOid: head } });
  try {
    const mgr = new RunManager(db, new ClaudeRunner(db));
    const req = { trigger: 'manual' as const, repoPath: repo, mode: 'range' as const, flowId: null, base: null, head: null };
    const { ensureDefaults } = await import('../src/server/flows/store.ts');
    ensureDefaults(db);
    const run = mgr.createRun(req)!;
    await (mgr as any).prepare(req, run);
    assert.equal(run.pr?.number, 7);
    assert.equal(run.pr?.account, 'work-me', 'found by the non-active account: it comments as that one');
  } finally { gh.restore(); db.close(); }
});
