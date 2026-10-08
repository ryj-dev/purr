// GitHub through the user's own `gh` login. Optional: without it, post-push still works from the pre-push hook and
// reviews the branch against the default branch, just without PR title/description.
import { exec } from './util.ts';

export interface PrInfo {
  number: number; title: string; body: string; url: string; baseRefName: string; headRefName: string; headRefOid: string; isDraft: boolean;
}
const FIELDS = 'number,title,body,url,baseRefName,headRefName,headRefOid,isDraft';

async function gh(cwd: string, args: string[], input?: string) {
  try {
    const r = await exec('gh', args, { cwd, input, timeoutMs: 30_000 });
    return r.code === 0 ? r.stdout : null;
  } catch { return null; }
}

let authCache: { at: number; ok: boolean } | null = null;
export async function ghAuthed(): Promise<boolean> {
  if (authCache && Date.now() - authCache.at < 5 * 60_000) return authCache.ok;
  const ok = (await gh(process.cwd(), ['auth', 'status'])) !== null;
  authCache = { at: Date.now(), ok };
  return ok;
}

export async function prForBranch(repoPath: string, branch: string): Promise<PrInfo | null> {
  const out = await gh(repoPath, ['pr', 'view', branch, '--json', FIELDS]);
  if (!out) return null;
  try { return JSON.parse(out); } catch { return null; }
}

export async function myOpenPrs(repoPath: string): Promise<PrInfo[] | null> {
  const out = await gh(repoPath, ['pr', 'list', '--author', '@me', '--state', 'open', '--json', FIELDS, '--limit', '50']);
  if (out === null) return null;
  try { return JSON.parse(out); } catch { return null; }
}

export async function commentOnPr(repoPath: string, number: number, body: string): Promise<boolean> {
  return (await gh(repoPath, ['pr', 'comment', String(number), '--body-file', '-'], body)) !== null;
}
