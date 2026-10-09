// Finds the git repositories in the user's project folders and registers them, so the PR poller covers every repo,
// including ones git's global hooks can't reach (a repo that sets its own core.hooksPath, like husky or .githooks).
// Only main checkouts count (a `.git` directory); worktrees register themselves when they're committed in.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.ts';
import { addRepo } from './http.ts';

const SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', '.venv', 'venv', 'Library', 'Applications']);

/** Main checkouts in `folder` and one level below it (folder/repo and folder/org/repo). */
export function findRepos(folder: string): string[] {
  const out: string[] = [];
  const isRepo = (p: string) => { try { return statSync(join(p, '.git')).isDirectory(); } catch { return false; } };
  const dirs = (p: string) => {
    try { return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP.has(d.name)).map((d) => join(p, d.name)); }
    catch { return []; }
  };
  if (!existsSync(folder)) return out;
  if (isRepo(folder)) return [folder];
  for (const d of dirs(folder)) {
    if (isRepo(d)) { out.push(d); continue; }
    for (const dd of dirs(d)) if (isRepo(dd)) out.push(dd);
  }
  return out;
}

/** Registers every repo in the project folders that PuRR doesn't know yet. Returns how many were added. */
export async function discoverRepos(db: DB): Promise<number> {
  const known = new Set(db.listRepos().map((r) => r.path));
  let added = 0;
  for (const folder of db.getSettings().projectFolders) {
    for (const path of findRepos(folder)) {
      if (known.has(path)) continue;
      try { const r = await addRepo(db, path); if (!known.has(r.path)) { known.add(r.path); added++; } } catch { /* not a usable repo */ }
    }
  }
  return added;
}
