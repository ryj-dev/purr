import {
  BadgeCheck, Merge, MessageSquareText, ScanSearch, Send, ShieldCheck, Split, Sprout, SquareTerminal, type LucideIcon,
} from 'lucide-react';
import type { Block, BlockType, Edge, Severity } from '../../src/shared/types.ts';

export const BLOCK_META: Record<BlockType, { icon: LucideIcon; color: string; name: string; group: 'Sources' | 'Sessions' | 'Results' }> = {
  scanner: { icon: ScanSearch, color: 'var(--c-scanner)', name: 'Scanner', group: 'Sources' },
  command: { icon: SquareTerminal, color: 'var(--c-command)', name: 'Command', group: 'Sources' },
  context: { icon: Sprout, color: 'var(--c-context)', name: 'Context', group: 'Sessions' },
  branch: { icon: Split, color: 'var(--c-branch)', name: 'Branch', group: 'Sessions' },
  prompt: { icon: MessageSquareText, color: 'var(--c-prompt)', name: 'Prompt', group: 'Sessions' },
  merge: { icon: Merge, color: 'var(--c-merge)', name: 'Merge', group: 'Results' },
  verify: { icon: BadgeCheck, color: 'var(--c-verify)', name: 'Verify', group: 'Sessions' },
  gate: { icon: ShieldCheck, color: 'var(--c-gate)', name: 'Gate', group: 'Results' },
  output: { icon: Send, color: 'var(--c-output)', name: 'Output', group: 'Results' },
};

export const SEVERITIES: Severity[] = ['must_fix', 'consider', 'minor'];
export const SEVERITY_LABEL: Record<Severity, string> = { must_fix: 'Must fix', consider: 'Consider', minor: 'Minor' };

export function firstLine(s: string | undefined, max = 60): string {
  const l = (s ?? '').split('\n').map((x) => x.trim()).find((x) => x.length > 0) ?? '';
  return l.length > max ? l.slice(0, max - 1) + '…' : l;
}

export function blockSummary(b: Block, blocks: Block[], edges: Edge[]): string {
  const c = b.config as unknown as Record<string, unknown>;
  switch (b.type) {
    case 'scanner': return String(c.scanner ?? '');
    case 'command': return firstLine(String(c.command ?? ''), 40) || 'no command';
    case 'context': return `${c.model ?? '?'}${c.effort ? ` · ${c.effort}` : ''} · ${(c.tools as string[] | undefined)?.length ?? 0} tools`;
    case 'branch': return `× ${edges.filter((e) => e.source === b.id).length}`;
    case 'prompt': {
      const fork = c.forkFrom ? `fork ${blocks.find((x) => x.id === c.forkFrom)?.label ?? c.forkFrom}` : '';
      return [String(c.output ?? ''), fork].filter(Boolean).join(' · ') + (c.prompt ? ` — ${firstLine(String(c.prompt), 32)}` : '');
    }
    case 'merge': return `±${c.lineWindow ?? 3} lines`;
    case 'verify': return `${((c.appliesTo as string[] | undefined) ?? []).join(', ')}${c.failClosed ? ' · fail closed' : ''}`;
    case 'gate': return `block on ${SEVERITY_LABEL[c.blockOn as Severity] ?? c.blockOn}`;
    case 'output': return [c.notify ? 'notify' : '', c.postPrComment ? 'PR comment' : ''].filter(Boolean).join(' · ') || 'store only';
  }
}

/** Walk upstream (or follow forkFrom) to find the context block whose session a block inherits. */
export function resolveContext(blockId: string, blocks: Block[], edges: Edge[], seen = new Set<string>()): Block | null {
  if (seen.has(blockId)) return null;
  seen.add(blockId);
  const b = blocks.find((x) => x.id === blockId);
  if (!b) return null;
  if (b.type === 'context') return b;
  const fork = (b.config as unknown as { forkFrom?: string | null }).forkFrom;
  if ((b.type === 'prompt' || b.type === 'verify') && fork) return resolveContext(fork, blocks, edges, seen);
  for (const e of edges.filter((x) => x.target === blockId)) {
    const src = blocks.find((x) => x.id === e.source);
    if (!src) continue;
    if (src.type === 'context' || src.type === 'branch' || src.type === 'prompt' || src.type === 'verify') {
      const r = resolveContext(src.id, blocks, edges, seen);
      if (r) return r;
    }
  }
  return null;
}

/** Left-to-right layering by longest path from a source. */
export function autoLayout(blocks: Block[], edges: Edge[]): Block[] {
  const depth = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const b of blocks) incoming.set(b.id, []);
  for (const e of edges) incoming.get(e.target)?.push(e.source);
  const visit = (id: string, stack: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (stack.has(id)) return 0;
    stack.add(id);
    const d = Math.max(-1, ...(incoming.get(id) ?? []).map((s) => visit(s, stack))) + 1;
    stack.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const b of blocks) visit(b.id, new Set());
  const cols = new Map<number, Block[]>();
  for (const b of blocks) {
    const d = depth.get(b.id) ?? 0;
    if (!cols.has(d)) cols.set(d, []);
    cols.get(d)!.push(b);
  }
  const out: Block[] = [];
  for (const [d, col] of cols) {
    col.sort((a, b) => a.position.y - b.position.y);
    const h = 110;
    const top = -((col.length - 1) * h) / 2;
    col.forEach((b, i) => out.push({ ...b, position: { x: d * 280, y: top + i * h } }));
  }
  const order = new Map(blocks.map((b, i) => [b.id, i]));
  return out.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

export function rid(n = 6): string {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function durationBetween(a: string | null, b: string | null): number | null {
  if (!a) return null;
  const end = b ? Date.parse(b) : Date.now();
  return end - Date.parse(a);
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (d < 45) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export function shortSha(s: string | null | undefined): string {
  return s ? s.slice(0, 7) : '—';
}

export function fmtNum(n: number | undefined | null): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

export function navigate(hash: string) {
  window.location.hash = hash;
}
