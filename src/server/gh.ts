// GitHub through the user's own `gh` logins. Optional: without gh, post-push still works from the pre-push hook and
// reviews the branch against the default branch, just without PR title/description.
//
// gh can hold several accounts (say a work and a personal one) but only one is "active". PuRR looks at all of them:
// each account's open PRs come from one GraphQL query, and a branch's PR is looked up under each account in turn. A
// token is fetched from gh for the duration of one gh call (GH_TOKEN) and never stored.
import { exec } from './util.ts';

export interface PrInfo {
  number: number; title: string; body: string; url: string; baseRefName: string; headRefName: string; headRefOid: string;
  isDraft: boolean; createdAt?: string;
  account?: string;   // the signed-in account that found it, and that PuRR comments as
}
/** An open PR plus where it lives, from an account's PR list. */
export interface OpenPr extends PrInfo { repo: string; account: string }   // repo: "owner/name", lower-case

const FIELDS = 'number,title,body,url,baseRefName,headRefName,headRefOid,isDraft,createdAt,state';

/**
 * One gh call as an account, with its exit code and output; null if it couldn't run (no token, no gh). `token`: one
 * already read for the account, used as it is (no second keychain read that could fail).
 */
async function ghRun(cwd: string, args: string[], opts: { input?: string; account?: string; token?: string } = {}) {
  try {
    let env: NodeJS.ProcessEnv | undefined;
    if (opts.token) env = { ...process.env, GH_TOKEN: opts.token };
    else if (opts.account && multiAccount) {   // an older gh has one login and no --user: just use it
      const token = await tokenFor(opts.account);
      if (!token) return null;
      env = { ...process.env, GH_TOKEN: token };
    }
    return await exec('gh', args, { cwd, input: opts.input, env, timeoutMs: 30_000 });
  } catch { return null; }
}

async function gh(cwd: string, args: string[], opts: { input?: string; account?: string; token?: string } = {}) {
  const r = await ghRun(cwd, args, opts);
  return r && r.code === 0 ? r.stdout : null;
}

async function tokenFor(account: string): Promise<string | null> {
  try {
    const r = await exec('gh', ['auth', 'token', '--hostname', 'github.com', '--user', account], { timeoutMs: 15_000 });
    return r.code === 0 ? r.stdout.trim() || null : null;
  } catch { return null; }
}

let accountsCache: { at: number; list: string[] } | null = null;
/** Stands in for an account when gh is signed in but PuRR can't read who as: gh's own login is used. Not a name to show. */
export const GH_DEFAULT_LOGIN = '(gh default login)';
/** Whether gh lists accounts the multi-account way (gh 2.40+), so each can be picked with `gh auth token --user`. */
let multiAccount = true;

/** Accounts in `gh auth status` output, the active one first. Older gh says "Logged in to github.com as <name>". */
export function parseGhStatus(text: string): { accounts: string[]; multi: boolean } {
  const found = [...text.matchAll(/Logged in to github\.com account (\S+)[^\n]*\n\s*- Active account: (true|false)/g)];
  if (found.length) {
    return { accounts: found.sort((a, b) => (a[2] === 'true' ? -1 : 0) - (b[2] === 'true' ? -1 : 0)).map((m) => m[1]), multi: true };
  }
  const old = text.match(/Logged in to github\.com (?:as|account) (\S+)/);
  return { accounts: old ? [old[1]] : [], multi: false };
}

/** Until then, a sign-in may be finishing in Terminal: look again every few seconds instead of every five minutes. */
let signInUntil = 0;
/** github.com accounts signed in to gh, the active one first. */
export async function ghAccounts(): Promise<string[]> {
  const ttl = Date.now() < signInUntil ? 5_000 : 5 * 60_000;
  if (accountsCache && Date.now() - accountsCache.at < ttl) return accountsCache.list;
  let list: string[] = [];
  try {
    const r = await exec('gh', ['auth', 'status', '--hostname', 'github.com'], { timeoutMs: 15_000 });
    const parsed = parseGhStatus(r.stdout + r.stderr);
    // only a clean answer says which kind of gh this is: a timeout says nothing
    if (r.code === 0 && parsed.accounts.length) multiAccount = parsed.multi;
    // signed in (exit 0) in words PuRR doesn't know: still use gh, as its default login
    list = parsed.accounts.length || r.code !== 0 ? parsed.accounts : [GH_DEFAULT_LOGIN];
    if (r.code === 0 && !parsed.accounts.length) multiAccount = false;   // that placeholder has no token: use gh's own login
  } catch { /* gh missing */ }
  // an account not in the last list was signed in since that list was read: not before it
  for (const a of list) if (!signedInSince.has(a)) signedInSince.set(a, lastAccountsRead ?? Date.now());
  accountsCache = { at: Date.now(), list };
  lastAccountsRead = Date.now();
  return list;
}

/** When PuRR last read gh's account list. Kept apart from the cache, which a refresh clears: the read still happened. */
let lastAccountsRead: number | null = null;
/** Per account, the earliest it can have been signed in: when PuRR last read an account list without it. */
const signedInSince = new Map<string, number>();
export const accountSignedInSince = (account: string) => signedInSince.get(account) ?? null;

/** Forget the cached account list (after a sign-in, or gh was just installed). */
export function forgetGhAccounts() { accountsCache = null; }

/** A gh sign-in has just started in Terminal: notice the new account soon after it finishes, not minutes later. */
export function expectGhSignIn(forMs = 10 * 60_000) { accountsCache = null; signInUntil = Date.now() + forMs; }

export async function ghAuthed(): Promise<boolean> {
  return (await ghAccounts()).length > 0;
}

/** "owner/name" (lower-case) for a GitHub remote URL in any of its forms, or null. */
export function githubRepo(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** The open PR for a branch, trying each signed-in account (a private personal repo is only visible to one). */
export async function prForBranch(repoPath: string, branch: string): Promise<PrInfo | null> {
  return (await prLookup(repoPath, branch)) ?? null;
}

/**
 * A branch's open PR, trying each account; null when gh says there's none; undefined when gh couldn't say (signed
 * out, offline, a timeout), which isn't the same as no PR.
 */
export async function prLookup(repoPath: string, branch: string): Promise<PrInfo | null | undefined> {
  const accounts = await ghAccounts();
  if (!accounts.length) return undefined;   // signed out: gh can't say
  let unknown = false;
  for (const account of accounts) {
    const r = await ghRun(repoPath, ['pr', 'view', branch, '--json', FIELDS], { account });
    if (!r) { unknown = true; continue; }
    if (r.code === 0) {
      try {
        const pr = JSON.parse(r.stdout) as PrInfo & { state?: string };
        if (pr.state === 'OPEN') return { ...pr, account };   // gh also returns a branch's closed or merged PR
        return null;
      } catch { unknown = true; continue; }   // garbled output says nothing either way
    }
    if (/no (open )?pull requests? found/i.test(r.stderr)) continue;   // this account sees no PR for it
    if (!/could not resolve to a repository/i.test(r.stderr)) unknown = true;   // (one that can't see the repo says nothing)
  }
  // an account that couldn't answer might be the one that sees the PR: "none" only when every one that could see said so
  return unknown ? undefined : null;
}

const OPEN_PRS = `query($n: Int!) { viewer { login pullRequests(first: $n, states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }) {
  nodes { number title body url isDraft createdAt baseRefName headRefName headRefOid repository { nameWithOwner } } } } }`;

/**
 * Open PRs; the accounts whose query got an answer (one that failed this time may have PRs it didn't list); and every
 * account asked (default: those that answered).
 */
export interface PrFetch { prs: OpenPr[]; answered: string[]; accounts?: string[]; askedAt?: Record<string, number>; signedInSince?: Record<string, number> }

/** Every open PR authored by any signed-in account: one GraphQL call per account. null if gh isn't usable at all. */
export async function openPrsForAllAccounts(): Promise<PrFetch | null> {
  const accounts = await ghAccounts();
  if (!accounts.length) return null;
  const prs: OpenPr[] = [], answered: string[] = [], askedAt: Record<string, number> = {};
  for (const account of accounts) {
    askedAt[account] = Date.now();   // what this account's list is current as of, not when the last account answered
    const out = await gh(process.cwd(), ['api', 'graphql', '-F', 'n=100', '-f', `query=${OPEN_PRS}`], { account });
    if (!out) continue;
    try {
      const nodes = JSON.parse(out)?.data?.viewer?.pullRequests?.nodes ?? [];
      for (const n of nodes) {
        prs.push({ ...n, body: n.body ?? '', repo: String(n.repository?.nameWithOwner ?? '').toLowerCase(), account });
      }
      answered.push(account);
    } catch { /* skip this account this time */ }
  }
  const since: Record<string, number> = {};
  for (const a of accounts) { const t = accountSignedInSince(a); if (t !== null) since[a] = t; }
  return { prs, answered, accounts, askedAt, signedInSince: since };
}

/**
 * Posts as the account that found the PR (else the active one), once: trying the next account after a failure could
 * post the comment twice, since a timed-out `gh pr comment` may still have posted it.
 */
export async function commentOnPr(repoPath: string, number: number, body: string, account?: string | null): Promise<boolean> {
  const accounts = await ghAccounts();
  // found through gh's own login while PuRR couldn't read who as: now gh lists accounts, so that's no account at all
  if (account === GH_DEFAULT_LOGIN && multiAccount) account = null;
  // each account's token is read once, with a second try for a keychain blip, and the post uses that same token
  const tokenOf = async (a: string) => (await tokenFor(a)) ?? (await tokenFor(a));
  // as that account; else (signed out since, nothing sent yet) the first other account that can see the PR, which a
  // read-only `gh pr view` tells without posting anything
  let as: string | undefined;   // none known (a run from before PuRR kept it): the first account that can see the PR
  let token: string | null = null;
  if (account) {
    token = multiAccount ? await tokenOf(account) : null;
    if (!multiAccount || token) as = account;
  }
  // still signed in but no token even so: don't post as somebody else
  if (account && !as && accounts.includes(account)) return false;
  for (const a of as ? [] : accounts.filter((x) => x !== account)) {
    const t = multiAccount ? await tokenOf(a) : null;
    if (multiAccount && !t) continue;
    if ((await gh(repoPath, ['pr', 'view', String(number), '--json', 'number'], { account: a, token: t ?? undefined })) !== null) { as = a; token = t; break; }
  }
  if (!as) return false;
  if (multiAccount && !token) token = await tokenOf(as);   // the active account, when no finding account was known
  if (multiAccount && !token) return false;
  return (await gh(repoPath, ['pr', 'comment', String(number), '--body-file', '-'], { input: body, account: as, token: token ?? undefined })) !== null;
}
