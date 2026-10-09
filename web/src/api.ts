import { useEffect, useRef } from 'react';
import type {
  AppState, Block, BlockType, Edge, Flow, FlowMeta, LedgerItem, Repo, Run, RunDetail, ServerEvent, Settings, TriggerAssignment, TriggerKind, Usage, ValidationIssue, FlowExport, ImportPreview, ToolName, Toolchain,
} from '../../src/shared/types.ts';

export interface BlockTypeInfo {
  type: BlockType;
  label: string;
  description: string;
  defaultConfig: Record<string, unknown>;
  maxInputs: number | null;
  startsSession: boolean;
  needsSession: boolean;
  models?: string[];
  tools?: string[];
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Daemon not reachable');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = undefined;
  try { data = text ? JSON.parse(text) : undefined; } catch { /* non-JSON */ }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && 'error' in data) ? String((data as { error: unknown }).error) : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const api = {
  state: () => req<AppState>('GET', '/api/state'),
  usage: () => req<Usage>('GET', '/api/usage'),
  saveSettings: (s: Partial<Settings>) => req<Settings>('PUT', '/api/settings', s),
  blockTypes: () => req<BlockTypeInfo[]>('GET', '/api/block-types'),

  toolchain: (fresh = false) => req<Toolchain>('GET', `/api/tools${fresh ? '?fresh=1' : ''}`),
  installTool: (name: ToolName) => req<{ ok: true }>('POST', `/api/tools/${name}/install`),
  installMissingTools: () => req<{ installing: ToolName[] }>('POST', '/api/tools/install-missing'),
  installHomebrew: () => req<{ ok: true }>('POST', '/api/tools/homebrew/install'),
  signIn: (name: 'claude' | 'gh') => req<{ ok: true }>('POST', `/api/tools/${name}/signin`),

  flows: () => req<FlowMeta[]>('GET', '/api/flows'),
  flow: (id: string) => req<Flow>('GET', `/api/flows/${encodeURIComponent(id)}`),
  createFlow: (b: { name: string; description?: string; blocks?: Block[]; edges?: Edge[] }) => req<Flow>('POST', '/api/flows', b),
  duplicateFlow: (id: string, name?: string) => req<Flow>('POST', '/api/flows', { duplicateOf: id, name }),
  exportFlow: (id: string) => req<FlowExport>('GET', `/api/flows/${encodeURIComponent(id)}/export`),
  previewImport: (text: string) => req<ImportPreview>('POST', '/api/flows/import/preview', { text }),
  importFlow: (text: string, name?: string) => req<Flow>('POST', '/api/flows/import', { text, name }),
  saveFlow: (id: string, b: Partial<Pick<Flow, 'name' | 'description' | 'blocks' | 'edges'>>) =>
    req<Flow>('PUT', `/api/flows/${encodeURIComponent(id)}`, b),
  deleteFlow: (id: string) => req<void>('DELETE', `/api/flows/${encodeURIComponent(id)}`),
  /** Preference options (PREFERENCE_OPTIONS) save straight away, on default flows too. */
  setBlockOptions: (flowId: string, blockId: string, patch: Record<string, unknown>) =>
    req<Flow>('PATCH', `/api/flows/${encodeURIComponent(flowId)}/blocks/${encodeURIComponent(blockId)}/options`, patch),
  validate: (blocks: Block[], edges: Edge[]) => req<ValidationIssue[]>('POST', '/api/flows/validate', { blocks, edges }),

  triggers: () => req<TriggerAssignment[]>('GET', '/api/triggers'),
  setTrigger: (t: { trigger: TriggerKind; repoId: string | null; flowId: string | null | 'inherit' }) =>
    req<TriggerAssignment[]>('PUT', '/api/triggers', t),

  repos: () => req<Repo[]>('GET', '/api/repos'),
  addRepo: (path: string) => req<Repo>('POST', '/api/repos', { path }),
  removeRepo: (id: string) => req<void>('DELETE', `/api/repos/${encodeURIComponent(id)}`),

  runs: (limit = 50, repoId?: string) =>
    req<Run[]>('GET', `/api/runs?limit=${limit}${repoId ? `&repoId=${encodeURIComponent(repoId)}` : ''}`),
  run: (id: string) => req<RunDetail>('GET', `/api/runs/${encodeURIComponent(id)}`),
  startRun: (b: { repoId: string; flowId?: string; base?: string; head?: string }) => req<Run>('POST', '/api/runs', b),
  cancelRun: (id: string) => req<Run>('POST', `/api/runs/${encodeURIComponent(id)}/cancel`),

  ledger: (repoId?: string, state?: string) => {
    const q = new URLSearchParams();
    if (repoId) q.set('repoId', repoId);
    if (state) q.set('state', state);
    return req<LedgerItem[]>('GET', `/api/ledger?${q.toString()}`);
  },
  setLedger: (fingerprint: string, state: 'open' | 'dismissed' | 'tracked', repoId?: string | null) =>
    req<LedgerItem>('POST', `/api/ledger/${encodeURIComponent(fingerprint)}`, { state, repoId: repoId ?? undefined }),
};

/** Subscribe to the daemon's SSE stream. The handler can change between renders without reconnecting. */
export function useEvents(handler: (e: ServerEvent) => void, onStatus?: (connected: boolean) => void) {
  const h = useRef(handler);
  const s = useRef(onStatus);
  h.current = handler;
  s.current = onStatus;
  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (closed) return;
      es = new EventSource('/api/events');
      es.onopen = () => s.current?.(true);
      es.onmessage = (m) => {
        try { h.current(JSON.parse(m.data) as ServerEvent); } catch { /* ignore malformed */ }
      };
      es.onerror = () => {
        s.current?.(false);
        es?.close();
        retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      es?.close();
    };
  }, []);
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
