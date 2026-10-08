import { useCallback, useEffect, useRef, useState } from 'react';
import type { Settings } from '../../../src/shared/types.ts';
import { api, errMsg } from '../api.ts';
import { useApp } from '../state.tsx';
import { useToast } from '../components/Toast.tsx';
import { UsageMeter } from '../components/UsageMeter.tsx';
import { fmtTime } from '../util.ts';
import { PageHeader } from '../components/ui.tsx';
import { numFieldHandlers, syncValue } from '../numText.ts';
import { cliAction } from '../../../src/shared/cliLink.ts';
import { Check, Save, SquareTerminal } from 'lucide-react';

function DesktopCard() {
  const toast = useToast();
  const bridge = window.purrDesktop!;
  const [login, setLogin] = useState<boolean | null>(null);
  useEffect(() => { bridge.getLoginItem().then(setLogin, () => setLogin(null)); }, [bridge]);
  const toggle = async (on: boolean) => {
    try { setLogin(await bridge.setLoginItem(on)); } catch (e) { toast(errMsg(e), 'error'); }
  };
  const [cliState, setCliState] = useState<Awaited<ReturnType<PurrDesktop['cliStatus']>> | null>(null);
  const loadCli = useCallback(() => { bridge.cliStatus?.().then(setCliState, () => setCliState(null)); }, [bridge]);
  useEffect(() => {
    loadCli();
    // installed from the tray, or changed in a terminal, while this page was open
    window.addEventListener('focus', loadCli);
    return () => window.removeEventListener('focus', loadCli);
  }, [loadCli]);
  const act = cliState ? cliAction(cliState) : null;
  const cli = async () => {
    const r = await bridge.installCli();
    toast(r.message, r.ok ? 'ok' : 'error');
    loadCli();
  };
  return (
    <div className="card">
      <div className="card-head">
        <div><h2>App</h2><div className="sub">PuRR.app {bridge.version}</div></div>
      </div>
      <label className="set-row" style={{ cursor: 'pointer' }}>
        <div>
          <div className="t">Start PuRR at login</div>
          <div className="d">Runs in the menu bar; closing this window keeps reviews running.</div>
        </div>
        <input type="checkbox" className="switch" checked={!!login} disabled={login === null} onChange={(e) => toggle(e.target.checked)} />
      </label>
      <div className="set-row">
        <div>
          <div className="t">Command line tool</div>
          <div className="d">Links <code>~/.local/bin/purr</code> to this app, so you can use <code>purr run</code> and <code>purr hooks</code> from a terminal.
            {act?.note && <> {act.note}</>}</div>
        </div>
        {act?.kind === 'done' ? (
          <span className="chip ok" title={`${cliState!.link} → ${cliState!.target}`}><Check size={12} />{act.button}</span>
        ) : act?.kind === 'blocked' ? (
          <span className="chip warn" title={act.note}>{act.button}</span>
        ) : (
          <button onClick={cli}><SquareTerminal size={13} />{act?.button ?? 'Install purr'}</button>
        )}
      </div>
    </div>
  );
}

/**
 * A number setting edited as text: clearing the box to type a new value leaves it empty (no 0 filled in, so 4 -> 6
 * doesn't become 06). Leaving it empty, or not a number, puts the last value back when you leave the box.
 */
function NumField({ label, hint, value, onChange }: { label: string; hint?: string; value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  const memo = useRef({ before: null as number | null, saved: null as number | null }).current;   // kept across renders, for the edit in progress
  const box = numFieldHandlers(() => ({ text, value }), setText, onChange, memo);
  const last = useRef<number | undefined>(undefined);
  useEffect(() => { last.current = syncValue(last.current, value, box); });
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" min={0} value={text} onChange={(e) => box.type(e.target.value)} onFocus={box.focus} onBlur={box.blur} />
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function SettingsPage() {
  const { state, refresh } = useApp();
  const toast = useToast();
  const [s, setS] = useState<Settings | null>(null);
  const [extra, setExtra] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (state && !dirty) { setS(state.settings); setExtra(state.settings.claudeExtraArgs.join('\n')); }
  }, [state, dirty]);

  if (!s || !state) {
    return (
      <div className="page settings">
        <PageHeader title="Settings" />
        <div className="card skel" style={{ height: 200 }} />
        <div className="card skel" style={{ height: 320 }} />
      </div>
    );
  }
  const u = state.usage;
  const upd = (p: Partial<Settings>) => { setS({ ...s, ...p }); setDirty(true); };
  const num = (k: keyof Settings, label: string, hint?: string) => (
    <NumField label={label} hint={hint} value={s[k] as number} onChange={(v) => upd({ [k]: v } as Partial<Settings>)} />
  );
  const save = async () => {
    try {
      const next = await api.saveSettings({ ...s, claudeExtraArgs: extra.split('\n').map((x) => x.trim()).filter(Boolean) });
      setS(next);
      setDirty(false);
      toast(next.port !== state.settings.port ? 'Saved. Restart the daemon for the new port.' : 'Saved', 'ok');
      refresh();
    } catch (e) { toast(errMsg(e), 'error'); }
  };

  return (
    <div className="page settings">
      <PageHeader title="Settings" sub="How the PuRR service runs Claude and watches your repos."
        actions={<>
          {dirty && <span className="chip warn"><span className="dot" />Unsaved</span>}
          <button className="primary" disabled={!dirty} onClick={save}><Save size={13} />Save</button>
        </>} />
      <div className="card">
        <div className="card-head">
          <div><h2>Claude usage</h2><div className="sub">Read from the rate-limit event Claude Code prints after each session; PuRR never reads your credentials.</div></div>
        </div>
        <div className="stat-row">
          <UsageMeter large label="5-hour window" value={u.fiveHour} resetsAt={u.fiveHourResetsAt} />
          <UsageMeter large label="7-day window" value={u.sevenDay} resetsAt={u.sevenDayResetsAt} />
        </div>
        <div className="kv-grid">
          <div><div className="k">Sessions today</div><div className="v">{u.sessionsToday} of {state.settings.dailySessionCap}</div></div>
          <div><div className="k">Paused until</div><div className="v">{u.pausedUntil ? fmtTime(u.pausedUntil) : 'Not paused'}</div></div>
          <div><div className="k">Last reading</div><div className="v">{fmtTime(u.updatedAt)}</div></div>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <div><h2>Service</h2><div className="sub">The background daemon that runs flows.</div></div>
        </div>
        <div className="grid2">
          <label className="field">
            <span>Claude binary</span>
            <input value={s.claudeBin} onChange={(e) => upd({ claudeBin: e.target.value })} className="mono" />
            <span className="hint">The unmodified Claude Code CLI, signed in with your own account.</span>
          </label>
          {num('port', 'Port', 'Restart the daemon after changing.')}
          {num('maxConcurrentClaude', 'Max concurrent Claude sessions')}
          {num('dailySessionCap', 'Daily session cap', 'Claude blocks fail once reached; scanners keep running.')}
          {num('pollIntervalSec', 'PR poll interval (seconds)')}
          {num('debounceSec', 'Post-push debounce (seconds)', 'A newer push within this window replaces the queued run.')}
        </div>
        <label className="field">
          <span>Extra claude arguments (one per line)</span>
          <textarea rows={4} value={extra} onChange={(e) => { setExtra(e.target.value); setDirty(true); }} spellCheck={false} />
        </label>
        <label className="set-row" style={{ cursor: 'pointer' }}>
          <div><div className="t">Desktop notifications</div><div className="d">Show desktop notifications for review results.</div></div>
          <input type="checkbox" className="switch" checked={s.notifications} onChange={(e) => upd({ notifications: e.target.checked })} />
        </label>
        <label className="set-row" style={{ cursor: 'pointer' }}>
          <div><div className="t">Pause background reviews</div><div className="d">Post-push reviews don't start; commit/push checks and Run now still work.</div></div>
          <input type="checkbox" className="switch" checked={s.reviewsPaused} onChange={(e) => upd({ reviewsPaused: e.target.checked })} />
        </label>
        <label className="set-row" style={{ cursor: 'pointer' }}>
          <div><div className="t">Review only pushes to open PRs</div><div className="d">Pushes to main or to branches without a PR don't spend Claude quota; a branch is reviewed once its PR opens. Needs gh; without it every push is reviewed.</div></div>
          <input type="checkbox" className="switch" checked={s.postPushPrsOnly} onChange={(e) => upd({ postPushPrsOnly: e.target.checked })} />
        </label>
      </div>
      {window.purrDesktop && <DesktopCard />}
    </div>
  );
}
