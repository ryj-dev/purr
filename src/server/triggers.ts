// Post-push detection. Git has no post-push hook, so two sources feed one debounced queue:
//  1. fast path: the pre-push hook tells the daemon what it is about to push; we wait until the remote has the commit.
//  2. source of truth: a poller over the open PRs of every account signed in to gh (one GraphQL call each), matched
//     to local clones by their GitHub remote. It catches pushes from other machines, PRs opened after the push, and
//     repos git's hooks can't reach. Repos in the project folders are discovered and registered every 10 minutes.
import { existsSync, realpathSync } from 'node:fs';
import type { DB } from './db.ts';
import { lsRemote, remoteUrl } from './git.ts';
import { addRepo } from './http.ts';
import { type OpenPr, type PrInfo, ghAuthed, githubRepo, openPrsForAllAccounts, prForBranch } from './gh.ts';
import { discoverRepos } from './discovery.ts';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Repo } from '../shared/types.ts';
import type { RunManager } from './manager.ts';

/** What the watcher asks of git and GitHub; the tests swap these out. */
export interface WatcherDeps {
  fetchPrs: () => Promise<OpenPr[] | null>;
  lsRemote: (cwd: string, remote: string, branch: string) => Promise<string | null>;
  ghAuthed: () => Promise<boolean>;
  prForBranch: (repoPath: string, branch: string) => Promise<PrInfo | null>;
}

export class PostPushWatcher {
  db: DB;
  mgr: RunManager;
  /** "owner/name:branch" (or the clone's path when it has no GitHub remote) -> head sha already scheduled for review,
   *  shared by the push hook and the poller, and by every clone or worktree of the same repo. */
  private lastSeen = new Map<string, string>();
  private seenPr = new Map<string, string>();     // owner/name#number -> head sha the poller last saw
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private lastDiscovery = 0;
  private startedAt = Date.now();
  private deps: WatcherDeps;
  /** push confirmations still waiting for the remote */
  private confirming = new Set<Promise<void>>();

  private handledKey(repo: Repo, branch: string) { return `${githubRepo(repo.remoteUrl) ?? repo.path}:${branch}`; }

  constructor(db: DB, mgr: RunManager, deps: Partial<WatcherDeps> = {}) {
    this.db = db; this.mgr = mgr;
    this.deps = { fetchPrs: openPrsForAllAccounts, lsRemote, ghAuthed, prForBranch, ...deps };
  }

  start() {
    const tick = async () => {
      if (!this.polling) {
        this.polling = true;
        try { await this.poll(); } catch { /* logged per repo */ } finally { this.polling = false; }
      }
      this.timer = setTimeout(tick, Math.max(15, this.db.getSettings().pollIntervalSec) * 1000);
      this.timer.unref();
    };
    void tick();
  }
  stop() { if (this.timer) clearTimeout(this.timer); }

  /** Test seam: resolves once every push the hook reported has been confirmed (or given up on). */
  async settled() { while (this.confirming.size) await Promise.all([...this.confirming]); }

  /** From the pre-push hook. Confirms the push landed (up to 90s), then schedules the post-push flow. */
  async pushIntent(body: { repoPath: string; branch: string; sha: string; remote?: string }) {
    if (body.repoPath && existsSync(body.repoPath)) body.repoPath = realpathSync(body.repoPath);
    // every repo counts: register it on its first push if no commit has yet
    const repo = this.db.getRepoByPath(body.repoPath) ?? await addRepo(this.db, body.repoPath).catch(() => null);
    if (!repo) return { queued: false, reason: 'not a git repository' };
    const remote = body.remote || 'origin';
    const prOnly = this.db.getSettings().postPushPrsOnly;
    const confirm = (async () => {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if ((await this.deps.lsRemote(body.repoPath, remote, body.branch)) === body.sha) {
          const gh = await this.deps.ghAuthed();
          const pr = gh ? await this.deps.prForBranch(body.repoPath, body.branch) : null;
          // no open PR (a push to main, or a branch not yet proposed): no review, and nothing marked as handled, so
          // the poller reviews this commit when its PR is opened
          if (prOnly && gh && !pr) {
            this.db.setPushOutcome({ sha: body.sha, kind: 'no-pr', reason: `${body.branch} has no open PR; it's reviewed once one is opened`,
              repoPath: body.repoPath, branch: body.branch });
            return;
          }
          const key = this.handledKey(repo, body.branch);
          if (this.lastSeen.get(key) === body.sha) return;   // already scheduled from another clone
          this.lastSeen.set(key, body.sha);
          this.mgr.schedulePostPush({
            trigger: 'post-push', repoPath: body.repoPath, mode: 'range', head: body.sha, branch: body.branch, pr,
            base: pr ? pr.baseRefName : null,
          });
          return;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      this.db.setPushOutcome({ sha: body.sha, kind: 'skipped', reason: `the push never showed up on ${remote}/${body.branch}`,
        repoPath: body.repoPath, branch: body.branch });
    })().catch(() => {});
    this.confirming.add(confirm);
    void confirm.finally(() => this.confirming.delete(confirm));
    return { queued: true, prOnly };
  }

  /** Local clones by GitHub repo ("owner/name"), main checkouts before worktrees. */
  private async clonesByRepo(): Promise<Map<string, Repo[]>> {
    const map = new Map<string, Repo[]>();
    for (const repo of this.db.listRepos()) {
      if (!repo.remoteUrl && existsSync(repo.path)) {
        // registered before it had a remote: look again rather than skipping it forever
        const url = await remoteUrl(repo.path);
        if (url) { repo.remoteUrl = url; this.db.putRepo(repo); }
      }
      const key = githubRepo(repo.remoteUrl);
      if (!key || !existsSync(repo.path)) continue;
      const list = map.get(key) ?? [];
      list.push(repo);
      map.set(key, list);
    }
    const isMain = (r: Repo) => { try { return statSync(join(r.path, '.git')).isDirectory(); } catch { return false; } };
    for (const list of map.values()) list.sort((a, b) => Number(isMain(b)) - Number(isMain(a)));
    return map;
  }

  /**
   * One poll. A PR's first sighting only counts if it was opened after the service started (within the last 10
   * minutes): otherwise discovering a repo, or restarting PuRR, would review every PR that's already open.
   */
  async poll() {
    if (Date.now() - this.lastDiscovery > 10 * 60_000) {
      this.lastDiscovery = Date.now();
      await discoverRepos(this.db).catch(() => 0);
    }
    const prs = await this.deps.fetchPrs();
    if (!prs) return;
    const clones = await this.clonesByRepo();
    for (const pr of prs) {
      const repo = clones.get(pr.repo)?.[0];
      if (!repo) continue;
      const key = `${pr.repo}#${pr.number}`;
      const seen = this.seenPr.get(key);
      this.seenPr.set(key, pr.headRefOid);
      if (seen === pr.headRefOid || pr.isDraft) continue;
      const handled = this.handledKey(repo, pr.headRefName);
      if (this.lastSeen.get(handled) === pr.headRefOid) continue;   // the push hook (from any clone) has it
      if (seen === undefined) {
        const opened = pr.createdAt ? Date.parse(pr.createdAt) : 0;
        if (!(opened >= this.startedAt && Date.now() - opened < 10 * 60_000)) continue;
      }
      this.lastSeen.set(handled, pr.headRefOid);
      this.mgr.schedulePostPush({
        trigger: 'post-push', repoPath: repo.path, mode: 'range', head: pr.headRefOid, branch: pr.headRefName, pr,
        base: pr.baseRefName,
      });
    }
  }
}
