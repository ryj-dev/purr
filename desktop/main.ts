// PuRR.app main process: a menu-bar app that keeps the review service running and shows the UI in a native window.
//
// The service (the same daemon `purr daemon` runs) is a supervised child process started with this app's own runtime
// (ELECTRON_RUN_AS_NODE), so the app needs no separate Node install. If a service is already listening (started from
// the CLI or an older launch agent), the app attaches to it instead of starting a second one.

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  BrowserWindow, Menu, Notification, Tray, app, dialog, ipcMain, nativeImage, shell, type MenuItemConstructorOptions,
} from 'electron';
import type { AppState, Run, ServerEvent } from '../src/shared/types.ts';
import { cliStatusOf, installCliAt } from './cliLink.ts';
import { cliAction, cliTrayItem } from '../src/shared/cliLink.ts';

const PURR_HOME = process.env.PURR_HOME || join(homedir(), '.purr');
const LOG = join(PURR_HOME, 'logs', 'daemon.log');
const STATE_FILE = join(PURR_HOME, 'app.json');
const DEFAULT_PORT = 7878;

const res = (...p: string[]) => (app.isPackaged ? join(process.resourcesPath, ...p) : join(app.getAppPath(), ...p));
const SERVER = app.isPackaged ? res('server', 'cli.mjs') : res('dist', 'server', 'cli.mjs');
const WEB = app.isPackaged ? res('web') : res('dist', 'web');
const SHIM = res('bin', 'purr');   // packaged: Resources/bin/purr (build/bin/purr); dev: the checkout's bin/purr
const TRAY_ICON = app.isPackaged ? res('tray', 'trayTemplate.png') : res('build', 'tray', 'trayTemplate.png');

// ---------------------------------------------------------------------------------------------------------------------
// small persistent app state (first-run flag)

interface AppFile { firstRunDone?: boolean; shellPath?: string }
function readAppState(): AppFile {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeAppState(s: AppFile) {
  try { mkdirSync(PURR_HOME, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------------------------------------------------
// PATH: apps launched from Finder or at login get a minimal PATH, which would hide claude, gh, the scanners, brew tools.
// Ask the user's login shell once, the way a terminal would see it.

async function loginShellPath(): Promise<string> {
  const shellBin = process.env.SHELL || '/bin/zsh';
  try {
    const { stdout } = await promisify(execFile)(shellBin, ['-ilc', 'printf "__PURR_PATH__%s" "$PATH"'], { timeout: 8000 });
    const m = stdout.match(/__PURR_PATH__(.*)$/s);
    if (m && m[1].trim()) return m[1].trim();
  } catch { /* fall through */ }
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin'), join(homedir(), '.npm-global/bin')];
  return [...extra, process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'].join(':');
}

// ---------------------------------------------------------------------------------------------------------------------
// the service

type ServiceMode = 'starting' | 'own' | 'external' | 'down';
let mode: ServiceMode = 'starting';
let port = DEFAULT_PORT;
let child: ChildProcess | null = null;
let quitting = false;
let restarts: number[] = [];
let userPath = process.env.PATH ?? '';

const base = () => `http://127.0.0.1:${port}`;

async function probe(p = port): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/state`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

const T0 = Date.now();
function log(line: string) {
  try { mkdirSync(join(PURR_HOME, 'logs'), { recursive: true }); appendFileSync(LOG, line.endsWith('\n') ? line : line + '\n'); } catch { /* ignore */ }
}
/** App lifecycle lines, timestamped from launch so slow starts are diagnosable. */
const appLog = (msg: string) => log(`[app +${((Date.now() - T0) / 1000).toFixed(2)}s] ${msg}`);

async function startService() {
  if (quitting) return;
  if (await probe(DEFAULT_PORT)) {
    port = DEFAULT_PORT;
    mode = 'external';
    appLog(`attached to a PuRR service already running on ${port}`);
    onServiceUp();
    return;
  }
  mode = 'starting';
  updateTray();
  appLog(`starting service: ${SERVER}`);
  const env = {
    ...process.env, PATH: userPath, ELECTRON_RUN_AS_NODE: '1', PURR_APP: '1', PURR_APP_BUNDLE: app.isPackaged ? '1' : '',
    PURR_WEB_DIR: WEB, PURR_SHIM: SHIM, PURR_BUILD_VERSION: app.getVersion(),
  };
  const c = spawn(process.execPath, ['--no-warnings', SERVER, 'daemon'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child = c;
  let addrInUse = false;
  c.stdout!.on('data', (d: Buffer) => {
    const s = d.toString();
    log(s);
    const m = s.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) { port = Number(m[1]); mode = 'own'; appLog('service is up'); onServiceUp(); }
  });
  c.stderr!.on('data', (d: Buffer) => {
    const s = d.toString();
    log(s);
    if (/port \d+ is in use/.test(s)) addrInUse = true;
  });
  c.on('exit', (code, signal) => {
    appLog(`service exited (code ${code}, signal ${signal})`);
    if (child === c) child = null;
    if (quitting) return;
    if (addrInUse) { setTimeout(startService, 500); return; }    // someone else took the port: attach to them
    mode = 'down';
    updateTray();
    // restart with backoff; give up after 5 crashes in 2 minutes and say so
    const now = Date.now();
    restarts = restarts.filter((t) => now - t < 120_000);
    restarts.push(now);
    if (restarts.length > 5) {
      notifyNative('PuRR service keeps stopping', `See ${LOG}. Use "Restart service" in the menu bar to try again.`);
      return;
    }
    setTimeout(startService, Math.min(30_000, 1000 * 2 ** (restarts.length - 1)));
  });
}

function stopService(): Promise<void> {
  return new Promise((resolve) => {
    const c = child;
    if (!c) { resolve(); return; }
    c.once('exit', () => resolve());
    c.kill('SIGTERM');
    setTimeout(() => { if (!c.killed) c.kill('SIGKILL'); resolve(); }, 4000);
  });
}

async function restartService() {
  restarts = [];
  if (mode === 'external') {
    dialog.showMessageBox({ message: 'The running PuRR service was started outside the app', detail: 'Stop it (purr agent uninstall, or end the `purr daemon` process), then choose Restart service again to let the app run it.' });
    return;
  }
  await stopService();
  await startService();
}

// ---------------------------------------------------------------------------------------------------------------------
// live state from the service: an SSE stream (no EventSource in the main process, so parse it by hand)

let appState: AppState | null = null;
let recentRuns: Run[] = [];
let streamAbort: AbortController | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

function onServiceUp() {
  restarts = restarts.filter((t) => Date.now() - t < 120_000);
  connectEvents();
  scheduleRefresh(0);
  for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().startsWith('data:')) w.loadURL(base());
}

function scheduleRefresh(delay = 400) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      const [s, r] = await Promise.all([
        fetch(`${base()}/api/state`).then((x) => x.json()),
        fetch(`${base()}/api/runs?limit=8`).then((x) => x.json()),
      ]);
      appState = s;
      recentRuns = r;
    } catch { /* service down: the stream reconnect handles it */ }
    updateTray();
  }, delay);
}

async function connectEvents() {
  streamAbort?.abort();
  const ctl = new AbortController();
  streamAbort = ctl;
  try {
    const r = await fetch(`${base()}/api/events`, { signal: ctl.signal });
    if (!r.body) throw new Error('no stream');
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try { onEvent(JSON.parse(line.slice(6)) as ServerEvent); } catch { /* ignore */ }
        }
      }
    }
  } catch { /* aborted or dropped */ }
  if (ctl.signal.aborted || quitting) return;
  // dropped: was the service restarted, or is it gone?
  setTimeout(async () => {
    if (await probe()) connectEvents();
    else if (mode === 'external') { mode = 'down'; updateTray(); setTimeout(startService, 2000); }
  }, 2000);
}

function onEvent(e: ServerEvent) {
  if (e.type === 'notify') { appLog(`notify event for ${e.runId}`); notifyNative(e.title, e.body, e.runId); }
  if (e.type === 'run' || e.type === 'state' || e.type === 'usage') scheduleRefresh();
}

const shown: Notification[] = [];   // keep references: a garbage-collected Notification can't be clicked
function notifyNative(title: string, body: string, runId?: string) {
  if (!Notification.isSupported()) { appLog('notifications not supported'); return; }
  const n = new Notification({ title, body, silent: false });
  n.on('show', () => appLog(`notification shown: ${title}`));
  n.on('failed', (_e, err) => appLog(`notification failed: ${err}`));
  n.on('click', () => showWindow(runId ? `#/runs/${runId}` : undefined));
  n.on('close', () => { const i = shown.indexOf(n); if (i >= 0) shown.splice(i, 1); });
  shown.push(n);
  if (shown.length > 20) shown.shift();
  n.show();
}

// ---------------------------------------------------------------------------------------------------------------------
// window

let win: BrowserWindow | null = null;

const WAITING = (msg: string) => `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0f1115;color:#9aa3b2;font:14px -apple-system,system-ui;-webkit-app-region:drag">${msg}</body></html>`)}`;

function showWindow(hash?: string) {
  if (process.platform === 'darwin') app.dock?.show();
  if (win && !win.isDestroyed()) {
    if (hash) win.loadURL(`${base()}/${hash}`);
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 980, minHeight: 600, show: false, title: 'PuRR',
    backgroundColor: '#0f1115', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 },
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win?.show());
  win.loadURL(mode === 'own' || mode === 'external' ? `${base()}/${hash ?? ''}` : WAITING('Starting the PuRR service…'));
  // links to GitHub etc. open in the browser; the window only ever shows the service's own pages
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(base())) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (ev, url) => {
    if (!url.startsWith(base()) && !url.startsWith('data:')) { ev.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); }
  });
  // closing hides: reviews keep running from the menu bar
  win.on('close', (ev) => {
    if (quitting) return;
    ev.preventDefault();
    win?.hide();
    if (process.platform === 'darwin') app.dock?.hide();
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// tray

let tray: Tray | null = null;
const ACTIVE = new Set(['queued', 'running']);
const STATUS_MARK: Record<string, string> = {
  passed: '✓', blocked: '⛔', failed: '✕', cancelled: '–', superseded: '–', running: '●', queued: '○',
};

function trayStatus(): { line: string; active: number } {
  if (mode === 'starting') return { line: 'Starting the PuRR service…', active: 0 };
  if (mode === 'down') return { line: 'Service not running', active: 0 };
  const active = recentRuns.filter((r) => ACTIVE.has(r.status)).length;
  const paused = appState?.usage.pausedUntil && new Date(appState.usage.pausedUntil) > new Date();
  if (paused) return { line: `Paused for the Claude usage limit until ${new Date(appState!.usage.pausedUntil!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, active };
  if (active) return { line: `Reviewing · ${active} run${active === 1 ? '' : 's'} in progress`, active };
  if (appState?.settings.reviewsPaused) return { line: 'Background reviews paused', active };
  return { line: 'Idle · watching for pushes', active };
}

const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)}%`);

async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(`${base()}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
  return r.json();
}

function updateTray() {
  const cli = cliAction(cliStatus());   // read once: the link could change between two reads
  if (!tray) return;
  const { line, active } = trayStatus();
  tray.setTitle(active ? ` ${active}` : '', { fontType: 'monospacedDigit' });
  tray.setToolTip(`PuRR · ${line}`);
  const up = mode === 'own' || mode === 'external';
  const repos = appState?.repos ?? [];
  const items: MenuItemConstructorOptions[] = [
    { label: line, enabled: false },
    ...(appState ? [{ label: `Claude usage: 5h ${pct(appState.usage.fiveHour)} · 7d ${pct(appState.usage.sevenDay)}`, enabled: false }] : []),
    { type: 'separator' },
    { label: 'Open PuRR', accelerator: 'CommandOrControl+O', click: () => showWindow() },
    {
      label: 'Review now', enabled: up && repos.length > 0,
      submenu: repos.map((r) => ({
        label: r.name,
        click: async () => {
          try {
            const run = await api('POST', '/api/runs', { repoId: r.id }) as Run;
            notifyNative(`purr · ${r.name}`, `Review started: ${run.flowName}`, run.id);
          } catch (e) { notifyNative('PuRR', `Couldn't start the review: ${(e as Error).message}`); }
        },
      })),
    },
    {
      label: 'Recent runs', enabled: recentRuns.length > 0,
      submenu: recentRuns.slice(0, 8).map((r) => ({
        label: `${STATUS_MARK[r.status] ?? '·'}  ${r.repoPath.split('/').pop()}${r.branch ? `/${r.branch}` : ''} · ${r.trigger}`
          + (r.counts.must_fix ? ` · ${r.counts.must_fix} must-fix` : ''),
        click: () => showWindow(`#/runs/${r.id}`),
      })),
    },
    { type: 'separator' },
    {
      label: 'Pause background reviews', type: 'checkbox', enabled: up && !!appState, checked: !!appState?.settings.reviewsPaused,
      click: async (item) => { try { await api('PUT', '/api/settings', { reviewsPaused: item.checked }); scheduleRefresh(0); } catch { /* shown on next refresh */ } },
    },
    {
      label: 'Start at login', type: 'checkbox', checked: loginItemEnabled(),
      click: (item) => { setLoginItem(item.checked); updateTray(); },
    },
    { type: 'separator' },
    // installed, or something in the way that only you can move: shown, not clickable
    cliTrayItem(cli, () => { const r = installCli(); updateTray(); void dialog.showMessageBox({ message: r.ok ? 'The purr command line tool is installed' : 'Couldn\'t install the command line tool', detail: r.message }); }),
    { label: mode === 'external' ? 'Service: started outside the app' : 'Restart service', enabled: mode !== 'external', click: () => restartService() },
    { label: 'Open service log', click: () => shell.openPath(LOG) },
    { type: 'separator' },
    { label: 'Quit PuRR', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ---------------------------------------------------------------------------------------------------------------------
// login item and command line tool

function loginItemEnabled(): boolean {
  try { return app.getLoginItemSettings().openAtLogin; } catch { return false; }
}
function setLoginItem(enabled: boolean): boolean {
  if (!app.isPackaged) return false;   // only the installed PuRR.app can be a login item
  app.setLoginItemSettings({ openAtLogin: enabled });
  return loginItemEnabled();
}

const CLI_DIR = join(homedir(), '.local', 'bin');
const CLI_LINK = join(CLI_DIR, 'purr');

const cliStatus = () => cliStatusOf(CLI_LINK, SHIM, userPath || '');

const installCli = () => installCliAt(CLI_LINK, SHIM, userPath || '');

ipcMain.handle('purr:get-login-item', () => loginItemEnabled());
ipcMain.handle('purr:set-login-item', (_e, on: boolean) => { const r = setLoginItem(!!on); updateTray(); return r; });
ipcMain.handle('purr:install-cli', () => { const r = installCli(); updateTray(); return r; });
ipcMain.handle('purr:cli-status', () => cliStatus());
ipcMain.on('purr:version', (e) => { e.returnValue = app.getVersion(); });

// ---------------------------------------------------------------------------------------------------------------------
// application menu (gives the window copy/paste/undo and the usual shortcuts)

function appMenu() {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'PuRR',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CommandOrControl+,', click: () => showWindow('#/settings') },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { label: 'Close window', accelerator: 'CommandOrControl+W', click: () => win?.close() },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Runs', accelerator: 'CommandOrControl+1', click: () => showWindow('#/runs') },
        { label: 'Flows', accelerator: 'CommandOrControl+2', click: () => showWindow('#/flows') },
        { label: 'Findings', accelerator: 'CommandOrControl+3', click: () => showWindow('#/findings') },
        { label: 'Repos & triggers', accelerator: 'CommandOrControl+4', click: () => showWindow('#/triggers') },
        { type: 'separator' },
        { role: 'reload' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as MenuItemConstructorOptions]),
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------------------------------------------------
// lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow());           // dock icon clicked
  app.on('before-quit', () => { quitting = true; streamAbort?.abort(); });
  app.on('will-quit', (ev) => {
    if (!child) return;
    ev.preventDefault();
    stopService().then(() => { child = null; app.quit(); });
  });
  app.on('window-all-closed', () => { /* keep running in the menu bar */ });

  app.whenReady().then(async () => {
    app.setAboutPanelOptions({
      applicationName: 'PuRR', applicationVersion: app.getVersion(),
      credits: 'Personal PR reviewer. Runs your own Claude Code CLI; never reads your credentials.',
    });
    appMenu();
    const icon = nativeImage.createFromPath(TRAY_ICON);
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.on('click', () => { updateTray(); tray?.popUpContextMenu(); });   // fresh: the CLI link may have changed
    updateTray();

    appLog('ready');
    // window and tray first; the service comes up behind them (the window shows "Starting…" until it does)
    // Reading the login shell's PATH can take seconds (it runs the user's profile), so start with the PATH saved last
    // time and refresh the saved copy in the background; only a first launch waits for it.
    const cached = readAppState().shellPath;
    const pathReady = loginShellPath().then((p) => {
      appLog('login shell PATH resolved');
      writeAppState({ ...readAppState(), shellPath: p });
      if (!cached) userPath = p;
      else if (p !== cached) appLog('PATH changed since last launch; it applies from the next service start');
      if (p !== cached) userPath = p;
    });
    if (cached) userPath = cached;
    void (async () => {
      if (!cached && !(await probe(DEFAULT_PORT))) await pathReady;
      await startService();
    })();

    const st = readAppState();
    const atLogin = app.getLoginItemSettings().wasOpenedAtLogin || process.argv.includes('--hidden');
    if (!st.firstRunDone && app.isPackaged) {   // dev runs would register the generic Electron binary as a login item
      // first launch: start at login by default (a background reviewer is only useful if it's running), and say so
      setLoginItem(true);
      writeAppState({ ...st, firstRunDone: true });
      updateTray();
      showWindow();
      notifyNative('PuRR is running in the menu bar', 'It starts at login and keeps reviewing after you close the window. Change this in the menu bar icon or Settings.');
    } else if (!atLogin) {
      showWindow();
    } else if (process.platform === 'darwin') {
      app.dock?.hide();
    }
    setInterval(() => scheduleRefresh(0), 60_000).unref();   // usage meters and the paused-until clock age
  });
}
