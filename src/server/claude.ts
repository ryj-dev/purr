// The ONLY place purr talks to Claude: it launches the unmodified `claude` CLI as a headless child process, signed in
// with whatever account the CLI already uses. PuRR never reads ~/.claude, the keychain or OAuth tokens and never calls
// the Anthropic API itself. Keep it that way: it is what keeps this inside ordinary Claude Code use.

import type { DB } from './db.ts';
import type { SessionUse, Usage } from '../shared/types.ts';
import { exec, Semaphore } from './util.ts';

export interface ClaudeCall {
  prompt: string;
  cwd: string;
  model?: string;              // forks must send the seed's model, effort and tools again or they miss the cache
  effort?: string | null;
  tools?: string[];
  allowedTools?: string[];
  maxTurns?: number;
  resume?: string;             // fork this session
  fork?: boolean;              // false = continue `resume` in place (used for a JSON retry on our own fork)
  signal?: AbortSignal;
  runId: string;
  blockId: string;
  timeoutMs?: number;
}

export interface ClaudeResult extends SessionUse { text: string; ok: boolean }

export class QuotaError extends Error {}

export class ClaudeRunner {
  db: DB;
  sem: Semaphore;
  onUsage: (u: Usage) => void;
  constructor(db: DB, onUsage: (u: Usage) => void = () => {}) {
    this.db = db;
    this.sem = new Semaphore(db.getSettings().maxConcurrentClaude);
    this.onUsage = onUsage;
  }

  /** Throws QuotaError when PuRR is paused for a usage limit or the daily session cap is reached. */
  checkQuota() {
    const usage = this.db.getUsage();
    const s = this.db.getSettings();
    if (usage.pausedUntil && new Date(usage.pausedUntil) > new Date()) {
      throw new QuotaError(`Paused until ${usage.pausedUntil}: the Claude usage limit was reached`);
    }
    if (usage.sessionsToday >= s.dailySessionCap) {
      throw new QuotaError(`Daily session cap reached (${s.dailySessionCap}); raise it in Settings`);
    }
  }

  async run(call: ClaudeCall): Promise<ClaudeResult> {
    const settings = this.db.getSettings();
    this.sem.limit = settings.maxConcurrentClaude;
    const release = await this.sem.acquire(call.signal);
    try {
      this.checkQuota();
      return await this.spawn(call, settings.claudeBin, settings.claudeExtraArgs);
    } finally {
      release();
    }
  }

  private async spawn(call: ClaudeCall, bin: string, extra: string[]): Promise<ClaudeResult> {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (call.resume) args.push('--resume', call.resume, ...(call.fork === false ? [] : ['--fork-session']));
    if (call.model) args.push('--model', call.model);
    if (call.effort) args.push('--effort', call.effort);
    if (call.tools) args.push('--tools', call.tools.join(','));
    if (call.allowedTools?.length) args.push('--allowedTools', ...call.allowedTools);
    if (call.maxTurns) args.push('--max-turns', String(call.maxTurns));
    args.push(...extra);

    const t0 = Date.now();
    let sessionId = '';
    let result: any = null;
    let lastAssistantText = '';
    const r = await exec(bin, args, {
      cwd: call.cwd, input: call.prompt, signal: call.signal, timeoutMs: call.timeoutMs ?? 20 * 60_000,
      onStdoutLine: (line) => {
        if (!line.trim()) return;
        let ev: any;
        try { ev = JSON.parse(line); } catch { return; }
        if (ev.session_id && !sessionId) sessionId = ev.session_id;
        if (ev.type === 'rate_limit_event') this.recordRateLimit(ev.rate_limit_info);
        if (ev.type === 'assistant') {
          const t = (ev.message?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
          if (t) lastAssistantText = t;
        }
        if (ev.type === 'result') result = ev;
      },
    });

    const u = result?.usage ?? {};
    const out: ClaudeResult = {
      sessionId: result?.session_id ?? sessionId,
      forkedFrom: call.resume && call.fork !== false ? call.resume : null,
      model: call.model ?? 'inherited',
      usage: {
        input: u.input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0,
      },
      durationMs: Date.now() - t0,
      turns: result?.num_turns ?? 0,
      text: typeof result?.result === 'string' && result.result ? result.result : lastAssistantText,
      ok: !!result && !result.is_error,
    };
    if (!result) {
      out.error = call.signal?.aborted ? 'cancelled'
        : r.timedOut ? 'timed out'
        : `claude exited ${r.code} without a result: ${r.stderr.trim().slice(0, 500) || r.stdout.trim().slice(-500)}`;
    } else if (result.is_error) {
      out.error = result.subtype === 'error_max_turns' ? 'hit the max-turns limit before answering' : String(result.result ?? result.subtype ?? 'error');
      if (/usage limit|rate limit/i.test(out.error)) this.pauseFromError();
    }
    if (out.sessionId) this.db.recordSession(out.sessionId, call.runId, call.blockId, { ...out, text: undefined });
    this.onUsage(this.db.getUsage());
    return out;
  }

  private recordRateLimit(info: any) {
    if (!info) return;
    const w = info.unifiedWindows ?? {};
    const iso = (s?: number) => (s ? new Date(s * 1000).toISOString() : null);
    const patch: Partial<Usage> = {
      fiveHour: w.five_hour?.utilization ?? null,
      sevenDay: w.seven_day?.utilization ?? null,
      fiveHourResetsAt: iso(w.five_hour?.resetsAt),
      sevenDayResetsAt: iso(w.seven_day?.resetsAt),
      updatedAt: new Date().toISOString(),
    };
    if (info.status && info.status !== 'allowed' && info.status !== 'allowed_warning' && !info.isUsingOverage) {
      patch.pausedUntil = iso(info.resetsAt) ?? new Date(Date.now() + 15 * 60_000).toISOString();
    }
    this.db.setUsage(patch);
    this.onUsage(this.db.getUsage());
  }

  private pauseFromError() {
    const u = this.db.getUsage();
    const until = u.fiveHourResetsAt && new Date(u.fiveHourResetsAt) > new Date() ? u.fiveHourResetsAt
      : new Date(Date.now() + 15 * 60_000).toISOString();
    this.db.setUsage({ pausedUntil: until });
  }
}
