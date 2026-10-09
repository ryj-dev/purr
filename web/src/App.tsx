import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  Activity, Flag, Gauge, Pause, Settings, Unplug, Workflow, Zap, type LucideIcon,
} from 'lucide-react';
import type { ServerEvent } from '../../src/shared/types.ts';
import { api, useEvents, type BlockTypeInfo } from './api.ts';
import { AppContext } from './state.tsx';
import type { AppState } from '../../src/shared/types.ts';
import { ToastProvider } from './components/Toast.tsx';
import { UsageMeter } from './components/UsageMeter.tsx';
import { ToolchainPopup } from './components/ToolchainPopup.tsx';
import { Logo } from './components/ui.tsx';
import { RunsPage } from './pages/Runs.tsx';
import { RunDetailPage } from './pages/RunDetail.tsx';
import { FlowsPage } from './pages/Flows.tsx';
import { FlowEditorPage } from './pages/FlowEditor.tsx';
import { TriggersPage } from './pages/Triggers.tsx';
import { FindingsPage } from './pages/Findings.tsx';
import { SettingsPage } from './pages/Settings.tsx';

function useHash(): string {
  const [h, setH] = useState(() => window.location.hash.slice(1) || '/runs');
  useEffect(() => {
    const f = () => setH(window.location.hash.slice(1) || '/runs');
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return h;
}

const NAV: { path: string; label: string; icon: LucideIcon; group: string }[] = [
  { path: '/runs', icon: Activity, label: 'Runs', group: 'Review' },
  { path: '/findings', icon: Flag, label: 'Findings', group: 'Review' },
  { path: '/flows', icon: Workflow, label: 'Flows', group: 'Configure' },
  { path: '/triggers', icon: Zap, label: 'Repos & triggers', group: 'Configure' },
  { path: '/settings', icon: Settings, label: 'Settings', group: 'Configure' },
];

export function App() {
  const hash = useHash();
  const [state, setState] = useState<AppState | null>(null);
  const [blockTypes, setBlockTypes] = useState<BlockTypeInfo[]>([]);
  const [reachable, setReachable] = useState(true);
  const [toolchainOpen, setToolchainOpen] = useState(false);
  const [connected, setConnected] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await api.state();
      setState(s);
      setReachable(true);
    } catch {
      setReachable(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    api.blockTypes().then(setBlockTypes).catch(() => {});
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
  }, [refresh]);

  useEvents((e: ServerEvent) => {
    if (e.type === 'usage') setState((s) => (s ? { ...s, usage: e.usage } : s));
    else if (e.type === 'state') refresh();
  }, (c) => {
    setConnected(c);
    if (c) {
      refresh();
      if (blockTypes.length === 0) api.blockTypes().then(setBlockTypes).catch(() => {});
    }
  });

  const seg = hash.split('/').filter(Boolean);
  let page;
  if (seg[0] === 'runs' && seg[1]) page = <RunDetailPage id={decodeURIComponent(seg[1])} />;
  else if (seg[0] === 'flows' && seg[1]) page = <FlowEditorPage key={seg[1]} id={decodeURIComponent(seg[1])} />;
  else if (seg[0] === 'flows') page = <FlowsPage />;
  else if (seg[0] === 'triggers') page = <TriggersPage />;
  else if (seg[0] === 'repos') page = <TriggersPage />;   // merged into Repos & triggers
  else if (seg[0] === 'findings') page = <FindingsPage />;
  else if (seg[0] === 'settings') page = <SettingsPage />;
  else page = <RunsPage />;

  const usage = state?.usage;
  const tools = state?.tools;
  const port = state?.settings.port ?? 7878;
  const fullBleed = seg[0] === 'flows' && !!seg[1];
  const active = `/${seg[0] ?? 'runs'}`;
  const current = NAV.find((n) => n.path === active) ?? NAV[0];

  return (
    <AppContext.Provider value={{ state, blockTypes, refresh, connected }}>
      <ToastProvider>
        <div className="app">
          <aside className="sidebar">
            <div className="brand"><Logo /><span className="name">PuRR</span>{state && <span className="ver">v{state.version}</span>}</div>
            <nav className="nav" aria-label="Main">
              {NAV.map((n, i) => (
                <Fragment key={n.path}>
                  {(i === 0 || NAV[i - 1].group !== n.group) && <div className="nav-label">{n.group}</div>}
                  <a href={`#${n.path}`} className={active === n.path ? 'active' : ''} aria-current={active === n.path ? 'page' : undefined} title={n.label}>
                    <n.icon size={15} strokeWidth={2} />{n.label}
                  </a>
                </Fragment>
              ))}
            </nav>
            <div className="foot">
              {tools && (
                <button type="button" className="toolchain" onClick={() => setToolchainOpen(true)} title="Install tools and sign in">
                  <h3>Toolchain</h3>
                  <ul className="tools">
                    {(['betterleaks', 'zizmor', 'osv', 'hadolint', 'actionlint', 'claude'] as const).map((t) => (
                      <li key={t} className={`tool ${tools[t] ? 'on' : 'off'}`} title={tools[t] ? 'installed' : 'not installed'}><i />{t}</li>
                    ))}
                    <li className={`tool ${tools.gh && tools.ghAuthed ? 'on' : 'off'}`}
                      title={!tools.gh ? 'gh not installed' : tools.ghAuthed ? 'gh authenticated' : 'gh not authenticated: PR detection and comments disabled'}><i />gh</li>
                  </ul>
                </button>
              )}
              {toolchainOpen && <ToolchainPopup onClose={() => setToolchainOpen(false)} />}
              <div className={`conn ${connected ? 'on' : ''}`} title={connected ? 'Receiving live updates from the PuRR service' : 'Not connected to the live event stream'}>
                <i />{connected ? 'Live' : 'Not live'}
              </div>
            </div>
          </aside>
          <div className="content">
          <header className="header">
            {current && <span className="crumb">{current.label}</span>}
            <span className="spacer" />
            {usage && <>
              <UsageMeter label="5h" value={usage.fiveHour} resetsAt={usage.fiveHourResetsAt} />
              <UsageMeter label="7d" value={usage.sevenDay} resetsAt={usage.sevenDayResetsAt} />
              <span className="sep" />
              <span className="sessions" title="Claude sessions started today vs the daily cap">
                <b>{usage.sessionsToday}</b>/{state?.settings.dailySessionCap ?? '?'} sessions today
              </span>
            </>}
          </header>
          <main className={`main ${fullBleed ? 'bleed' : ''}`}>
            {state?.settings.reviewsPaused && (
              <div className="banner warn"><Pause size={14} />Background reviews are paused. Commit and push checks still run. Resume from Settings or the menu bar icon.</div>
            )}
            {!reachable && (
              <div className="banner danger">
                <Unplug size={14} />
                <span>{window.purrDesktop
                  ? <>The PuRR service isn't responding. It restarts on its own; if it doesn't, use the menu bar icon → <b>Restart service</b>. Retrying…</>
                  : <>Daemon not reachable at 127.0.0.1:{port}. Start it with <code>purr daemon</code>. Retrying…</>}</span>
              </div>
            )}
            {usage?.pausedUntil && Date.parse(usage.pausedUntil) > Date.now() && (
              <div className="banner warn">
                <Gauge size={14} />
                <span>Usage limit reached: Claude blocks are paused until {new Date(usage.pausedUntil).toLocaleString()}. Scanner-only flows still run.</span>
              </div>
            )}
            {fullBleed ? <div style={{ flex: 1, minHeight: 0 }}>{page}</div> : page}
          </main>
          </div>
        </div>
      </ToastProvider>
    </AppContext.Provider>
  );
}
