import { useState } from 'react';
import type { Block, Finding, Severity } from '../../../src/shared/types.ts';
import { foundByPlain } from '../../../src/shared/scanners.ts';
import { api, errMsg } from '../api.ts';
import { SEVERITIES, SEVERITY_LABEL } from '../util.ts';
import { EmptyState, InlineCode, SevBadge, TypeTile } from './ui.tsx';
import {
  BadgeCheck, Bookmark, ChevronRight, CircleCheck, CircleX, EyeOff, FileCode, RotateCcw, ScanSearch, Tag, Wrench,
} from 'lucide-react';
import { useToast } from './Toast.tsx';

const LEDGER_CLS: Record<string, string> = { new: 'info', open: 'muted', regression: 'danger', dismissed: 'muted', tracked: 'muted' };

function FindingCard({ f, blocks, onLedger }: { f: Finding; blocks: Block[]; onLedger?: (fp: string, s: 'dismissed' | 'tracked' | 'open') => void }) {
  const src = blocks.find((b) => b.id === f.source.blockId);
  const loc = f.lines && f.lines.length > 1 ? `${f.file}:${f.lines.join(',')}` : f.line != null ? `${f.file}:${f.line}` : f.file;
  const dismissed = f.ledger === 'dismissed';
  const scanner = f.source.kind === 'scanner';
  return (
    <div className={`finding ${f.severity} ${dismissed ? 'dimmed' : ''}`}>
      <div className="head">
        <SevBadge sev={f.severity} />
        <div className="title">{f.title}</div>
        {f.ledger && <span className={`chip ${LEDGER_CLS[f.ledger] ?? 'muted'}`}>{f.ledger}</span>}
      </div>
      <div className="loc"><FileCode />{loc}{f.symbol ? <span className="sym">· {f.symbol}</span> : null}</div>
      {f.scenario && <div className="scenario"><InlineCode text={f.scenario} /></div>}
      {f.fix && <div className="fix"><Wrench /><div><span className="k">Fix</span><InlineCode text={f.fix} /></div></div>}
      {f.verified && (
        <div className="verified">
          {f.verified.real
            ? <span className="chip ok"><BadgeCheck />Verified</span>
            : <span className="chip danger"><CircleX />Refuted</span>}
          <span style={{ paddingTop: 2 }}><InlineCode text={f.verified.note} /></span>
        </div>
      )}
      {f.evidence && (
        <details className="evidence">
          <summary><ChevronRight />Evidence</summary>
          <pre className="out">{f.evidence}</pre>
        </details>
      )}
      <div className="meta">
        <span className="chip src" title={scanner ? foundByPlain(f) || 'Found by a code scanner' : 'Found by a Claude lens'}>
          {scanner ? <ScanSearch /> : src ? <TypeTile type={src.type} size="sm" /> : null}
          {scanner ? `${f.source.scanner ?? 'scanner'}${f.source.rule ? ` · ${f.source.rule}` : ''}` : src?.label ?? f.source.blockId}
        </span>
        {f.alsoFoundBy && f.alsoFoundBy.length > 0 && (
          <span className="chip" title={f.alsoFoundBy.map((id) => blocks.find((b) => b.id === id)?.label ?? id).join(', ')}>
            +{f.alsoFoundBy.length} lens{f.alsoFoundBy.length > 1 ? 'es' : ''}
          </span>
        )}
        <span className="chip plain"><Tag />{f.category}</span>
        {f.confidence != null && <span className="chip plain" title="Model confidence">{Math.round(f.confidence * 100)}% conf</span>}
        <span className="spacer" />
        {f.fingerprint && onLedger && (
          <span className="acts">
            {dismissed || f.ledger === 'tracked'
              ? <button className="sm ghost" onClick={() => onLedger(f.fingerprint!, 'open')}><RotateCcw size={13} />Reopen</button>
              : <>
                  <button className="sm ghost" onClick={() => onLedger(f.fingerprint!, 'tracked')} title="Keep it, but stop raising it"><Bookmark size={13} />Track</button>
                  <button className="sm ghost" onClick={() => onLedger(f.fingerprint!, 'dismissed')} title="Not a real issue: don't raise it again while this code is unchanged"><EyeOff size={13} />Dismiss</button>
                </>}
          </span>
        )}
      </div>
    </div>
  );
}

export function FindingList({ findings, blocks, repoId, onChanged }: { findings: Finding[]; blocks: Block[]; repoId?: string | null; onChanged?: () => void }) {
  const toast = useToast();
  const [local, setLocal] = useState<Record<string, Finding['ledger']>>({});
  const onLedger = async (fp: string, state: 'dismissed' | 'tracked' | 'open') => {
    try {
      await api.setLedger(fp, state, repoId);
      setLocal((l) => ({ ...l, [fp]: state === 'open' ? 'open' : state }));
      toast(state === 'open' ? 'Reopened' : state === 'dismissed' ? 'Dismissed' : 'Tracked', 'ok');
      onChanged?.();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };
  const view = findings.map((f) => (f.fingerprint && local[f.fingerprint] ? { ...f, ledger: local[f.fingerprint] } : f));
  if (view.length === 0) {
    return <div className="card" style={{ padding: 0 }}><EmptyState icon={CircleCheck} title="No findings">Nothing to fix in this change.</EmptyState></div>;
  }
  return (
    <div className="findings">
      {SEVERITIES.map((sev: Severity) => {
        const list = view.filter((f) => f.severity === sev);
        if (!list.length) return null;
        const files = Array.from(new Set(list.map((f) => f.file)));
        return (
          <div key={sev} className="group">
            <h3 className={`group-head ${sev}`}>{SEVERITY_LABEL[sev]}<span className="n">{list.length}</span></h3>
            {files.map((file) => {
              const inFile = list.filter((f) => f.file === file).sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
              return (
                <div key={file} className="file-group">
                  <div className="fg-head"><FileCode size={13} />{file}<span className="n">{inFile.length}</span></div>
                  {inFile.map((f) => <FindingCard key={f.id} f={f} blocks={blocks} onLedger={onLedger} />)}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
