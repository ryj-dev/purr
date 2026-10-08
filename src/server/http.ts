import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import type { AppState, Repo, ServerEvent, Settings, ToolName, TriggerAssignment, TriggerKind } from '../shared/types.ts';
import { TRIGGERS } from '../shared/types.ts';
import type { DB } from './db.ts';
import { BLOCK_TYPES } from './flows/blockTypes.ts';
import { HttpError, createFlow, deleteFlow, setBlockOptions, updateFlow } from './flows/store.ts';
import { validateFlow } from './flows/validate.ts';
import { exportFlow, importFlow, previewImport } from './flows/share.ts';
import { uniqueFolders } from './db.ts';
import { remoteUrl, repoRoot } from './git.ts';
import { TOOL_NAMES, installMissing, installTool, onToolchainChange, openHomebrewInstall, openSignIn, refreshToolchain, toolchainStatus, toolsSummary } from './toolchain.ts';
import type { RunManager } from './manager.ts';
import type { PostPushWatcher } from './triggers.ts';
import { newId, now } from './util.ts';
import { VERSION, WEB_DIR as WEB } from './runtime.ts';
import { GLOBAL_HOOKS_DIR, currentGlobalHooksPath } from './globalHooks.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

let hooksCache: { at: number; v: AppState['globalHooks'] } | null = null;
async function globalHooksState(): Promise<AppState['globalHooks']> {
  if (hooksCache && Date.now() - hooksCache.at < 30_000) return hooksCache.v;
  const hooksPath = await currentGlobalHooksPath();
  const v = { active: hooksPath === GLOBAL_HOOKS_DIR, hooksPath };
  hooksCache = { at: Date.now(), v };
  return v;
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
  onToolchainChange((settled) => {
    mgr.emit({ type: 'tools' });
    if (settled) broadcastState();   // the sidebar's summary
  });

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
        const state: AppState = {
          settings: db.getSettings(), usage: db.getUsage(), repos: db.listRepos(), flows: db.listFlows(),
          triggers: db.listTriggers(), tools: await toolsSummary(), version: VERSION,
          globalHooks: await globalHooksState(),
        };
        return send(200, state);
      }
      if (a === 'tools') {
        if (!id && m === 'GET') {
          if (url.searchParams.has('fresh')) refreshToolchain();
          return send(200, await toolchainStatus());
        }
        if (id === 'install-missing' && m === 'POST') return send(202, { installing: await installMissing() });
        if (id === 'homebrew' && sub === 'install' && m === 'POST') {
          try { await openHomebrewInstall(); } catch (e: any) { throw new HttpError(400, String(e?.message ?? e)); }
          return send(200, { ok: true });
        }
        if (id && !TOOL_NAMES.includes(id as ToolName)) throw new HttpError(404, `Unknown tool ${id}`);
        if (id && sub === 'install' && m === 'POST') { installTool(id as ToolName); return send(202, { ok: true }); }
        if (id && sub === 'signin' && m === 'POST') {
          try { await openSignIn(id as ToolName); } catch (e: any) { throw new HttpError(400, String(e?.message ?? e)); }
          return send(200, { ok: true });
        }
      }
      if (a === 'usage' && m === 'GET') return send(200, db.getUsage());
      if (a === 'settings' && m === 'PUT') {
        const patch = await body<Partial<Settings>>(req);
        const next = { ...db.getSettings(), ...patch };
        if (Array.isArray(patch.projectFolders)) {
          const home = process.env.HOME ?? '';
          next.projectFolders = uniqueFolders(patch.projectFolders.map((f) => String(f).trim()).filter(Boolean)   // resolve('') would be the service's cwd
            .map((f) => resolve(f.replace(/^~(?=\/|$)/, home))));
        }
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
