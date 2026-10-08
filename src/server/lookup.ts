// Read side for `purr findings` / `purr runs`: lets a Claude session (or a person) look up a review's results.
import { existsSync, realpathSync } from 'node:fs';
import type { Finding, Run } from '../shared/types.ts';
import type { DB } from './db.ts';
import { githubRepo } from './gh.ts';
import { remoteUrl, repoRoot } from './git.ts';
import { TERMINAL } from './manager.ts';

/**
 * Registered repos that are the same project as the checkout at `path`: itself plus every other clone or worktree of
 * the same GitHub repo (the poller reviews a PR in the main checkout, wherever the push came from). Empty if unknown.
 */
export async function sameRepoIds(db: DB, path: string): Promise<string[]> {
  const top = await repoRoot(path);
  if (!top) return [];
  const root = existsSync(top) ? realpathSync(top) : top;
  const key = githubRepo(db.getRepoByPath(root)?.remoteUrl ?? await remoteUrl(root));
  return db.listRepos().filter((r) => r.path === root || (key && githubRepo(r.remoteUrl) === key)).map((r) => r.id);
}

/** A run's findings with their ledger state as it is now: a finding dismissed, or fixed by a later review, says so. */
export function currentFindings(db: DB, run: Run): Finding[] {
  return db.getRunFindings(run.id).map((f) => {
    const l = f.fingerprint && run.repoId ? db.getLedger(f.fingerprint, run.repoId) : null;
    if (!l) return f;
    if (l.state === 'dismissed' || l.state === 'tracked' || l.state === 'fixed') return { ...f, ledger: l.state };
    if (f.ledger === 'dismissed' || f.ledger === 'tracked') return { ...f, ledger: 'open' };   // reopened since
    return f;
  });
}

export const isFinished = (run: Run) => TERMINAL.has(run.status);

/**
 * Polls `find` until it returns a finished run, or the timeout passes (then the last run seen, finished or not, or
 * null if none appeared). A review after a push starts only once the push lands and the debounce passes, so the run
 * may not exist yet when waiting begins.
 */
export async function waitForRun(find: () => Run | null, opts: { timeoutMs: number; intervalMs?: number; onChange?: (run: Run | null) => void }) {
  const deadline = Date.now() + opts.timeoutMs;
  let last: Run | null = null, lastKey = '';
  for (;;) {
    last = find();
    const key = last ? `${last.id}:${last.status}` : '';
    if (key !== lastKey) { lastKey = key; opts.onChange?.(last); }
    if ((last && isFinished(last)) || Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, Math.min(opts.intervalMs ?? 3000, Math.max(0, deadline - Date.now()))));
  }
}

/** The Claude session behind each block of a run (the last one, for a block that ran several), by block id. */
export function blockSessions(db: DB, runId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of db.listBlockRuns(runId)) {
    const id = b.output?.sessions?.at(-1)?.sessionId ?? b.output?.sessionId;
    if (id) out[b.blockId] = id;
  }
  return out;
}

/** Findings this run closed: raised by an earlier review of the branch, gone from this one (see applyLedger). */
export function resolvedBy(db: DB, run: Run): Finding[] {
  if (!run.repoId) return [];
  return db.listLedger(run.repoId, 'fixed').filter((l) => l.lastRunId === run.id).map((l) => ({ ...l.finding, ledger: 'fixed' }));
}

/** Counts towards the exit code and the default listing: not dismissed, tracked or since fixed. */
export const isActive = (f: Finding) => f.ledger !== 'dismissed' && f.ledger !== 'tracked' && f.ledger !== 'fixed';
