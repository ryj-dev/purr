import { FAKE_SECRET, FAKE_CLAUDE, sh, tempRepo } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { openDb } from '../src/server/db.ts';
import { ensureDefaults } from '../src/server/flows/store.ts';
import { ClaudeRunner } from '../src/server/claude.ts';
import { RunManager } from '../src/server/manager.ts';
import { addRepo, startHttp } from '../src/server/http.ts';
import { PostPushWatcher } from '../src/server/triggers.ts';

const log = join(process.env.PURR_HOME!, 'claude-calls.jsonl');
process.env.FAKE_CLAUDE_LOG = log;

function setup() {
  const db = openDb();
  ensureDefaults(db);
  db.setSettings({ ...db.getSettings(), claudeBin: FAKE_CLAUDE, claudeExtraArgs: [], notifications: false });
  const claude = new ClaudeRunner(db);
  return { db, mgr: new RunManager(db, claude) };
}

function featureRepo() {
  const repo = tempRepo({ 'app.js': 'export const x = 1;\n' });
  sh(repo, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(repo, 'app.js'), `export const x = 1;\nexport const awsKey = "${FAKE_SECRET}";\n\nexport function avg(total, count) {\n  return total / count;\n}\n`);
  sh(repo, 'commit', '-qam', 'add avg', '--no-verify');
  return repo;
}

test('full review flow: scanners -> seed -> branch x6 -> merge -> severity -> verify -> output', async () => {
  const { db, mgr } = setup();
  const repo = featureRepo();
  await addRepo(db, repo);
  const req = { trigger: 'manual' as const, repoPath: repo, mode: 'range' as const, flowId: 'default-review' };
  const run = mgr.createRun(req)!;
  const done = await mgr.execute(req, run);
  assert.equal(done.status, 'passed', done.error ?? '');
  assert.ok(done.baseSha && done.headSha && done.baseSha !== done.headSha);

  const blocks = db.listBlockRuns(run.id);
  const byId = Object.fromEntries(blocks.map((b) => [b.blockId, b]));
  for (const b of blocks) assert.equal(b.status, 'done', `${b.blockId}: ${b.error}`);
  // betterleaks, or the gitleaks it falls back to on a machine without it: real tools, the same report
  assert.equal(byId['scan-betterleaks'].output?.scanner?.state, 'ran');
  assert.equal(byId['scan-betterleaks'].output?.findings?.length, 1, 'the secrets scanner flags the AWS key');
  assert.equal(byId['scan-zizmor'].output?.scanner?.state, 'n/a');
  assert.equal(byId['scan-hadolint'].output?.scanner?.state, 'n/a', 'no Dockerfile changed');
  assert.equal(byId['scan-actionlint'].output?.scanner?.state, 'n/a', 'no workflow changed');

  // every lens forked the seed session
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const seedSid = byId['context'].output!.sessionId!;
  const lensCalls = calls.filter((c) => /lens/i.test(c.head) || c.resume === seedSid);
  assert.equal(lensCalls.filter((c) => c.resume === seedSid).length, 6 + 1 + 2, 'six lenses + severity + two verifies fork the seed');
  assert.ok(calls.every((c) => !c.resume || c.args.includes('--fork-session')));
  const seedCall = calls.find((c) => c.sid === seedSid)!;
  const opt = (c: any, f: string) => c.args[c.args.indexOf(f) + 1];
  assert.ok(calls.filter((c) => c.resume).every((c) => opt(c, '--model') === opt(seedCall, '--model') && opt(c, '--tools') === opt(seedCall, '--tools')),
    'forks re-send the seed model and tool list (needed for cache hits)');

  const findings = db.getRunFindings(run.id);
  const titles = findings.map((f) => f.title);
  assert.ok(titles.some((t) => /secret is committed/.test(t)), 'scanner finding reaches the results');
  assert.ok(!titles.some((t) => /Speculative/.test(t)), 'severity drop removed the speculative finding');
  const div = findings.find((f) => /Divides/.test(f.title));
  assert.equal(div?.severity, 'consider');
  assert.ok(findings.every((f) => f.fingerprint && f.ledger === 'new'));
  // the security lens' AWS-key finding duplicates the secrets scanner's hit: merged into it, scanner copy wins
  const key = findings.find((f) => f.source.scanner === 'betterleaks' || f.source.scanner === 'gitleaks')!;
  assert.deepEqual(key.alsoFoundBy, ['lens-security']);
  // the verifier refuted the concurrency lens' must-fix, so it is gone
  assert.ok(!titles.some((t) => /Race on shared counter/.test(t)), 'refuted finding dropped');
  assert.match(byId['verify'].output!.log!.join(' '), /2 checked, 1 refuted/);
  assert.match(byId['merge'].output!.log!.join(' '), /^4 findings in, 4 after/);
  assert.equal(db.getUsage().fiveHour, 0.12);

  // second run of the same change: the ledger recognises them; dismissing one excludes it from counts
  const fp = findings.find((f) => /Divides/.test(f.title))!.fingerprint!;
  db.putLedger({ ...db.findLedgerByFingerprint(fp)!, state: 'dismissed' });
  const run2 = mgr.createRun(req)!;
  const done2 = await mgr.execute(req, run2);
  const f2 = db.getRunFindings(run2.id);
  assert.equal(f2.find((f) => f.fingerprint === fp)?.ledger, 'dismissed');
  assert.ok(f2.filter((f) => f.fingerprint !== fp).every((f) => f.ledger === 'open'));
  assert.equal(done2.counts.consider, 0);
  db.close();
});

test('pre-commit default flow blocks a staged secret and passes clean changes; dismissing unblocks', async () => {
  const { db, mgr } = setup();
  const repo = tempRepo();
  await addRepo(db, repo);
  writeFileSync(join(repo, 'config.js'), `module.exports = { key: "${FAKE_SECRET}" };\n`);
  sh(repo, 'add', 'config.js');
  const req = { trigger: 'pre-commit' as const, repoPath: repo, mode: 'staged' as const };
  const r1 = await mgr.execute(req, mgr.createRun(req)!);
  assert.equal(r1.status, 'blocked');
  const fp = db.getRunFindings(r1.id)[0].fingerprint!;
  db.putLedger({ ...db.findLedgerByFingerprint(fp)!, state: 'dismissed' });
  const r2 = await mgr.execute(req, mgr.createRun(req)!);
  assert.equal(r2.status, 'passed', 'a dismissed finding no longer blocks');

  writeFileSync(join(repo, 'config.js'), 'module.exports = { key: process.env.KEY };\n');
  sh(repo, 'add', 'config.js');
  const r3 = await mgr.execute(req, mgr.createRun(req)!);
  assert.equal(r3.status, 'passed');
  db.close();
});

test('a repo registered before it had a remote picks the remote up later', async () => {
  const db = openDb();
  const repo = tempRepo();
  const r = await addRepo(db, repo);
  assert.equal(r.remoteUrl, null);
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/example/demo.git');
  const again = await addRepo(db, repo);
  assert.equal(again.id, r.id);
  assert.equal(again.remoteUrl, 'https://github.com/example/demo.git');
  assert.equal(db.getRepo(r.id)!.remoteUrl, 'https://github.com/example/demo.git');
  db.close();
});

test('disabled trigger returns no run; repo override beats global', async () => {
  const { db, mgr } = setup();
  const repo = tempRepo();
  const r = await addRepo(db, repo);
  db.setTrigger({ trigger: 'pre-commit', repoId: r.id, flowId: null });
  assert.equal(mgr.createRun({ trigger: 'pre-commit', repoPath: repo, mode: 'staged' }), null);
  db.setTrigger({ trigger: 'pre-commit', repoId: r.id, flowId: 'default-pre-push' });
  assert.equal(mgr.createRun({ trigger: 'pre-commit', repoPath: repo, mode: 'staged' })!.flowId, 'default-pre-push');
  db.deleteTrigger('pre-commit', r.id);
  assert.equal(mgr.createRun({ trigger: 'pre-commit', repoPath: repo, mode: 'staged' })!.flowId, 'default-pre-commit');
  db.close();
});

test('HTTP API: state, default flows read-only, duplicate/edit/delete, triggers, validation', async () => {
  const { db, mgr } = setup();
  const server = startHttp(db, mgr, new PostPushWatcher(db, mgr), 0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as any).port;
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: r.status === 204 ? null : await r.json() };
  };
  try {
    const st = await api('GET', '/api/state');
    assert.equal(st.status, 200);
    assert.ok(st.json.flows.some((f: any) => f.id === 'default-review' && f.isDefault));
    assert.equal((await api('PUT', '/api/flows/default-review', { name: 'x' })).status, 403);
    assert.equal((await api('DELETE', '/api/flows/default-review')).status, 403);
    // preference options stay editable on read-only defaults, and survive the defaults being rewritten from code
    const opt = await api('PATCH', '/api/flows/default-review/blocks/out/options', { notify: false, postPrComment: true });
    assert.equal(opt.status, 200);
    assert.deepEqual(opt.json.blocks.find((b: any) => b.id === 'out').config, { notify: false, postPrComment: true });
    ensureDefaults(db);
    const again = (await api('GET', '/api/flows/default-review')).json;
    assert.equal(again.blocks.find((b: any) => b.id === 'out').config.notify, false, 'override survives ensureDefaults');
    assert.equal(again.isDefault, true);
    assert.equal((await api('PATCH', '/api/flows/default-review/blocks/out/options', { model: 'x' })).status, 400);
    assert.equal((await api('PATCH', '/api/flows/default-review/blocks/context/options', { notify: true })).status, 400);
    assert.equal((await api('PATCH', '/api/flows/default-review/blocks/out/options', { notify: 'yes' })).status, 400);
    await api('PATCH', '/api/flows/default-review/blocks/out/options', { notify: true, postPrComment: false });
    const dup = await api('POST', '/api/flows', { duplicateOf: 'default-review' });
    assert.equal(dup.status, 201);
    assert.equal(dup.json.isDefault, false);
    assert.equal(dup.json.blocks.length, 17, 'five scanners, context, branch, six lenses, merge, severity, verify, results');
    const edited = await api('PUT', `/api/flows/${dup.json.id}`, { name: 'Mine', blocks: dup.json.blocks.filter((b: any) => b.id !== 'lens-tests'), edges: dup.json.edges.filter((e: any) => !e.id.includes('lens-tests')) });
    assert.equal(edited.json.name, 'Mine');
    assert.equal(edited.json.blocks.length, 16);
    const t = await api('PUT', '/api/triggers', { trigger: 'post-push', repoId: null, flowId: dup.json.id });
    assert.ok(t.json.some((x: any) => x.trigger === 'post-push' && x.flowId === dup.json.id));
    assert.equal((await api('DELETE', `/api/flows/${dup.json.id}`)).status, 204);
    const after = await api('GET', '/api/triggers');
    assert.ok(after.json.some((x: any) => x.trigger === 'post-push' && x.repoId === null && x.flowId === 'default-review'), 'deleting falls back to the default');
    const v = await api('POST', '/api/flows/validate', { blocks: [{ id: 'p', type: 'prompt', label: 'p', position: { x: 0, y: 0 }, config: { prompt: 'x', allowedTools: [], output: 'text', forkFrom: null, maxTurns: 1, category: 'x' } }], edges: [] });
    assert.ok(v.json.some((i: any) => i.level === 'error' && /session/.test(i.message)));
    assert.equal((await api('GET', '/api/block-types')).json.length, 9);
    const bad = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { origin: 'https://evil.example' } });
    assert.equal(bad.status, 403, 'cross-origin requests are refused');
    const repo = tempRepo();
    const added = await api('POST', '/api/repos', { path: repo });
    assert.equal(added.status, 201);
  } finally {
    server.close();
    db.close();
  }
});
