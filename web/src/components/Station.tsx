import { useMemo } from 'react';
import type { Block, BlockStatus, Edge, RunStatus } from '../../../src/shared/types.ts';
import { BLOCK_META } from '../util.ts';

type S = RunStatus | BlockStatus;

/** Status as a station marker: the shape carries the state (disc, barred disc, crossed disc, ring), the colour repeats it. */
export function StationMark({ status, size = 14 }: { status: S; size?: number }) {
  let body;
  switch (status) {
    case 'passed':
    case 'done':
      body = <><circle cx="8" cy="8" r="7" fill="var(--ok)" /><path d="M4.9 8.2 7 10.2 11.1 5.9" fill="none" stroke="var(--on-status)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></>;
      break;
    case 'blocked':
      body = <><circle cx="8" cy="8" r="7" fill="var(--warn)" /><rect x="3.8" y="6.9" width="8.4" height="2.2" rx=".4" fill="var(--on-status)" /></>;
      break;
    case 'failed':
      body = <><circle cx="8" cy="8" r="7" fill="var(--danger)" /><path d="M5.3 5.3 10.7 10.7M10.7 5.3 5.3 10.7" stroke="var(--on-status)" strokeWidth="1.9" strokeLinecap="round" /></>;
      break;
    case 'running':
      body = <><circle className="st-pulse" cx="8" cy="8" r="6" fill="none" stroke="var(--info)" strokeWidth="2" /><circle cx="8" cy="8" r="6" fill="var(--surface)" stroke="var(--info)" strokeWidth="2.4" /><circle cx="8" cy="8" r="2.4" fill="var(--info)" /></>;
      break;
    case 'cancelled':
    case 'superseded':
    case 'skipped':
      body = <><circle cx="8" cy="8" r="6" fill="var(--surface)" stroke="var(--text-4)" strokeWidth="2" /><path d="M4.2 11.8 11.8 4.2" stroke="var(--text-4)" strokeWidth="1.8" strokeLinecap="round" /></>;
      break;
    default: // queued, pending
      body = <circle cx="8" cy="8" r="6" fill="var(--surface)" stroke="var(--text-3)" strokeWidth="2" />;
  }
  return <svg className={`stmark ${status}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden>{body}</svg>;
}

/** Longest-path depth of every block, the same layering the editor's auto-layout uses. */
function depths(blocks: Block[], edges: Edge[]): Map<string, number> {
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
  return depth;
}

/** A flow drawn as a small route diagram: one column per stage, lines in the source block's colour. */
export function RouteMini({ blocks, edges, height = 64 }: { blocks: Block[]; edges: Edge[]; height?: number }) {
  const geo = useMemo(() => {
    const d = depths(blocks, edges);
    const cols = new Map<number, Block[]>();
    for (const b of blocks) {
      const k = d.get(b.id) ?? 0;
      if (!cols.has(k)) cols.set(k, []);
      cols.get(k)!.push(b);
    }
    const nCols = Math.max(1, ...Array.from(cols.keys()).map((k) => k + 1));
    const maxRows = Math.max(1, ...Array.from(cols.values()).map((c) => c.length));
    const dx = 34;
    const pad = 8;
    const dy = Math.min(14, (height - pad * 2) / Math.max(1, maxRows - 1));
    const pos = new Map<string, { x: number; y: number }>();
    for (const [k, col] of cols) {
      col.sort((a, b) => a.position.y - b.position.y);
      const top = height / 2 - ((col.length - 1) * dy) / 2;
      col.forEach((b, i) => pos.set(b.id, { x: pad + k * dx, y: top + i * dy }));
    }
    return { pos, width: pad * 2 + (nCols - 1) * dx };
  }, [blocks, edges, height]);

  if (!blocks.length) return <svg className="route-mini" width={60} height={height} aria-hidden />;
  return (
    <svg className="route-mini" width={geo.width} height={height} viewBox={`0 0 ${geo.width} ${height}`} aria-hidden>
      {edges.map((e) => {
        const a = geo.pos.get(e.source);
        const b = geo.pos.get(e.target);
        const src = blocks.find((x) => x.id === e.source);
        if (!a || !b || !src) return null;
        // run level, bend at 45°, run level again
        const dyAbs = Math.abs(b.y - a.y);
        const mid = (a.x + b.x) / 2;
        const path = dyAbs < 0.5
          ? `M${a.x} ${a.y}H${b.x}`
          : `M${a.x} ${a.y}H${Math.max(a.x, mid - dyAbs / 2)}L${Math.min(b.x, mid + dyAbs / 2)} ${b.y}H${b.x}`;
        return <path key={e.id} d={path} fill="none" stroke={BLOCK_META[src.type].color} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />;
      })}
      {blocks.map((b) => {
        const p = geo.pos.get(b.id);
        if (!p) return null;
        return <circle key={b.id} cx={p.x} cy={p.y} r={4} fill={BLOCK_META[b.type].color} stroke="var(--surface)" strokeWidth={1.8} />;
      })}
    </svg>
  );
}
