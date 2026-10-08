// PuRR covers every repo while it's running: git's global core.hooksPath points at ~/.purr/hooks.
//
// Setting a global hooks path makes git ignore each repo's own .git/hooks, so every script here first runs the hook
// it replaced: the repo's .git/hooks/<name> (or its pre-purr original), then the global hooks path the user had before
// purr. Only pre-commit and pre-push then call purr, and only while the PuRR service is running (its pid file is live):
// quitting PuRR turns the checks off without touching git config. Repos that set their own core.hooksPath (husky)
// keep it, because git prefers the repo setting; PuRR's post-push poller still covers their PRs.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHIM } from './runtime.ts';
import { exec, paths } from './util.ts';

export const GLOBAL_HOOKS_DIR = join(paths.home, 'hooks');
const PREVIOUS = join(GLOBAL_HOOKS_DIR, '.previous-hooks-path');
export const PID_FILE = join(paths.home, 'service.pid');
const MARK = '# purr-global-hook';

// Client-side hooks git runs from a hooks directory. reference-transaction and post-index-change are left out on
// purpose: git calls them on almost every ref/index write, and a pass-through script there would slow every repo down.
const PASSTHROUGH = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg',
  'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'post-rewrite',
  'pre-auto-gc', 'push-to-checkout', 'sendemail-validate',
];
const WITH_STDIN = new Set(['pre-push', 'post-rewrite', 'push-to-checkout']);
const PURR_HOOKS = new Set(['pre-commit', 'pre-push']);

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function script(name: string): string {
  const stdin = WITH_STDIN.has(name);
  const feed = stdin ? 'printf "%s\\n" "$PURR_STDIN" | ' : '';
  const purr = PURR_HOOKS.has(name) ? `
# PuRR's own check: only while the PuRR service is running, and never blocking git because of PuRR itself
[ -n "$PURR_SKIP" ] && exit 0
PURR_PID="$(cat ${q(PID_FILE)} 2>/dev/null)"
if [ -n "$PURR_PID" ] && kill -0 "$PURR_PID" 2>/dev/null; then
  PURR_BIN=${q(SHIM)}
  [ -x "$PURR_BIN" ] || PURR_BIN="$(command -v purr)"
  if [ -n "$PURR_BIN" ]; then
    ${feed}"$PURR_BIN" hook ${name} "$@"
    [ $? -eq 1 ] && exit 1
  else
    echo "purr: not found, skipping (reopen the PuRR app to repair its hooks)" >&2
  fi
fi` : '';
  return `#!/bin/sh
${MARK} (PuRR sets git's global core.hooksPath to this folder while installed; \`purr hooks uninstall --global\` restores yours)
${stdin ? 'PURR_STDIN="$(cat)"\n' : ''}GIT_COMMON="$(git rev-parse --git-common-dir 2>/dev/null)"
if [ -n "$GIT_COMMON" ]; then
  REPO_HOOK="$GIT_COMMON/hooks/${name}"
  if [ -x "$REPO_HOOK" ]; then ${feed}"$REPO_HOOK" "$@" || exit $?; fi
fi
PREV_DIR="$(cat ${q(PREVIOUS)} 2>/dev/null)"
if [ -n "$PREV_DIR" ] && [ -x "$PREV_DIR/${name}" ]; then ${feed}"$PREV_DIR/${name}" "$@" || exit $?; fi
${purr}
exit 0
`;
}

async function gitGlobal(args: string[]) {
  return exec('git', ['config', '--global', ...args], { timeoutMs: 15_000 });
}

export async function currentGlobalHooksPath(): Promise<string | null> {
  const r = await gitGlobal(['--get', 'core.hooksPath']);
  return r.code === 0 ? r.stdout.trim() || null : null;
}

/**
 * Writes ~/.purr/hooks and points git's global core.hooksPath at it, remembering any hooks path the user had so it
 * keeps running. Safe to call on every start: it refreshes the scripts (e.g. after PuRR.app moved).
 */
export async function installGlobalHooks(): Promise<{ changed: boolean; previous: string | null }> {
  mkdirSync(GLOBAL_HOOKS_DIR, { recursive: true });
  for (const name of PASSTHROUGH) {
    const p = join(GLOBAL_HOOKS_DIR, name);
    const body = script(name);
    if (!existsSync(p) || readFileSync(p, 'utf8') !== body) writeFileSync(p, body);
    chmodSync(p, 0o755);
  }
  const current = await currentGlobalHooksPath();
  if (current === GLOBAL_HOOKS_DIR) return { changed: false, previous: readPrevious() };
  if (current) writeFileSync(PREVIOUS, current);
  const r = await gitGlobal(['core.hooksPath', GLOBAL_HOOKS_DIR]);
  if (r.code !== 0) throw new Error(`couldn't set git's global core.hooksPath: ${r.stderr.trim()}`);
  return { changed: true, previous: current };
}

function readPrevious(): string | null {
  try { return readFileSync(PREVIOUS, 'utf8').trim() || null; } catch { return null; }
}

/** Puts git's global hooks path back the way it was before PuRR and removes ~/.purr/hooks. */
export async function uninstallGlobalHooks(): Promise<string> {
  const current = await currentGlobalHooksPath();
  const previous = readPrevious();
  if (current === GLOBAL_HOOKS_DIR) {
    if (previous) await gitGlobal(['core.hooksPath', previous]);
    else await gitGlobal(['--unset', 'core.hooksPath']);
  }
  if (existsSync(GLOBAL_HOOKS_DIR)) {
    for (const f of readdirSync(GLOBAL_HOOKS_DIR)) {
      const p = join(GLOBAL_HOOKS_DIR, f);
      if (f === '.previous-hooks-path' || readFileSync(p, 'utf8').includes(MARK)) rmSync(p, { force: true });
    }
    try { rmdirSync(GLOBAL_HOOKS_DIR); } catch { /* not empty: leave the user's files */ }
  }
  return previous ? `restored core.hooksPath to ${previous}` : 'removed PuRR from git\'s global core.hooksPath';
}

/** The pid file the hooks check: present and live only while the service runs. */
export function writePidFile() { writeFileSync(PID_FILE, String(process.pid)); }
export function removePidFile() {
  try { if (readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) rmSync(PID_FILE); } catch { /* gone */ }
}
