import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft, CircleAlert, CircleCheck, Copy, LayoutGrid, ListChecks, LoaderCircle, Lock, MousePointerClick, Save, TriangleAlert,
} from 'lucide-react';
import { EmptyState, ErrorCard, TypeTile } from '../components/ui.tsx';
import type { Block, BlockType, Edge, Flow, ValidationIssue } from '../../../src/shared/types.ts';
import { api, errMsg } from '../api.ts';
import { useApp } from '../state.tsx';
import { FlowCanvas } from '../components/FlowCanvas.tsx';
import { Inspector } from '../components/Inspector.tsx';
import { Palette } from '../components/Palette.tsx';
import { RouteMini } from '../components/Station.tsx';
import { useToast } from '../components/Toast.tsx';
import { BLOCK_META, autoLayout, navigate, rid } from '../util.ts';

export function FlowEditorPage({ id }: { id: string }) {
  const { blockTypes, refresh } = useApp();
  const toast = useToast();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [canvasKey, setCanvasKey] = useState(0);
  const validateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const readOnly = !!flow?.isDefault;

  useEffect(() => {
    api.flow(id).then((f) => {
      setFlow(f);
      setBlocks(f.blocks);
      setEdges(f.edges);
      setName(f.name);
      setDescription(f.description);
      setDirty(false);
    }).catch((e) => setLoadError(errMsg(e)));
  }, [id]);

  const runValidate = useCallback(async (b: Block[], e: Edge[], announce = false) => {
    try {
      const res = await api.validate(b, e);
      setIssues(res);
      if (announce) {
        const errs = res.filter((x) => x.level === 'error').length;
        toast(errs ? `${errs} error${errs === 1 ? '' : 's'} found` : res.length ? `${res.length} warning${res.length === 1 ? '' : 's'}, no errors` : 'Flow is valid', errs ? 'error' : 'ok');
      }
    } catch (err) {
      if (announce) toast(errMsg(err), 'error');
    }
  }, [toast]);

  // Debounced auto-validate whenever the graph changes.
  useEffect(() => {
    if (!flow) return;
    if (validateTimer.current) clearTimeout(validateTimer.current);
    validateTimer.current = setTimeout(() => runValidate(blocks, edges), 600);
    return () => { if (validateTimer.current) clearTimeout(validateTimer.current); };
  }, [blocks, edges, flow, runValidate]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const f = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', f);
    return () => window.removeEventListener('beforeunload', f);
  }, [dirty]);

  const change = useCallback((b: Block[], e: Edge[]) => {
    if (readOnly) return;
    setBlocks(b);
    setEdges(e);
    setDirty(true);
  }, [readOnly]);

  const save = useCallback(async () => {
    if (!flow || readOnly) return;
    setSaving(true);
    try {
      const f = await api.saveFlow(flow.id, { name, description, blocks, edges });
      setFlow(f);
      setDirty(false);
      toast('Saved', 'ok');
      refresh();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setSaving(false);
    }
  }, [flow, readOnly, name, description, blocks, edges, toast, refresh]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [save]);

  const duplicate = async () => {
    if (!flow) return;
    try {
      if (dirty && !readOnly) await api.saveFlow(flow.id, { name, description, blocks, edges });
      const copy = await api.duplicateFlow(flow.id, `${name} (copy)`);
      await refresh();
      toast(`Created ${copy.name}`, 'ok');
      navigate(`/flows/${copy.id}`);
    } catch (e) { toast(errMsg(e), 'error'); }
  };

  const addBlock = (type: BlockType) => {
    if (readOnly) return;
    const info = blockTypes.find((t) => t.type === type);
    const sel = blocks.find((b) => b.id === selected);
    const maxX = blocks.reduce((m, b) => Math.max(m, b.position.x), -280);
    const position = sel && info?.maxInputs !== 0
      ? { x: sel.position.x + 280, y: sel.position.y + (blocks.filter((b) => Math.abs(b.position.x - sel.position.x - 280) < 40).length * 110) }
      : { x: maxX + 280, y: 0 };
    const nb: Block = {
      id: `${type}-${rid()}`,
      type,
      label: info?.label ?? BLOCK_META[type].name,
      position,
      config: structuredClone(info?.defaultConfig ?? {}) as unknown as Block['config'],
    };
    const takesInput = info?.maxInputs !== 0;   // scanner/command blocks are sources: never auto-connect into them
    const ne = sel && takesInput && sel.type !== 'output' ? [...edges, { id: `e-${rid()}`, source: sel.id, target: nb.id }] : edges;
    change([...blocks, nb], ne);
    setSelected(nb.id);
  };

  // Preference options save immediately via PATCH (read-only flows only; editable flows use Save).
  const setPreference = async (blockId: string, patch: Record<string, unknown>) => {
    if (!flow) return;
    const before = blocks;
    setBlocks((bs) => bs.map((b) => (b.id === blockId ? { ...b, config: { ...b.config, ...patch } as Block['config'] } : b)));
    try {
      const f = await api.setBlockOptions(flow.id, blockId, patch);
      setFlow(f);
      setBlocks(f.blocks);
      toast('Saved', 'ok');
    } catch (e) {
      setBlocks(before);
      toast(errMsg(e), 'error');
    }
  };

  const layout = () => {
    change(autoLayout(blocks, edges), edges);
    setCanvasKey((k) => k + 1); // re-mount so fitView applies to the new layout
  };

  const issueMap = useMemo(() => {
    const m: Record<string, 'error' | 'warning'> = {};
    for (const i of issues) {
      if (!i.blockId) continue;
      if (i.level === 'error' || !m[i.blockId]) m[i.blockId] = i.level;
    }
    return m;
  }, [issues]);

  if (loadError) return <div className="page"><ErrorCard>{loadError}</ErrorCard></div>;
  if (!flow) {
    return (
      <div className="editor">
        <div className="editor-bar"><div className="skel" style={{ width: 240, height: 16, marginLeft: 8 }} /></div>
        <div />
        <div className="editor-body"><div className="palette" /><div className="canvas" /><div className="inspector" /></div>
      </div>
    );
  }

  const selBlock = blocks.find((b) => b.id === selected) ?? null;
  const errors = issues.filter((i) => i.level === 'error').length;

  return (
    <div className="editor">
      <div className="editor-bar">
        <a className="iconlink" href="#/flows" title="Back to flows" aria-label="Back to flows"><ChevronLeft size={16} /></a>
        <div className="titles">
          <input className="name" value={name} disabled={readOnly} aria-label="Flow name" onChange={(e) => { setName(e.target.value); setDirty(true); }} />
          <input className="desc" placeholder="Add a description" value={description} disabled={readOnly} aria-label="Description"
            onChange={(e) => { setDescription(e.target.value); setDirty(true); }} />
        </div>
        {readOnly && <span className="chip"><Lock />Read-only</span>}
        {dirty && <span className="chip warn" title="Unsaved changes"><span className="dot" />Unsaved</span>}
        {issues.length > 0
          ? <span className={`chip ${errors ? 'danger' : 'warn'}`}>{errors ? <CircleAlert /> : <TriangleAlert />}{errors ? `${errors} error${errors === 1 ? '' : 's'}` : `${issues.length} warning${issues.length === 1 ? '' : 's'}`}</span>
          : <span className="chip ok"><CircleCheck />Valid</span>}
        <span className="spacer" />
        {!readOnly && <button className="ghost" onClick={layout} title="Arrange blocks left to right"><LayoutGrid size={14} />Auto-layout</button>}
        <button className="ghost" onClick={() => runValidate(blocks, edges, true)}><ListChecks size={14} />Validate</button>
        <button className="ghost" onClick={duplicate}><Copy size={14} />Duplicate</button>
        {!readOnly && <>
          <span className="vsep" />
          <button className="primary" disabled={!dirty || saving} onClick={save} title="Save (⌘S)">{saving ? <><LoaderCircle size={13} className="spin" />Saving…</> : <><Save size={13} />Save <kbd>⌘S</kbd></>}</button>
        </>}
      </div>
      <div>
        {readOnly && (
          <div className="banner info">
            <Lock size={14} />
            <span>Default flows are read-only. Duplicate to edit; the Output block's notification and PR-comment preferences can still be changed here.</span>
            <button className="sm primary" onClick={duplicate}><Copy size={12} />Duplicate</button>
          </div>
        )}
        {issues.length > 0 && (
          <div className="issues">
            {issues.map((i, k) => (
              <div key={k} className={i.level} onClick={() => i.blockId && setSelected(i.blockId)}>
                {i.level === 'error' ? <CircleAlert size={13} /> : <TriangleAlert size={13} />}
                <span>{i.blockId ? <b>{blocks.find((b) => b.id === i.blockId)?.label ?? i.blockId}: </b> : null}{i.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="editor-body">
        <Palette onAdd={addBlock} disabled={readOnly} />
        <div className="canvas">
          <FlowCanvas key={canvasKey} blocks={blocks} edges={edges} readOnly={readOnly} selectedId={selected}
            onSelect={setSelected} onChange={change} issues={issueMap}
            onConnectRejected={(m) => toast(m, 'error')} />
        </div>
        {selBlock ? (
          <Inspector block={selBlock} blocks={blocks} edges={edges} readOnly={readOnly}
            issues={issues.filter((i) => i.blockId === selBlock.id)}
            onChange={(b) => change(blocks.map((x) => (x.id === b.id ? b : x)), edges)}
            onPreference={readOnly ? (patch) => setPreference(selBlock.id, patch) : undefined}
            onDelete={() => {
              change(
                blocks.filter((x) => x.id !== selBlock.id).map((x) => {
                  const cfg = x.config as unknown as { forkFrom?: string | null };
                  return cfg.forkFrom === selBlock.id ? { ...x, config: { ...x.config, forkFrom: null } as Block['config'] } : x;
                }),
                edges.filter((e) => e.source !== selBlock.id && e.target !== selBlock.id),
              );
              setSelected(null);
            }} />
        ) : (
          <div className="inspector">
            <div className="ins-head">
              <div className="row1">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="nm">{name || 'Untitled flow'}</div>
                  <div className="ty">{blocks.length} block{blocks.length === 1 ? '' : 's'} · {edges.length} connection{edges.length === 1 ? '' : 's'}</div>
                </div>
              </div>
            </div>
            <div className="ins-body">
              {blocks.length > 0 && <div className="ins-route"><RouteMini blocks={blocks} edges={edges} height={72} /></div>}
              {blocks.length === 0 && !readOnly ? (
                <EmptyState small icon={MousePointerClick} title="Empty flow">Add blocks from the palette on the left. With a block selected, a new block is connected after it.</EmptyState>
              ) : (
                <p className="hint">Select a block to edit it{readOnly ? ' (read-only)' : ''}. {readOnly ? '' : 'Click a palette item to add a block; with a block selected, the new one is connected after it.'}</p>
              )}
              <h3 style={{ marginTop: 20 }}>Legend</h3>
              <div className="legend">
                {(Object.keys(BLOCK_META) as BlockType[]).map((t) => <span key={t}><TypeTile type={t} size="sm" />{BLOCK_META[t].name}</span>)}
              </div>
              <h3 style={{ marginTop: 20 }}>How sessions flow</h3>
              <p className="hint">
                A <b>Context</b> block starts the seed session and fixes the model and tools. A <b>Branch</b> duplicates it once per
                outgoing connection. <b>Prompt</b> and <b>Verify</b> blocks send their prompt to a fork, so every lens reads the
                seed's context from the prompt cache. Scanner and command outputs connected into a Context block reach its prompt
                as <code>{'{{scanner_findings}}'}</code> and <code>{'{{command_outputs}}'}</code>.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
