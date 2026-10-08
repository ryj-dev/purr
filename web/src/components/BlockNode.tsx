import { memo, type CSSProperties } from 'react';
import { Handle, Position, useStore, type NodeProps, type Node } from '@xyflow/react';
import { CircleAlert, TriangleAlert } from 'lucide-react';
import type { Block, BlockStatus, Edge } from '../../../src/shared/types.ts';
import { BLOCK_META, blockSummary } from '../util.ts';
import { TypeTile } from './ui.tsx';
import { StatusIcon } from './StatusChip.tsx';

export interface BlockNodeData extends Record<string, unknown> {
  block: Block;
  blocks: Block[];
  edges: Edge[];
  status?: BlockStatus;
  issue?: 'error' | 'warning';
  hasInput: boolean;
  hasOutput: boolean;
  statusNote?: string;
}

export type BlockNodeType = Node<BlockNodeData, 'block'>;

function BlockNodeImpl({ data, selected }: NodeProps<BlockNodeType>) {
  const { block, blocks, edges, status, issue, hasInput, hasOutput, statusNote } = data;
  const meta = BLOCK_META[block.type];
  // zoomed far out (a whole review on screen), drop the detail and enlarge label + status so they stay readable
  const compact = useStore((s) => s.transform[2] < 0.62);
  const cls = ['bnode', compact ? 'compact' : '', selected ? 'selected' : '', issue ? `has-${issue}` : '', status ? `st-${status}` : ''].join(' ');
  const summary = blockSummary(block, blocks, edges);
  return (
    <div className={cls} style={{ '--tc': meta.color } as CSSProperties}>
      {hasInput && <Handle type="target" position={Position.Left} />}
      <div className="top">
        <TypeTile type={block.type} />
        <div className="titles">
          <div className="lbl" title={block.label}>{block.label || meta.name}</div>
          <div className="sum" title={summary ? `${meta.name} · ${summary}` : meta.name}>{summary || meta.name}</div>
        </div>
        {issue && !status && (
          <span className={`badge issue-${issue}`} title={issue === 'error' ? 'Has validation errors' : 'Has warnings'}>
            {issue === 'error' ? <CircleAlert size={14} /> : <TriangleAlert size={14} />}
          </span>
        )}
        {status && <span className={`badge ${status}`} title={status}><StatusIcon status={status} size={12} /></span>}
      </div>
      {status && status !== 'pending' && (
        <div className="st"><span className="s">{status}</span>{statusNote && <span>· {statusNote}</span>}</div>
      )}
      {hasOutput && <Handle type="source" position={Position.Right} />}
    </div>
  );
}

export const BlockNode = memo(BlockNodeImpl);
export const nodeTypes = { block: BlockNode };
