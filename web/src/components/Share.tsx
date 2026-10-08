// Sharing flows as text: an Export dialog (copy the share text or the JSON) and an Import dialog (paste, read what the
// flow can do, then import it as a new flow). The format and all checks live on the server (src/server/flows/share.ts).
import { useEffect, useRef, useState } from 'react';
import { Check, ClipboardPaste, Copy, Download, Info, OctagonAlert, TriangleAlert, Upload } from 'lucide-react';
import type { FlowExport, ImportPreview, ShareRisk } from '../../../src/shared/types.ts';
import { api, errMsg } from '../api.ts';
import { Modal } from './Modal.tsx';
import { RouteMini } from './Station.tsx';
import { useToast } from './Toast.tsx';

export function ExportFlowModal({ flowId, flowName, onClose }: { flowId: string; flowName: string; onClose: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<FlowExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'text' | 'json'>('text');
  const [copied, setCopied] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { api.exportFlow(flowId).then(setData, (e) => setError(errMsg(e))); }, [flowId]);
  const value = data ? (mode === 'text' ? data.text : data.json) : '';
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); }
    catch { area.current?.select(); document.execCommand('copy'); }
    setCopied(true);
    toast('Copied. Paste it into PuRR → Flows → Import', 'ok');
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <Modal wide title={`Share “${flowName}”`} onClose={onClose} actions={<>
      <button onClick={onClose}>Close</button>
      <button className="primary" disabled={!data} onClick={copy}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy'}</button>
    </>}>
      <p className="share-hint">Send this text to anyone with PuRR. They paste it into <b>Flows → Import</b>. It holds the flow's blocks, prompts and settings, and nothing about your repos, runs or findings.</p>
      <div className="seg nocap" role="tablist" style={{ marginBottom: 10 }}>
        <button role="tab" aria-selected={mode === 'text'} className={mode === 'text' ? 'on' : ''} onClick={() => setMode('text')}>Share text</button>
        <button role="tab" aria-selected={mode === 'json'} className={mode === 'json' ? 'on' : ''} onClick={() => setMode('json')}>JSON</button>
      </div>
      {error ? <div className="err-text">{error}</div> : (
        <textarea ref={area} className={`share-text ${mode}`} readOnly value={data ? value : 'Preparing…'} rows={mode === 'text' ? 6 : 14}
          onFocus={(e) => e.currentTarget.select()} spellCheck={false} aria-label="Shared flow" />
      )}
      {data && <div className="hint" style={{ marginTop: 6 }}>{mode === 'text' ? `${data.bytes.toLocaleString()} characters, one line` : 'Readable and editable; Import accepts it too.'}</div>}
    </Modal>
  );
}

const RISK_ICON = { danger: OctagonAlert, warn: TriangleAlert, info: Info } as const;

function RiskList({ risks }: { risks: ShareRisk[] }) {
  if (!risks.length) return <div className="share-safe"><Check size={14} />No shell commands, write or network permissions, or PR comments.</div>;
  return (
    <ul className="share-risks">
      {risks.map((r, i) => {
        const Icon = RISK_ICON[r.level];
        return (
          <li key={i} className={r.level}>
            <Icon size={14} />
            <div><b>{r.label}</b>: {r.message}{r.detail && <code className="detail">{r.detail}</code>}</div>
          </li>
        );
      })}
    </ul>
  );
}

export function ImportFlowModal({ onClose, onImported }: { onClose: () => void; onImported: (flowId: string) => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // re-check whenever the pasted text changes
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    setAgreed(false);
    if (!text.trim()) { setPreview(null); setError(null); return; }
    timer.current = setTimeout(async () => {
      try { const p = await api.previewImport(text); setPreview(p); setName(p.name); setError(null); }
      catch (e) { setPreview(null); setError(errMsg(e)); }
    }, 250);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [text]);

  const needsAgreement = !!preview?.risks.some((r) => r.level !== 'info');
  const errors = preview?.issues.filter((i) => i.level === 'error') ?? [];
  const pasteFromClipboard = async () => {
    try { setText(await navigator.clipboard.readText()); } catch { toast('Paste with ⌘V into the box instead', 'info'); }
  };
  const doImport = async () => {
    setBusy(true);
    try {
      const f = await api.importFlow(text, name.trim() || undefined);
      toast(`Imported “${f.name}”. Assign it to a trigger when you're ready.`, 'ok');
      onImported(f.id);
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };

  return (
    <Modal wide title="Import a flow" onClose={onClose} actions={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={!preview || busy || (needsAgreement && !agreed)} onClick={doImport}><Download size={14} />Import</button>
    </>}>
      <div className="share-paste">
        <textarea className="share-text text" rows={preview ? 3 : 6} value={text} onChange={(e) => setText(e.target.value)} autoFocus spellCheck={false}
          placeholder="Paste the shared text (purr-flow:v1:…) or the flow's JSON" aria-label="Shared flow" />
        {!text && <button className="sm" onClick={pasteFromClipboard}><ClipboardPaste size={13} />Paste from clipboard</button>}
      </div>
      {error && <div className="err-text" style={{ marginTop: 8 }}>{error}</div>}
      {preview && (
        <div className="share-preview">
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </label>
          {preview.description && <p className="hint" style={{ margin: '0 0 10px' }}>{preview.description}</p>}
          <div className="share-route"><RouteMini blocks={preview.blocks} edges={preview.edges} height={72} /></div>
          <div className="hint" style={{ margin: '6px 0 12px' }}>
            {preview.blocks.length} blocks · {preview.edges.length} connections
            {errors.length > 0 && <> · <span className="warn-text">{errors.length} validation error{errors.length === 1 ? '' : 's'} to fix in the editor</span></>}
          </div>
          <h3 className="share-h">What this flow can do</h3>
          <RiskList risks={preview.risks} />
          {preview.notes.length > 0 && (
            <details className="share-notes">
              <summary>{preview.notes.length} thing{preview.notes.length === 1 ? ' was' : 's were'} repaired while reading it</summary>
              <ul>{preview.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
            </details>
          )}
          {needsAgreement && (
            <label className="check share-agree">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              I've read what this flow can do and trust where it came from
            </label>
          )}
          <p className="hint" style={{ marginTop: 10 }}><Upload size={12} style={{ verticalAlign: '-2px' }} /> It's imported as a new flow you can edit. Nothing runs it until you assign it on <b>Repos &amp; triggers</b>.</p>
        </div>
      )}
    </Modal>
  );
}
