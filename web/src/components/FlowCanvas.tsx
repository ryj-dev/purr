import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, useNodesInitialized, useReactFlow, useStore, BackgroundVariant, Controls, MiniMap, MarkerType,
  type Connection, type EdgeChange, type NodeChange, type Edge as RFEdge,
} from '@xyflow/react';
import type { Block, BlockStatus, Edge } from '../../../src/shared/types.ts';
import { nodeTypes, type BlockNodeType } from './BlockNode.tsx';
import { BLOCK_META, rid } from '../util.ts';
import { useApp } from '../state.tsx';

export interface FlowCanvasProps {
  blocks: Block[];
  edges: Edge[];
  readOnly: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange?: (blocks: Block[], edges: Edge[]) => void;
  statuses?: Record<string, BlockStatus>;
  statusNotes?: Record<string, string>;
  issues?: Record<string, 'error' | 'warning'>;
  onConnectRejected?: (msg: string) => void;
  minimap?: boolean;
}

const FIT = { padding: 0.12, maxZoom: 1.1 };

/** Re-fit once every node has been measured: the `fitView` prop alone can run against unmeasured nodes. */
function FitWhenMeasured({ followResize }: { followResize: boolean }) {
  const rf = useReactFlow();
  const ready = useNodesInitialized();
  const width = useStore((s) => s.width);
  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;
    requestAnimationFrame(() => rf.fitView(FIT));
  }, [ready, rf]);
  // a run map is for watching, not arranging: keep it fitted when the window resizes
  useEffect(() => {
    if (!followResize || !done.current) return;
    const t = setTimeout(() => rf.fitView(FIT), 120);
    return () => clearTimeout(t);
  }, [followResize, width, rf]);
  return null;
}

export function FlowCanvas(p: FlowCanvasProps) {
  const { blockTypes } = useApp();
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const maxInputs = useMemo(() => {
    const m: Record<string, number | null> = {};
    for (const t of blockTypes) m[t.type] = t.maxInputs;
    return m;
  }, [blockTypes]);

  const nodes: BlockNodeType[] = useMemo(() => p.blocks.map((b) => ({
    id: b.id,
    type: 'block' as const,
    position: b.position,
    selected: b.id === p.selectedId,
    draggable: !p.readOnly,
    deletable: !p.readOnly,
    connectable: !p.readOnly,
    measured: measured[b.id],
    data: {
      block: b, blocks: p.blocks, edges: p.edges,
      status: p.statuses?.[b.id], statusNote: p.statusNotes?.[b.id], issue: p.issues?.[b.id],
      hasInput: maxInputs[b.type] !== 0,
      hasOutput: b.type !== 'output',
    },
  })), [p.blocks, p.edges, p.selectedId, p.readOnly, p.statuses, p.statusNotes, p.issues, measured, maxInputs]);

  // Edges are curves in the source block's colour. On a run, track a finished block has handed on is solid,
  // track still ahead is faded, and the edge into a running block moves.
  const rfEdges: RFEdge[] = useMemo(() => p.edges.map((e) => {
    const src = p.blocks.find((b) => b.id === e.source);
    const srcSt = p.statuses?.[e.source];
    const tgtSt = p.statuses?.[e.target];
    const state = !p.statuses ? '' : tgtSt === 'running' ? 'live' : srcSt === 'failed' ? 'broken' : srcSt === 'done' ? 'run' : 'ahead';
    return {
      id: e.id, source: e.source, target: e.target,
      selected: e.id === selectedEdge,
      deletable: !p.readOnly,
      animated: state === 'live',
      className: state ? `track ${state}` : 'track',
      markerEnd: src ? { type: MarkerType.ArrowClosed, width: 12, height: 12, color: BLOCK_META[src.type].color } : undefined,
      style: src ? { stroke: BLOCK_META[src.type].color } : undefined,
    };
  }), [p.edges, p.blocks, p.statuses, p.readOnly, selectedEdge]);

  const onNodesChange = useCallback((changes: NodeChange<BlockNodeType>[]) => {
    let blocks = p.blocks;
    let edges = p.edges;
    let changed = false;
    const dims: Record<string, { width: number; height: number }> = {};
    for (const c of changes) {
      if (c.type === 'dimensions' && c.dimensions) dims[c.id] = c.dimensions;
      else if (c.type === 'select') {
        if (c.selected) { p.onSelect(c.id); setSelectedEdge(null); }
      } else if (p.readOnly) continue;
      else if (c.type === 'position' && c.position) {
        const pos = c.position;
        blocks = blocks.map((b) => (b.id === c.id ? { ...b, position: { x: Math.round(pos.x), y: Math.round(pos.y) } } : b));
        changed = true;
      } else if (c.type === 'remove') {
        blocks = blocks.filter((b) => b.id !== c.id);
        edges = edges.filter((e) => e.source !== c.id && e.target !== c.id);
        // forkFrom references to a removed block fall back to "nearest upstream"
        blocks = blocks.map((b) => {
          const cfg = b.config as unknown as { forkFrom?: string | null };
          return cfg.forkFrom === c.id ? { ...b, config: { ...b.config, forkFrom: null } as Block['config'] } : b;
        });
        if (p.selectedId === c.id) p.onSelect(null);
        changed = true;
      }
    }
    if (Object.keys(dims).length) setMeasured((m) => ({ ...m, ...dims }));
    if (changed) p.onChange?.(blocks, edges);
  }, [p]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    let edges = p.edges;
    let changed = false;
    for (const c of changes) {
      if (c.type === 'select') { if (c.selected) setSelectedEdge(c.id); else if (selectedEdge === c.id) setSelectedEdge(null); }
      else if (c.type === 'remove' && !p.readOnly) { edges = edges.filter((e) => e.id !== c.id); changed = true; }
    }
    if (changed) p.onChange?.(p.blocks, edges);
  }, [p, selectedEdge]);

  const onConnect = useCallback((c: Connection) => {
    if (p.readOnly || !c.source || !c.target) return;
    if (c.source === c.target) return;
    if (p.edges.some((e) => e.source === c.source && e.target === c.target)) return;
    const tgt = p.blocks.find((b) => b.id === c.target);
    if (tgt) {
      const max = maxInputs[tgt.type];
      const n = p.edges.filter((e) => e.target === tgt.id).length;
      if (max != null && n >= max) {
        p.onConnectRejected?.(`${BLOCK_META[tgt.type].name} blocks take at most ${max} input${max === 1 ? '' : 's'}`);
        return;
      }
    }
    p.onChange?.(p.blocks, [...p.edges, { id: `e-${rid()}`, source: c.source, target: c.target }]);
  }, [p, maxInputs]);

  return (
    <ReactFlow<BlockNodeType, RFEdge>
      nodes={nodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onPaneClick={() => { p.onSelect(null); setSelectedEdge(null); }}
      nodesDraggable={!p.readOnly}
      nodesConnectable={!p.readOnly}
      elementsSelectable
      deleteKeyCode={p.readOnly ? null : ['Backspace', 'Delete']}
      fitView
      fitViewOptions={FIT}
      minZoom={0.05}
      // on a run page the map sits inside a scrolling page: let the wheel scroll the page, pinch or buttons zoom
      zoomOnScroll={!p.statuses}
      preventScrolling={!p.statuses}
      proOptions={{ hideAttribution: true }}
    >
      <FitWhenMeasured followResize={!!p.statuses} />
      {!p.readOnly && <Background variant={BackgroundVariant.Dots} gap={24} size={1.3} color="var(--dot)" />}
      <Controls showInteractive={false} position="bottom-left" />
      {p.minimap !== false && <MiniMap pannable zoomable nodeBorderRadius={6} nodeStrokeWidth={0} style={{ width: 168, height: 104 }}
        nodeColor={(n) => BLOCK_META[(n as BlockNodeType).data.block.type].color} />}
    </ReactFlow>
  );
}
