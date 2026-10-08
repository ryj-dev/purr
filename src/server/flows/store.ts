import type { Block, Edge, Flow, TriggerKind } from '../../shared/types.ts';
import { PREFERENCE_OPTIONS, TRIGGERS } from '../../shared/types.ts';
import type { DB } from '../db.ts';
import { newId, now } from '../util.ts';
import { DEFAULT_FLOWS, DEFAULT_TRIGGERS } from './defaults.ts';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** A default flow with the user's preference overrides applied. */
function withOverrides(db: DB, f: Flow): Flow {
  const mine = db.getFlowOverrides()[f.id];
  if (!mine) return f;
  return { ...f, blocks: f.blocks.map((b) => (mine[b.id] ? { ...b, config: { ...b.config, ...mine[b.id] } as Block['config'] } : b)) };
}

/**
 * Default flows are owned by the code: rewritten on every start so they track prompt improvements. Preference options
 * the user changed on them (PREFERENCE_OPTIONS) are re-applied on top.
 */
export function ensureDefaults(db: DB) {
  for (const f of DEFAULT_FLOWS) db.putFlow(withOverrides(db, f));
  const globals = db.listTriggers().filter((t) => t.repoId === null);
  for (const t of TRIGGERS) {
    if (!globals.some((g) => g.trigger === t)) db.setTrigger({ trigger: t, repoId: null, flowId: DEFAULT_TRIGGERS[t] });
  }
}

export function createFlow(db: DB, body: { name?: string; description?: string; blocks?: Block[]; edges?: Edge[]; duplicateOf?: string }): Flow {
  const ts = now();
  if (body.duplicateOf) {
    const src = db.getFlow(body.duplicateOf);
    if (!src) throw new HttpError(404, 'Flow to duplicate not found');
    const f: Flow = {
      ...structuredClone(src), id: newId('flow-'), isDefault: false, createdAt: ts, updatedAt: ts,
      name: (body.name || `${src.name} (copy)`).replace(/^Default · /, ''),
    };
    db.putFlow(f);
    return f;
  }
  const f: Flow = {
    id: newId('flow-'), name: body.name || 'Untitled flow', description: body.description ?? '', isDefault: false,
    blocks: body.blocks ?? [], edges: body.edges ?? [], createdAt: ts, updatedAt: ts,
  };
  db.putFlow(f);
  return f;
}

export function updateFlow(db: DB, id: string, body: Partial<Pick<Flow, 'name' | 'description' | 'blocks' | 'edges'>>): Flow {
  const f = db.getFlow(id);
  if (!f) throw new HttpError(404, 'Flow not found');
  if (f.isDefault) throw new HttpError(403, 'Default flows are read-only. Duplicate it to make changes.');
  const next: Flow = {
    ...f,
    name: body.name ?? f.name, description: body.description ?? f.description,
    blocks: body.blocks ?? f.blocks, edges: body.edges ?? f.edges, updatedAt: now(),
  };
  db.putFlow(next);
  return next;
}

export function deleteFlow(db: DB, id: string) {
  const f = db.getFlow(id);
  if (!f) throw new HttpError(404, 'Flow not found');
  if (f.isDefault) throw new HttpError(403, "Default flows can't be deleted");
  const affected = db.listTriggers().filter((t) => t.flowId === id);
  db.deleteFlow(id);
  // a global trigger that used it falls back to the default for that trigger; repo overrides fall back to global
  for (const t of affected) if (t.repoId === null) db.setTrigger({ trigger: t.trigger, repoId: null, flowId: DEFAULT_TRIGGERS[t.trigger as TriggerKind] });
}

/**
 * Sets preference options (PREFERENCE_OPTIONS) on one block. Allowed on any flow; on a default flow they're kept as
 * overrides so they survive the defaults being rewritten. Unknown keys are rejected.
 */
export function setBlockOptions(db: DB, flowId: string, blockId: string, patch: Record<string, unknown>): Flow {
  const f = db.getFlow(flowId);
  if (!f) throw new HttpError(404, 'Flow not found');
  const block = f.blocks.find((b) => b.id === blockId);
  if (!block) throw new HttpError(404, 'Block not found');
  const allowed = PREFERENCE_OPTIONS[block.type] ?? [];
  const keys = Object.keys(patch ?? {});
  if (!keys.length) throw new HttpError(400, 'Nothing to change');
  const bad = keys.filter((k) => !allowed.includes(k));
  if (bad.length) {
    throw new HttpError(400, `${bad.join(', ')} can't be changed here${allowed.length ? `; allowed for ${block.type} blocks: ${allowed.join(', ')}` : ''}`);
  }
  for (const k of keys) {
    if (typeof patch[k] !== typeof (block.config as unknown as Record<string, unknown>)[k]) throw new HttpError(400, `${k} must be a ${typeof (block.config as unknown as Record<string, unknown>)[k]}`);
  }
  if (f.isDefault) {
    const all = db.getFlowOverrides();
    all[flowId] = { ...(all[flowId] ?? {}), [blockId]: { ...(all[flowId]?.[blockId] ?? {}), ...patch } };
    db.setFlowOverrides(all);
  }
  const next: Flow = {
    ...f, updatedAt: f.isDefault ? f.updatedAt : now(),
    blocks: f.blocks.map((b) => (b.id === blockId ? { ...b, config: { ...b.config, ...patch } as Block['config'] } : b)),
  };
  db.putFlow(next);
  return next;
}
