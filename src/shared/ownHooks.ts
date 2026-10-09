// Which Triggers cells a repo's own git hooks lock: shared by the Triggers page and its tests.
import type { Repo, TriggerKind } from './types.ts';

/** Triggers that run from PuRR's git hooks, which a repo with its own core.hooksPath never calls. */
export const HOOK_TRIGGERS: ReadonlySet<TriggerKind> = new Set<TriggerKind>(['pre-commit', 'pre-push']);

/** The repo's own hooks path when it locks this cell, else null. The Global row (repoId null) is never locked. */
export function lockedBy(trigger: TriggerKind, repoId: string | null, ownHooks: Record<string, string>): string | null {
  return repoId && HOOK_TRIGGERS.has(trigger) ? ownHooks[repoId] ?? null : null;
}

/** How many of these repos use their own hooks. */
export const ownHooksCount = (repos: Pick<Repo, 'id'>[], ownHooks: Record<string, string>) => repos.filter((r) => ownHooks[r.id]).length;
