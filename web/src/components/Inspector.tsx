import type { ReactNode } from 'react';
import type {
  Block, BlockType, CommandConfig, ContextConfig, Edge, Effort, GateConfig, MergeConfig, OutputConfig, PromptConfig,
  ScannerConfig, ScannerName, Severity, ValidationIssue, VerifyConfig,
} from '../../../src/shared/types.ts';
import { PREFERENCE_OPTIONS } from '../../../src/shared/types.ts';
import { SCANNERS, SCANNER_CHOICE } from '../../../src/shared/scanners.ts';
import { useApp } from '../state.tsx';
import { BLOCK_META, SEVERITIES, SEVERITY_LABEL, resolveContext } from '../util.ts';
import { PromptField } from './PromptField.tsx';
import { TypeTile } from './ui.tsx';
import { CircleAlert, Link2, Trash, TriangleAlert } from 'lucide-react';

interface Props {
  block: Block;
  blocks: Block[];
  edges: Edge[];
  readOnly: boolean;
  issues: ValidationIssue[];
  onChange: (b: Block) => void;
  onDelete: () => void;
  /** Saves preference options immediately; used on read-only flows, where nothing else can change. */
  onPreference?: (patch: Record<string, unknown>) => void;
}

const EFFORTS: (Effort | null)[] = [null, 'low', 'medium', 'high', 'xhigh', 'max'];

function lines(v: string): string[] {
  return v.split('\n').map((x) => x.trim()).filter(Boolean);
}

function Num({ label, value, onChange, disabled, min = 0, step = 1 }: {
  label: string; value: number; onChange: (n: number) => void; disabled: boolean; min?: number; step?: number;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" value={Number.isFinite(value) ? value : ''} min={min} step={step} disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))} />
    </label>
  );
}

function Check({ label, value, onChange, disabled, toggle }: { label: string; value: boolean; onChange: (b: boolean) => void; disabled: boolean; toggle?: boolean }) {
  return (
    <label className={`check ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" className={toggle ? 'switch' : undefined} checked={value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function ListField({ label, value, onChange, disabled, hint }: {
  label: string; value: string[]; onChange: (v: string[]) => void; disabled: boolean; hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea rows={Math.max(2, Math.min(8, value.length + 1))} disabled={disabled} defaultValue={value.join('\n')}
        key={value.join('\n')} onBlur={(e) => onChange(lines(e.target.value))} spellCheck={false} />
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

function ForkFromSelect({ block, blocks, value, onChange, disabled }: {
  block: Block; blocks: Block[]; value: string | null; onChange: (v: string | null) => void; disabled: boolean;
}) {
  const options = blocks.filter((b) => b.id !== block.id && (b.type === 'context' || b.type === 'prompt'));
  return (
    <label className="field">
      <span>Fork from</span>
      <select value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Nearest upstream session</option>
        {options.map((b) => <option key={b.id} value={b.id}>{b.label || b.id} ({BLOCK_META[b.type].name})</option>)}
      </select>
      <span className="hint">Fork the seed directly to give this block the whole PR context from the prompt cache.</span>
    </label>
  );
}

function Inherited({ block, blocks, edges }: { block: Block; blocks: Block[]; edges: Edge[] }) {
  const ctx = resolveContext(block.id, blocks, edges);
  if (!ctx) {
    return <div className="inherited err"><CircleAlert size={14} style={{ marginTop: 1 }} /><span>No session to fork: connect this block downstream of a Context block, or set "Fork from".</span></div>;
  }
  const c = ctx.config as ContextConfig;
  return (
    <div className="inherited">
      <div className="kvr"><span>Model</span><span><code>{c.model}</code>{c.effort ? <span className="muted"> · effort <code>{c.effort}</code></span> : null}</span></div>
      <div className="kvr"><span>Tools</span><code>{c.tools.length ? c.tools.join(', ') : 'none'}</code></div>
      <div className="note">
        <Link2 size={12} />
        <span>Inherited from <b style={{ color: 'var(--text-2)' }}>{ctx.label}</b>: changing model or tools here would lose the prompt cache.</span>
      </div>
    </div>
  );
}

export function Inspector({ block, blocks, edges, readOnly, issues, onChange, onDelete, onPreference }: Props) {
  const { blockTypes } = useApp();
  const info = blockTypes.find((t) => t.type === block.type);
  const meta = BLOCK_META[block.type];
  const d = readOnly;
  const set = <T extends BlockType>(patch: Partial<Block<T>['config']>) =>
    onChange({ ...block, config: { ...block.config, ...patch } as Block['config'] });
  // Preference options stay live on a read-only flow and save on their own; everything else follows readOnly.
  const prefKeys = PREFERENCE_OPTIONS[block.type] ?? [];
  const livePref = (k: string) => readOnly && !!onPreference && prefKeys.includes(k);
  const dis = (k: string) => d && !livePref(k);
  const setOpt = <T extends BlockType>(patch: Partial<Block<T>['config']>) => {
    if (readOnly) onPreference?.(patch as Record<string, unknown>);
    else set<T>(patch);
  };

  let form: ReactNode = null;
  switch (block.type) {
    case 'scanner': {
      const c = block.config as ScannerConfig;
      form = (
        <>
          <label className="field">
            <span>Scanner</span>
            <select value={c.scanner} disabled={d} onChange={(e) => set<'scanner'>({ scanner: e.target.value as ScannerName })}>
              {/* a flow saved before betterleaks replaced gitleaks shows its old choice (which runs betterleaks) */}
              {[...SCANNERS, ...(c.scanner === 'gitleaks' ? ['gitleaks' as const] : [])].map((s) => (
                <option key={s} value={s}>{SCANNER_CHOICE[s]}</option>
              ))}
            </select>
          </label>
          <div className="hint" style={{ marginTop: -4 }}>Scans only what this change adds: staged lines for pre-commit, the pushed range otherwise. Connect it to a Context block to feed its findings in as <code>{'{{scanner_findings}}'}</code>.</div>
        </>
      );
      break;
    }
    case 'command': {
      const c = block.config as CommandConfig;
      form = (
        <>
          <label className="field">
            <span>Command</span>
            <textarea rows={3} value={c.command} disabled={d} onChange={(e) => set<'command'>({ command: e.target.value })} spellCheck={false} />
            <span className="hint">Runs in the repo (or review worktree) with sh. Output reaches later blocks as <code>{'{{command_outputs}}'}</code>.</span>
          </label>
          <Num label="Timeout (seconds)" value={c.timeoutSec} disabled={d} min={1} onChange={(n) => set<'command'>({ timeoutSec: n })} />
          <Check toggle label="Fail the block on a non-zero exit" value={c.failOnNonZero} disabled={d} onChange={(b) => set<'command'>({ failOnNonZero: b })} />
        </>
      );
      break;
    }
    case 'context': {
      const c = block.config as ContextConfig;
      const models = info?.models ?? ['opus', 'sonnet', 'haiku'];
      const tools = info?.tools ?? [];
      const allTools = Array.from(new Set([...tools, ...c.tools]));
      form = (
        <>
          <div className="grid2">
            <label className="field">
              <span>Model</span>
              <input list={`models-${block.id}`} value={c.model} disabled={d} onChange={(e) => set<'context'>({ model: e.target.value })} />
              <datalist id={`models-${block.id}`}>{models.map((m) => <option key={m} value={m} />)}</datalist>
            </label>
            <label className="field">
              <span>Effort</span>
              <select value={c.effort ?? ''} disabled={d} onChange={(e) => set<'context'>({ effort: (e.target.value || null) as Effort | null })}>
                {EFFORTS.map((x) => <option key={x ?? ''} value={x ?? ''}>{x ?? 'default'}</option>)}
              </select>
            </label>
          </div>
          <div style={{ marginBottom: 12 }}>
            <span className="field-label">Tools (inherited by every fork)</span>
            <div className="tool-checks">
              {allTools.map((t) => (
                <Check key={t} label={t} value={c.tools.includes(t)} disabled={d}
                  onChange={(on) => set<'context'>({ tools: on ? [...c.tools, t] : c.tools.filter((x) => x !== t) })} />
              ))}
            </div>
            <span className="hint">Give the seed every tool any downstream block needs; narrow per block with allowed tools.</span>
          </div>
          <ListField label="Allowed tools for the seed (one per line)" value={c.allowedTools} disabled={d}
            onChange={(v) => set<'context'>({ allowedTools: v })} hint='e.g. Read, Grep, Bash(git log:*)' />
          <div className="grid2">
            <Num label="Max turns" value={c.maxTurns} disabled={d} min={1} onChange={(n) => set<'context'>({ maxTurns: n })} />
            <Num label="Budget (chars)" value={c.budgetChars} disabled={d} min={0} step={1000} onChange={(n) => set<'context'>({ budgetChars: n })} />
          </div>
          <Check toggle label="Include the diff" value={c.includeDiff} disabled={d} onChange={(b) => set<'context'>({ includeDiff: b })} />
          <Check toggle label="Include full changed files (within budget)" value={c.includeFiles} disabled={d} onChange={(b) => set<'context'>({ includeFiles: b })} />
          <div style={{ height: 6 }} />
          <PromptField label="Seed prompt" value={c.prompt} disabled={d} onChange={(v) => set<'context'>({ prompt: v })} rows={16} />
        </>
      );
      break;
    }
    case 'branch': {
      const n = edges.filter((e) => e.source === block.id).length;
      form = (
        <div className="inherited"><div>
          Duplicates the upstream session once per outgoing connection (currently <b>{n}</b>). Nothing to configure:
          each connected block receives its own fork with the full cached context.
        </div></div>
      );
      break;
    }
    case 'prompt': {
      const c = block.config as PromptConfig;
      form = (
        <>
          <Inherited block={block} blocks={blocks} edges={edges} />
          <PromptField label="Prompt" value={c.prompt} disabled={d} onChange={(v) => set<'prompt'>({ prompt: v })} rows={14} />
          <div className="grid2">
            <label className="field">
              <span>Output</span>
              <select value={c.output} disabled={d} onChange={(e) => set<'prompt'>({ output: e.target.value as PromptConfig['output'] })}>
                <option value="findings">Findings (JSON)</option>
                <option value="text">Text</option>
              </select>
            </label>
            <Num label="Max turns" value={c.maxTurns} disabled={d} min={1} onChange={(n) => set<'prompt'>({ maxTurns: n })} />
          </div>
          <ForkFromSelect block={block} blocks={blocks} value={c.forkFrom} disabled={d} onChange={(v) => set<'prompt'>({ forkFrom: v })} />
          <label className="field">
            <span>Default category</span>
            <input value={c.category} disabled={d} onChange={(e) => set<'prompt'>({ category: e.target.value })} />
          </label>
          <ListField label="Allowed tools (one per line)" value={c.allowedTools} disabled={d}
            onChange={(v) => set<'prompt'>({ allowedTools: v })} hint="Permission only: narrows what this fork may use without breaking the cache." />
          {c.output === 'findings' && (
            <div className="hint">Returned findings whose <code>id</code> matches an input finding update it (severity, scenario, title…); <code>"severity": "drop"</code> removes it. Others are added as new.</div>
          )}
        </>
      );
      break;
    }
    case 'merge': {
      const c = block.config as MergeConfig;
      form = (
        <>
          <Num label="Line window for duplicates" value={c.lineWindow} disabled={d} onChange={(n) => set<'merge'>({ lineWindow: n })} />
          <div className="hint">Findings in the same file and category within this many lines (or on the same symbol) merge into one, keeping the most severe. No Claude call.</div>
        </>
      );
      break;
    }
    case 'verify': {
      const c = block.config as VerifyConfig;
      form = (
        <>
          <Inherited block={block} blocks={blocks} edges={edges} />
          <PromptField label="Verifier prompt" value={c.prompt} disabled={d} onChange={(v) => set<'verify'>({ prompt: v })} rows={12} />
          <ForkFromSelect block={block} blocks={blocks} value={c.forkFrom} disabled={d} onChange={(v) => set<'verify'>({ forkFrom: v })} />
          <div style={{ marginBottom: 12 }}>
            <span className="field-label">Verify findings at</span>
            <div className="row" style={{ gap: 14, marginTop: 6 }}>
              {SEVERITIES.map((s) => (
                <Check key={s} label={SEVERITY_LABEL[s]} value={c.appliesTo.includes(s)} disabled={d}
                  onChange={(on) => set<'verify'>({ appliesTo: on ? [...c.appliesTo, s] : c.appliesTo.filter((x) => x !== s) })} />
              ))}
            </div>
          </div>
          <Check toggle label="Fail closed (unclear verdict → downgrade to Consider)" value={c.failClosed} disabled={d} onChange={(b) => set<'verify'>({ failClosed: b })} />
          <div className="grid2">
            <Num label="Concurrency" value={c.concurrency} disabled={d} min={1} onChange={(n) => set<'verify'>({ concurrency: n })} />
            <Num label="Max turns" value={c.maxTurns} disabled={d} min={1} onChange={(n) => set<'verify'>({ maxTurns: n })} />
          </div>
          <ListField label="Allowed tools (one per line)" value={c.allowedTools} disabled={d} onChange={(v) => set<'verify'>({ allowedTools: v })} />
        </>
      );
      break;
    }
    case 'gate': {
      const c = block.config as GateConfig;
      form = (
        <>
          <label className="field">
            <span>Block when any finding is at least</span>
            <select value={c.blockOn} disabled={d} onChange={(e) => set<'gate'>({ blockOn: e.target.value as Severity })}>
              {SEVERITIES.map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}
            </select>
          </label>
          <div className="hint">On pre-commit and pre-push a failed gate stops the commit or push. Dismissed findings don't count.</div>
        </>
      );
      break;
    }
    case 'output': {
      const c = block.config as OutputConfig;
      form = (
        <>
          {readOnly && prefKeys.length > 0 && onPreference && <div className="pref-note">Preferences · saved instantly, even on a default flow</div>}
          <Check toggle label="Desktop notification" value={c.notify} disabled={dis('notify')} onChange={(b) => setOpt<'output'>({ notify: b })} />
          <Check toggle label="Post a summary comment on the PR (needs gh)" value={c.postPrComment} disabled={dis('postPrComment')} onChange={(b) => setOpt<'output'>({ postPrComment: b })} />
          <div className="hint">Results are always stored and shown in Runs.</div>
        </>
      );
      break;
    }
  }

  return (
    <div className="inspector">
      <div className="ins-head">
        <div className="row1">
          <TypeTile type={block.type} size="lg" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="nm">{block.label || meta.name}</div>
            <div className="ty">{meta.name}<span>·</span><code>{block.id}</code></div>
          </div>
          {!readOnly && <button className="sm ghost danger icon" onClick={onDelete} title="Delete block" aria-label="Delete block"><Trash size={14} /></button>}
        </div>
        {info && <div className="hint desc">{info.description}</div>}
      </div>
      <div className="ins-body">
        {issues.length > 0 && (
          <div className="ins-issues">
            {issues.map((i, k) => (
              <div key={k} className={`ins-issue ${i.level}`}>
                {i.level === 'error' ? <CircleAlert size={13} /> : <TriangleAlert size={13} />}<span>{i.message}</span>
              </div>
            ))}
          </div>
        )}
        <label className="field">
          <span>Label</span>
          <input value={block.label} disabled={d} onChange={(e) => onChange({ ...block, label: e.target.value })} />
        </label>
        {form}
      </div>
    </div>
  );
}
