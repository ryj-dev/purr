// The tools PuRR uses but doesn't ship: the three scanners, claude (reviews) and gh (PR detection and comments).
// The Toolchain popup shows each one's state and installs what's missing:
//  - claude: with Claude Code's own installer (https://claude.ai/install.sh), which needs no admin rights and keeps
//    claude up to date by itself;
//  - the rest: with Homebrew. Without Homebrew, the popup offers to install it, in Terminal, since its installer
//    asks for the Mac's password.
// Signing in also opens Terminal, on the tool's own login command: PuRR never sees a password or token.
import { existsSync, realpathSync } from 'node:fs';
import type { AppState, ToolName, ToolStatus, Toolchain } from '../shared/types.ts';
import { forgetGhAccounts, ghAccounts } from './gh.ts';
import { exec } from './util.ts';

export const TOOL_NAMES: ToolName[] = ['gitleaks', 'zizmor', 'osv-scanner', 'claude', 'gh'];

const PURPOSE: Record<ToolName, string> = {
  gitleaks: 'Secrets in commits',
  zizmor: 'GitHub Actions workflow issues',
  'osv-scanner': 'Known-vulnerable dependencies',
  claude: 'Runs the reviews, on your subscription',
  gh: 'Finds your PRs and posts review comments',
};

const BREW_FORMULA: Record<Exclude<ToolName, 'claude'>, string> = {
  gitleaks: 'gitleaks', zizmor: 'zizmor', 'osv-scanner': 'osv-scanner', gh: 'gh',
};

const CLAUDE_INSTALLER = 'https://claude.ai/install.sh';

// ---- status ----

async function locate(bin: string): Promise<string | null> {
  try {
    const r = await exec('/usr/bin/which', [bin], { timeoutMs: 5000 });
    return r.code === 0 ? r.stdout.trim() || null : null;
  } catch { return null; }
}

async function brewPath(): Promise<string | null> {
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
const listeners = new Set<(settled: boolean) => void>();

/** Called whenever a tool's state changes; `settled` when an install has finished or failed. */
export function onToolchainChange(fn: (settled: boolean) => void) { listeners.add(fn); return () => listeners.delete(fn); }
function changed(settled = false) {
  statusCache = null;
  for (const fn of listeners) fn(settled);
}
/** Forget cached state, e.g. after the user signed in from Terminal. */
export function refreshToolchain() { statusCache = null; forgetGhAccounts(); }

async function statusOf(name: ToolName): Promise<ToolStatus> {
  const path = await locate(name);
  const installVia: ToolStatus['installVia'] = name === 'claude' ? 'claude-installer' : 'homebrew';
  let auth: ToolStatus['auth'] = null;
  if (path && name === 'claude') auth = await claudeAuth(path);
  if (path && name === 'gh') {
    const accounts = await ghAccounts();
    auth = { signedIn: accounts.length > 0, accounts };
  }
  return {
    name, purpose: PURPOSE[name], installed: !!path, path, version: path ? await versionOf(path) : null,
    source: path ? sourceOf(path) : null, installVia, auth, job: jobs.get(name) ?? null,
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

/** The sidebar's summary (AppState.tools). */
export async function toolsSummary(): Promise<AppState['tools']> {
  const by = Object.fromEntries((await toolchainStatus()).tools.map((t) => [t.name, t])) as Record<ToolName, ToolStatus>;
  return {
    gh: by.gh.installed, ghAuthed: !!by.gh.auth?.signedIn, gitleaks: by.gitleaks.installed, zizmor: by.zizmor.installed,
    osv: by['osv-scanner'].installed, claude: by.claude.installed,
  };
}

// ---- installing ----

function lastLine(s: string): string {
  return s.trim().split('\n').filter(Boolean).pop()?.slice(0, 300) ?? '';
}

async function runInstall(name: ToolName, step: (s: string) => void): Promise<void> {
  if (name === 'claude') {
    step('Running Claude Code’s installer');
    const r = await exec('/bin/bash', ['-c', `set -o pipefail; /usr/bin/curl -fsSL ${CLAUDE_INSTALLER} | /bin/bash`], {
      timeoutMs: 10 * 60_000, onStdoutLine: (l) => { if (l.trim()) step(l.trim().slice(0, 200)); },
    });
    if (r.code !== 0) throw new Error(lastLine(r.stderr) || lastLine(r.stdout) || `The installer stopped (exit ${r.code})`);
    return;
  }
  const brew = await brewPath();
  if (!brew) throw new Error(`Install Homebrew first, then ${name}`);
  step(`brew install ${BREW_FORMULA[name]}`);
  const r = await exec(brew, ['install', BREW_FORMULA[name]], {
    timeoutMs: 15 * 60_000, env: { ...process.env, HOMEBREW_NO_ENV_HINTS: '1', NONINTERACTIVE: '1' },
    onStdoutLine: (l) => { if (l.trim()) step(l.replace(/^==> /, '').trim().slice(0, 200)); },
  });
  if (r.code !== 0) throw new Error(lastLine(r.stderr) || `brew install ${BREW_FORMULA[name]} failed (exit ${r.code})`);
}

/** Starts installing a tool in the background. Returns at once; progress shows in the tool's `job`. */
export function installTool(name: ToolName): void {
  if (jobs.get(name)?.state === 'running') return;
  const job: NonNullable<ToolStatus['job']> = { state: 'running', step: 'Starting' };
  jobs.set(name, job);
  changed();
  let last = 0;
  const step = (s: string) => {
    job.step = s;
    if (Date.now() - last > 500) { last = Date.now(); changed(); }   // brew is chatty
  };
  runInstall(name, step).then(
    () => { jobs.delete(name); refreshToolchain(); changed(true); },
    (e) => { jobs.set(name, { state: 'failed', step: job.step, error: String(e?.message ?? e) }); changed(true); },
  );
}

/** Installs every missing tool, one at a time (Homebrew doesn't like running twice at once). */
export async function installMissing(): Promise<ToolName[]> {
  const { homebrew, tools } = await toolchainStatus();
  const missing = tools.filter((t) => !t.installed && t.job?.state !== 'running' && (homebrew.installed || t.installVia !== 'homebrew')).map((t) => t.name);
  void (async () => {
    for (const n of missing) {
      installTool(n);
      while (jobs.get(n)?.state === 'running') await new Promise((r) => setTimeout(r, 500));
    }
  })();
  return missing;
}

// ---- signing in ----

/** AppleScript string literal. */
const asString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
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
  const r = await exec('/usr/bin/osascript', [
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
}
