// Post-push detection. Git has no post-push hook, so two sources feed one debounced queue:
//  1. fast path: the pre-push hook tells the daemon what it is about to push; we wait until the remote has the commit.
//  2. source of truth: a poller over the open PRs of every account signed in to gh (one GraphQL call each), matched
//     to local clones by their GitHub remote. It catches pushes from other machines, PRs opened after the push, and
//     repos git's hooks can't reach. Repos in the project folders are discovered and registered every 10 minutes.
import { existsSync, realpathSync } from 'node:fs';
import type { DB, PushOutcome } from './db.ts';
import { inHistoryOf, lsRemote, remoteUrl } from './git.ts';
import { addRepo } from './http.ts';
import { type PrFetch, type PrInfo, ghAuthed, githubRepo, openPrsForAllAccounts, prForBranch } from './gh.ts';
import { discoverRepos } from './discovery.ts';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Repo } from '../shared/types.ts';
import type { RunManager } from './manager.ts';

/** What the watcher asks of git and GitHub; the tests swap these out. */
export interface WatcherDeps {
  fetchPrs: () => Promise<PrFetch | null>;
  lsRemote: (cwd: string, remote: string, branch: string) => Promise<string | null>;
  ghAuthed: () => Promise<boolean>;
  prForBranch: (repoPath: string, branch: string) => Promise<PrInfo | null>;
  inHistoryOf: (cwd: string, remote: string, a: string, b: string) => Promise<'yes' | 'no' | 'unknown'>;
  /** how long the hook's push gets to show up on the remote, and how often to look */
  confirmMs: number;
  confirmEveryMs: number;
}

/** How often the poller looks for repos cloned since (ones PuRR's hooks never ran in, like a husky repo). */
const DISCOVERY_MS = 10 * 60_000;

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
  /** per gh account: when its PR list last got an answer */
  private lastFetch = new Map<string, number>();
  /** gh accounts listed at the first poll */
  private startAccounts: Set<string> | null = null;
  private answeredOnce = false;
  private deps: WatcherDeps;
  /** push confirmations still waiting for the remote */
  private confirming = new Set<Promise<void>>();

  private handledKey(repo: Repo, branch: string) { return `${githubRepo(repo.remoteUrl) ?? repo.path}:${branch}`; }

  constructor(db: DB, mgr: RunManager, deps: Partial<WatcherDeps> = {}) {
    this.db = db; this.mgr = mgr;
    this.deps = { fetchPrs: openPrsForAllAccounts, lsRemote, ghAuthed, prForBranch, inHistoryOf, confirmMs: 90_000, confirmEveryMs: 3000, ...deps };
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
  async pushIntent(body: { repoPath: string; branch: string; sha: string; remote?: string; from: string | null }) {
    if (body.repoPath && existsSync(body.repoPath)) body.repoPath = realpathSync(body.repoPath);
    // every repo counts: register it on its first push if no commit has yet
    const repo = this.db.getRepoByPath(body.repoPath) ?? await addRepo(this.db, body.repoPath).catch(() => null);
    if (!repo) return { queued: false, reason: 'not a git repository' };
    if (!repo.remoteUrl) {
      // a remote added since the repo was registered: the poller keys pushes by owner/name, so the hook must too
      const url = await remoteUrl(body.repoPath);
      if (url) { repo.remoteUrl = url; this.db.putRepo(repo); }
    }
    const remote = body.remote || 'origin';
    const prOnly = this.db.getSettings().postPushPrsOnly;
    // what became of the push, for `purr findings --wait`: pending until its review exists (createRun clears it) or
    // it's clear none will; a restart turns what's still pending into skipped
    const note = (kind: PushOutcome['kind'], reason: string, nextSha: string | null = null) => {
      this.db.setPushOutcome({ sha: body.sha, kind, reason, repoPath: body.repoPath, branch: body.branch, nextSha });
      this.mgr.emit({ type: 'push', sha: body.sha });   // wakes a `purr findings --wait` on this commit
    };
    note('pending', 'waiting for the push to land');
    const confirm = (async () => {
      const deadline = Date.now() + this.deps.confirmMs;
      const from = body.from;   // the branch's tip before this push (null: a new branch), as the hook saw it
      let onTop: string | null = null;   // a newer tip found on top of this push before it was seen, that nothing else reviews
      while (Date.now() < deadline) {
        const tip = await this.deps.lsRemote(body.repoPath, remote, body.branch);
        if (tip && tip !== body.sha && tip !== from) {
          // the branch moved on before this push was seen. If something will review that newer push (its own hook here
          // reported it: a quick second push, or an amend force-pushed straight after; or an open PR the poller
          // lists), its review covers or replaces this one
          const pr0 = (await this.deps.ghAuthed()) ? await this.deps.prForBranch(body.repoPath, body.branch) : null;
          if (await this.reviewed(repo, body.repoPath, body.branch, tip, pr0)) return note('superseded', 'a newer push to the branch took its place', tip);
          // nothing will. Not on top of this push (it was rejected, a teammate's went in instead): nothing reviews it;
          // a teammate's commit isn't this hook's to review. git fetches the tip if it hasn't got it, to tell
          const line = await this.deps.inHistoryOf(body.repoPath, remote, body.sha, tip);
          if (line === 'no') return note('skipped', `the branch moved to ${tip.slice(0, 12)}, which doesn't include this push (was it rejected?)`);
          if (line === 'unknown') { await new Promise((r) => setTimeout(r, this.deps.confirmEveryMs)); continue; }   // look again
          // on top of it (CI, a bot's) with no review coming: the newer push is reviewed here, which covers this one
          onTop = tip;
        }
        if (tip === body.sha || (tip && tip !== from)) {
          const gh = await this.deps.ghAuthed();
          const pr = gh ? await this.deps.prForBranch(body.repoPath, body.branch) : null;
          // gh can be slow: if a newer push landed meanwhile, it's the one to review, and this older push mustn't take
          // its place in the debounce. It's left to the newer push's own review if something will give one (a hook
          // here reported it, or an open PR the poller sees); otherwise (another machine's or a bot's push, no PR)
          // this hook reviews the newer push, which covers this one, and --wait follows it there. No answer from
          // ls-remote is no news: it landed
          // (a tip already found on top of this push is the one to review, even if the next look gets no answer)
          let head = onTop ?? body.sha;
          if (onTop) note('superseded', 'a newer push nothing else reviews landed on top; reviewed in its place', onTop);
          const again = await this.deps.lsRemote(body.repoPath, remote, body.branch);
          if (again && again !== body.sha && again !== onTop && await this.reviewed(repo, body.repoPath, body.branch, again, pr)) {
            return note('superseded', 'a newer push to the branch took its place', again);
          }
          // nothing will review the newer push: on top of this one (a bot's), it's reviewed here instead, covering this
          // one; not on top (a force-push nobody here reported, a teammate's), this push, which did land, is reviewed
          if (again && again !== body.sha && again !== onTop && (await this.deps.inHistoryOf(body.repoPath, remote, body.sha, again)) === 'yes') {
            note('superseded', 'a newer push nothing else reviews landed on top; reviewed in its place', again);
            head = again;
          }
          // no open PR (a push to main, or a branch not yet proposed): no review, and nothing marked as handled, so
          // the poller reviews this commit when its PR is opened
          // not a GitHub remote (GitLab, a bare repo): it can't have a PR here, so with reviews PR-only none will come
          // (the remote pushed to, which needn't be origin)
          const pushedUrl = remote === 'origin' ? repo.remoteUrl : await remoteUrl(body.repoPath, remote);
          // (only with gh signed in: without gh, PR-only can't apply and every push is reviewed)
          if (prOnly && gh && pushedUrl && !githubRepo(pushedUrl)) return note('skipped', `${remote} isn't on GitHub, and PuRR reviews only PRs (turn that off in Settings)`);
          // post-push off in every clone: nothing will review it, PR or not
          const ghRepo = githubRepo(repo.remoteUrl);
          const clonesHere = ghRepo ? this.db.listRepos().filter((r) => githubRepo(r.remoteUrl) === ghRepo) : [repo];
          if (!clonesHere.some((c) => this.mgr.resolveFlow('post-push', c.id))) return note('skipped', 'the post-push trigger is off for this repo');
          if (prOnly && gh && !pr) return note('no-pr', `${body.branch} has no open PR; it's reviewed once one is opened`);
          if (!this.mgr.resolveFlow('post-push', repo.id)) {
            // post-push off for this clone: left to the poller, through another clone of the repo that has it on
            const others = (await this.clonesByRepo()).get(githubRepo(repo.remoteUrl) ?? '') ?? [];
            if (pr && others.some((c) => this.mgr.resolveFlow('post-push', c.id))) {
              return note('elsewhere', 'the post-push trigger is off in this clone; another clone reviews its PR');
            }
            return note('skipped', 'the post-push trigger is off for this repo');
          }
          const key = this.handledKey(repo, body.branch);
          // already scheduled from another clone: its review covers this push, and its creation clears the notes
          if (this.lastSeen.get(key) === head) return head === body.sha ? this.db.deletePushOutcome(body.sha, body.repoPath, body.branch) : undefined;
          this.lastSeen.set(key, head);
          this.mgr.schedulePostPush({
            trigger: 'post-push', repoPath: body.repoPath, mode: 'range', head, branch: body.branch, pr,
            base: pr ? pr.baseRefName : null,
          });
          return;
        }
        await new Promise((r) => setTimeout(r, this.deps.confirmEveryMs));
      }
      note('skipped', `the push never showed up on ${remote}/${body.branch}`);
    })().catch((e) => {
      // a waiting `purr findings` must hear that this went wrong, not wait out its timeout on "pending"
      try { note('skipped', `PuRR couldn't confirm the push: ${e?.message ?? e}`); } catch { /* nothing more to do */ }
    });
    this.confirming.add(confirm);
    void confirm.finally(() => this.confirming.delete(confirm));
    return { queued: true, prOnly };
  }


  /**
   * Whether a push at `sha` will be reviewed by something: an open (not draft) PR the poller sees, or a hook here
   * (any clone of the repo) that reported it.
   */
  private async reviewed(repo: Repo, repoPath: string, branch: string, sha: string, pr: PrInfo | null): Promise<boolean> {
    const key = githubRepo(repo.remoteUrl);
    // the poller reviews an open PR only if it lists it (PRs by the signed-in accounts, so not a teammate's), and only
    // through a clone with post-push on
    const clones = key ? this.db.listRepos().filter((r) => githubRepo(r.remoteUrl) === key) : [repo];
    if (pr && !pr.isDraft && this.seenPr.has(`${key}#${pr.number}`) && clones.some((c) => this.mgr.resolveFlow('post-push', c.id))) return true;
    const paths = [repoPath, ...(key ? this.db.listRepos().filter((r) => githubRepo(r.remoteUrl) === key).map((r) => r.path) : [])];
    // already scheduled here, or its review already created (which clears its notes): a quick debounce, slow gh calls
    if (this.lastSeen.get(this.handledKey(repo, branch)) === sha) return true;
    const ids = clones.map((c) => c.id);
    if (this.db.findRuns({ repoIds: ids, branch, sha, triggers: ['post-push', 'manual'], limit: 1 }).length) return true;
    // a note for this branch that still promises a review: one pushed to another branch long ago says nothing here
    // (a pending note from a clone with post-push off promises nothing: that clone's hook won't review it)
    const willReview = (path: string) => { const r = this.db.getRepoByPath(path); return !!r && !!this.mgr.resolveFlow('post-push', r.id); };
    return this.db.getPushOutcomes(sha, paths)
      .some((o) => o.branch === branch && ((o.kind === 'pending' && willReview(o.repoPath)) || !!o.nextSha));
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
   * One poll. A PR's first sighting only counts if it was opened since the service started and since the last poll
   * that got an answer: otherwise discovering a repo, or restarting PuRR, would review every PR that's already open.
   * Measured from the last good poll rather than a fixed window, so a long poll interval or a gh outage doesn't
   * lose a PR opened in between.
   */
  async poll() {
    if (Date.now() - this.lastDiscovery > DISCOVERY_MS) {
      this.lastDiscovery = Date.now();
      await discoverRepos(this.db).catch(() => 0);
    }
    const asked = Date.now();
    const fetched = await this.deps.fetchPrs();
    // gh unusable at the first poll: an account that turns up within the first quarter hour was most likely there all
    // along (gh offline at login, before the network was up); one that turns up later was signed in later
    if (!fetched) { this.startAccounts ??= new Set(); return; }
    if (!this.answeredOnce) {
      this.answeredOnce = true;
      if (!this.startAccounts?.size && Date.now() - this.startedAt < 15 * 60_000) this.startAccounts = new Set(fetched.accounts ?? fetched.answered);
    }
    const { prs } = fetched;
    // PRs opened before their account's last answered poll were there to be seen then (two minutes' slack for
    // GitHub's clock). Per account: one whose query failed (asleep, offline, token expired) keeps its old mark
    // An account signed in only after the first poll starts from now: its PRs are already open, not new. One that was
    // there at the first poll but hasn't answered yet (failing since startup) still starts from startedAt
    if (!this.startAccounts) this.startAccounts = new Set(fetched.accounts ?? fetched.answered);
    const since = (account: string) => {
      // signed in after startup: from when PuRR last read gh's accounts without it (a sign-in in a terminal shows
      // up only when the five-minute account cache runs out), else from now
      const last = this.lastFetch.get(account) ?? (this.startAccounts!.has(account) ? 0 : fetched.signedInSince?.[account] ?? Date.now());
      return Math.max(this.startedAt, last - 2 * 60_000);
    };
    const marks = new Map(prs.map((pr) => [pr.account, since(pr.account)]));
    // when each account last answered before this poll: a clone registered after that is new to that account's PRs
    const before = new Map(this.lastFetch);
    const anyBefore = Math.max(0, ...before.values());   // for an account answering for the first time
    for (const a of fetched.answered) this.lastFetch.set(a, fetched.askedAt?.[a] ?? asked);
    const clones = await this.clonesByRepo();
    for (const pr of prs) {
      const local = clones.get(pr.repo);
      if (!local?.length) continue;
      // what each PR's head was at the last poll, whether or not it's reviewed here now: a draft's is marked as one,
      // so marking it ready counts as a change, and so does a push made while post-push was off
      const key = `${pr.repo}#${pr.number}`;
      const seen = this.seenPr.get(key);
      this.seenPr.set(key, pr.isDraft ? `draft:${pr.headRefOid}` : pr.headRefOid);
      if (seen === pr.headRefOid || pr.isDraft) continue;
      // the first clone (main checkouts first) with post-push on; none: leave the PR alone, and claim nothing
      const repo = local.find((c) => this.mgr.resolveFlow('post-push', c.id));
      if (!repo) continue;
      const handled = this.handledKey(repo, pr.headRefName);
      if (this.lastSeen.get(handled) === pr.headRefOid) continue;   // the push hook (from any clone) has it
      if (seen === undefined) {
        const opened = pr.createdAt ? Date.parse(pr.createdAt) : 0;
        // an older PR, unless its head is a push the hook saw with no PR to review it through (opened while PuRR
        // was down, say): that push is still owed its review
        const owed = this.db.getPushOutcomes(pr.headRefOid, local.map((c) => c.path))
          .some((o) => (o.kind === 'no-pr' || o.kind === 'elsewhere') && o.sha === pr.headRefOid.toLowerCase());
        // or opened shortly before its clone was first registered here: a repo with its own git hooks is only found by
        // discovery, up to ten minutes after it was cloned, pushed and proposed. Not before PuRR started, though
        // (only for a clone registered since this PR's account last answered: before that, the poller couldn't have
        // seen the PR through it, even if gh failed in the poll that found the clone)
        const cloned = Math.max(...local.map((c) => Date.parse(c.addedAt) || 0));
        // (and only once some account has answered a poll before: gh signed in late, every clone predates that answer)
        const justCloned = before.size > 0 && cloned > (before.get(pr.account) ?? anyBefore) && opened >= this.startedAt && opened >= cloned - DISCOVERY_MS;
        if (!owed && !justCloned && !(opened >= (marks.get(pr.account) ?? this.startedAt))) continue;
      }
      this.lastSeen.set(handled, pr.headRefOid);
      this.mgr.schedulePostPush({
        trigger: 'post-push', repoPath: repo.path, mode: 'range', head: pr.headRefOid, branch: pr.headRefName, pr,
        base: pr.baseRefName,
      });
    }
  }
}
