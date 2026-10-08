import { Lightbulb, Plus } from 'lucide-react';
import type { BlockType } from '../../../src/shared/types.ts';
import { useApp } from '../state.tsx';
import { BLOCK_META } from '../util.ts';
import { TypeTile } from './ui.tsx';

const GROUPS = ['Sources', 'Sessions', 'Results'] as const;

export function Palette({ onAdd, disabled }: { onAdd: (t: BlockType) => void; disabled: boolean }) {
  const { blockTypes } = useApp();
  return (
    <div className="palette">
      {blockTypes.length === 0 && (
        <div style={{ padding: '0 6px' }}>
          {Array.from({ length: 7 }, (_, i) => <div key={i} className="skel" style={{ height: 30, marginBottom: 8 }} />)}
        </div>
      )}
      {GROUPS.map((g) => {
        const list = blockTypes.filter((t) => BLOCK_META[t.type]?.group === g);
        if (!list.length) return null;
        return (
          <div key={g} className="grp">
            <h3>{g}</h3>
            {list.map((t) => (
              <div key={t.type} className={`item ${disabled ? 'disabled' : ''}`} title={t.description} role="button"
                aria-disabled={disabled} onClick={() => { if (!disabled) onAdd(t.type); }}>
                <TypeTile type={t.type} />
                <div style={{ minWidth: 0 }}>
                  <div className="t">{t.label}</div>
                  <small>{t.description}</small>
                </div>
                {!disabled && <Plus size={14} className="add" />}
              </div>
            ))}
          </div>
        );
      })}
      <div className="tips">
        <h3><Lightbulb size={12} />Tips</h3>
        <div className="hint">
          Drag from a block's right handle to another's left handle to connect. Select and press <kbd>⌫</kbd> to delete.
          Branch duplicates its upstream session once per outgoing connection.
        </div>
      </div>
    </div>
  );
}
