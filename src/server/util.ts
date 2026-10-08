import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

export const PURR_HOME = process.env.PURR_HOME || join(homedir(), '.purr');
export const paths = {
  home: PURR_HOME,
  db: join(PURR_HOME, 'purr.db'),
  worktrees: join(PURR_HOME, 'worktrees'),
  scratch: join(PURR_HOME, 'scratch'),
  logs: join(PURR_HOME, 'logs'),
};
for (const p of [paths.home, paths.worktrees, paths.scratch, paths.logs]) mkdirSync(p, { recursive: true });

export const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

export const now = () => new Date().toISOString();
export const newId = (prefix = '') => prefix + randomBytes(6).toString('hex');

export interface ExecResult { code: number; stdout: string; stderr: string; timedOut: boolean }

/** Runs a command without a shell (unless `shell`). Never throws on a non-zero exit; throws ENOENT if the binary is missing. */
export function exec(cmd: string, args: string[], opts: {
  cwd?: string; input?: string; timeoutMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv; shell?: boolean;
  onStdoutLine?: (line: string) => void;
} = {}): Promise<ExecResult> {
  if (opts.signal?.aborted) return Promise.resolve({ code: -1, stdout: '', stderr: 'cancelled', timedOut: false });
  return new Promise((resolve, reject) => {
    // own process group, so a timeout or cancel also kills grandchildren (npm -> test runner, claude -> tools)
    const child = spawn(cmd, args, {
      cwd: opts.cwd, env: opts.env ?? process.env, shell: opts.shell ?? false, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
    let stdout = '', stderr = '', buf = '', timedOut = false, settled = false;
    const killGroup = (sig: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, sig); } catch { /* gone */ } };
    let forceTimer: NodeJS.Timeout | null = null;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (buf && opts.onStdoutLine) opts.onStdoutLine(buf);
      resolve({ code, stdout, stderr, timedOut });
    };
    const kill = () => {
      killGroup('SIGTERM');
      // settle even if a stray descendant keeps the pipes open
      forceTimer = setTimeout(() => { killGroup('SIGKILL'); finish(child.exitCode ?? -1); }, 3000);
      forceTimer.unref();
    };
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs) : null;
    const onAbort = () => kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      if (opts.onStdoutLine) {
        buf += s;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { opts.onStdoutLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
      }
    });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e) => { if (timer) clearTimeout(timer); settled = true; reject(e); });
    child.on('close', (code) => finish(code ?? -1));
    child.stdin.on('error', () => {});
    if (opts.input !== undefined) child.stdin.end(opts.input); else child.stdin.end();
  });
}

export async function which(bin: string): Promise<boolean> {
  try { return (await exec('/usr/bin/which', [bin])).code === 0; } catch { return false; }
}

export class Semaphore {
  private waiters: Array<() => void> = [];
  private active = 0;
  limit: number;
  constructor(limit: number) { this.limit = limit; }
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error('cancelled');
    if (this.active >= this.limit) {
      await new Promise<void>((res, rej) => {
        const w = () => { signal?.removeEventListener('abort', ab); res(); };
        const ab = () => { this.waiters = this.waiters.filter((x) => x !== w); rej(new Error('cancelled')); };
        signal?.addEventListener('abort', ab, { once: true });
        this.waiters.push(w);
      });
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + `\n… [truncated ${s.length - n} chars]`;
}

/** Last top-level JSON array (or object) in a model's text answer that parses. */
export function extractJson(text: string, kind: 'array' | 'object' = 'array'): unknown {
  const open = kind === 'array' ? '[' : '{';
  const close = kind === 'array' ? ']' : '}';
  let found: unknown = undefined;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== open) continue;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) continue;
    if (text[end] === close) {
      try { found = JSON.parse(text.slice(i, end + 1)); i = end; continue; } catch { /* not JSON: keep scanning inside */ }
    }
  }
  return found;
}

/**
 * `fn` at most once per `ttlMs`: concurrent callers share one call, and a failed call isn't kept, so the next caller
 * tries again.
 */
export function sharedCache<T>(fn: () => Promise<T>, ttlMs: number): () => Promise<T> {
  let cache: { at: number; v: Promise<T> } | null = null;
  return () => {
    if (!cache || Date.now() - cache.at >= ttlMs) {
      const v = fn();
      cache = { at: Date.now(), v };
      v.catch(() => { if (cache?.v === v) cache = null; });
    }
    return cache.v;
  };
}
