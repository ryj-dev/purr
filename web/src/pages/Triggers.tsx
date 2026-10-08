import { useCallback, useEffect, useState } from 'react';
import { TRIGGERS, type Repo, type TriggerAssignment, type TriggerKind } from '../../../src/shared/types.ts';
import { api, errMsg } from '../api.ts';
import { useApp } from '../state.tsx';
import { useToast } from '../components/Toast.tsx';
import { Confirm } from '../components/Modal.tsx';
import { ErrorCard, PageHeader, SkeletonRows, triggerIcon } from '../components/ui.tsx';
import { Ban, FolderGit2, FolderPlus, Globe, LoaderCircle, Plus, ShieldCheck, Trash, TriangleAlert, Undo2 } from 'lucide-react';

const EXPLAIN: Record<TriggerKind, string> = {
  'pre-commit': 'Blocks the commit if the gate fails. Keep it fast: scanners only.',
  'pre-push': 'Blocks the push if the gate fails.',
  'post-push': 'Runs in the background after a push lands on the remote.',
  manual: 'Used by Run now and `purr run`.',
};

export function TriggersPage() {
  const { state, refresh } = useApp();
  const toast = useToast();
  const [rows, setRows] = useState<TriggerAssignment[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setRows(await api.triggers()); setError(null); } catch (e) { setError(errMsg(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const flows = state?.flows ?? [];
  const repos = state?.repos ?? [];
  const get = (trigger: TriggerKind, repoId: string | null) => rows?.find((r) => r.trigger === trigger && r.repoId === repoId);

  const set = async (trigger: TriggerKind, repoId: string | null, value: string) => {
    const flowId = value === '__disabled' ? null : value === '__inherit' ? 'inherit' : value;
    try {
      setRows(await api.setTrigger({ trigger, repoId, flowId }));
      refresh();
      toast('Trigger updated', 'ok');
    } catch (e) { toast(errMsg(e), 'error'); }
  };

  // repos: PuRR registers them on their first commit or push; adding one by hand just starts watching its PRs sooner
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [toRemove, setToRemove] = useState<Repo | null>(null);
  const addRepo = async () => {
    if (!path.trim()) return;
    setBusy(true);
    try {
      const r = await api.addRepo(path.trim());
      toast(`Added ${r.name}`, 'ok');
      setPath('');
      await refresh();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const removeRepo = async (r: Repo) => {
    setToRemove(null);
    try { await api.removeRepo(r.id); toast(`Removed ${r.name}`, 'ok'); await refresh(); await load(); } catch (e) { toast(errMsg(e), 'error'); }
  };
  const excluded = (repoId: string) => TRIGGERS.every((t) => get(t, repoId)?.flowId === null);
  const setExcluded = async (r: Repo, exclude: boolean) => {
    try {
      let next = rows;
      for (const t of TRIGGERS) next = await api.setTrigger({ trigger: t, repoId: r.id, flowId: exclude ? null : 'inherit' });
      setRows(next);
      refresh();
      toast(exclude ? `${r.name} excluded: PuRR leaves it alone` : `${r.name} follows the global triggers again`, 'ok');
    } catch (e) { toast(errMsg(e), 'error'); }
  };
  const gh = state?.globalHooks;

  const flowName = (id: string | null | undefined) => (id ? flows.find((f) => f.id === id)?.name ?? 'missing flow' : 'Disabled');

  const cell = (trigger: TriggerKind, repoId: string | null) => {
    const row = get(trigger, repoId);
    const value = row ? (row.flowId ?? '__disabled') : repoId ? '__inherit' : '__disabled';
    const globalRow = get(trigger, null);
    return (
      <select value={value} className={value === '__inherit' ? 'inherit' : ''} onChange={(e) => set(trigger, repoId, e.target.value)}>
        {repoId && <option value="__inherit">Inherit global ({flowName(globalRow?.flowId)})</option>}
        <option value="__disabled">Disabled</option>
        {flows.map((f) => <option key={f.id} value={f.id}>{f.name}{f.isDefault ? ' (default)' : ''}</option>)}
      </select>
    );
  };

  return (
    <div className="page">
      <PageHeader title="Repos & triggers"
        sub={<>PuRR covers every git repository while it's running; each appears here on its first commit or push. Choose which flow runs on each trigger: the Global row applies everywhere, a repo row overrides it, and <b>Exclude</b> leaves a repo out entirely.</>} />
      {gh && (
        <div className={`banner inline ${gh.active ? 'info' : 'warn'}`} style={{ marginBottom: 16 }}>
          {gh.active ? <ShieldCheck size={15} /> : <TriangleAlert size={15} />}
          <span>
            {gh.active
              ? <>Commit and push checks are active in every repo: git's global <code>core.hooksPath</code> points at PuRR's hooks, which run each repo's own hooks first. Quitting PuRR turns them off.</>
              : <>Commit and push checks are <b>not</b> active: git's global <code>core.hooksPath</code> is {gh.hooksPath ? <code>{gh.hooksPath}</code> : 'unset'}. Restart the PuRR service to reinstall them.</>}
          </span>
        </div>
      )}
      {error && <ErrorCard>{error}</ErrorCard>}
      {!rows && !error && <SkeletonRows rows={3} cols={[140, 170, 170, 170, 170]} />}
      {rows && (
        <div className="table-wrap">
          <table className="t matrix">
            <thead>
              <tr>
                <th>Scope</th>
                {TRIGGERS.map((t) => {
                  const Icon = triggerIcon(t);
                  return <th key={t}><span className="th-t"><Icon size={13} />{t}</span><span className="explain">{EXPLAIN[t]}</span></th>;
                })}
              </tr>
            </thead>
            <tbody>
              <tr className="global">
                <td><div className="scope"><span className="ic ink"><Globe size={14} /></span><div><div className="cell-main">Global</div><div className="cell-sub">All repos</div></div></div></td>
                {TRIGGERS.map((t) => <td key={t}>{cell(t, null)}</td>)}
              </tr>
              {repos.map((r) => {
                const out = excluded(r.id);
                return (
                  <tr key={r.id} className={out ? 'excluded' : ''}>
                    <td>
                      <div className="scope">
                        <span className="ic"><FolderGit2 size={14} /></span>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className="cell-main">{r.name}{out && <span className="chip" style={{ marginLeft: 8 }}>Excluded</span>}</div>
                          <div className="cell-sub mono" title={r.remoteUrl ?? undefined}>{r.path}</div>
                        </div>
                        <div className="row-actions">
                          <button className="sm ghost" onClick={() => setExcluded(r, !out)} title={out ? 'Follow the global triggers again' : 'Disable every trigger for this repo'}>
                            {out ? <><Undo2 size={13} />Include</> : <><Ban size={13} />Exclude</>}
                          </button>
                          <button className="sm ghost danger" onClick={() => setToRemove(r)} title="Remove from this list" aria-label={`Remove ${r.name}`}><Trash size={13} /></button>
                        </div>
                      </div>
                    </td>
                    {TRIGGERS.map((t) => <td key={t}>{cell(t, r.id)}</td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {repos.length === 0 && rows && <p className="hint" style={{ marginTop: 12 }}>No repos yet: make a commit or push in any repository and it appears here.</p>}
      <div className="card" style={{ marginTop: 16, padding: 12 }}>
        <div className="add-repo">
          <div className="inp">
            <FolderPlus size={14} />
            <input placeholder="Add a repo by path, to watch its open PRs before its first commit or push" value={path}
              onChange={(e) => setPath(e.target.value)} aria-label="Repo path" onKeyDown={(e) => { if (e.key === 'Enter') addRepo(); }} />
          </div>
          <button disabled={busy || !path.trim()} onClick={addRepo}>{busy ? <LoaderCircle size={13} className="spin" /> : <Plus size={14} />}Add repo</button>
        </div>
      </div>
      {toRemove && (
        <Confirm title={`Remove ${toRemove.name}?`} danger confirmLabel="Remove"
          message="It leaves this list and its PRs stop being polled, until its next commit or push through PuRR adds it back. To leave it out for good, use Exclude instead. Past runs are kept."
          onConfirm={() => removeRepo(toRemove)} onCancel={() => setToRemove(null)} />
      )}
    </div>
  );
}
