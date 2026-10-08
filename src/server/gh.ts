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

async function gh(cwd: string, args: string[], opts: { input?: string; account?: string } = {}) {
  try {
    let env: NodeJS.ProcessEnv | undefined;
    if (opts.account && multiAccount) {   // an older gh has one login and no --user: just use it
      const token = await tokenFor(opts.account);
      if (!token) return null;
      env = { ...process.env, GH_TOKEN: token };
    }
    const r = await exec('gh', args, { cwd, input: opts.input, env, timeoutMs: 30_000 });
    return r.code === 0 ? r.stdout : null;
  } catch { return null; }
}

async function tokenFor(account: string): Promise<string | null> {
  try {
    const r = await exec('gh', ['auth', 'token', '--hostname', 'github.com', '--user', account], { timeoutMs: 15_000 });
    return r.code === 0 ? r.stdout.trim() || null : null;
  } catch { return null; }
}

let accountsCache: { at: number; list: string[] } | null = null;
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
    multiAccount = parsed.multi;
    // signed in (exit 0) in words PuRR doesn't know: still use gh, as its default login
    list = parsed.accounts.length || r.code !== 0 ? parsed.accounts : ['github.com'];
  } catch { /* gh missing */ }
  accountsCache = { at: Date.now(), list };
  return list;
}

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
  for (const account of await ghAccounts()) {
    const out = await gh(repoPath, ['pr', 'view', branch, '--json', FIELDS], { account });
    if (!out) continue;
    try {
      const pr = JSON.parse(out) as PrInfo & { state?: string };
      if (pr.state === 'OPEN') return { ...pr, account };   // gh also returns a branch's closed or merged PR
      return null;
    } catch { /* try the next account */ }
  }
  return null;
}

const OPEN_PRS = `query($n: Int!) { viewer { login pullRequests(first: $n, states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }) {
  nodes { number title body url isDraft createdAt baseRefName headRefName headRefOid repository { nameWithOwner } } } } }`;

/** Every open PR authored by any signed-in account: one GraphQL call per account. null if gh isn't usable at all. */
export async function openPrsForAllAccounts(): Promise<OpenPr[] | null> {
  const accounts = await ghAccounts();
  if (!accounts.length) return null;
  const all: OpenPr[] = [];
  for (const account of accounts) {
    const out = await gh(process.cwd(), ['api', 'graphql', '-F', 'n=100', '-f', `query=${OPEN_PRS}`], { account });
    if (!out) continue;
    try {
      const nodes = JSON.parse(out)?.data?.viewer?.pullRequests?.nodes ?? [];
      for (const n of nodes) {
        all.push({ ...n, body: n.body ?? '', repo: String(n.repository?.nameWithOwner ?? '').toLowerCase(), account });
      }
    } catch { /* skip this account this time */ }
  }
  return all;
}

/**
 * Posts as the account that found the PR (else the active one), once: trying the next account after a failure could
 * post the comment twice, since a timed-out `gh pr comment` may still have posted it.
 */
export async function commentOnPr(repoPath: string, number: number, body: string, account?: string | null): Promise<boolean> {
  const as = account || (await ghAccounts())[0];
  if (!as) return false;
  return (await gh(repoPath, ['pr', 'comment', String(number), '--body-file', '-'], { input: body, account: as })) !== null;
}
