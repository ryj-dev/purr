import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BlockRun, BlockStatus, RunDetail, SessionUse } from '../../../src/shared/types.ts';
import { api, errMsg, useEvents } from '../api.ts';
import { useApp } from '../state.tsx';
import { FlowCanvas } from '../components/FlowCanvas.tsx';
import { FindingList } from '../components/FindingList.tsx';
import { StationMark } from '../components/Station.tsx';
import { Counts, StatusChip } from '../components/StatusChip.tsx';
import { useToast } from '../components/Toast.tsx';
import { EmptyState, ErrorCard, SevBadge, TriggerLabel, TypeTile } from '../components/ui.tsx';
import {
  Boxes, ChevronLeft, CircleCheck, Clock, Workflow, CircleDashed, CircleHelp, CircleStop, Copy, FolderGit2, GitBranch, GitCommitHorizontal,
  LoaderCircle, MousePointerClick, OctagonAlert, Terminal, Timer, X,
} from 'lucide-react';
import { BLOCK_META, durationBetween, fmtDuration, fmtNum, fmtTime, shortSha } from '../util.ts';

function Session({ s, cwd }: { s: SessionUse; cwd: string | null }) {
  const toast = useToast();
  // sessions are stored per working directory, so resume from the checkout the run used
  const cmd = `${cwd ? `cd '${cwd}' && ` : ''}claude --resume ${s.sessionId}`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(cmd); toast('Copied resume command', 'ok'); } catch { toast(cmd, 'info'); }
  };
  const hit = s.usage.cacheRead > 0;
  return (
    <div className="session">
      <div className="sid">
        <Terminal size={13} style={{ color: 'var(--text-3)' }} />
        <code title={s.sessionId}>{s.sessionId}</code>
        <button className="sm" onClick={copy} title={cmd}><Copy size={12} />Copy resume</button>
      </div>
      <div className="sinfo">{s.model} · {s.turns} turn{s.turns === 1 ? '' : 's'} · {fmtDuration(s.durationMs)}{s.forkedFrom ? ` · fork of ${s.forkedFrom.slice(0, 8)}` : ' · new session'}</div>
      <div className="usage-grid">
        <div title="Uncached input tokens"><div className="k">In</div><div className="v">{fmtNum(s.usage.input)}</div></div>
        <div title="Tokens written to the prompt cache"><div className="k">Cache +</div><div className="v">{fmtNum(s.usage.cacheWrite)}</div></div>
        <div title="Tokens read from the prompt cache"><div className="k">Cache ↺</div><div className={`v ${hit ? 'hit' : ''}`}>{fmtNum(s.usage.cacheRead)}</div></div>
        <div title="Output tokens"><div className="k">Out</div><div className="v">{fmtNum(s.usage.output)}</div></div>
      </div>
      {s.error && <div className="err-text" style={{ marginTop: 6 }}>{s.error}</div>}
    </div>
  );
}

function BlockPanel({ detail, blockId, onClose }: { detail: RunDetail; blockId: string; onClose: () => void }) {
  const block = detail.run.flow.blocks.find((b) => b.id === blockId);
  const br: BlockRun | undefined = detail.blocks.find((b) => b.blockId === blockId);
  if (!block) return <div className="side"><EmptyState small icon={CircleHelp} title="Unknown block" /></div>;
  const out = br?.output;
  const meta = BLOCK_META[block.type];
  return (
    <div className="side" key={blockId}>
      <div className="side-head">
        <div className="row1">
          <TypeTile type={block.type} size="lg" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="nm">{block.label}</div>
            <div className="hint">{meta.name}{br ? ` · ${fmtDuration(durationBetween(br.startedAt, br.finishedAt))}` : ''}</div>
          </div>
          {br && <StatusChip status={br.status} />}
          <button className="ghost icon sm" onClick={onClose} title="Close (back to the full map)" aria-label="Close"><X size={14} /></button>
        </div>
      </div>
      <div className="side-body">
        {br?.startedAt && <div className="hint" style={{ marginBottom: 12 }}>Started {fmtTime(br.startedAt)}</div>}
        {!br && <EmptyState small icon={CircleDashed} title="Not started">This block hasn't run yet.</EmptyState>}
        {br?.error && <div className="sec"><h3>Error</h3><pre className="out err-text">{br.error}</pre></div>}
        {out?.pass !== undefined && (
          <div className="sec row"><h3 style={{ margin: 0 }}>Gate</h3>{out.pass ? <span className="status ok"><CircleCheck size={13} />pass</span> : <span className="status warn"><OctagonAlert size={13} />blocked</span>}</div>
        )}
        {out?.scanner && (
          <div className="sec">
            <h3>Scanner</h3>
            <dl className="kv">
              <dt>State</dt><dd>{out.scanner.state}</dd>
              {out.scanner.hits != null && <><dt>Hits</dt><dd>{out.scanner.hits}</dd></>}
              <dt>Time</dt><dd className="mono">{out.scanner.secs}s</dd>
              {out.scanner.error && <><dt>Error</dt><dd className="err-text">{out.scanner.error}</dd></>}
            </dl>
          </div>
        )}
        {out?.sessions && out.sessions.length > 0 && (
          <div className="sec">
            <h3>Sessions · {out.sessions.length}</h3>
            {out.sessions.map((s) => <Session key={s.sessionId + s.durationMs} s={s} cwd={detail.run.workdir ?? detail.run.repoPath} />)}
          </div>
        )}
        {out?.findings && (
          <div className="sec">
            <h3>Findings out · {out.findings.length}</h3>
            {out.findings.length === 0 ? <div className="hint">None.</div> : out.findings.map((f) => (
              <div key={f.id} className="out-finding">
                <SevBadge sev={f.severity} />
                <div className="ft">
                  <div>{f.title}</div>
                  <div className="loc">{f.file}{f.line != null ? `:${f.line}` : ''}</div>
                </div>
              </div>
            ))}
          </div>
        )}
        {out?.text && <div className="sec"><h3>Text</h3><pre className="out">{out.text}</pre></div>}
        {out?.log && out.log.length > 0 && <div className="sec"><h3>Log</h3><pre className="out">{out.log.join('\n')}</pre></div>}
      </div>
    </div>
  );
}

export function RunDetailPage({ id }: { id: string }) {
  const { refresh } = useApp();
  const toast = useToast();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [, tick] = useState(0);

  const load = useCallback(async () => {
    try { setDetail(await api.run(id)); setError(null); } catch (e) { setError(errMsg(e)); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);

  useEvents((e) => {
    if (e.type === 'run' && e.run.id === id) {
      // live events carry the run without its flow snapshot (kept small); keep the one we loaded
      setDetail((d) => (d ? { ...d, run: { ...e.run, flow: e.run.flow.blocks.length ? e.run.flow : d.run.flow } } : d));
      if (['passed', 'blocked', 'failed', 'cancelled', 'superseded'].includes(e.run.status)) load();
    } else if (e.type === 'block' && e.runId === id) {
      setDetail((d) => {
        if (!d) return d;
        const i = d.blocks.findIndex((b) => b.blockId === e.block.blockId);
        const blocks = d.blocks.slice();
        if (i === -1) blocks.push(e.block); else blocks[i] = e.block;
        return { ...d, blocks };
      });
    }
  }, (c) => { if (c) load(); });

  const statuses = useMemo(() => {
    const m: Record<string, BlockStatus> = {};
    for (const b of detail?.run.flow.blocks ?? []) m[b.id] = 'pending';
    for (const b of detail?.blocks ?? []) m[b.blockId] = b.status;
    return m;
  }, [detail]);
  const notes = useMemo(() => {
    const m: Record<string, string> = {};
    for (const b of detail?.blocks ?? []) {
      const parts: string[] = [];
      if (b.output?.findings) parts.push(`${b.output.findings.length} finding${b.output.findings.length === 1 ? '' : 's'}`);
      if (b.output?.sessions?.length) parts.push(`${b.output.sessions.length} session${b.output.sessions.length === 1 ? '' : 's'}`);
      if (b.output?.pass === false) parts.push('blocked');
      if (b.status === 'running' && b.startedAt) parts.push(fmtDuration(durationBetween(b.startedAt, null)));
      if (parts.length) m[b.blockId] = parts.join(' · ');
    }
    return m;
  }, [detail]);

  const cancel = async () => {
    try { await api.cancelRun(id); toast('Cancelling…', 'info'); } catch (e) { toast(errMsg(e), 'error'); }
  };

  if (error) return <div className="page"><ErrorCard>{error}</ErrorCard></div>;
  if (!detail) {
    return (
      <div className="page">
        <div className="skel" style={{ width: 80, marginBottom: 14 }} />
        <div className="skel" style={{ width: 280, height: 22, marginBottom: 12 }} />
        <div className="skel" style={{ width: 420, marginBottom: 22 }} />
        <div className="run-layout"><div className="run-graph skel" style={{ borderRadius: 12 }} /><div className="side skel" style={{ borderRadius: 12 }} /></div>
      </div>
    );
  }
  const r = detail.run;
  const live = r.status === 'running' || r.status === 'queued';
  const done = detail.blocks.filter((b) => b.status === 'done').length;

  return (
    <div className="page wide">
      <div className="run-head">
        <a className="back" href="#/runs"><ChevronLeft size={14} />Runs</a>
        <div className="run-title">
          <h1>{r.flowName}</h1>
          <StatusChip status={r.status} />
          <span className="spacer" style={{ flex: 1 }} />
          <Counts counts={r.counts} />
          {live && <button className="danger" onClick={cancel}><CircleStop size={13} />Cancel</button>}
        </div>
        <div className="run-meta">
          <span><FolderGit2 />{r.repoPath.split('/').pop()}</span>
          <span className="mono"><GitBranch />{r.branch ?? 'detached'}</span>
          <span className="mono" title={r.mode === 'staged' ? 'Staged changes' : `${r.baseSha ?? ''}…${r.headSha ?? ''}`}><GitCommitHorizontal />{r.mode === 'staged' ? 'staged' : `${shortSha(r.baseSha)}…${shortSha(r.headSha)}`}</span>
          {r.pr && <a href={r.pr.url} target="_blank" rel="noreferrer">#{r.pr.number} {r.pr.title}</a>}
          <TriggerLabel trigger={r.trigger} />
          <span title={`Queued ${fmtTime(r.queuedAt)} · finished ${fmtTime(r.finishedAt)}`}><Clock />{fmtTime(r.startedAt ?? r.queuedAt)}</span>
          <span><Timer />{fmtDuration(durationBetween(r.startedAt, r.finishedAt))}</span>
          <span><Boxes />{done}/{r.flow.blocks.length} blocks done</span>
          <a className="meta-link" href={`#/flows/${r.flowId}`}><Workflow />Open flow</a>
        </div>
        {r.error && <div className="error-card run-error"><OctagonAlert size={15} /><pre>{r.error}</pre></div>}
      </div>
      <div className={`run-layout ${selected ? 'has-side' : ''}`}>
        <div className="run-graph">
          <FlowCanvas blocks={r.flow.blocks} edges={r.flow.edges} readOnly selectedId={selected} onSelect={setSelected}
            statuses={statuses} statusNotes={notes} minimap={false} />
          {!selected && <div className="map-hint"><MousePointerClick size={13} />Click a block for its output, sessions and log</div>}
          <div className="map-key" aria-label="Key">
            {(['done', 'running', 'pending', 'failed'] as const).map((s) => <span key={s}><StationMark status={s} size={12} />{s}</span>)}
          </div>
        </div>
        {selected && <BlockPanel detail={detail} blockId={selected} onClose={() => setSelected(null)} />}
      </div>
      <div className="section-head">
        <h2>Findings</h2>
        {detail.findings.length > 0 && <span className="chip">{detail.findings.length}</span>}
      </div>
      {live && detail.findings.length === 0
        ? <div className="card" style={{ padding: 0 }}><EmptyState icon={LoaderCircle} title="Review in progress">Findings appear when the run finishes.</EmptyState></div>
        : <FindingList findings={detail.findings} blocks={r.flow.blocks} repoId={r.repoId} onChanged={refresh} />}
    </div>
  );
}
