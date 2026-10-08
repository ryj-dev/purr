import './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { commentOnPr, forgetGhAccounts, ghAccounts, parseGhStatus, prForBranch } from '../src/server/gh.ts';

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
  "pr comment") cat > /dev/null; echo "\${GH_TOKEN:-none} $3" >> "$D/comments"; exit ${commentExit} ;;
  *) exit 2 ;;
esac
`);
  chmodSync(join(dir, 'gh'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  forgetGhAccounts();
  return { dir, comments: () => existsSync(join(dir, 'comments')) ? readFileSync(join(dir, 'comments'), 'utf8').trim().split('\n') : [],
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

test('a comment falls back to another account only when the finding account is signed out, before anything is sent', async () => {
  const gh = fakeGh(TWO, {});
  try {
    assert.equal(await commentOnPr(process.cwd(), 7, 'b', 'no-token'), true);
    assert.deepEqual(gh.comments(), ['tok-me 7'], 'no token for it: posted as the active account');
  } finally { gh.restore(); }
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
