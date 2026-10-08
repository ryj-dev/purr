// Post-push detection. Git has no post-push hook, so two sources feed one debounced queue:
//  1. fast path: the pre-push hook tells the daemon what it is about to push; we wait until the remote has the commit.
//  2. source of truth: a `gh` poller over the user's open PRs in registered repos (catches pushes from other machines).
import { existsSync, realpathSync } from 'node:fs';
import type { DB } from './db.ts';
import { lsRemote } from './git.ts';
import { addRepo } from './http.ts';
import { ghAuthed, myOpenPrs, prForBranch } from './gh.ts';
import type { RunManager } from './manager.ts';

export class PostPushWatcher {
  db: DB;
  mgr: RunManager;
  private lastSeen = new Map<string, string>();   // repoId:branch -> head sha already handled
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private primed = false;

  constructor(db: DB, mgr: RunManager) { this.db = db; this.mgr = mgr; }

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

  /** From the pre-push hook. Confirms the push landed (up to 90s), then schedules the post-push flow. */
  async pushIntent(body: { repoPath: string; branch: string; sha: string; remote?: string }) {
    if (body.repoPath && existsSync(body.repoPath)) body.repoPath = realpathSync(body.repoPath);
    // every repo counts: register it on its first push if no commit has yet
    const repo = this.db.getRepoByPath(body.repoPath) ?? await addRepo(this.db, body.repoPath).catch(() => null);
    if (!repo) return { queued: false, reason: 'not a git repository' };
    const remote = body.remote || 'origin';
    const prOnly = this.db.getSettings().postPushPrsOnly;
    void (async () => {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if ((await lsRemote(body.repoPath, remote, body.branch)) === body.sha) {
          this.lastSeen.set(`${repo.id}:${body.branch}`, body.sha);
          const gh = await ghAuthed();
          const pr = gh ? await prForBranch(body.repoPath, body.branch) : null;
          // no open PR (a push to main, or a branch not yet proposed): no review; the poller reviews it once a PR opens
          if (prOnly && gh && !pr) return;
          this.mgr.schedulePostPush({
            trigger: 'post-push', repoPath: body.repoPath, mode: 'range', head: body.sha, branch: body.branch, pr,
            base: pr ? pr.baseRefName : null,
          });
          return;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    })();
    return { queued: true, prOnly };
  }

  /** One poll over every registered repo. The first poll only records what's there, so startup doesn't re-review every open PR. */
  async poll() {
    if (!(await ghAuthed())) return;
    for (const repo of this.db.listRepos()) {
      if (!repo.remoteUrl || !/github\.com/.test(repo.remoteUrl)) continue;
      const prs = await myOpenPrs(repo.path);
      if (!prs) continue;
      for (const pr of prs) {
        const key = `${repo.id}:${pr.headRefName}`;
        const seen = this.lastSeen.get(key);
        this.lastSeen.set(key, pr.headRefOid);
        if (!this.primed || seen === pr.headRefOid) continue;
        if (pr.isDraft) continue;
        this.mgr.schedulePostPush({
          trigger: 'post-push', repoPath: repo.path, mode: 'range', head: pr.headRefOid, branch: pr.headRefName, pr,
          base: pr.baseRefName,
        });
      }
    }
    this.primed = true;
  }
}
