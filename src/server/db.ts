import { DatabaseSync } from 'node:sqlite';
import type {
  BlockRun, Finding, Flow, FlowMeta, LedgerItem, Repo, Run, Settings, TriggerAssignment, TriggerKind, Usage,
} from '../shared/types.ts';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { now, paths } from './util.ts';

// Common places people keep their clones; the ones that exist on this machine are watched by default.
const COMMON_PROJECT_FOLDERS = ['Documents/github', 'Documents/GitHub', 'github', 'GitHub', 'code', 'Code', 'src', 'projects',
  'Projects', 'dev', 'Developer', 'repos', 'workspace', 'git'];
/** Real on-disk paths, without duplicates: on a case-insensitive disk ~/Documents/github and ~/Documents/GitHub are one folder. */
export function uniqueFolders(folders: string[]): string[] {
  const out = new Map<string, string>();
  for (const f of folders) {
    if (!existsSync(f)) { out.set(f, f); continue; }
    const real = realpathSync.native(f);
    if (!out.has(real.toLowerCase())) out.set(real.toLowerCase(), real);
  }
  return [...out.values()];
}
export const defaultProjectFolders = () =>
  uniqueFolders(COMMON_PROJECT_FOLDERS.map((f) => join(homedir(), f)).filter((p) => existsSync(p)));

export const DEFAULT_SETTINGS: Settings = {
  claudeBin: 'claude',
  // Keep the user's own hooks and plugins out of review sessions; auth is unaffected.
  claudeExtraArgs: ['--strict-mcp-config'],
  maxConcurrentClaude: 4,
  dailySessionCap: 300,
  pollIntervalSec: 60,
  debounceSec: 60,
  notifications: true,
  reviewsPaused: false,
  postPushPrsOnly: true,
  projectFolders: [],          // filled with defaultProjectFolders() on first read
  port: 7878,
};

const EMPTY_USAGE: Usage = {
  fiveHour: null, sevenDay: null, fiveHourResetsAt: null, sevenDayResetsAt: null, pausedUntil: null, sessionsToday: 0, updatedAt: null,
};

export type DB = ReturnType<typeof openDb>;

export interface RunQuery {
  repoIds?: string[];
  branch?: string | null;
  pr?: number | null;
  sha?: string | null;
  triggers?: TriggerKind[];
  limit?: number;
}

/**
 * Why a pushed commit got no review of its own: its branch had no open PR (it gets one once a PR is opened), a newer
 * push to the branch took its place (`nextSha`, whose review covers it), or reviews were off. 'pending' while that
 * isn't known yet.
 */
export interface PushOutcome {
  sha: string;
  kind: 'pending' | 'no-pr' | 'superseded' | 'skipped';
  reason: string;
  repoPath: string;
  branch: string | null;
  nextSha?: string | null;
  at: string;
}

export function openDb(file = paths.db) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS flows (id TEXT PRIMARY KEY, is_default INTEGER NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS repos (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS triggers (trigger TEXT NOT NULL, repo_id TEXT NOT NULL, flow_id TEXT, PRIMARY KEY (trigger, repo_id));
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, repo_id TEXT, status TEXT NOT NULL, queued_at TEXT NOT NULL,
      data TEXT NOT NULL, findings TEXT NOT NULL DEFAULT '[]');
    CREATE INDEX IF NOT EXISTS runs_queued ON runs (queued_at DESC);
    CREATE TABLE IF NOT EXISTS block_runs (run_id TEXT NOT NULL, block_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (run_id, block_id));
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, run_id TEXT, block_id TEXT, created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_created ON sessions (created_at);
    CREATE TABLE IF NOT EXISTS ledger (fingerprint TEXT NOT NULL, repo_id TEXT NOT NULL, branch TEXT, state TEXT NOT NULL,
      data TEXT NOT NULL, first_run_id TEXT NOT NULL, last_run_id TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (fingerprint, repo_id));
    CREATE TABLE IF NOT EXISTS push_outcomes (sha TEXT PRIMARY KEY, data TEXT NOT NULL, at TEXT NOT NULL);
  `);
  try { db.exec('ALTER TABLE ledger ADD COLUMN flow_id TEXT'); } catch { /* already there */ }

  const kvGet = <T>(key: string, dflt: T): T => {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? { ...dflt, ...JSON.parse(row.value) } : dflt;
  };
  const kvSet = (key: string, value: unknown) =>
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));

  return {
    raw: db,
    close: () => db.close(),

    // settings / usage
    getSettings: (): Settings => {
      const s = kvGet('settings', DEFAULT_SETTINGS);
      return s.projectFolders.length || kvGet('settings', { projectFoldersSet: false } as { projectFoldersSet: boolean }).projectFoldersSet
        ? s : { ...s, projectFolders: defaultProjectFolders() };
    },
    setSettings: (s: Settings) => kvSet('settings', { ...s, projectFoldersSet: true }),
    getUsage: (): Usage => {
      const u = kvGet('usage', EMPTY_USAGE);
      const since = new Date(); since.setHours(0, 0, 0, 0);
      const r = db.prepare('SELECT COUNT(*) n FROM sessions WHERE created_at >= ?').get(since.toISOString()) as { n: number };
      return { ...u, sessionsToday: r.n };
    },
    setUsage: (u: Partial<Usage>) => kvSet('usage', { ...kvGet('usage', EMPTY_USAGE), ...u }),

    // per-block preference overrides on default flows: { [flowId]: { [blockId]: { key: value } } }
    getFlowOverrides: (): Record<string, Record<string, Record<string, unknown>>> => kvGet('flowOverrides', {}),
    setFlowOverrides: (o: Record<string, Record<string, Record<string, unknown>>>) => kvSet('flowOverrides', o),

    // flows
    listFlows: (): FlowMeta[] =>
      (db.prepare('SELECT data FROM flows ORDER BY is_default DESC, updated_at DESC').all() as { data: string }[]).map((r) => {
        const f = JSON.parse(r.data) as Flow;
        const { blocks, edges: _e, ...meta } = f;
        return { ...meta, blockCount: blocks.length };
      }),
    getFlow: (id: string): Flow | null => {
      const r = db.prepare('SELECT data FROM flows WHERE id = ?').get(id) as { data: string } | undefined;
      return r ? JSON.parse(r.data) : null;
    },
    putFlow: (f: Flow) =>
      db.prepare(`INSERT INTO flows (id, is_default, data, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET is_default = excluded.is_default, data = excluded.data, updated_at = excluded.updated_at`)
        .run(f.id, f.isDefault ? 1 : 0, JSON.stringify(f), f.updatedAt),
    deleteFlow: (id: string) => {
      db.prepare('DELETE FROM flows WHERE id = ?').run(id);
      db.prepare('DELETE FROM triggers WHERE flow_id = ?').run(id);
    },

    // repos
    listRepos: (): Repo[] => (db.prepare('SELECT data FROM repos ORDER BY path').all() as { data: string }[]).map((r) => JSON.parse(r.data)),
    getRepo: (id: string): Repo | null => {
      const r = db.prepare('SELECT data FROM repos WHERE id = ?').get(id) as { data: string } | undefined;
      return r ? JSON.parse(r.data) : null;
    },
    getRepoByPath: (path: string): Repo | null => {
      const r = db.prepare('SELECT data FROM repos WHERE path = ?').get(path) as { data: string } | undefined;
      return r ? JSON.parse(r.data) : null;
    },
    putRepo: (r: Repo) =>
      db.prepare('INSERT INTO repos (id, path, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET path = excluded.path, data = excluded.data')
        .run(r.id, r.path, JSON.stringify(r)),
    deleteRepo: (id: string) => {
      db.prepare('DELETE FROM repos WHERE id = ?').run(id);
      db.prepare('DELETE FROM triggers WHERE repo_id = ?').run(id);
    },

    // triggers ('' repo_id = global)
    listTriggers: (): TriggerAssignment[] =>
      (db.prepare('SELECT trigger, repo_id, flow_id FROM triggers ORDER BY repo_id, trigger').all() as
        { trigger: TriggerKind; repo_id: string; flow_id: string | null }[])
        .map((r) => ({ trigger: r.trigger, repoId: r.repo_id || null, flowId: r.flow_id })),
    setTrigger: (t: TriggerAssignment) =>
      db.prepare(`INSERT INTO triggers (trigger, repo_id, flow_id) VALUES (?, ?, ?)
        ON CONFLICT(trigger, repo_id) DO UPDATE SET flow_id = excluded.flow_id`).run(t.trigger, t.repoId ?? '', t.flowId),
    deleteTrigger: (trigger: TriggerKind, repoId: string) =>
      db.prepare('DELETE FROM triggers WHERE trigger = ? AND repo_id = ?').run(trigger, repoId),
    /** Repo override, else global. undefined = no row at all; null = disabled. */
    resolveTrigger: (trigger: TriggerKind, repoId: string | null): string | null | undefined => {
      const get = (rid: string) =>
        db.prepare('SELECT flow_id FROM triggers WHERE trigger = ? AND repo_id = ?').get(trigger, rid) as { flow_id: string | null } | undefined;
      const own = repoId ? get(repoId) : undefined;
      if (own) return own.flow_id;
      const glob = get('');
      return glob ? glob.flow_id : undefined;
    },

    // runs
    putRun: (r: Run) =>
      db.prepare(`INSERT INTO runs (id, repo_id, status, queued_at, data) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`).run(r.id, r.repoId, r.status, r.queuedAt, JSON.stringify(r)),
    getRun: (id: string): Run | null => {
      const r = db.prepare('SELECT data FROM runs WHERE id = ?').get(id) as { data: string } | undefined;
      return r ? JSON.parse(r.data) : null;
    },
    listRuns: (limit = 50, repoId?: string): Run[] => {
      const rows = repoId
        ? db.prepare('SELECT data FROM runs WHERE repo_id = ? ORDER BY queued_at DESC LIMIT ?').all(repoId, limit)
        : db.prepare('SELECT data FROM runs ORDER BY queued_at DESC LIMIT ?').all(limit);
      return (rows as { data: string }[]).map((r) => {
        const run = JSON.parse(r.data) as Run;
        return { ...run, flow: { ...run.flow, blocks: [], edges: [] } }; // list view doesn't need the snapshot
      });
    },
    /** Newest first. Every filter is optional; `sha` matches a prefix of the head commit. */
    findRuns: (q: RunQuery): Run[] => {
      const where: string[] = [], args: (string | number)[] = [];
      if (q.repoIds) { where.push(`repo_id IN (${q.repoIds.map(() => '?').join(', ') || 'NULL'})`); args.push(...q.repoIds); }
      if (q.branch) { where.push("json_extract(data, '$.branch') = ?"); args.push(q.branch); }
      if (q.pr != null) { where.push("json_extract(data, '$.pr.number') = ?"); args.push(q.pr); }
      if (q.sha != null) {
        const hex = q.sha.replace(/[^0-9a-f]/gi, '');
        if (!hex) return [];   // an empty prefix would match every run
        where.push("json_extract(data, '$.headSha') LIKE ?"); args.push(`${hex}%`);
      }
      if (q.triggers?.length) { where.push(`json_extract(data, '$.trigger') IN (${q.triggers.map(() => '?').join(', ')})`); args.push(...q.triggers); }
      const sql = `SELECT data FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY queued_at DESC LIMIT ?`;
      return (db.prepare(sql).all(...args, q.limit ?? 50) as { data: string }[]).map((r) => {
        const run = JSON.parse(r.data) as Run;
        return { ...run, flow: { ...run.flow, blocks: [], edges: [] } };
      });
    },
    setRunFindings: (id: string, findings: Finding[]) => db.prepare('UPDATE runs SET findings = ? WHERE id = ?').run(JSON.stringify(findings), id),
    getRunFindings: (id: string): Finding[] => {
      const r = db.prepare('SELECT findings FROM runs WHERE id = ?').get(id) as { findings: string } | undefined;
      return r ? JSON.parse(r.findings) : [];
    },
    putBlockRun: (b: BlockRun) =>
      db.prepare(`INSERT INTO block_runs (run_id, block_id, data) VALUES (?, ?, ?)
        ON CONFLICT(run_id, block_id) DO UPDATE SET data = excluded.data`).run(b.runId, b.blockId, JSON.stringify(b)),
    listBlockRuns: (runId: string): BlockRun[] =>
      (db.prepare('SELECT data FROM block_runs WHERE run_id = ?').all(runId) as { data: string }[]).map((r) => JSON.parse(r.data)),
    /** Runs left 'running' or 'queued' by a daemon that died. */
    failOrphanRuns: () => {
      const rows = db.prepare("SELECT data FROM runs WHERE status IN ('running', 'queued')").all() as { data: string }[];
      for (const row of rows) {
        const r = JSON.parse(row.data) as Run;
        r.status = 'failed';
        r.error = 'The daemon stopped while this run was in progress';
        r.finishedAt = now();
        db.prepare('UPDATE runs SET status = ?, data = ? WHERE id = ?').run(r.status, JSON.stringify(r), r.id);
      }
      return rows.length;
    },

    // pushes the hook reported that PuRR then decided not to review, so `purr findings --wait` can stop waiting
    /** Best effort: losing the note never costs a review (the callers are mid-way through scheduling one). */
    setPushOutcome: (o: Omit<PushOutcome, 'at'>) => {
      try {
        db.prepare('INSERT INTO push_outcomes (sha, data, at) VALUES (?, ?, ?) ON CONFLICT(sha) DO UPDATE SET data = excluded.data, at = excluded.at')
          .run(o.sha.toLowerCase(), JSON.stringify(o), now());
        db.prepare('DELETE FROM push_outcomes WHERE at < ?').run(new Date(Date.now() - 30 * 86_400_000).toISOString());
      } catch { /* the database is busy: --wait then waits out its timeout instead of stopping early */ }
    },
    clearPushOutcome: (sha: string) => { try { db.prepare('DELETE FROM push_outcomes WHERE sha = ?').run(sha.toLowerCase()); } catch { /* as above */ } },
    /** The newest outcome for a commit (by sha prefix) pushed from one of `repoPaths`: another repo's commit can share a short prefix. */
    getPushOutcome: (shaPrefix: string, repoPaths: string[]): PushOutcome | null => {
      const hex = shaPrefix.replace(/[^0-9a-f]/gi, '').toLowerCase();
      if (!hex) return null;
      // a range on the key rather than LIKE, so the primary key index is used ('g' sorts after every hex digit)
      const rows = db.prepare('SELECT data, at FROM push_outcomes WHERE sha >= ? AND sha < ? ORDER BY at DESC LIMIT 50').all(hex, `${hex}g`) as
        { data: string; at: string }[];
      const paths = new Set(repoPaths);
      for (const r of rows) {
        const o = { ...JSON.parse(r.data), at: r.at } as PushOutcome;
        if (paths.has(o.repoPath)) return o;
      }
      return null;
    },
    /** On start: pushes still pending lost their review when the service stopped. */
    expirePendingPushes: () => {
      const rows = db.prepare('SELECT sha, data FROM push_outcomes').all() as { sha: string; data: string }[];
      for (const r of rows) {
        const o = JSON.parse(r.data) as PushOutcome;
        if (o.kind !== 'pending') continue;
        db.prepare('UPDATE push_outcomes SET data = ? WHERE sha = ?')
          .run(JSON.stringify({ ...o, kind: 'skipped', reason: 'PuRR stopped before reviewing it; push again or run purr run' }), r.sha);
      }
    },

    // sessions (for the daily cap and audit)
    recordSession: (id: string, runId: string, blockId: string, data: unknown) =>
      db.prepare('INSERT OR REPLACE INTO sessions (id, run_id, block_id, created_at, data) VALUES (?, ?, ?, ?, ?)')
        .run(id, runId, blockId, now(), JSON.stringify(data)),

    // ledger
    getLedger: (fingerprint: string, repoId: string): LedgerItem | null => {
      const r = db.prepare('SELECT * FROM ledger WHERE fingerprint = ? AND repo_id = ?').get(fingerprint, repoId) as LedgerRow | undefined;
      return r ? fromLedgerRow(r) : null;
    },
    putLedger: (l: LedgerItem) =>
      db.prepare(`INSERT INTO ledger (fingerprint, repo_id, branch, state, data, first_run_id, last_run_id, updated_at, flow_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(fingerprint, repo_id) DO UPDATE SET branch = excluded.branch,
        state = excluded.state, data = excluded.data, last_run_id = excluded.last_run_id, updated_at = excluded.updated_at,
        flow_id = excluded.flow_id`)
        .run(l.fingerprint, l.repoId, l.branch, l.state, JSON.stringify(l.finding), l.firstRunId, l.lastRunId, l.updatedAt, l.flowId),
    listLedger: (repoId?: string, state?: string): LedgerItem[] => {
      const where: string[] = [], args: string[] = [];
      if (repoId) { where.push('repo_id = ?'); args.push(repoId); }
      if (state) { where.push('state = ?'); args.push(state); }
      const sql = `SELECT * FROM ledger ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT 1000`;
      return (db.prepare(sql).all(...args) as unknown as LedgerRow[]).map(fromLedgerRow);
    },
    /** Ledger items a run marked fixed (raised before on its branch, not by it). */
    listFixedBy: (repoId: string, runId: string): LedgerItem[] =>
      (db.prepare("SELECT * FROM ledger WHERE repo_id = ? AND state = 'fixed' AND last_run_id = ?").all(repoId, runId) as unknown as LedgerRow[])
        .map(fromLedgerRow),
    findLedgerByFingerprint: (fingerprint: string, repoId?: string): LedgerItem | null => {
      const r = (repoId
        ? db.prepare('SELECT * FROM ledger WHERE fingerprint = ? AND repo_id = ?').get(fingerprint, repoId)
        : db.prepare('SELECT * FROM ledger WHERE fingerprint = ?').get(fingerprint)) as LedgerRow | undefined;
      return r ? fromLedgerRow(r) : null;
    },
  };
}

interface LedgerRow {
  fingerprint: string; repo_id: string; branch: string | null; state: LedgerItem['state']; data: string;
  first_run_id: string; last_run_id: string; updated_at: string; flow_id: string | null;
}
const fromLedgerRow = (r: LedgerRow): LedgerItem => ({
  fingerprint: r.fingerprint, repoId: r.repo_id, branch: r.branch, state: r.state, flowId: r.flow_id ?? null, finding: JSON.parse(r.data),
  firstRunId: r.first_run_id, lastRunId: r.last_run_id, updatedAt: r.updated_at,
});
