import { useRef } from 'react';
import { ChevronRight } from 'lucide-react';
import { TEMPLATE_VARS } from '../../../src/shared/types.ts';

export function PromptField({ label, value, onChange, disabled, rows = 12 }: {
  label: string; value: string; onChange: (v: string) => void; disabled: boolean; rows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = (name: string) => {
    if (disabled) return;
    const ta = ref.current;
    const token = `{{${name}}}`;
    if (!ta) { onChange(value + token); return; }
    const s = ta.selectionStart ?? value.length;
    const e = ta.selectionEnd ?? value.length;
    const next = value.slice(0, s) + token + value.slice(e);
    onChange(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = s + token.length;
    });
  };
  return (
    <>
      <label className="field">
        <span>{label}</span>
        <textarea ref={ref} className="prompt" rows={rows} value={value} disabled={disabled}
          onChange={(e) => onChange(e.target.value)} spellCheck={false} />
      </label>
      <details className="vars">
        <summary><ChevronRight size={12} />Template variables{disabled ? '' : ' · click to insert'}</summary>
        <div className="list">
          {Object.entries(TEMPLATE_VARS).map(([k, d]) => (
            <div key={k} className="v" onClick={() => insert(k)} title={disabled ? '' : 'Insert at cursor'}>
              <code>{`{{${k}}}`}</code><span>{d}</span>
            </div>
          ))}
        </div>
      </details>
    </>
  );
}
