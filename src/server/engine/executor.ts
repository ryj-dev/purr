// Runs a flow: each block starts once all its inputs are done; independent blocks run concurrently (Claude calls are
// additionally limited by the runner's global semaphore). Forks use `claude --resume <seed> --fork-session`.

import type {
  Block, BlockOutput, BlockRun, CommandConfig, ContextConfig, Finding, Flow, GateConfig, MergeConfig, OutputConfig,
  PromptConfig, Run, ScannerConfig, Severity, VerifyConfig,
} from '../../shared/types.ts';
import { type ClaudeResult, type ClaudeRunner, QuotaError } from '../claude.ts';
import type { ChangeSpec, ChangedFile } from '../git.ts';
import { FINDING_SCHEMA } from '../flows/prompts.ts';
import { graph, rootContext, sessionSource } from '../flows/validate.ts';
import { runScanner } from '../scanners.ts';
import { exec, extractJson, now, truncate } from '../util.ts';
import { SEV_RANK, dedupe, normalizeFinding, slim } from './findings.ts';
import { Material } from './material.ts';

export interface ExecDeps {
  claude: ClaudeRunner;
  signal: AbortSignal;
  onBlock: (b: BlockRun) => void;
  /** Assigns ledger fingerprints in place (same function the ledger uses afterwards). */
  fingerprint?: (fs: Finding[]) => Promise<void>;
  /** Dismissed/tracked in the ledger: gates ignore these so a known false positive can't block git forever. */
  isSuppressed?: (f: Finding) => Promise<boolean>;
}
export interface ExecInput { run: Run; flow: Flow; change: ChangeSpec; files: ChangedFile[]; cwd: string }
export interface ExecResult { blocks: Map<string, BlockRun>; findings: Finding[]; gateFailed: boolean; failedBlocks: string[] }

const render = (tpl: string, vars: Record<string, string>) =>
  tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (k in vars ? (vars[k] === '' ? '(none)' : vars[k]) : m));

class BlockError extends Error {
  output: BlockOutput;
  constructor(message: string, output: BlockOutput = {}) { super(message); this.output = output; }
}

export async function executeFlow(input: ExecInput, deps: ExecDeps): Promise<ExecResult> {
  const { run, flow, change, files, cwd } = input;
  const g = graph(flow.blocks, flow.edges);
  if (!g.order.length) throw new Error('The flow has a cycle');
  const material = new Material(change, files, run);
  const state = new Map<string, BlockRun>();
  for (const b of flow.blocks) {
    const br: BlockRun = { runId: run.id, blockId: b.id, status: 'pending', startedAt: null, finishedAt: null, output: null, error: null };
    state.set(b.id, br);
  }
  const update = (id: string, patch: Partial<BlockRun>) => {
    const br = { ...state.get(id)!, ...patch };
    state.set(id, br);
    deps.onBlock(br);
  };
  for (const br of state.values()) deps.onBlock(br);

  const upstream = (id: string) => {
    const findings: Finding[] = [], texts: string[] = [];
    for (const i of g.inputs.get(id)!) {
      const o = state.get(i)!.output;
      if (!o) continue;
      if (o.findings) findings.push(...o.findings);
      const ib = g.byId.get(i)!;
      if (o.text && ib.type === 'command') texts.push(`### ${ib.label}\n${o.text}`);
    }
    return { findings, texts };
  };
  const sessionOf = (id: string): string | null => {
    const s = sessionSource(g, id);
    if ('error' in s) return null;
    return state.get(s.source)?.output?.sessionId ?? null;
  };
  // A fork only reads the seed from cache if it sends the same model, effort and tool list (measured: omitting
  // --tools on a fork falls back to the default tool set and misses most of the prefix). So every call re-sends the
  // root context block's settings; that is what "inherited" means in the editor.
  const inherited = (b: Block) => {
    const ctx = b.type === 'context' ? b : rootContext(g, b.id);
    const c = ctx?.config as ContextConfig | undefined;
    return c ? { model: c.model, effort: c.effort, tools: c.tools } : {};
  };
  const claudeCall = async (b: Block, call: Omit<Parameters<ClaudeRunner['run']>[0], 'runId' | 'blockId' | 'signal' | 'cwd'>) =>
    deps.claude.run({ ...inherited(b), ...call, cwd, runId: run.id, blockId: b.id, signal: deps.signal });

  /** Runs a prompt in a fork; if the answer has no parseable JSON, asks once more in the same fork. */
  async function promptJson(b: Block, resume: string, prompt: string, kind: 'array' | 'object', maxTurns: number, allowedTools: string[], sessions: ClaudeResult[]) {
    const r = await claudeCall(b, { prompt, resume, maxTurns, allowedTools });
    sessions.push(r);
    if (deps.signal.aborted) throw new BlockError('cancelled', { sessions });
    if (!r.sessionId) throw new BlockError(r.error ?? 'Claude returned no session', { sessions });
    let parsed = extractJson(r.text, kind);
    if (parsed === undefined && r.sessionId && r.ok) {
      const again = await claudeCall(b, {
        prompt: `Your last message did not contain valid JSON. Reply with ONLY the JSON ${kind}, nothing else.`,
        resume: r.sessionId, fork: false, maxTurns: 2, allowedTools,
      });
      sessions.push(again);
      parsed = extractJson(again.text, kind);
    }
    return { parsed, sessionId: r.sessionId, text: r.text };
  }

  async function runBlock(b: Block): Promise<BlockOutput> {
    const up = upstream(b.id);
    switch (b.type) {
      case 'scanner': {
        const c = b.config as ScannerConfig;
        const { findings, state: st } = await runScanner(c.scanner, b.id, files, change);
        return { findings, scanner: st, log: st.error ? [st.error] : [] };
      }
      case 'command': {
        const c = b.config as CommandConfig;
        const r = await exec('/bin/sh', ['-c', c.command], { cwd, timeoutMs: c.timeoutSec * 1000, signal: deps.signal });
        const text = `$ ${c.command}\n(exit ${r.code}${r.timedOut ? ', timed out' : ''})\n${truncate((r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim(), 20_000)}`;
        if (c.failOnNonZero && r.code !== 0) throw new BlockError(`Command exited ${r.code}`, { text });
        return { text };
      }
      case 'context': {
        const c = b.config as ContextConfig;
        const vars = { ...(await material.vars(c, up)), finding_schema: FINDING_SCHEMA };
        const r = await claudeCall(b, {
          prompt: render(c.prompt, vars), model: c.model, effort: c.effort, tools: c.tools, allowedTools: c.allowedTools, maxTurns: c.maxTurns,
        });
        // upstream findings (scanner hits) are context for the session, not passed on: they reach the results by their own edge
        const out: BlockOutput = { sessionId: r.sessionId, text: r.text, sessions: [r] };
        // A seed that ran out of turns still holds the context it gathered: forks can use it.
        if (!r.ok && !(r.sessionId && /max-turns/.test(r.error ?? ''))) throw new BlockError(r.error ?? 'Claude failed', out);
        if (!r.ok) out.log = [`Warning: ${r.error}; forks continue from what it gathered`];
        return out;
      }
      case 'branch':
        return { sessionId: sessionOf(b.id) ?? undefined };
      case 'prompt': {
        const c = b.config as PromptConfig;
        const resume = sessionOf(b.id);
        if (!resume) throw new BlockError('No session to fork (the upstream session block failed or produced none)');
        const vars = { ...(await material.vars({ includeDiff: true, includeFiles: false, budgetChars: 60_000 }, up)), finding_schema: FINDING_SCHEMA };
        const prompt = render(c.prompt, vars);
        const sessions: ClaudeResult[] = [];
        if (c.output === 'text') {
          const r = await claudeCall(b, { prompt, resume, maxTurns: c.maxTurns, allowedTools: c.allowedTools });
          sessions.push(r);
          if (!r.ok) throw new BlockError(r.error ?? 'Claude failed', { sessions, sessionId: r.sessionId });
          return { text: r.text, sessionId: r.sessionId, sessions, findings: up.findings };
        }
        const { parsed, sessionId, text } = await promptJson(b, resume, prompt, 'array', c.maxTurns, c.allowedTools, sessions);
        if (!Array.isArray(parsed)) throw new BlockError('The answer had no JSON array of findings', { sessions, sessionId, text: truncate(text, 4000) });
        const byId = new Map(up.findings.map((f) => [f.id, f]));
        const patched = new Map<string, Finding | null>();
        const fresh: Finding[] = [];
        const log: string[] = [];
        for (const item of parsed as any[]) {
          if (item && typeof item === 'object' && typeof item.id === 'string' && byId.has(item.id)) {
            const base = byId.get(item.id)!;
            if (item.severity === 'drop' || item.label === 'drop') { patched.set(item.id, null); log.push(`dropped ${base.title}: ${item.scenario ?? ''}`); continue; }
            const sev = ['must_fix', 'consider', 'minor'].includes(item.severity) ? item.severity as Severity : base.severity;
            patched.set(item.id, {
              ...base, severity: sev,
              scenario: typeof item.scenario === 'string' && item.scenario ? item.scenario : base.scenario,
              title: typeof item.title === 'string' && item.title ? item.title.slice(0, 200) : base.title,
              fix: typeof item.fix === 'string' && item.fix ? item.fix : base.fix,
              confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : base.confidence,
            });
          } else {
            const f = normalizeFinding(item, b.id, c.category);
            if (f) fresh.push(f);
          }
        }
        const kept = up.findings.map((f) => (patched.has(f.id) ? patched.get(f.id) : f)).filter((f): f is Finding => !!f);
        return { findings: [...kept, ...fresh], sessionId, sessions, log, text: truncate(text, 4000) };
      }
      case 'merge': {
        const c = b.config as MergeConfig;
        const merged = dedupe(up.findings, c.lineWindow);
        return { findings: merged, log: [`${up.findings.length} findings in, ${merged.length} after merging duplicates`] };
      }
      case 'verify': {
        const c = b.config as VerifyConfig;
        const resume = sessionOf(b.id);
        if (!resume) throw new BlockError('No session to fork (the upstream session block failed or produced none)');
        const sessions: ClaudeResult[] = [];
        const log: string[] = [];
        const targets = up.findings.filter((f) => c.appliesTo.includes(f.severity) && f.source.kind !== 'scanner');
        const results = new Map<string, Finding | null>();
        let next = 0;
        const worker = async () => {
          while (next < targets.length && !deps.signal.aborted) {
            const f = targets[next++];
            try {
              const prompt = render(c.prompt, { finding: JSON.stringify(slim(f), null, 1) });
              const { parsed } = await promptJson(b, resume, prompt, 'object', c.maxTurns, c.allowedTools, sessions);
              const v = parsed as any;
              if (v && typeof v === 'object' && typeof v.real === 'boolean') {
                if (!v.real) { results.set(f.id, null); log.push(`refuted: ${f.title}: ${v.note ?? ''}`); continue; }
                const sev = ['must_fix', 'consider', 'minor'].includes(v.severity) ? v.severity as Severity : f.severity;
                results.set(f.id, { ...f, severity: sev, verified: { real: true, note: String(v.note ?? '') } });
              } else {
                results.set(f.id, c.failClosed ? { ...f, severity: 'consider', verified: { real: false, note: 'Verifier gave no verdict; downgraded' } } : f);
                log.push(`no verdict for ${f.title}${c.failClosed ? ' (downgraded to consider)' : ''}`);
              }
            } catch (e: any) {
              if (e instanceof QuotaError || deps.signal.aborted) throw e;
              results.set(f.id, c.failClosed ? { ...f, severity: 'consider', verified: { real: false, note: `Verifier failed: ${e.message}` } } : f);
              log.push(`verifier failed for ${f.title}: ${e.message}`);
            }
          }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(c.concurrency, targets.length)) }, worker));
        if (deps.signal.aborted) throw new BlockError('cancelled', { sessions, log });
        const findings = up.findings.map((f) => (results.has(f.id) ? results.get(f.id) : f)).filter((f): f is Finding => !!f);
        log.unshift(`${targets.length} checked, ${targets.length - [...results.values()].filter(Boolean).length} refuted`);
        return { findings, sessions, log };
      }
      case 'gate': {
        const c = b.config as GateConfig;
        const bad: Finding[] = [];
        let suppressed = 0;
        if (deps.fingerprint) await deps.fingerprint(up.findings);
        for (const f of up.findings) {
          if (SEV_RANK[f.severity] < SEV_RANK[c.blockOn]) continue;
          if (deps.isSuppressed && await deps.isSuppressed(f)) { suppressed++; continue; }
          bad.push(f);
        }
        const log = [bad.length ? `${bad.length} finding(s) at ${c.blockOn} or worse` : 'clean'];
        if (suppressed) log.push(`${suppressed} dismissed/tracked finding(s) ignored`);
        return { findings: up.findings, pass: bad.length === 0, log };
      }
      case 'output': {
        // side effects (notification, PR comment) happen after the ledger is applied, in the run manager
        return { findings: dedupe(up.findings) };
      }
    }
  }

  const failedBlocks: string[] = [];
  const done = new Set<string>();
  const running = new Map<string, Promise<void>>();
  const needsSession = (b: Block) => b.type === 'prompt' || b.type === 'verify' || b.type === 'branch';

  const start = (b: Block) => {
    const ins = g.inputs.get(b.id)!;
    const bad = ins.filter((i) => ['failed', 'skipped', 'cancelled'].includes(state.get(i)!.status));
    const sessionLost = needsSession(b) && (() => {
      const s = sessionSource(g, b.id);
      return 'source' in s && ['failed', 'skipped', 'cancelled'].includes(state.get(s.source)!.status) && !state.get(s.source)!.output?.sessionId;
    })();
    if (deps.signal.aborted) {
      update(b.id, { status: 'cancelled', finishedAt: now() });
      return Promise.resolve();
    }
    if (sessionLost || (bad.length && bad.length === ins.length && b.type !== 'output')) {
      update(b.id, { status: 'skipped', finishedAt: now(), error: 'An input block did not complete' });
      return Promise.resolve();
    }
    update(b.id, { status: 'running', startedAt: now() });
    return runBlock(b).then(
      (output) => update(b.id, { status: 'done', finishedAt: now(), output }),
      (e: any) => {
        const cancelled = deps.signal.aborted;
        if (!cancelled) failedBlocks.push(b.id);
        update(b.id, {
          status: cancelled ? 'cancelled' : 'failed', finishedAt: now(), error: cancelled ? 'cancelled' : String(e?.message ?? e),
          output: e instanceof BlockError ? e.output : null,
        });
        if (e instanceof QuotaError) failedBlocks.push(`quota:${e.message}`);
      },
    );
  };

  while (done.size < flow.blocks.length) {
    for (const id of g.order) {
      if (done.has(id) || running.has(id)) continue;
      if (g.inputs.get(id)!.every((i) => done.has(i))) {
        const p = start(g.byId.get(id)!).then(() => { done.add(id); running.delete(id); });
        running.set(id, p);
      }
    }
    if (!running.size) break;
    await Promise.race(running.values());
  }

  const outputs = flow.blocks.filter((b) => b.type === 'output');
  const leaves = outputs.length ? outputs : flow.blocks.filter((b) => !g.outputs.get(b.id)!.length);
  const findings = dedupe(leaves.flatMap((b) => state.get(b.id)!.output?.findings ?? []));
  const gateFailed = flow.blocks.some((b) => b.type === 'gate' && state.get(b.id)!.output?.pass === false);
  return { blocks: state, findings, gateFailed, failedBlocks };
}
