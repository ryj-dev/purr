// Sharing flows as text: export -> copy -> paste -> import.
//
// The share text is `purr-flow:v1:` + base64url(deflate-raw(JSON)), compact enough for a chat message or a gist.
// Import also accepts the plain JSON. Either way an imported flow is untrusted: it's rebuilt block by block from the
// known block types and fields (anything else is dropped), its risky capabilities (shell commands, tool permissions)
// are listed for the user to read before importing, and it's saved as a new editable flow that no trigger runs until
// the user assigns one.

import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type {
  Block, BlockConfigMap, BlockType, ContextConfig, Edge, Flow, FlowExport, ImportPreview, PromptConfig, ShareRisk, VerifyConfig,
} from '../../shared/types.ts';
import type { DB } from '../db.ts';
import { BLOCK_TYPES, blockTypeInfo } from './blockTypes.ts';
import { HttpError, createFlow } from './store.ts';
import { validateFlow } from './validate.ts';

export const SHARE_PREFIX = 'purr-flow:v1:';
const FORMAT = 'purr-flow';
const MAX_TEXT = 512 * 1024;
const MAX_BLOCKS = 200;
const MAX_EDGES = 800;
const MAX_STRING = 100_000;

/** What travels: the flow's own content, without ids, timestamps or default status. */
interface SharedFlowV1 {
  format: typeof FORMAT;
  version: 1;
  name: string;
  description: string;
  blocks: Array<Pick<Block, 'id' | 'type' | 'label' | 'position' | 'config'>>;
  edges: Array<{ source: string; target: string }>;
}

export function exportFlow(flow: Flow): FlowExport {
  const shared: SharedFlowV1 = {
    format: FORMAT, version: 1,
    name: flow.name.replace(/^Default · /, ''), description: flow.description,
    blocks: flow.blocks.map((b) => ({ id: b.id, type: b.type, label: b.label, position: b.position, config: b.config })),
    edges: flow.edges.map((e) => ({ source: e.source, target: e.target })),
  };
  const json = JSON.stringify(shared, null, 2);
  const text = SHARE_PREFIX + deflateRawSync(Buffer.from(JSON.stringify(shared)), { level: 9 }).toString('base64url');
  return { text, json, bytes: text.length };
}

/** Share text or plain JSON -> the parsed object. Throws a 400 with a readable reason. */
function decode(input: string): unknown {
  const text = (input ?? '').trim();
  if (!text) throw new HttpError(400, 'Paste a shared flow first');
  if (text.length > MAX_TEXT) throw new HttpError(400, `That's too long for a flow (${Math.round(text.length / 1024)} KB; the limit is ${MAX_TEXT / 1024} KB)`);
  if (text.startsWith('purr-flow:')) {
    if (!text.startsWith(SHARE_PREFIX)) throw new HttpError(400, `This flow was shared from a newer PuRR (${text.split(':').slice(0, 2).join(':')}); update PuRR to import it`);
    const body = text.slice(SHARE_PREFIX.length).replace(/\s+/g, '');
    let raw: Buffer;
    try { raw = inflateRawSync(Buffer.from(body, 'base64url'), { maxOutputLength: 4 * 1024 * 1024 }); }
    catch { throw new HttpError(400, "The shared text is damaged or incomplete; copy it again, all of it"); }
    try { return JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'The shared text decoded to something that isn\'t a flow'); }
  }
  if (text.startsWith('{')) {
    try { return JSON.parse(text); } catch (e) { throw new HttpError(400, `That JSON doesn't parse: ${(e as Error).message}`); }
  }
  throw new HttpError(400, `Not a PuRR flow: paste text that starts with "${SHARE_PREFIX}" or a flow's JSON`);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = MAX_STRING) => (typeof v === 'string' ? v.slice(0, max) : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const ENUMS: Record<string, readonly (string | null)[]> = {
  scanner: ['gitleaks', 'zizmor', 'osv'],
  effort: [null, 'low', 'medium', 'high', 'xhigh', 'max'],
  output: ['findings', 'text'],
  blockOn: ['must_fix', 'consider', 'minor'],
};
const INT_RANGES: Record<string, [number, number]> = {
  timeoutSec: [1, 3600], maxTurns: [1, 500], budgetChars: [0, 2_000_000], lineWindow: [0, 1000], concurrency: [1, 32],
};

/** Rebuilds one config from the type's defaults, taking only known fields of the right kind from the shared one. */
function cleanConfig(type: BlockType, raw: unknown, where: string, notes: string[]): BlockConfigMap[BlockType] {
  const defaults = blockTypeInfo(type).defaultConfig as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = structuredClone(defaults);
  if (!isObj(raw)) { if (raw !== undefined) notes.push(`${where}: settings weren't readable, used the defaults`); return out as never; }
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in defaults)) { notes.push(`${where}: dropped unknown setting "${k}"`); continue; }
    const d = defaults[k];
    let ok: unknown = undefined;
    if (k in ENUMS) ok = ENUMS[k].includes(v as string) ? v : undefined;
    else if (k === 'forkFrom') ok = v === null || typeof v === 'string' ? v : undefined;
    else if (k === 'appliesTo') ok = Array.isArray(v) && v.every((x) => ENUMS.blockOn.includes(x)) ? [...new Set(v)] : undefined;
    else if (Array.isArray(d)) ok = Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length < 500) ? v.slice(0, 100) : undefined;
    else if (typeof d === 'number') {
      const n = num(v);
      const [lo, hi] = INT_RANGES[k] ?? [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
      ok = n === null ? undefined : Math.min(hi, Math.max(lo, Math.round(n)));
    } else if (typeof d === 'boolean') ok = typeof v === 'boolean' ? v : undefined;
    else if (typeof d === 'string') ok = str(v) ?? undefined;
    if (ok === undefined) notes.push(`${where}: "${k}" had an invalid value, used the default`);
    else out[k] = ok;
  }
  return out as never;
}

/** Shared object -> blocks and edges PuRR can trust structurally, plus notes on everything that was repaired. */
function rebuild(data: unknown): { name: string; description: string; blocks: Block[]; edges: Edge[]; notes: string[] } {
  if (!isObj(data)) throw new HttpError(400, 'Not a PuRR flow');
  if (data.format !== FORMAT) throw new HttpError(400, `Not a PuRR flow (expected "format": "${FORMAT}")`);
  if (data.version !== 1) throw new HttpError(400, `This flow uses format version ${String(data.version)}; update PuRR to import it`);
  const notes: string[] = [];
  const rawBlocks = Array.isArray(data.blocks) ? data.blocks : [];
  const rawEdges = Array.isArray(data.edges) ? data.edges : [];
  if (!rawBlocks.length) throw new HttpError(400, 'The flow has no blocks');
  if (rawBlocks.length > MAX_BLOCKS) throw new HttpError(400, `The flow has ${rawBlocks.length} blocks; the limit is ${MAX_BLOCKS}`);
  if (rawEdges.length > MAX_EDGES) throw new HttpError(400, `The flow has ${rawEdges.length} connections; the limit is ${MAX_EDGES}`);

  const types = new Set(BLOCK_TYPES.map((t) => t.type));
  const blocks: Block[] = [];
  const ids = new Set<string>();
  rawBlocks.forEach((rb: unknown, i: number) => {
    if (!isObj(rb)) { notes.push(`Block ${i + 1}: unreadable, skipped`); return; }
    const type = rb.type as BlockType;
    if (!types.has(type)) { notes.push(`Block ${i + 1}: unknown type "${String(rb.type)}", skipped`); return; }
    let id = typeof rb.id === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(rb.id) ? rb.id : `${type}-${i + 1}`;
    if (ids.has(id)) { notes.push(`Block "${id}": duplicate id, renamed`); id = `${id}-${i + 1}`; }
    ids.add(id);
    const label = (str(rb.label, 120) ?? '').trim() || blockTypeInfo(type).label;
    const pos = isObj(rb.position) ? rb.position : {};
    const position = { x: num(pos.x) ?? i * 300, y: num(pos.y) ?? 0 };
    blocks.push({ id, type, label, position, config: cleanConfig(type, rb.config, `"${label}"`, notes) });
  });
  if (!blocks.length) throw new HttpError(400, 'None of the blocks could be read');

  // forkFrom must name a block that exists in this flow
  for (const b of blocks) {
    const c = b.config as PromptConfig | VerifyConfig;
    if ((b.type === 'prompt' || b.type === 'verify') && c.forkFrom && !ids.has(c.forkFrom)) {
      notes.push(`"${b.label}": "fork from" pointed at a missing block, reset to the nearest upstream session`);
      c.forkFrom = null;
    }
  }
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const re of rawEdges) {
    if (!isObj(re) || typeof re.source !== 'string' || typeof re.target !== 'string') { notes.push('A connection was unreadable, skipped'); continue; }
    if (!ids.has(re.source) || !ids.has(re.target) || re.source === re.target) { notes.push(`Connection ${re.source} → ${re.target} doesn't join two blocks, skipped`); continue; }
    const key = `${re.source}\u0000${re.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ id: `e-${re.source}-${re.target}`, source: re.source, target: re.target });
  }
  const name = (str(data.name, 120) ?? '').trim() || 'Imported flow';
  const description = (str(data.description, 2000) ?? '').trim();
  return { name, description, blocks, edges, notes };
}

const BROAD_BASH = /^Bash(\((\*|\*:\*|:\*)?\))?$/;   // Bash, Bash(), Bash(*), Bash(*:*)

/** What a flow can do that its importer must agree to: shell commands, write/network tools, PR comments. */
export function flowRisks(blocks: Block[]): ShareRisk[] {
  const risks: ShareRisk[] = [];
  for (const b of blocks) {
    const base = { blockId: b.id, label: b.label };
    if (b.type === 'command') {
      risks.push({ ...base, level: 'danger', message: 'Runs this shell command in your repository on every run', detail: (b.config as BlockConfigMap['command']).command });
    }
    if (b.type === 'context') {
      const tools = (b.config as ContextConfig).tools;
      const strong = tools.filter((t) => ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Task'].includes(t));
      if (strong.length) risks.push({ ...base, level: 'warn', message: `Gives its Claude sessions these tools: ${strong.join(', ')}`, detail: 'Each block\'s "allowed tools" decides which of them run without asking' });
    }
    if (b.type === 'context' || b.type === 'prompt' || b.type === 'verify') {
      const allowed = (b.config as ContextConfig | PromptConfig | VerifyConfig).allowedTools;
      const broad = allowed.filter((t) => BROAD_BASH.test(t));
      const shell = allowed.filter((t) => /^Bash\(/.test(t) && !BROAD_BASH.test(t) && !/^Bash\((git (log|diff|show|blame|grep)|rg|ls|wc)[ :]/.test(t));
      const write = allowed.filter((t) => /^(Edit|Write|NotebookEdit)\b/.test(t));
      const net = allowed.filter((t) => /^(WebFetch|WebSearch)\b/.test(t));
      if (broad.length) risks.push({ ...base, level: 'danger', message: 'Lets Claude run any shell command without asking', detail: broad.join(', ') });
      if (shell.length) risks.push({ ...base, level: 'warn', message: 'Lets Claude run these shell commands without asking', detail: shell.join(', ') });
      if (write.length) risks.push({ ...base, level: 'warn', message: 'Lets Claude change files in the review checkout', detail: write.join(', ') });
      if (net.length) risks.push({ ...base, level: 'warn', message: 'Lets Claude reach the internet', detail: net.join(', ') });
    }
    if (b.type === 'output' && (b.config as BlockConfigMap['output']).postPrComment) {
      risks.push({ ...base, level: 'info', message: 'Posts a summary comment on your PRs (with your gh login)' });
    }
  }
  const order = { danger: 0, warn: 1, info: 2 };
  return risks.sort((a, b) => order[a.level] - order[b.level]);
}

export function previewImport(text: string): ImportPreview {
  const { name, description, blocks, edges, notes } = rebuild(decode(text));
  return { name, description, blocks, edges, notes, risks: flowRisks(blocks), issues: validateFlow(blocks, edges) };
}

/** Saves a shared flow as a new, editable flow. It isn't assigned to any trigger. */
export function importFlow(db: DB, text: string, name?: string): Flow {
  const p = previewImport(text);
  let wanted = (name ?? p.name).trim() || p.name;
  const taken = new Set(db.listFlows().map((f) => f.name));
  if (taken.has(wanted)) {
    let n = 1;
    while (taken.has(`${wanted} (imported${n > 1 ? ` ${n}` : ''})`)) n++;
    wanted = `${wanted} (imported${n > 1 ? ` ${n}` : ''})`;
  }
  return createFlow(db, { name: wanted, description: p.description, blocks: p.blocks, edges: p.edges });
}
