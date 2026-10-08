import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import type { AppState, Repo, ServerEvent, Settings, TriggerAssignment, TriggerKind } from '../shared/types.ts';
import { TRIGGERS } from '../shared/types.ts';
import type { DB } from './db.ts';
import { BLOCK_TYPES } from './flows/blockTypes.ts';
import { HttpError, createFlow, deleteFlow, setBlockOptions, updateFlow } from './flows/store.ts';
import { validateFlow } from './flows/validate.ts';
import { exportFlow, importFlow, previewImport } from './flows/share.ts';
import { remoteUrl, repoRoot } from './git.ts';
import { ghAuthed } from './gh.ts';
import type { RunManager } from './manager.ts';
import type { PostPushWatcher } from './triggers.ts';
import { Semaphore, newId, now, sharedCache, which } from './util.ts';
import { VERSION, WEB_DIR as WEB } from './runtime.ts';
import { GLOBAL_HOOKS_DIR, currentGlobalHooksPath, repoOwnHooksPath } from './globalHooks.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

let toolCache: { at: number; tools: AppState['tools'] } | null = null;
async function tools(): Promise<AppState['tools']> {
  if (toolCache && Date.now() - toolCache.at < 60_000) return toolCache.tools;
  const [gh, gitleaks, zizmor, osv, claude] = await Promise.all(['gh', 'gitleaks', 'zizmor', 'osv-scanner', 'claude'].map(which));
  const t = { gh, ghAuthed: gh ? await ghAuthed() : false, gitleaks, zizmor, osv, claude };
  toolCache = { at: Date.now(), tools: t };
  return t;
}

// every open window refetches state at once: they share one git call, kept for 30s (a failed one isn't kept)
const globalHooksPath = sharedCache(
  () => currentGlobalHooksPath().then((hooksPath) => ({ active: hooksPath === GLOBAL_HOOKS_DIR, hooksPath })), 30_000);

/**
 * Which repos set their own core.hooksPath. That's a git call per repo, and a repo on a slow or unplugged volume can
 * take seconds, so it never holds up /api/state (the desktop app gives up on it after 1.5s): the last result is
 * served straight away and a stale one is refreshed in the background, a few repos at a time, one refresh at once.
 * onChange fires when the answer changes, so open windows pick it up.
 */
export function ownHooksTracker(onChange: () => void, opts: { ttlMs?: number; check?: (repoPath: string) => Promise<string | null> } = {}) {
  const ttlMs = opts.ttlMs ?? 30_000;
  const check = opts.check ?? repoOwnHooksPath;
  let known: Record<string, string> = {};
  let checked = new Set<string>();
  let at = 0;
  let refreshing: Promise<void> | null = null;
  let covering = new Set<string>();    // repo ids the running refresh checks
  let waiting: Repo[] | null = null;   // a repo list with ids the running refresh doesn't cover
  const gate = new Semaphore(4);
  const refresh = async (repos: Repo[]) => {
    const found = await Promise.all(repos.map(async (r) => {
      const release = await gate.acquire();
      // a repo that didn't answer in time keeps what was known about it
      try { return [r.id, await check(r.path)] as const; } catch { return [r.id, known[r.id] ?? null] as const; } finally { release(); }
    }));
    const next: Record<string, string> = {};
    for (const [id, p] of found) if (p) next[id] = p;
    const changed = JSON.stringify(next) !== JSON.stringify(known);
    known = next;
    checked = new Set(repos.map((r) => r.id));
    at = Date.now();
    if (changed) onChange();
  };
  const start = (repos: Repo[]) => {
    covering = new Set(repos.map((r) => r.id));
    refreshing = refresh(repos).catch(() => {}).finally(() => {
      refreshing = null;
      const next = waiting;
      waiting = null;
      if (next) start(next);
    });
  };
  return {
    get(repos: Repo[]): Record<string, string> {
      const unseen = repos.some((r) => !checked.has(r.id));
      if (refreshing) { if (repos.some((r) => !covering.has(r.id))) waiting = repos; }
      else if (unseen || Date.now() - at >= ttlMs) start(repos);
      return known;
    },
    /** Resolves once no refresh is running or waiting (for tests). */
    async settled() { while (refreshing) await refreshing; },
  };
}

async function body<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString();
  if (!s) return {} as T;
  try { return JSON.parse(s); } catch { throw new HttpError(400, 'Body is not valid JSON'); }
}

export async function addRepo(db: DB, path: string): Promise<Repo> {
  if (!path?.trim()) throw new HttpError(400, 'Give the path of a git repository');
  const abs = resolve(path.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
  if (!existsSync(abs)) throw new HttpError(400, `${abs} doesn't exist`);
  const top = await repoRoot(abs);
  const root = top ? realpathSync(top) : null;
  if (!root) throw new HttpError(400, `${abs} is not inside a git repository`);
  const existing = db.getRepoByPath(root);
  if (existing) {
    // remotes get added or changed after a repo is first seen (e.g. a new project pushed to GitHub later)
    const url = await remoteUrl(root);
    if (url !== existing.remoteUrl) { existing.remoteUrl = url; db.putRepo(existing); }
    return existing;
  }
  const repo: Repo = {
    id: newId('repo-'), path: root, name: basename(root), remoteUrl: await remoteUrl(root), addedAt: now(),
  };
  db.putRepo(repo);
  return repo;
}

export function startHttp(db: DB, mgr: RunManager, watcher: PostPushWatcher, port: number) {
  const clients = new Set<ServerResponse>();
  mgr.bus.on('event', (e: ServerEvent) => {
    const line = `data: ${JSON.stringify(e)}\n\n`;
    for (const c of clients) c.write(line);
  });
  const broadcastState = () => mgr.emit({ type: 'state' });
  const ownHooks = ownHooksTracker(broadcastState);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    const send = (status: number, data?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    try {
      // Only accept requests from this machine's browser/CLI: block cross-site requests from other origins.
      // Flows can run shell commands, so this matters: Origin stops cross-site requests, Host stops DNS rebinding.
      // Only the daemon's own page (or the Vite dev server on 5178) may call it: another local dev server must not.
      const origin = req.headers.origin;
      const myPort = (server.address() as { port: number } | null)?.port;
      const allowed = new Set([`http://127.0.0.1:${myPort}`, `http://localhost:${myPort}`, 'http://127.0.0.1:5178', 'http://localhost:5178']);
      if (origin && !allowed.has(origin)) throw new HttpError(403, 'Cross-origin requests are not allowed');
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) throw new HttpError(403, 'Unexpected Host header');

      if (!p.startsWith('/api/')) return serveStatic(p, res);
      const parts = p.split('/').filter(Boolean).slice(1); // after 'api'
      const [a, id, sub] = parts;
      const m = req.method ?? 'GET';

      if (a === 'events' && m === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }
      if (a === 'state' && m === 'GET') {
        const repos = db.listRepos();
        const state: AppState = {
          settings: db.getSettings(), usage: db.getUsage(), repos, flows: db.listFlows(),
          triggers: db.listTriggers(), tools: await tools(), version: VERSION,
          globalHooks: { ...(await globalHooksPath()), ownHooks: ownHooks.get(repos) },
        };
        return send(200, state);
      }
      if (a === 'usage' && m === 'GET') return send(200, db.getUsage());
      if (a === 'settings' && m === 'PUT') {
        const patch = await body<Partial<Settings>>(req);
        const next = { ...db.getSettings(), ...patch };
        if (!(next.maxConcurrentClaude >= 1)) throw new HttpError(400, 'Max concurrent Claude sessions must be at least 1');
        if (!(next.port > 0 && next.port < 65536)) throw new HttpError(400, 'Port must be 1-65535');
        db.setSettings(next);
        broadcastState();
        return send(200, next);
      }
      if (a === 'block-types' && m === 'GET') return send(200, BLOCK_TYPES);

      if (a === 'flows') {
        if (id === 'validate' && m === 'POST') {
          const b = await body<{ blocks: any[]; edges: any[] }>(req);
          return send(200, validateFlow(b.blocks ?? [], b.edges ?? []));
        }
        // sharing: export as text, preview a pasted flow, import it as a new flow
        if (id === 'import' && sub === 'preview' && m === 'POST') return send(200, previewImport((await body<{ text: string }>(req)).text));
        if (id === 'import' && !sub && m === 'POST') {
          const b = await body<{ text: string; name?: string }>(req);
          const f = importFlow(db, b.text, b.name);
          broadcastState();
          return send(201, f);
        }
        if (id && sub === 'export' && m === 'GET') {
          const f = db.getFlow(id);
          return f ? send(200, exportFlow(f)) : send(404, { error: 'Flow not found' });
        }
        if (id && sub === 'blocks' && parts[4] === 'options' && m === 'PATCH') {
          const f = setBlockOptions(db, id, decodeURIComponent(parts[3] ?? ''), await body(req));
          broadcastState();
          return send(200, f);
        }
        if (!id && m === 'GET') return send(200, db.listFlows());
        if (!id && m === 'POST') { const f = createFlow(db, await body(req)); broadcastState(); return send(201, f); }
        if (id && m === 'GET') { const f = db.getFlow(id); return f ? send(200, f) : send(404, { error: 'Flow not found' }); }
        if (id && m === 'PUT') { const f = updateFlow(db, id, await body(req)); broadcastState(); return send(200, f); }
        if (id && m === 'DELETE') { deleteFlow(db, id); broadcastState(); return send(204); }
      }

      if (a === 'triggers') {
        if (m === 'GET') return send(200, db.listTriggers());
        if (m === 'PUT') {
          const t = await body<{ trigger: TriggerKind; repoId: string | null; flowId: string | null }>(req);
          if (!TRIGGERS.includes(t.trigger)) throw new HttpError(400, `Unknown trigger ${t.trigger}`);
          if (t.repoId && !db.getRepo(t.repoId)) throw new HttpError(404, 'Repo not found');
          if (t.flowId === 'inherit') {
            if (!t.repoId) throw new HttpError(400, 'Only repo rows can inherit');
            db.deleteTrigger(t.trigger, t.repoId);
          } else {
            if (t.flowId && !db.getFlow(t.flowId)) throw new HttpError(404, 'Flow not found');
            db.setTrigger(t as TriggerAssignment);
          }
          broadcastState();
          return send(200, db.listTriggers());
        }
      }

      if (a === 'repos') {
        if (!id && m === 'GET') return send(200, db.listRepos());
        if (!id && m === 'POST') {
          const r = await addRepo(db, (await body<{ path: string }>(req)).path);
          broadcastState();
          return send(201, r);
        }
        const repo = id ? db.getRepo(id) : null;
        if (id && !repo) throw new HttpError(404, 'Repo not found');
        if (repo && !sub && m === 'DELETE') {
          db.deleteRepo(repo.id);
          broadcastState();
          return send(204);
        }
      }

      if (a === 'runs') {
        if (!id && m === 'GET') return send(200, db.listRuns(Number(url.searchParams.get('limit') ?? 50), url.searchParams.get('repoId') || undefined));
        if (!id && m === 'POST') {
          const b = await body<{ repoId: string; flowId?: string; base?: string; head?: string }>(req);
          const repo = db.getRepo(b.repoId);
          if (!repo) throw new HttpError(404, 'Repo not found');
          const runReq = { trigger: 'manual' as const, repoPath: repo.path, flowId: b.flowId || null, mode: 'range' as const, base: b.base || null, head: b.head || null };
          const run = mgr.createRun(runReq);
          if (!run) throw new HttpError(409, 'The manual trigger is disabled for this repo; pick a flow explicitly');
          mgr.start(runReq, run);
          return send(201, run);
        }
        if (id && !sub && m === 'GET') {
          const run = db.getRun(id);
          if (!run) return send(404, { error: 'Run not found' });
          return send(200, { run, blocks: db.listBlockRuns(id), findings: db.getRunFindings(id) });
        }
        if (id && sub === 'cancel' && m === 'POST') {
          const r = mgr.cancel(id);
          return r ? send(200, db.getRun(id)) : send(404, { error: 'Run not found' });
        }
      }

      if (a === 'ledger') {
        if (!id && m === 'GET') return send(200, db.listLedger(url.searchParams.get('repoId') || undefined, url.searchParams.get('state') || undefined));
        if (id && m === 'POST') {
          const { state, repoId } = await body<{ state: 'open' | 'dismissed' | 'tracked'; repoId?: string }>(req);
          if (!['open', 'dismissed', 'tracked'].includes(state)) throw new HttpError(400, 'state must be open, dismissed or tracked');
          const item = db.findLedgerByFingerprint(id, repoId || url.searchParams.get('repoId') || undefined);
          if (!item) throw new HttpError(404, 'Finding not in the ledger');
          const next = { ...item, state, updatedAt: now() };
          db.putLedger(next);
          return send(200, next);
        }
      }

      if (a === 'hooks') {
        if (id === 'notify' && m === 'POST') {
          const { runId } = await body<{ runId: string }>(req);
          const run = db.getRun(runId);
          if (run) {
            mgr.emit({ type: 'run', run: { ...run, flow: { ...run.flow, blocks: [], edges: [] } } });
            for (const b of db.listBlockRuns(runId)) mgr.emit({ type: 'block', runId, block: b });
          }
          return send(200, { ok: true });
        }
        if (id === 'push-intent' && m === 'POST') return send(200, await watcher.pushIntent(await body(req)));
      }
      throw new HttpError(404, `No route for ${m} ${p}`);
    } catch (e: any) {
      if (res.headersSent) { res.end(); return; }
      send(e instanceof HttpError ? e.status : 500, { error: String(e?.message ?? e) });
    }
  });

  function serveStatic(p: string, res: ServerResponse) {
    if (!existsSync(WEB)) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('purr daemon is running, but the UI is not built. Run `npm run build` in the purr repo.');
      return;
    }
    let file = normalize(join(WEB, decodeURIComponent(p)));
    if (!file.startsWith(WEB + sep) || !existsSync(file) || statSync(file).isDirectory()) file = join(WEB, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  }

  server.listen(port, '127.0.0.1');
  return server;
}
