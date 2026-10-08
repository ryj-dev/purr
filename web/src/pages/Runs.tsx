import { useCallback, useEffect, useState } from 'react';
import type { Run } from '../../../src/shared/types.ts';
import { api, errMsg, useEvents } from '../api.ts';
import { useApp } from '../state.tsx';
import { Counts, StatusChip } from '../components/StatusChip.tsx';
import { Modal } from '../components/Modal.tsx';
import { EmptyState, ErrorCard, PageHeader, SkeletonRows, TriggerLabel } from '../components/ui.tsx';
import { Activity, ChevronRight, Filter as Filter_, GitBranch, Play } from 'lucide-react';
import { useToast } from '../components/Toast.tsx';
import { durationBetween, fmtDuration, navigate, shortSha, timeAgo } from '../util.ts';

function RunNowModal({ onClose }: { onClose: () => void }) {
  const { state } = useApp();
  const toast = useToast();
  const repos = state?.repos ?? [];
  const flows = state?.flows ?? [];
  const [repoId, setRepoId] = useState(repos[0]?.id ?? '');
  const [flowId, setFlowId] = useState('');
  const [base, setBase] = useState('');
  const [head, setHead] = useState('');
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const run = await api.startRun({ repoId, flowId: flowId || undefined, base: base.trim() || undefined, head: head.trim() || undefined });
      toast('Run queued', 'ok');
      onClose();
      navigate(`/runs/${run.id}`);
    } catch (e) {
      toast(errMsg(e), 'error');
      setBusy(false);
    }
  };
  return (
    <Modal title="Run now" onClose={onClose} actions={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={!repoId || busy} onClick={start}>{busy ? 'Starting…' : 'Start run'}</button>
    </>}>
      {repos.length === 0 ? (
        <div className="muted">No repos yet. Make a commit or push in any repository, or add one on the <a href="#/triggers" onClick={onClose}>Repos &amp; triggers</a> page.</div>
      ) : (
        <>
          <label className="field">
            <span>Repo</span>
            <select value={repoId} onChange={(e) => setRepoId(e.target.value)}>
              {repos.map((r) => <option key={r.id} value={r.id}>{r.name} — {r.path}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Flow</span>
            <select value={flowId} onChange={(e) => setFlowId(e.target.value)}>
              <option value="">Flow assigned to the manual trigger</option>
              {flows.map((f) => <option key={f.id} value={f.id}>{f.name}{f.isDefault ? ' (default)' : ''}</option>)}
            </select>
          </label>
          <div className="grid2">
            <label className="field"><span>Base (optional)</span><input placeholder="merge-base with default branch" value={base} onChange={(e) => setBase(e.target.value)} /></label>
            <label className="field"><span>Head (optional)</span><input placeholder="HEAD" value={head} onChange={(e) => setHead(e.target.value)} /></label>
          </div>
        </>
      )}
    </Modal>
  );
}

type Filter = 'all' | 'active' | 'blocked' | 'failed';
const FILTERS: Record<Filter, (r: Run) => boolean> = {
  all: () => true,
  active: (r) => r.status === 'running' || r.status === 'queued',
  blocked: (r) => r.status === 'blocked',
  failed: (r) => r.status === 'failed',
};

export function RunsPage() {
  const { state } = useApp();
  const [filter, setFilter] = useState<Filter>('all');
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRun, setShowRun] = useState(false);
  const [, tick] = useState(0);

  const load = useCallback(async () => {
    try { setRuns(await api.runs(100)); setError(null); } catch (e) { setError(errMsg(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);

  useEvents((e) => {
    if (e.type !== 'run') return;
    setRuns((rs) => {
      if (!rs) return rs;
      const i = rs.findIndex((r) => r.id === e.run.id);
      if (i === -1) return [e.run, ...rs];
      const next = rs.slice();
      next[i] = e.run;
      return next;
    });
  }, (c) => { if (c) load(); });

  const repoName = (r: Run) => state?.repos.find((x) => x.id === r.repoId)?.name ?? r.repoPath.split('/').pop();
  const n = (f: Filter) => (runs ?? []).filter(FILTERS[f]).length;
  const view = (runs ?? []).filter(FILTERS[filter]);

  return (
    <div className="page">
      <PageHeader title="Runs" sub="Every review PuRR has run, live. Click a run to see its flow, sessions and findings."
        actions={<button className="primary" onClick={() => setShowRun(true)}><Play size={13} fill="currentColor" />Run now</button>} />
      {error && <ErrorCard>{error}</ErrorCard>}
      {!runs && !error && <SkeletonRows cols={[70, 80, 160, 150, 60, 60, 50]} />}
      {runs && runs.length === 0 && (
        <div className="card" style={{ padding: 0 }}>
          <EmptyState icon={Activity} title="No runs yet"
            actions={<button className="primary" onClick={() => setShowRun(true)}><Play size={13} fill="currentColor" />Run now</button>}>
            Add a repo and install its hooks, or start a review by hand with <b>Run now</b>.
          </EmptyState>
        </div>
      )}
      {runs && runs.length > 0 && (
        <>
          <div className="toolbar">
            <div className="seg" role="tablist">
              {(Object.keys(FILTERS) as Filter[]).map((f) => (
                <button key={f} className={filter === f ? 'on' : ''} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>
                  {f}<span className="n">{n(f)}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="table-wrap">
            <table className="t runs">
              <thead>
                <tr><th>Status</th><th>Repo &amp; branch</th><th>Flow</th><th className="c-opt">Trigger</th><th>Findings</th><th className="c-opt">Started</th><th className="num c-opt">Duration</th><th /></tr>
              </thead>
              <tbody>
                {view.map((r) => (
                  <tr key={r.id} className="click" onClick={() => navigate(`/runs/${r.id}`)}>
                    <td className="route"><StatusChip status={r.status} /></td>
                    <td>
                      <div className="cell-main">{repoName(r)}</div>
                      <div className="cell-sub row" style={{ gap: 8 }}>
                        <span className="branch"><GitBranch size={12} />{r.branch ?? 'detached'}</span>
                        {r.pr && <span className="muted">#{r.pr.number}</span>}
                        <span className="sha">{shortSha(r.headSha)}</span>
                      </div>
                    </td>
                    <td>{r.flowName}</td>
                    <td className="c-opt"><TriggerLabel trigger={r.trigger} /></td>
                    <td><Counts counts={r.counts} /></td>
                    <td title={r.startedAt ?? r.queuedAt} className="muted c-opt" style={{ whiteSpace: 'nowrap' }}>{timeAgo(r.startedAt ?? r.queuedAt)}</td>
                    <td className="num mono c-opt">{fmtDuration(durationBetween(r.startedAt, r.finishedAt))}</td>
                    <td className="act"><ChevronRight size={15} className="go" /></td>
                  </tr>
                ))}
                {view.length === 0 && (
                  <tr><td colSpan={8}><EmptyState small icon={Filter_} title={`No ${filter} runs`}>Nothing matches this filter.</EmptyState></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
      {showRun && <RunNowModal onClose={() => setShowRun(false)} />}
    </div>
  );
}
