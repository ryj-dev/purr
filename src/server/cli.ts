#!/usr/bin/env node
// purr command line: the daemon, the git hook entry points, manual runs and setup.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Finding, Run } from '../shared/types.ts';
import { ClaudeRunner } from './claude.ts';
import { openDb } from './db.ts';
import { ensureDefaults } from './flows/store.ts';
import { exportFlow, importFlow, previewImport } from './flows/share.ts';
import { readFileSync } from 'node:fs';
import { repoRoot } from './git.ts';
import { addRepo, startHttp } from './http.ts';
import { installGlobalHooks, removePidFile, uninstallGlobalHooks, writePidFile } from './globalHooks.ts';
import { type RunRequest, RunManager } from './manager.ts';
import { PostPushWatcher } from './triggers.ts';
import { exec, paths } from './util.ts';
import { SHIM } from './runtime.ts';

type HookName = 'pre-commit' | 'pre-push';
const ZERO = /^0+$/;
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function setup() {
  const db = openDb();
  ensureDefaults(db);
  const claude = new ClaudeRunner(db);
  const mgr = new RunManager(db, claude);
  claude.onUsage = (usage) => mgr.emit({ type: 'usage', usage });
  return { db, claude, mgr };
}

async function daemonPost(path: string, body: unknown, timeoutMs = 2000): Promise<any> {
  const db = openDb();
  const port = db.getSettings().port;
  db.close();
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const C = process.stderr.isTTY ? { red: '\x1b[31m', yel: '\x1b[33m', grn: '\x1b[32m', dim: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { red: '', yel: '', grn: '', dim: '', b: '', x: '' };

function report(run: Run, findings: Finding[]) {
  const counted = findings.filter((f) => f.ledger !== 'dismissed' && f.ledger !== 'tracked');
  const status = run.status === 'blocked' ? `${C.red}${C.b}BLOCKED${C.x}` : run.status === 'passed' ? `${C.grn}passed${C.x}`
    : `${C.yel}${run.status}${C.x}`;
  process.stderr.write(`purr · ${run.trigger} · ${run.flowName}: ${status}${run.error ? ` ${C.dim}(${run.error})${C.x}` : ''}\n`);
  for (const f of counted) {
    const sev = f.severity === 'must_fix' ? `${C.red}must_fix${C.x}` : f.severity === 'consider' ? `${C.yel}consider${C.x}` : 'minor   ';
    const src = f.source.scanner ? ` ${C.dim}(${f.source.scanner} ${f.source.rule})${C.x}` : '';
    process.stderr.write(`  ${sev}  ${f.file}${f.line ? `:${f.line}` : ''}${f.lines && f.lines.length > 1 ? ` (+${f.lines.length - 1} more)` : ''}  ${f.title}${src}\n`);
    if (f.fix) process.stderr.write(`            ${C.dim}fix: ${f.fix}${C.x}\n`);
  }
}

/** Runs a hook flow in this process (fast, no daemon needed), then tells the daemon so the UI updates. */
async function runHookFlow(req: RunRequest): Promise<Run | null> {
  const { db, mgr } = setup();
  const run = mgr.createRun(req);
  if (!run) { db.close(); return null; }
  const done = await mgr.execute(req, run);
  report(done, db.getRunFindings(done.id));
  await daemonPost('/api/hooks/notify', { runId: done.id });
  db.close();
  return done;
}

async function hook(name: HookName) {
  const repoPath = await repoRoot(process.cwd());
  if (!repoPath) return 0;
  try {
    // PuRR covers every repo: the first commit or push through it registers the repo (for the poller, ledger and settings)
    { const db = openDb(); try { await addRepo(db, repoPath); } finally { db.close(); } }
    if (name === 'pre-commit') {
      const run = await runHookFlow({ trigger: 'pre-commit', repoPath, mode: 'staged' });
      if (run?.status === 'blocked') {
        process.stderr.write(`${C.dim}Commit blocked by purr. Fix the above, dismiss a false positive in the purr UI (Findings), or skip once with PURR_SKIP=1.${C.x}\n`);
        return 1;
      }
      return 0;
    }
    // pre-push: stdin lines "<local ref> <local sha> <remote ref> <remote sha>"; argv: <remote name> <url>
    const remote = args[2] || 'origin';
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    const refs = Buffer.concat(chunks).toString().split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 4);
    const pushed: Array<{ branch: string; sha: string }> = [];
    for (const [localRef, localSha, remoteRef, remoteSha] of refs) {
      if (ZERO.test(localSha) || !remoteRef.startsWith('refs/heads/')) continue; // branch deletion or tag
      const branch = remoteRef.slice('refs/heads/'.length);
      const run = await runHookFlow({
        trigger: 'pre-push', repoPath, mode: 'range', head: localSha, base: ZERO.test(remoteSha) ? null : remoteSha,
        branch: localRef.startsWith('refs/heads/') ? localRef.slice(11) : branch,
      });
      if (run?.status === 'blocked') {
        process.stderr.write(`${C.dim}Push blocked by purr. Fix the above, dismiss a false positive in the purr UI (Findings), or skip once with PURR_SKIP=1.${C.x}\n`);
        return 1;
      }
      pushed.push({ branch, sha: localSha });
    }
    for (const p of pushed) {
      const r = await daemonPost('/api/hooks/push-intent', { repoPath, branch: p.branch, sha: p.sha, remote });
      if (r?.queued) process.stderr.write(`${C.dim}purr: ${p.branch} will be reviewed once the push lands${r.prOnly ? ' (if it has an open PR)' : ''}${C.x}\n`);
    }
    return 0;
  } catch (e: any) {
    // PuRR must never stop you committing because of its own bug
    process.stderr.write(`purr: hook error, not blocking: ${e?.message ?? e}\n`);
    return 0;
  }
}

async function daemon() {
  const { db, mgr } = setup();
  const orphans = db.failOrphanRuns();
  if (!process.env.PURR_NO_GLOBAL_HOOKS) {
    try {
      const g = await installGlobalHooks();
      if (g.changed) console.log(`purr: git hooks now run for every repo (core.hooksPath)${g.previous ? `; your previous hooks path ${g.previous} still runs` : ''}`);
    } catch (e: any) {
      console.error(`purr: couldn't install the global git hooks: ${e?.message ?? e}`);
    }
  }
  const watcher = new PostPushWatcher(db, mgr);
  const port = Number(flag('port') ?? db.getSettings().port);
  const server = startHttp(db, mgr, watcher, port);
  server.on('error', (e: any) => {
    console.error(e.code === 'EADDRINUSE' ? `purr: port ${port} is in use (is the daemon already running?)` : e);
    process.exit(1);
  });
  server.on('listening', () => {
    writePidFile();
    console.log(`purr daemon ${orphans ? `(marked ${orphans} interrupted run(s) failed) ` : ''}listening on http://127.0.0.1:${port}`);
    watcher.start();
  });
  const stop = () => { removePidFile(); watcher.stop(); server.close(); db.close(); process.exit(0); };
  process.on('exit', removePidFile);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function manualRun() {
  const repoPath = await repoRoot(flag('repo') ?? process.cwd());
  if (!repoPath) { console.error('Not inside a git repository'); return 2; }
  const { db, mgr } = setup();
  const req: RunRequest = { trigger: 'manual', repoPath, mode: 'range', flowId: flag('flow') ?? null, base: flag('base') ?? null, head: flag('head') ?? null };
  const run = mgr.createRun(req);
  if (!run) { console.error('The manual trigger is disabled for this repo; pass --flow <id>'); return 2; }
  process.stderr.write(`purr: running "${run.flowName}" (${run.id})…\n`);
  const done = await mgr.execute(req, run);
  const findings = db.getRunFindings(done.id);
  if (args.includes('--json')) console.log(JSON.stringify({ run: { ...done, flow: undefined }, findings }, null, 2));
  else report(done, findings);
  await daemonPost('/api/hooks/notify', { runId: done.id });
  db.close();
  if (done.status === 'failed' || done.status === 'cancelled') return 2;
  return done.counts.must_fix > 0 ? 1 : 0;
}

/** `purr flow export <id> [--json]` prints a flow as share text; `purr flow import [file|-] [--yes]` reads one back. */
async function flowCmd(sub: string | undefined, arg: string | undefined): Promise<number> {
  const db = openDb();
  ensureDefaults(db);
  try {
    if (sub === 'list') {
      for (const f of db.listFlows()) console.log(`${f.id.padEnd(22)} ${f.name}${f.isDefault ? '  (default)' : ''}`);
      return 0;
    }
    if (sub === 'export') {
      const f = arg && !arg.startsWith('--') ? db.getFlow(arg) : null;
      if (!f) { console.error('Usage: purr flow export <flow id> [--json]   (ids: purr flow list)'); return 2; }
      const e = exportFlow(f);
      console.log(args.includes('--json') ? e.json : e.text);
      return 0;
    }
    if (sub === 'import') {
      const src = arg && !arg.startsWith('--') && arg !== '-' ? readFileSync(arg, 'utf8') : await new Promise<string>((res) => {
        let t = ''; process.stdin.on('data', (d) => { t += d; }).on('end', () => res(t));
      });
      const p = previewImport(src);
      process.stderr.write(`${C.b}${p.name}${C.x}: ${p.blocks.length} blocks, ${p.edges.length} connections\n`);
      for (const n of p.notes) process.stderr.write(`  ${C.dim}note: ${n}${C.x}\n`);
      for (const r of p.risks) process.stderr.write(`  ${r.level === 'danger' ? C.red : r.level === 'warn' ? C.yel : C.dim}${r.level}${C.x}  ${r.label}: ${r.message}${r.detail ? `\n           ${C.dim}${r.detail}${C.x}` : ''}\n`);
      const errors = p.issues.filter((i) => i.level === 'error');
      if (errors.length) process.stderr.write(`  ${C.yel}${errors.length} validation error(s): fix them in the editor before assigning it to a trigger${C.x}\n`);
      if (p.risks.some((r) => r.level !== 'info') && !args.includes('--yes')) {
        process.stderr.write(`Read the above, then run again with --yes to import it.\n`);
        return 1;
      }
      const f = importFlow(db, src);
      console.log(`Imported "${f.name}" (${f.id}). It isn't assigned to any trigger yet.`);
      return 0;
    }
    console.error('Usage: purr flow list | export <id> [--json] | import [file|-] [--yes]');
    return 2;
  } catch (e: any) {
    console.error(`purr: ${e?.message ?? e}`);
    return 2;
  } finally {
    db.close();
  }
}

const PLIST = join(homedir(), 'Library/LaunchAgents/com.purr.daemon.plist');
async function agent(action: string | undefined) {
  if (action === 'install' && process.env.PURR_APP_BUNDLE) {
    console.error('PuRR.app starts the service itself: use "Start at login" in its tray menu instead.');
    return 2;
  }
  if (action === 'install') {
    mkdirSync(join(homedir(), 'Library/LaunchAgents'), { recursive: true });
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.purr.daemon</string>
  <key>ProgramArguments</key><array>
    <string>${esc(SHIM)}</string><string>daemon</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(process.env.PATH ?? '/usr/bin:/bin')}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(join(paths.logs, 'daemon.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(join(paths.logs, 'daemon.log'))}</string>
</dict></plist>
`);
    await exec('launchctl', ['unload', PLIST]).catch(() => null);
    const r = await exec('launchctl', ['load', '-w', PLIST]);
    console.log(r.code === 0 ? `Installed and started: ${PLIST}` : `Wrote ${PLIST} but launchctl failed: ${r.stderr}`);
    return r.code === 0 ? 0 : 1;
  }
  if (action === 'uninstall') {
    await exec('launchctl', ['unload', '-w', PLIST]).catch(() => null);
    rmSync(PLIST, { force: true });
    console.log('Removed the launch agent');
    return 0;
  }
  console.error('Usage: purr agent install|uninstall');
  return 2;
}

const USAGE = `PuRR: Pull Request Reviewer

  purr daemon [--port N]          run the background daemon + UI (http://127.0.0.1:7878)
  purr open                       open the UI in your browser
  purr run [--repo P] [--flow ID] [--base REF] [--head REF] [--json]
                                 run a flow now on the current branch (exit 0 clean, 1 must-fix, 2 failed)
  purr repo add [PATH]            register a repository (default: current)
  purr hooks install|uninstall    git hooks for every repo (the service installs them on start);
                                 uninstall restores your previous core.hooksPath
  purr flow list | export <id> [--json] | import [file|-] [--yes]
                                 share flows as text
  purr agent install|uninstall    start the daemon at login (macOS launchd)
  purr hook pre-commit|pre-push   (called by the installed git hooks)
`;

async function main(): Promise<number> {
  const [cmd, sub] = args;
  switch (cmd) {
    case 'daemon': await daemon(); return -1;
    case 'hook': return hook(sub as HookName);
    case 'run': return manualRun();
    case 'open': {
      const db = openDb();
      await exec('open', [`http://127.0.0.1:${db.getSettings().port}`]);
      return 0;
    }
    case 'repo': {
      if (sub !== 'add') break;
      const db = openDb();
      const r = await addRepo(db, args[2] ?? process.cwd());
      console.log(`Registered ${r.path}`);
      return 0;
    }
    case 'hooks': {
      if (sub === 'uninstall') { console.log(await uninstallGlobalHooks()); return 0; }
      if (sub === 'install') { const g = await installGlobalHooks(); console.log(`purr hooks run for every repo (${g.changed ? 'installed' : 'already installed'})`); return 0; }
      break;
    }
    case 'flow': return flowCmd(sub, args[2]);
    case 'agent': return agent(sub);
  }
  process.stdout.write(USAGE);
  return cmd ? 2 : 0;
}

main().then((code) => { if (code >= 0) process.exit(code); }, (e) => { console.error(e); process.exit(2); });
