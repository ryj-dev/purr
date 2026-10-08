import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { Boxes, Copy, Eye, Lock, Pencil, Plus, Trash } from 'lucide-react';
import { ErrorCard, PageHeader, triggerIcon } from '../components/ui.tsx';
import type { Flow, FlowMeta, TriggerAssignment } from '../../../src/shared/types.ts';
import { RouteMini } from '../components/Station.tsx';
import { api, errMsg } from '../api.ts';
import { useApp } from '../state.tsx';
import { Confirm, Modal } from '../components/Modal.tsx';
import { useToast } from '../components/Toast.tsx';
import { navigate, timeAgo } from '../util.ts';

function NewFlowModal({ flows, onClose }: { flows: FlowMeta[]; onClose: () => void }) {
  const toast = useToast();
  const { refresh } = useApp();
  const [name, setName] = useState('My flow');
  const [from, setFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const f = from ? await api.duplicateFlow(from, name) : await api.createFlow({ name, description: '', blocks: [], edges: [] });
      await refresh();
      onClose();
      navigate(`/flows/${f.id}`);
    } catch (e) {
      toast(errMsg(e), 'error');
      setBusy(false);
    }
  };
  return (
    <Modal title="New flow" onClose={onClose} actions={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={!name.trim() || busy} onClick={create}>Create</button>
    </>}>
      <label className="field"><span>Name</span><input value={name} autoFocus onChange={(e) => setName(e.target.value)} /></label>
      <label className="field">
        <span>Start from</span>
        <select value={from} onChange={(e) => setFrom(e.target.value)}>
          <option value="">Blank</option>
          {flows.map((f) => <option key={f.id} value={f.id}>Copy of {f.name}{f.isDefault ? ' (default)' : ''}</option>)}
        </select>
      </label>
    </Modal>
  );
}

export function FlowsPage() {
  const toast = useToast();
  const { refresh } = useApp();
  const [flows, setFlows] = useState<FlowMeta[] | null>(null);
  const [triggers, setTriggers] = useState<TriggerAssignment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [toDelete, setToDelete] = useState<FlowMeta | null>(null);
  const [graphs, setGraphs] = useState<Record<string, Flow>>({});

  const load = useCallback(async () => {
    try {
      const [f, t] = await Promise.all([api.flows(), api.triggers()]);
      setFlows(f);
      setTriggers(t);
      setError(null);
      // each card draws its flow's route; the list endpoint only carries block counts
      Promise.all(f.map((m) => api.flow(m.id).catch(() => null))).then((full) => {
        const g: Record<string, Flow> = {};
        for (const x of full) if (x) g[x.id] = x;
        setGraphs(g);
      });
    } catch (e) { setError(errMsg(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const duplicate = async (f: FlowMeta) => {
    try {
      const copy = await api.duplicateFlow(f.id, `${f.name} (copy)`);
      await refresh();
      toast(`Created ${copy.name}`, 'ok');
      navigate(`/flows/${copy.id}`);
    } catch (e) { toast(errMsg(e), 'error'); }
  };
  const del = async (f: FlowMeta) => {
    setToDelete(null);
    try {
      await api.deleteFlow(f.id);
      toast(`Deleted ${f.name}`, 'ok');
      await Promise.all([load(), refresh()]);
    } catch (e) { toast(errMsg(e), 'error'); }
  };

  const usedBy = (id: string) => triggers.filter((t) => t.flowId === id);
  const sorted = (flows ?? []).slice().sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));

  return (
    <div className="page">
      <PageHeader title="Flows"
        sub={<>A flow is a graph of scanners, Claude sessions and gates. Assign flows to triggers on the <a href="#/triggers">Triggers</a> page.</>}
        actions={<button className="primary" onClick={() => setShowNew(true)}><Plus size={14} />New flow</button>} />
      {error && <ErrorCard>{error}</ErrorCard>}
      {!flows && !error && (
        <div className="cards">{Array.from({ length: 3 }, (_, i) => <div key={i} className="card skel" style={{ height: 168 }} />)}</div>
      )}
      <div className="cards">
        {sorted.map((f) => {
          const uses = usedBy(f.id);
          const stop = (fn: () => void) => (e: MouseEvent) => { e.stopPropagation(); fn(); };
          return (
            <div key={f.id} className={`card flow-card ${f.isDefault ? 'default' : ''}`} onClick={() => navigate(`/flows/${f.id}`)}>
              <div className="fc-body">
                <div className="fc-top">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="fc-name"><a href={`#/flows/${f.id}`} onClick={(e) => e.stopPropagation()} style={{ color: 'inherit' }}>{f.name}</a></div>
                    <div className="hint">{f.isDefault ? <><Lock size={11} />Default · read-only</> : `Edited ${timeAgo(f.updatedAt)}`}</div>
                  </div>
                </div>
                <div className="fc-route">{graphs[f.id] ? <RouteMini blocks={graphs[f.id].blocks} edges={graphs[f.id].edges} height={84} /> : <div className="skel" style={{ width: 160, height: 8 }} />}</div>
                <div className="fc-desc">{f.description || <span className="muted">No description.</span>}</div>
                <div className="fc-meta">
                  <span className="chip"><Boxes />{f.blockCount} block{f.blockCount === 1 ? '' : 's'}</span>
                  {uses.map((u, i) => {
                    const Icon = triggerIcon(u.trigger);
                    return <span key={i} className="chip accent"><Icon />{u.trigger}{u.repoId ? ' (repo)' : ''}</span>;
                  })}
                </div>
              </div>
              <div className="fc-foot">
                <button className="sm" onClick={stop(() => navigate(`/flows/${f.id}`))}>{f.isDefault ? <><Eye size={13} />View</> : <><Pencil size={13} />Edit</>}</button>
                <button className="sm" onClick={stop(() => duplicate(f))}><Copy size={13} />Duplicate</button>
                <span className="spacer" />
                {!f.isDefault && <button className="sm ghost danger icon" title="Delete" aria-label={`Delete ${f.name}`} onClick={stop(() => setToDelete(f))}><Trash size={13} /></button>}
              </div>
            </div>
          );
        })}
      </div>
      {showNew && flows && <NewFlowModal flows={flows} onClose={() => setShowNew(false)} />}
      {toDelete && (
        <Confirm title={`Delete ${toDelete.name}?`} danger confirmLabel="Delete"
          message={usedBy(toDelete.id).length
            ? `It is assigned to ${usedBy(toDelete.id).map((u) => u.trigger).join(', ')}. Those triggers fall back to the default flow.`
            : 'This cannot be undone.'}
          onConfirm={() => del(toDelete)} onCancel={() => setToDelete(null)} />
      )}
    </div>
  );
}
