import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { exec } from './util.ts';

export async function git(cwd: string, args: string[], opts: { input?: string; allowFail?: boolean; signal?: AbortSignal } = {}) {
  const r = await exec('git', ['-c', 'core.quotePath=false', ...args], { cwd, input: opts.input, signal: opts.signal, timeoutMs: 120_000 });
  if (r.code !== 0 && !opts.allowFail) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}
const tryGit = async (cwd: string, args: string[]) => {
  const r = await exec('git', args, { cwd, timeoutMs: 60_000 });
  return r.code === 0 ? r.stdout.trim() : null;
};

export const repoRoot = (path: string) => tryGit(path, ['rev-parse', '--show-toplevel']);
export const headSha = (cwd: string) => tryGit(cwd, ['rev-parse', 'HEAD']);
export const currentBranch = async (cwd: string) => {
  const b = await tryGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return b || null;
};
/** The remote branch `branch` tracks (origin/bar -> "bar"), or null. Pushes are reviewed under that name. */
export const upstreamBranch = async (cwd: string, branch: string) =>
  (await tryGit(cwd, ['for-each-ref', '--format=%(upstream:lstrip=3)', `refs/heads/${branch}`]))?.trim() || null;
export const remoteUrl = (cwd: string, remote = 'origin') => tryGit(cwd, ['remote', 'get-url', remote]);
export const gitDir = (cwd: string) => tryGit(cwd, ['rev-parse', '--absolute-git-dir']);
/** Shared hooks dir (respects core.hooksPath). */
export async function hooksDir(cwd: string): Promise<string> {
  const custom = await tryGit(cwd, ['config', '--get', 'core.hooksPath']);
  if (custom) return custom.startsWith('/') ? custom : join(cwd, custom);
  const common = await tryGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return join(common || join(cwd, '.git'), 'hooks');
}

/** origin's default branch as a ref usable for merge-base (origin/main), falling back to local main/master. */
export async function defaultBaseRef(cwd: string, remote = 'origin'): Promise<string | null> {
  const sym = await tryGit(cwd, ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`]);
  if (sym) return sym.replace('refs/remotes/', '');
  for (const c of [`${remote}/main`, `${remote}/master`, 'main', 'master']) {
    if (await tryGit(cwd, ['rev-parse', '--verify', '--quiet', c])) return c;
  }
  return null;
}
export const mergeBase = (cwd: string, a: string, b: string) => tryGit(cwd, ['merge-base', a, b]);
export const resolveRef = (cwd: string, ref: string) => tryGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);

export interface ChangedFile {
  path: string;
  oldPath: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  added: Map<number, string>;   // new-file line number -> text
  deletedAt: number[];          // new-file line numbers where deletions happened
  additions: number;
  deletions: number;
  binary: boolean;
}

/** The change under review. `staged`: index vs HEAD (pre-commit). `range`: base..head commits. */
export interface ChangeSpec { mode: 'staged' | 'range'; cwd: string; base: string | null; head: string | null }

const diffArgs = (c: ChangeSpec) =>
  c.mode === 'staged' ? ['diff', '--cached'] : ['diff', c.base ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904', c.head ?? 'HEAD'];

export async function changedFiles(c: ChangeSpec): Promise<ChangedFile[]> {
  const out = await git(c.cwd, [...diffArgs(c), '-U0', '--no-color', '--no-ext-diff', '-M', '--src-prefix=a/', '--dst-prefix=b/']);
  return parseDiff(out);
}

export async function unifiedDiff(c: ChangeSpec, context = 3): Promise<string> {
  return git(c.cwd, [...diffArgs(c), `-U${context}`, '--no-color', '--no-ext-diff', '-M']);
}

/** Unquotes a git path ("a/caf\303\251.txt" style C-quoting) and strips the trailing tab git adds to paths with spaces. */
function gitPath(raw: string): string {
  let p = raw.replace(/\t$/, '');
  if (p.startsWith('"') && p.endsWith('"')) {
    const bytes: number[] = [];
    const body = p.slice(1, -1);
    for (let i = 0; i < body.length; i++) {
      if (body[i] !== '\\') { bytes.push(...Buffer.from(body[i])); continue; }
      const nx = body[++i];
      if (/[0-7]/.test(nx)) { bytes.push(parseInt(body.slice(i, i + 3), 8)); i += 2; }
      else bytes.push(({ n: 10, t: 9, '"': 34, '\\': 92 } as Record<string, number>)[nx] ?? nx.charCodeAt(0));
    }
    p = Buffer.from(bytes).toString('utf8');
  }
  return p;
}

export function parseDiff(out: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let cur: ChangedFile | null = null;
  let n = 0;
  let inHunk = false;   // ---/+++ are headers only before a file's first @@; inside a hunk they are content
  for (const line of out.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      cur = { path: m ? gitPath(m[2]) : '', oldPath: null, status: 'modified', added: new Map(), deletedAt: [], additions: 0, deletions: 0, binary: false };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (!inHunk) {
      if (line.startsWith('new file mode')) cur.status = 'added';
      else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
      else if (line.startsWith('rename from ')) { cur.oldPath = gitPath(line.slice(12)); cur.status = 'renamed'; }
      else if (line.startsWith('rename to ')) cur.path = gitPath(line.slice(10));
      else if (line.startsWith('Binary files')) cur.binary = true;
      else if (line.startsWith('+++ ')) { if (!line.startsWith('+++ /dev/null')) cur.path = gitPath(line.slice(4)).replace(/^b\//, ''); }
    }
    if (line.startsWith('@@')) {
      inHunk = true;
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))?/);
      n = m ? Number(m[1]) : 0;
      if (m && m[2] === '0') cur.deletedAt.push(n + 1); // pure deletion: the hunk sits after line n
    } else if (!inHunk) continue;
    else if (line.startsWith('+')) { cur.added.set(n, line.slice(1)); cur.additions++; n++; }
    else if (line.startsWith('-')) { cur.deletions++; if (!cur.deletedAt.includes(n)) cur.deletedAt.push(n); }
    else if (line.startsWith(' ')) n++;
  }
  return files;
}

/** File contents at the reviewed revision (staged blob, or head commit), or null if absent. */
export async function fileAt(c: ChangeSpec, path: string): Promise<string | null> {
  const spec = c.mode === 'staged' ? `:${path}` : `${c.head ?? 'HEAD'}:${path}`;
  const r = await exec('git', ['show', spec], { cwd: c.cwd, timeoutMs: 60_000 });
  return r.code === 0 ? r.stdout : null;
}
export async function fileAtBase(c: ChangeSpec, path: string): Promise<string | null> {
  const spec = c.mode === 'staged' ? `HEAD:${path}` : `${c.base}:${path}`;
  if (c.mode === 'range' && !c.base) return null;
  const r = await exec('git', ['show', spec], { cwd: c.cwd, timeoutMs: 60_000 });
  return r.code === 0 ? r.stdout : null;
}

/** A detached worktree at `sha` under `dir` (one per run; re-checks-out if it already exists). */
export async function ensureWorktree(repoPath: string, dir: string, sha: string): Promise<string> {
  if (existsSync(join(dir, '.git'))) {
    await git(dir, ['checkout', '--quiet', '--detach', '--force', sha]);
    await git(dir, ['clean', '-fdq'], { allowFail: true });
  } else {
    await git(repoPath, ['worktree', 'prune'], { allowFail: true });
    await git(repoPath, ['worktree', 'add', '--quiet', '--detach', '--force', dir, sha]);
  }
  return dir;
}
export const removeWorktree = (repoPath: string, dir: string) => git(repoPath, ['worktree', 'remove', '--force', dir], { allowFail: true });

export async function lsRemote(cwd: string, remote: string, branch: string): Promise<string | null> {
  const r = await exec('git', ['ls-remote', remote, `refs/heads/${branch}`], { cwd, timeoutMs: 30_000 });
  if (r.code !== 0) return null;
  return r.stdout.split(/\s+/)[0] || null;
}

/** Whether `a` is in `b`'s history: unknown when git doesn't have one of them (a commit only on the remote, say). */
export async function ancestry(cwd: string, a: string, b: string): Promise<'yes' | 'no' | 'unknown'> {
  const r = await exec('git', ['merge-base', '--is-ancestor', a, b], { cwd, timeoutMs: 30_000 });
  return r.code === 0 ? 'yes' : r.code === 1 ? 'no' : 'unknown';
}
export async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  return (await exec('git', ['merge-base', '--is-ancestor', a, b], { cwd, timeoutMs: 30_000 })).code === 0;
}

/** "refs/heads/x", "x" or "origin/x" -> local branch name x, if such a branch exists. */
export async function branchNamed(cwd: string, ref: string): Promise<string | null> {
  const name = ref.replace(/^refs\/heads\//, '');
  return (await tryGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])) ? name : null;
}

/** A base branch name ("main") or ref: tries it as given, then on each remote (origin first). */
export async function resolveBase(cwd: string, ref: string): Promise<string | null> {
  const direct = await resolveRef(cwd, ref);
  const remotes = ((await tryGit(cwd, ['remote'])) ?? '').split('\n').filter(Boolean)
    .sort((a, b) => (a === 'origin' ? -1 : b === 'origin' ? 1 : 0));
  for (const r of remotes) {
    const sha = await resolveRef(cwd, `${r}/${ref}`);
    if (sha) return sha;   // prefer the remote's view of the base branch over a possibly stale local one
  }
  return direct;
}

/** Keeps the 10 newest run worktrees under `dir` (they hold the cwd that `claude --resume` needs). */
export async function pruneWorktrees(repoPath: string, dir: string, keep: string) {
  try {
    const entries = readdirSync(dir).filter((n) => n !== keep).map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const e of entries.slice(9)) await removeWorktree(repoPath, join(dir, e.n));
    await git(repoPath, ['worktree', 'prune'], { allowFail: true });
  } catch { /* best effort */ }
}
