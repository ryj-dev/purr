// The tools PuRR uses but doesn't ship: the five scanners, claude (reviews) and gh (PR detection and comments).
// The Toolchain popup shows each one's state and installs what's missing:
// all with Homebrew (claude as the claude-code cask). Without Homebrew, the popup offers to install it, in Terminal,
// since its installer asks for the Mac's password.
// Signing in also opens Terminal, on the tool's own login command: PuRR never sees a password or token.
import { existsSync, realpathSync } from 'node:fs';
import type { AppState, ToolName, ToolStatus, Toolchain } from '../shared/types.ts';
import { GH_DEFAULT_LOGIN, expectGhSignIn, forgetGhAccounts, ghAccounts } from './gh.ts';
import { exec } from './util.ts';

export const TOOL_NAMES: ToolName[] = ['betterleaks', 'zizmor', 'osv-scanner', 'hadolint', 'actionlint', 'claude', 'gh'];

const PURPOSE: Record<ToolName, string> = {
  betterleaks: 'Secrets in commits (the gitleaks successor)',
  zizmor: 'GitHub Actions workflow issues',
  'osv-scanner': 'Known-vulnerable dependencies',
  hadolint: 'Dockerfile errors (advice)',
  actionlint: 'GitHub Actions workflow errors (advice)',
  claude: 'Runs the reviews, on your subscription',
  gh: 'Finds your PRs and posts review comments',
};

/** `brew install` arguments for each tool. */
export const BREW_INSTALL: Record<ToolName, string[]> = {
  betterleaks: ['betterleaks'], zizmor: ['zizmor'], 'osv-scanner': ['osv-scanner'], hadolint: ['hadolint'], actionlint: ['actionlint'],
  gh: ['gh'], claude: ['--cask', 'claude-code'],
};

// ---- status ----

async function locate(bin: string): Promise<string | null> {
  try {
    const r = await exec('/usr/bin/which', [bin], { timeoutMs: 5000 });
    return r.code === 0 ? r.stdout.trim() || null : null;
  } catch { return null; }
}

async function brewPath(): Promise<string | null> {
  // PURR_BREW names Homebrew's brew explicitly (empty: act as if there's none); the tests use it
  if (process.env.PURR_BREW !== undefined) return process.env.PURR_BREW && existsSync(process.env.PURR_BREW) ? process.env.PURR_BREW : null;
  for (const p of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) if (existsSync(p)) return p;
  return locate('brew');
}

async function versionOf(path: string): Promise<string | null> {
  try {
    const r = await exec(path, ['--version'], { timeoutMs: 10_000 });
    return (r.stdout + r.stderr).match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? null;
  } catch { return null; }
}

function sourceOf(path: string): ToolStatus['source'] {
  let real = path;
  try { real = realpathSync(path); } catch { /* keep the link */ }
  if (/\/(Cellar|Caskroom)\//.test(real) || real.startsWith('/opt/homebrew/')) return 'homebrew';
  if (real.includes('/.local/share/claude/')) return 'claude-installer';
  return 'other';
}

async function claudeAuth(path: string): Promise<ToolStatus['auth']> {
  try {
    const r = await exec(path, ['auth', 'status', '--json'], { timeoutMs: 15_000 });
    const s = JSON.parse(r.stdout) as { loggedIn?: boolean; email?: string; orgName?: string; authMethod?: string };
    if (!s.loggedIn) return { signedIn: false, accounts: [] };
    return { signedIn: true, accounts: s.email ? [s.email] : [], detail: s.orgName || s.authMethod };
  } catch { return { signedIn: false, accounts: [] }; }
}

const jobs = new Map<ToolName, NonNullable<ToolStatus['job']>>();
let statusCache: { at: number; list: Promise<Toolchain> } | null = null;
let summaryCache: { at: number; v: Promise<AppState['tools']> } | null = null;
const listeners = new Set<(settled: boolean) => void>();

/** Called whenever a tool's state changes; `settled` when an install has finished or failed. */
export function onToolchainChange(fn: (settled: boolean) => void) { listeners.add(fn); return () => listeners.delete(fn); }
function changed(settled = false) {
  statusCache = null;
  if (settled) summaryCache = null;
  for (const fn of listeners) fn(settled);
}
/** Forget cached state, e.g. after the user signed in from Terminal. */
export function refreshToolchain() { statusCache = null; summaryCache = null; forgetGhAccounts(); }

async function statusOf(name: ToolName): Promise<ToolStatus> {
  const path = await locate(name);
  const authOf = async (): Promise<ToolStatus['auth']> => {
    if (path && name === 'claude') return claudeAuth(path);
    if (path && name === 'gh') {
      const accounts = await ghAccounts();
      const named = accounts.filter((a) => a !== GH_DEFAULT_LOGIN);
      return { signedIn: accounts.length > 0, accounts: named, ...(accounts.length && !named.length ? { detail: 'signed in' } : {}) };
    }
    return null;
  };
  const [auth, version] = await Promise.all([authOf(), path ? versionOf(path) : null]);
  return {
    name, purpose: PURPOSE[name], installed: !!path, path, version,
    source: path ? sourceOf(path) : null, auth, job: jobs.get(name) ?? null,
  };
}

/** Homebrew and every tool's state. Cached briefly: the popup polls it while a sign-in may be happening in Terminal. */
export function toolchainStatus(): Promise<Toolchain> {
  if (statusCache && Date.now() - statusCache.at < 2000) return statusCache.list;
  const list = (async () => {
    const [brew, tools] = await Promise.all([brewPath(), Promise.all(TOOL_NAMES.map(statusOf))]);
    return { homebrew: { installed: !!brew, path: brew }, tools };
  })();
  statusCache = { at: Date.now(), list };
  list.catch(() => { statusCache = null; });
  return list;
}

/**
 * The sidebar's summary (AppState.tools). Kept cheap, since /api/state is also the app's is-the-service-up probe:
 * only `which` and the cached gh accounts, for a minute or until an install finishes or a sign-in is looked for.
 */
export function toolsSummary(): Promise<AppState['tools']> {
  if (summaryCache && Date.now() - summaryCache.at < 60_000) return summaryCache.v;
  const v = (async () => {
    const [betterleaks, zizmor, osv, hadolint, actionlint, claude, gh] = await Promise.all(
      ['betterleaks', 'zizmor', 'osv-scanner', 'hadolint', 'actionlint', 'claude', 'gh'].map(async (n) => !!(await locate(n))));
    return { gh, ghAuthed: gh ? (await ghAccounts()).length > 0 : false, betterleaks, zizmor, osv, hadolint, actionlint, claude };
  })();
  summaryCache = { at: Date.now(), v };
  v.catch(() => { summaryCache = null; });
  return v;
}

// ---- installing ----

function lastLine(s: string): string {
  return s.trim().split('\n').filter(Boolean).pop()?.slice(0, 300) ?? '';
}

async function runInstall(name: ToolName, step: (s: string) => void): Promise<void> {
  const brew = await brewPath();
  if (!brew) throw new Error(`Install Homebrew first, then ${name}`);
  const cmd = `brew install ${BREW_INSTALL[name].join(' ')}`;
  step(cmd);
  const r = await exec(brew, ['install', ...BREW_INSTALL[name]], {
    timeoutMs: 15 * 60_000, env: { ...process.env, HOMEBREW_NO_ENV_HINTS: '1', NONINTERACTIVE: '1' },
    onStdoutLine: (l) => { if (l.trim()) step(l.replace(/^==> /, '').trim().slice(0, 200)); },
  });
  if (r.code !== 0) throw new Error(lastLine(r.stderr) || `${cmd} failed (exit ${r.code})`);
}

function runJob(name: ToolName, job: NonNullable<ToolStatus['job']>): Promise<void> {
  job.step = 'Starting';
  changed();
  let last = 0;
  const step = (s: string) => {
    job.step = s;
    if (Date.now() - last > 500) { last = Date.now(); changed(); }   // brew is chatty
  };
  const mine = () => jobs.get(name) === job;
  return runInstall(name, step).then(
    () => { if (mine()) jobs.delete(name); refreshToolchain(); changed(true); },
    (e) => { if (mine()) jobs.set(name, { state: 'failed', step: job.step, error: String(e?.message ?? e) }); changed(true); },
  );
}

/** Every install, from any button, runs on this one chain: Homebrew doesn't like two installs at once. */
let installs: Promise<void> = Promise.resolve();

/** Queues a tool for installing. Returns at once; progress shows in the tool's `job` ("Queued" until its turn). */
export function installTool(name: ToolName): void {
  if (jobs.get(name)?.state === 'running') return;
  const job: NonNullable<ToolStatus['job']> = { state: 'running', step: 'Queued' };
  jobs.set(name, job);
  changed();
  installs = installs.then(() => runJob(name, job));
}

/** Queues every missing tool that isn't already queued or installing. */
export async function installMissing(): Promise<ToolName[]> {
  const { homebrew, tools } = await toolchainStatus();
  if (!homebrew.installed) return [];
  // read the jobs now, not from the status snapshot: another request may have queued some while we waited
  const missing = tools.filter((t) => !t.installed && jobs.get(t.name)?.state !== 'running').map((t) => t.name);
  for (const n of missing) installTool(n);
  return missing;
}

// ---- signing in ----

/** AppleScript string literal. */
export const asString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
/** POSIX shell single-quoted word. */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The command Terminal runs to sign in (or add another gh account). */
export function signInCommand(name: 'claude' | 'gh', binPath: string): string {
  return name === 'claude'
    ? `${shQuote(binPath)} auth login`
    : `${shQuote(binPath)} auth login --hostname github.com --web`;
}

/** Homebrew's official install command (https://brew.sh). */
export const HOMEBREW_INSTALL = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';

async function inTerminal(cmd: string): Promise<void> {
  const r = await exec(process.env.PURR_OSASCRIPT || '/usr/bin/osascript', [
    '-e', 'tell application "Terminal"', '-e', 'activate', '-e', `do script ${asString(cmd)}`, '-e', 'end tell',
  ], { timeoutMs: 20_000 });
  if (r.code !== 0) throw new Error(`Couldn't open Terminal: ${lastLine(r.stderr)}. Run this yourself: ${cmd}`);
}

/** Opens Terminal on Homebrew's installer: it asks for the Mac's password, so it can't run in the background. */
export async function openHomebrewInstall(): Promise<void> {
  if (await brewPath()) throw new Error('Homebrew is already installed');
  await inTerminal(HOMEBREW_INSTALL);
}

/** Opens Terminal on the tool's own login. PuRR notices the result when the popup next checks. */
export async function openSignIn(name: ToolName): Promise<void> {
  if (name !== 'claude' && name !== 'gh') throw new Error(`${name} doesn't need signing in`);
  const path = await locate(name);
  if (!path) throw new Error(`Install ${name} first`);
  await inTerminal(signInCommand(name, path));
  refreshToolchain();
  // the poller and the sidebar read gh's accounts through a five-minute cache: shorten it while the login finishes,
  // or a new account's PRs would be ignored (and gh shown signed out) until it expired
  if (name === 'gh') expectGhSignIn();
}
