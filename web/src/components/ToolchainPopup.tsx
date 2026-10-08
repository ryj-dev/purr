// The Toolchain popup (opened from the sidebar): each tool PuRR uses, with Install, and for claude and gh, Sign in.
// Installs run on the service (src/server/toolchain.ts); signing in and installing Homebrew happen in Terminal, so
// while the popup is open it keeps checking and updates when they're done.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Download, LoaderCircle, LogIn, Plus, RotateCw, Terminal } from 'lucide-react';
import type { ToolStatus, Toolchain } from '../../../src/shared/types.ts';
import { api, errMsg } from '../api.ts';
import { Modal } from './Modal.tsx';
import { useToast } from './Toast.tsx';

const SOURCE: Record<NonNullable<ToolStatus['source']>, string> = {
  homebrew: 'Homebrew', 'claude-installer': 'Claude Code installer', other: 'on PATH',
};

export function ToolchainPopup({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<Toolchain | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** something is happening in Terminal: re-read sign-ins without the service's cache until it shows up */
  const [waiting, setWaiting] = useState<{ what: string; done: (d: Toolchain) => boolean; until: number } | null>(null);
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;

  const load = useCallback(async () => {
    try { setData(await api.toolchain(!!waitingRef.current)); setError(null); } catch (e) { setError(errMsg(e)); }
  }, []);

  const busy = !!data?.tools.some((t) => t.job?.state === 'running');
  useEffect(() => {
    load();
    const t = setInterval(load, busy ? 1200 : waiting ? 2500 : 5000);
    return () => clearInterval(t);
  }, [load, busy, waiting]);
  useEffect(() => {
    if (waiting && data && (waiting.done(data) || Date.now() > waiting.until)) setWaiting(null);
  }, [data, waiting]);

  const inTerminal = async (what: string, call: () => Promise<unknown>, done: (d: Toolchain) => boolean) => {
    try {
      await call();
      setWaiting({ what, done, until: Date.now() + 5 * 60_000 });
      toast(`Finish ${what} in Terminal. This updates when it's done.`, 'info');
    } catch (e) { toast(errMsg(e), 'error'); }
  };
  const signIn = (t: ToolStatus) => {
    // done once signed in and the account list changed; signing in again as a listed gh account changes nothing,
    // so that wait can be dismissed (or ends by itself after five minutes)
    const before = [...(t.auth?.accounts ?? [])].sort().join('\n');
    inTerminal(`signing in to ${t.name}`, () => api.signIn(t.name as 'claude' | 'gh'), (d) => {
      const now = d.tools.find((x) => x.name === t.name)?.auth;
      return !!now?.signedIn && [...now.accounts].sort().join('\n') !== before;
    });
  };
  const install = async (t: ToolStatus) => {
    try { await api.installTool(t.name); load(); } catch (e) { toast(errMsg(e), 'error'); }
  };

  const brew = data?.homebrew.installed ?? true;
  const installable = data?.tools.filter((t) => !t.installed && t.job?.state !== 'running' && brew) ?? [];
  const [queueing, setQueueing] = useState(false);
  const installMissing = async () => {
    setQueueing(true);
    try { await api.installMissingTools(); await load(); } catch (e) { toast(errMsg(e), 'error'); } finally { setQueueing(false); }
  };

  return (
    <Modal wide title="Toolchain" onClose={onClose} actions={<>
      <button onClick={onClose}>Close</button>
      <button className="primary" disabled={!installable.length || queueing} onClick={installMissing}>
        <Download size={14} />{installable.length ? `Install missing (${installable.length})` : 'All installed'}
      </button>
    </>}>
      <p className="share-hint">The tools PuRR runs. Scanners check every commit and push; claude runs the reviews; gh finds your PRs and comments on them.</p>
      {error && <div className="err-text" style={{ marginBottom: 8 }}>{error}</div>}
      {data && !data.homebrew.installed && data.tools.some((t) => !t.installed) && (
        <div className="tc-brew">
          <div>
            <b>Homebrew isn't installed.</b> PuRR installs these tools with it. Its installer asks for your Mac's password, so it runs in Terminal.
          </div>
          <button className="sm" onClick={() => inTerminal('installing Homebrew', api.installHomebrew, (d) => d.homebrew.installed)}><Terminal size={13} />Install Homebrew</button>
        </div>
      )}
      {!data && !error && <div className="hint">Checking…</div>}
      {data && (
        <ul className="tc-list">
          {data.tools.map((t) => <ToolRow key={t.name} t={t} brew={brew} onInstall={() => install(t)}
            onSignIn={() => signIn(t)} />)}
        </ul>
      )}
      {waiting && (
        <div className="hint tc-waiting">
          <LoaderCircle size={12} className="spin" />Waiting for {waiting.what} in Terminal…
          <button className="sm ghost" onClick={() => setWaiting(null)}>Done</button>
        </div>
      )}
    </Modal>
  );
}

function ToolRow({ t, brew, onInstall, onSignIn }: { t: ToolStatus; brew: boolean; onInstall: () => void; onSignIn: () => void }) {
  const running = t.job?.state === 'running';
  const failed = t.job?.state === 'failed';
  const needsBrew = !t.installed && !brew;
  const ok = t.installed && (!t.auth || t.auth.signedIn);

  let action;
  if (running) action = <button className="sm" disabled><LoaderCircle size={13} className="spin" />{t.job!.step === 'Queued' ? 'Queued' : 'Installing'}</button>;
  else if (!t.installed) {
    action = (
      <button className="sm" disabled={needsBrew} onClick={onInstall} title={needsBrew ? 'Install Homebrew first' : t.name === 'claude' ? 'brew install --cask claude-code' : `brew install ${t.name}`}>
        {failed ? <RotateCw size={13} /> : <Download size={13} />}{failed ? 'Retry' : 'Install'}
      </button>
    );
  } else if (t.auth && !t.auth.signedIn) action = <button className="sm" onClick={onSignIn}><LogIn size={13} />Sign in</button>;
  else if (t.name === 'gh') action = <button className="sm" onClick={onSignIn} title="Sign in to another GitHub account"><Plus size={13} />Add account</button>;
  else action = <span className="tc-done"><Check size={13} />{t.auth ? 'Signed in' : 'Installed'}</span>;

  return (
    <li className={`tc-row ${ok ? 'on' : 'off'}`}>
      <i className="tc-dot" />
      <div className="tc-main">
        <div className="tc-name">
          <span>{t.name}</span>
          {t.version && <span className="tc-ver">{t.version}</span>}
          {t.source && <span className="tc-src">{SOURCE[t.source]}</span>}
        </div>
        <div className="tc-purpose">{t.purpose}</div>
        {t.auth?.signedIn && (
          <div className="tc-accounts">
            {t.name === 'gh' && <span className="tc-signed"><Check size={11} />Signed in as</span>}
            {t.auth.accounts.map((a) => <code key={a}>{a}</code>)}
            {t.auth.detail && <span className="tc-src">{t.auth.detail}</span>}
          </div>
        )}
        {running && t.job!.step !== 'Queued' && <div className="tc-step">{t.job!.step}</div>}
        {failed && <div className="tc-step err-text">{t.job!.error}</div>}
        {needsBrew && <div className="tc-step">Needs Homebrew</div>}
      </div>
      <div className="tc-action">{action}</div>
    </li>
  );
}
