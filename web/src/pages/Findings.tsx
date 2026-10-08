import { useCallback, useEffect, useState } from 'react';
import type { LedgerItem } from '../../../src/shared/types.ts';
import { api, errMsg } from '../api.ts';
import { useApp } from '../state.tsx';
import { useToast } from '../components/Toast.tsx';
import { timeAgo } from '../util.ts';
import { EmptyState, ErrorCard, PageHeader, SevBadge, SkeletonRows } from '../components/ui.tsx';
import { Bookmark, CircleCheck, EyeOff, GitBranch, Inbox, RotateCcw } from 'lucide-react';

const STATES: [string, string][] = [['open', 'Open'], ['fixed', 'Fixed'], ['tracked', 'Tracked'], ['dismissed', 'Dismissed'], ['', 'Any']];
const STATE_CLS: Record<string, string> = { open: 'muted', fixed: 'ok', dismissed: 'muted', tracked: 'muted' };

export function FindingsPage() {
  const { state } = useApp();
  const toast = useToast();
  const [repoId, setRepoId] = useState('');
  const [st, setSt] = useState('open');
  const [items, setItems] = useState<LedgerItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setItems(await api.ledger(repoId || undefined, st || undefined)); setError(null); } catch (e) { setError(errMsg(e)); }
  }, [repoId, st]);
  useEffect(() => { load(); }, [load]);

  const setState = async (fp: string, s: 'open' | 'dismissed' | 'tracked', rid?: string) => {
    try { await api.setLedger(fp, s, rid); toast('Updated', 'ok'); load(); } catch (e) { toast(errMsg(e), 'error'); }
  };
  const repoName = (id: string) => state?.repos.find((r) => r.id === id)?.name ?? id;

  return (
    <div className="page">
      <PageHeader title="Findings"
        sub="The ledger remembers findings across runs by fingerprint. Dismissed findings aren't raised again while their code is unchanged; tracked ones are kept but stay quiet; a fixed finding that comes back is flagged as a regression." />
      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="State">
          {STATES.map(([v, l]) => (
            <button key={v} role="tab" aria-selected={st === v} className={st === v ? 'on' : ''} onClick={() => setSt(v)}>{l}</button>
          ))}
        </div>
        <span className="spacer" />
        <select style={{ width: 200 }} value={repoId} onChange={(e) => setRepoId(e.target.value)} aria-label="Repo">
          <option value="">All repos</option>
          {(state?.repos ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>
      {error && <ErrorCard>{error}</ErrorCard>}
      {!items && !error && <SkeletonRows cols={[50, 70, 300, 100, 90, 60]} />}
      {items && items.length === 0 && (
        <div className="card" style={{ padding: 0 }}>
          <EmptyState icon={st === 'open' ? CircleCheck : Inbox} title={st === 'open' ? 'No open findings' : 'Nothing here'}>
            {st === 'open' ? 'Every finding PuRR has raised is fixed, tracked or dismissed.' : 'No findings match these filters.'}
          </EmptyState>
        </div>
      )}
      {items && items.length > 0 && (
        <div className="table-wrap">
          <table className="t ledger">
            <thead><tr><th>Severity</th><th>Finding</th><th>Location</th><th>Repo / branch</th><th>State</th><th>Last run</th><th /></tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.fingerprint} className={i.finding.severity}>
                  <td className="sevcell" style={{ width: 110 }}><SevBadge sev={i.finding.severity} /></td>
                  <td style={{ maxWidth: 460 }}>
                    <div className="ftitle">{i.finding.title}</div>
                    {i.finding.scenario && <div className="fscen">{i.finding.scenario}</div>}
                  </td>
                  <td className="mono" style={{ whiteSpace: 'nowrap', color: 'var(--text-2)' }}>{i.finding.file}{i.finding.line != null ? `:${i.finding.line}` : ''}</td>
                  <td>
                    <div>{repoName(i.repoId)}</div>
                    <div className="cell-sub"><span className="branch"><GitBranch size={11} />{i.branch ?? '—'}</span></div>
                  </td>
                  <td><span className={`chip ${STATE_CLS[i.state]}`}>{i.state}</span></td>
                  <td style={{ whiteSpace: 'nowrap' }}><a href={`#/runs/${i.lastRunId}`}>{timeAgo(i.updatedAt)}</a></td>
                  <td className="act">
                    <span className="acts">
                      {i.state === 'open' || i.state === 'fixed' ? <>
                        <button className="sm ghost" onClick={() => setState(i.fingerprint, 'tracked', i.repoId)} title="Keep it, but stop raising it"><Bookmark size={13} />Track</button>
                        <button className="sm ghost" onClick={() => setState(i.fingerprint, 'dismissed', i.repoId)} title="Not a real issue"><EyeOff size={13} />Dismiss</button>
                      </> : <button className="sm ghost" onClick={() => setState(i.fingerprint, 'open', i.repoId)}><RotateCcw size={13} />Reopen</button>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
