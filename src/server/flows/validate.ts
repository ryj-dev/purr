import type { Block, Edge, PromptConfig, ValidationIssue, VerifyConfig } from '../../shared/types.ts';
import { blockTypeInfo } from './blockTypes.ts';

export interface Graph {
  byId: Map<string, Block>;
  inputs: Map<string, string[]>;
  outputs: Map<string, string[]>;
  order: string[];             // topological order (empty if cyclic)
}

export function graph(blocks: Block[], edges: Edge[]): Graph {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const inputs = new Map<string, string[]>(blocks.map((b) => [b.id, []]));
  const outputs = new Map<string, string[]>(blocks.map((b) => [b.id, []]));
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    if (!inputs.get(e.target)!.includes(e.source)) inputs.get(e.target)!.push(e.source);
    if (!outputs.get(e.source)!.includes(e.target)) outputs.get(e.source)!.push(e.target);
  }
  const indeg = new Map(blocks.map((b) => [b.id, inputs.get(b.id)!.length]));
  const queue = blocks.filter((b) => indeg.get(b.id) === 0).map((b) => b.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const t of outputs.get(id)!) {
      indeg.set(t, indeg.get(t)! - 1);
      if (indeg.get(t) === 0) queue.push(t);
    }
  }
  return { byId, inputs, outputs, order: order.length === blocks.length ? order : [] };
}

export function ancestors(g: Graph, id: string): Set<string> {
  const seen = new Set<string>();
  const stack = [...(g.inputs.get(id) ?? [])];
  while (stack.length) {
    const x = stack.pop()!;
    if (seen.has(x)) continue;
    seen.add(x);
    stack.push(...(g.inputs.get(x) ?? []));
  }
  return seen;
}

/** Which block's session a prompt/verify/branch block forks. Returns block id, or an error message. */
export function sessionSource(g: Graph, id: string): { source: string } | { error: string } {
  const b = g.byId.get(id)!;
  const forkFrom = b.type === 'prompt' || b.type === 'verify' ? (b.config as PromptConfig | VerifyConfig).forkFrom : null;
  if (forkFrom) {
    const src = g.byId.get(forkFrom);
    if (!src) return { error: `"Fork from" points at a block that no longer exists (${forkFrom})` };
    if (src.type !== 'context' && src.type !== 'prompt') return { error: `"Fork from" must be a context or prompt block, not ${src.type}` };
    if (!ancestors(g, id).has(forkFrom)) return { error: `"Fork from" block "${src.label}" must come before this block in the flow` };
    return { source: forkFrom };
  }
  const sources = new Set<string>();
  for (const inp of g.inputs.get(id) ?? []) {
    const ib = g.byId.get(inp)!;
    if (ib.type === 'context' || ib.type === 'prompt') sources.add(inp);
    else if (ib.type === 'branch') {
      const s = sessionSource(g, inp);
      if ('source' in s) sources.add(s.source);
    }
  }
  if (sources.size === 0) return { error: 'Needs a session: connect it after a context, prompt or branch block, or set "fork from"' };
  if (sources.size > 1) return { error: 'Inputs come from more than one session: set "fork from" to choose which one to fork' };
  return { source: [...sources][0] };
}

/** The context block whose model/tools a session inherits. */
export function rootContext(g: Graph, id: string, depth = 0): Block | null {
  if (depth > 100) return null;
  const b = g.byId.get(id);
  if (!b) return null;
  if (b.type === 'context') return b;
  const s = sessionSource(g, id);
  return 'source' in s ? rootContext(g, s.source, depth + 1) : null;
}

export function validateFlow(blocks: Block[], edges: Edge[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (blockId: string | null, message: string) => issues.push({ blockId, level: 'error', message });
  const warn = (blockId: string | null, message: string) => issues.push({ blockId, level: 'warning', message });

  if (!blocks.length) { err(null, 'The flow has no blocks'); return issues; }
  const ids = new Set<string>();
  for (const b of blocks) {
    if (ids.has(b.id)) err(b.id, `Duplicate block id ${b.id}`);
    ids.add(b.id);
  }
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) err(null, `Connection ${e.id} points at a missing block`);
    if (e.source === e.target) err(e.source, 'A block cannot connect to itself');
  }
  const g = graph(blocks, edges);
  if (!g.order.length) { err(null, 'The flow has a cycle; flows must run left to right'); return issues; }

  for (const b of blocks) {
    const info = blockTypeInfo(b.type);
    const ins = g.inputs.get(b.id)!, outs = g.outputs.get(b.id)!;
    if (info.maxInputs !== null && ins.length > info.maxInputs) {
      err(b.id, info.maxInputs === 0 ? `${info.label} blocks take no inputs` : `${info.label} takes at most ${info.maxInputs} input`);
    }
    switch (b.type) {
      case 'context': {
        const c = b.config as any;
        if (!c.model) err(b.id, 'Choose a model');
        if (!c.prompt?.trim()) err(b.id, 'The prompt is empty');
        if (!(c.maxTurns > 0)) err(b.id, 'Max turns must be at least 1');
        if (!outs.length) warn(b.id, 'Nothing uses this session');
        break;
      }
      case 'branch': {
        if (ins.length !== 1) err(b.id, 'A branch needs exactly one input session');
        else {
          const ib = g.byId.get(ins[0])!;
          if (!['context', 'prompt', 'branch'].includes(ib.type)) err(b.id, 'A branch must follow a context, prompt or branch block');
        }
        if (outs.length < 2) warn(b.id, `A branch with ${outs.length} output${outs.length === 1 ? '' : 's'} duplicates nothing`);
        for (const o of outs) {
          const ob = g.byId.get(o)!;
          if (!['prompt', 'verify', 'branch'].includes(ob.type)) err(b.id, `Branch outputs must be prompt, verify or branch blocks ("${ob.label}" is ${ob.type})`);
        }
        break;
      }
      case 'prompt': case 'verify': {
        const s = sessionSource(g, b.id);
        if ('error' in s) err(b.id, s.error);
        const c = b.config as PromptConfig | VerifyConfig;
        if (!c.prompt?.trim()) err(b.id, 'The prompt is empty');
        if (b.type === 'prompt' && (c as PromptConfig).output === 'findings' && !/\{\{finding_schema\}\}|"severity"/.test(c.prompt)) {
          warn(b.id, 'Findings output: the prompt should ask for the JSON schema ({{finding_schema}})');
        }
        if (b.type === 'verify' && !ins.length) err(b.id, 'Verify needs findings as input');
        if (b.type === 'verify' && !(c as VerifyConfig).appliesTo.length) warn(b.id, 'Verify applies to no severities, so it does nothing');
        const ctx = rootContext(g, b.id);
        if (ctx) {
          const tools: string[] = (ctx.config as any).tools ?? [];
          for (const t of c.allowedTools) {
            const base = t.replace(/\(.*$/, '');
            if (!tools.includes(base)) warn(b.id, `Allowed tool ${t} isn't in the inherited tool set of "${ctx.label}"`);
          }
        }
        break;
      }
      case 'gate':
        if (!ins.length) err(b.id, 'A gate needs findings as input');
        break;
      case 'merge':
        if (ins.length < 1) err(b.id, 'Merge needs at least one input');
        break;
      case 'command':
        if (!(b.config as any).command?.trim()) err(b.id, 'The command is empty');
        break;
      case 'output':
        if (!ins.length) warn(b.id, 'Nothing is connected to this output');
        break;
    }
  }
  if (!blocks.some((b) => b.type === 'output')) warn(null, 'No output block: the run will report every block\'s findings');
  if (blocks.filter((b) => b.type === 'output').length > 1) warn(null, 'More than one output block: their findings are combined');
  return issues;
}
