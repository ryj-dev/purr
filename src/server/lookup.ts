// Read side for `purr findings` / `purr runs`: lets a Claude session (or a person) look up a review's results.
import { existsSync, realpathSync } from 'node:fs';
import type { Finding, Run } from '../shared/types.ts';
import type { DB, RunQuery } from './db.ts';
import { type PrInfo, githubRepo, prLookup } from './gh.ts';
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

/**
 * A run's findings with their ledger state as it is now: a finding dismissed since says so, and so does one a later
 * review of the same branch found fixed. The ledger keeps one row per finding for the whole repo, so a fix on another
 * branch (a stacked PR, say) says nothing about this one.
 */
export function currentFindings(db: DB, run: Run): Finding[] {
  return db.getRunFindings(run.id).map((f) => {
    const l = f.fingerprint && run.repoId ? db.getLedger(f.fingerprint, run.repoId) : null;
    if (!l) return f;
    if (l.state === 'dismissed' || l.state === 'tracked') return { ...f, ledger: l.state };
    if (l.state === 'fixed') {
      const by = db.getRun(l.lastRunId);
      if (run.branch && l.branch === run.branch && by && by.queuedAt > run.queuedAt) return { ...f, ledger: 'fixed' };
    }
    if (f.ledger === 'dismissed' || f.ledger === 'tracked') return { ...f, ledger: 'open' };   // reopened since
    return f;
  });
}

export const isFinished = (run: Run) => TERMINAL.has(run.status);

export interface ReviewState {
  run: Run | null;      // null until the review exists
  done: boolean;        // nothing more to wait for
  stop?: string;        // why no review will come
}

/**
 * What `purr findings --wait` waits on. A commit can lose its own review to a newer push (in the debounce, or a
 * running review superseded): the watch then follows the newer push's review, which covers it. It stops early when
 * PuRR recorded that the commit won't be reviewed, unless that was for want of a PR and one is open now.
 */
export class ReviewWatch {
  q: RunQuery;
  notes: string[] = [];
  private db: DB;
  private findPr: typeof prLookup;
  private prChecked = new Map<string, { at: number; pr: PrInfo | null }>();
  private visited = new Set<string>();
  private via: { repoPath: string; branch: string } | null = null;
  constructor(db: DB, q: RunQuery, findPr: typeof prLookup = prLookup) {
    this.db = db; this.q = q; this.findPr = findPr;
    if (q.sha) this.visited.add(q.sha.toLowerCase());
  }

  async check(): Promise<ReviewState> {
    for (let hops = 0; hops < 20; hops++) {
      const run = this.db.findRuns({ ...this.q, limit: 1 })[0] ?? null;
      if (run?.status === 'superseded') {
        const next = run.branch ? this.db.findRuns({ repoIds: this.q.repoIds, branch: run.branch, triggers: this.q.triggers, limit: 1 })[0] : null;
        if (next?.headSha && next.id !== run.id && next.queuedAt > run.queuedAt) {
          // back to a commit followed before (pushed A, B, then A again): its newer review is the one to wait on now
          if (!this.follow(next.headSha, `review ${run.id} was superseded by a newer push`)) this.revisit(next.headSha);
          continue;
        }
        return { run, done: false };   // the newer push's review is still in its debounce
      }
      if (run) return { run, done: isFinished(run) };
      const paths = (this.q.repoIds ?? []).map((id) => this.db.getRepo(id)?.path).filter((p): p is string => !!p);
      // one note per branch the commit went to: wait while any of them may still bring a review
      const outs = this.q.sha ? this.db.getPushOutcomes(this.q.sha, paths) : [];
      // a newer push that took its place: follow it, whatever else is still pending
      const overtaken = outs.find((o) => o.nextSha);
      if (overtaken) {
        // back to a commit already followed (pushed A, B, then A again): look at that commit's review afresh; the
        // hop limit stops notes that only point at each other
        if (!this.follow(overtaken.nextSha!, `commit ${overtaken.sha.slice(0, 12)} wasn't reviewed on its own: ${overtaken.reason}`, overtaken)) this.revisit(overtaken.nextSha!);
        continue;
      }
      if (outs.some((o) => o.kind === 'pending')) return { run: null, done: false };
      let stop: string | null = null;
      for (const out of outs) {
        // reviewed through its PR (once there's one, or by another clone): depends on that PR now
        if ((out.kind !== 'no-pr' && out.kind !== 'elsewhere') || !out.branch) continue;
        const pr = await this.prOf(out.repoPath, out.branch);
        if (pr === undefined) return { run: null, done: false };   // gh couldn't say: no conclusions
        if (pr && !pr.isDraft) {
          // a PR is open now, and the poller reviews its head: this commit, or a later push that covers it
          if (pr.headRefOid && pr.headRefOid !== out.sha) {
            if (!this.follow(pr.headRefOid, `${out.branch}'s PR is at a later push now`, out)) this.revisit(pr.headRefOid);
            stop = 'follow';
            break;
          }
          return { run: null, done: false };
        }
        if (pr?.isDraft) stop ??= `commit ${out.sha.slice(0, 12)} won't be reviewed yet: its PR is a draft (PuRR reviews it once it's marked ready)`;
      }
      if (stop === 'follow') continue;
      if (outs.length) return { run: null, done: true, stop: stop ?? `commit ${outs[0].sha.slice(0, 12)} won't be reviewed: ${outs[0].reason}` };
      // followed to a push no hook here reported (CI, another machine): no note says what becomes of it, so its PR does
      if (this.via) return this.byPr(this.via);
      return { run: null, done: false };
    }
    // only notes that point at each other, with no review between them: one may still come, so wait
    return { run: null, done: false };
  }

  /** Moves on to `sha`'s review; false if it was followed before (a loop). `from`: the push note that led here. */
  private follow(sha: string, why: string, from?: { repoPath: string; branch: string | null }): boolean {
    const key = sha.toLowerCase();
    if ([...this.visited].some((v) => key.startsWith(v))) return false;   // the first may be a short prefix
    this.visited.add(key);
    this.notes.push(`${why}; following the review of ${sha.slice(0, 12)}, which covers it`);
    this.q = { ...this.q, sha, branch: null, pr: null };
    this.via = from?.branch ? { repoPath: from.repoPath, branch: from.branch } : null;
    return true;
  }

  private revisit(sha: string) { this.q = { ...this.q, sha, branch: null, pr: null }; }

  /** For a push nothing here noted: reviewed if its branch's PR is open (not a draft), or if reviews aren't PR-only. */
  private async byPr(via: { repoPath: string; branch: string }): Promise<ReviewState> {
    const pr = await this.prOf(via.repoPath, via.branch);
    if (pr === undefined) return { run: null, done: false };
    if (pr?.isDraft) return { run: null, done: true, stop: `${via.branch}'s PR is a draft: PuRR reviews it once it's marked ready` };
    if (!pr && this.db.getSettings().postPushPrsOnly) {
      return { run: null, done: true, stop: `${via.branch} has no open PR, so the newer push won't be reviewed until one is opened` };
    }
    return { run: null, done: false };
  }

  /**
   * The branch's open PR now (a draft included), null for none, or undefined when gh couldn't say (then keep
   * waiting rather than conclude anything). A real answer is kept for 20s.
   */
  private async prOf(repoPath: string, branch: string): Promise<PrInfo | null | undefined> {
    const c = this.prChecked.get(branch);
    if (c && Date.now() - c.at < 20_000) return c.pr;
    const pr = await this.findPr(repoPath, branch).catch(() => undefined);
    if (pr !== undefined) this.prChecked.set(branch, { at: Date.now(), pr });
    return pr;
  }


}

/**
 * The PuRR service's event stream (GET /api/events) as what wakes a waiting `purr findings`: an event about a run or
 * a pushed commit wakes it to look again, and the stream failing or ending means the service stopped, so no review
 * will come. Nothing here polls the service.
 */
export class ServiceEvents {
  down = false;
  private wake: (() => void) | null = null;
  private ac = new AbortController();

  /** Connected, or null when the service isn't running (nothing listening, or no answer within `timeoutMs`). */
  static async connect(port: number, timeoutMs = 3000): Promise<ServiceEvents | null> {
    const ev = new ServiceEvents();
    const t = setTimeout(() => ev.ac.abort(), timeoutMs);
    let res: Response;
    try { res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: ev.ac.signal }); } catch { return null; } finally { clearTimeout(t); }
    if (!res.ok || !res.body) { ev.ac.abort(); return null; }
    void ev.read(res.body);
    return ev;
  }

  private async read(body: ReadableStream<Uint8Array>) {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (const reader = body.getReader(); ;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('\n');
          buf = buf.slice(i + 2);
          try { if (['run', 'push'].includes(JSON.parse(data)?.type)) this.poke(); } catch { /* a ping, or not ours */ }
        }
      }
    } catch { /* the connection dropped */ }
    this.down = true;
    this.poke();
  }

  private poke() { const w = this.wake; this.wake = null; w?.(); }

  /** Until an event, the stream ends, or `ms` pass (a slow look anyway, in case an event was missed). */
  wait(ms: number) {
    if (this.down) return Promise.resolve();
    return new Promise<void>((r) => {
      const t = setTimeout(() => { this.wake = null; r(); }, ms);
      this.wake = () => { clearTimeout(t); r(); };
    });
  }

  close() { this.ac.abort(); }
}

/**
 * Looks, then waits for the service to say something changed, until the watch is done, the service stops (`stop`
 * says so) or the timeout passes. Returns the last state. Without `events` (tests), it looks every `intervalMs`.
 */
export async function waitForReview(watch: { check: () => Promise<ReviewState> },
  opts: { timeoutMs: number; intervalMs?: number; events?: ServiceEvents | null; onChange?: (run: Run | null) => void }) {
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 0) throw new Error(`Bad timeout: ${opts.timeoutMs}`);
  const deadline = Date.now() + opts.timeoutMs;
  let lastKey = '\0';   // nothing a state gives: the first check always reports, even "no review yet"
  for (;;) {
    const st = await watch.check();
    const key = st.run ? `${st.run.id}:${st.run.status}` : '';
    if (key !== lastKey) { lastKey = key; opts.onChange?.(st.run); }
    if (st.done || Date.now() >= deadline) return st;
    if (opts.events?.down) return { ...st, done: true, stop: st.stop ?? "the PuRR service stopped, so no review will come (start PuRR and push again)" };
    const left = Math.max(0, deadline - Date.now());
    if (opts.events) await opts.events.wait(Math.min(opts.intervalMs ?? 30_000, left));
    else await new Promise((r) => setTimeout(r, Math.min(opts.intervalMs ?? 3000, left)));
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
  return db.listFixedBy(run.repoId, run.id).map((l) => ({ ...l.finding, ledger: 'fixed' }));
}

/** Counts towards the exit code and the default listing: not dismissed, tracked or since fixed. */
export const isActive = (f: Finding) => f.ledger !== 'dismissed' && f.ledger !== 'tracked' && f.ledger !== 'fixed';
