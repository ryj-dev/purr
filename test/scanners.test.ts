// The five scanners, with fake tools on PATH: what each is given, and what PuRR makes of what it says.
import { FAKE_AWS, sh, tempRepo } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runScanner } from '../src/server/scanners.ts';
import { changedFiles, type ChangeSpec } from '../src/server/git.ts';
import { fingerprint } from '../src/server/engine/findings.ts';
import { DEFAULT_FLOWS } from '../src/server/flows/defaults.ts';
import { exportFlow, previewImport } from '../src/server/flows/share.ts';
import { foundBy } from '../src/shared/scanners.ts';
import type { Finding } from '../src/shared/types.ts';

/** A folder of fake tools, put first on PATH with only the system's own folders after it (git is in /usr/bin). */
function fakeTools(tools: Record<string, string>) {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR!, 'purr-scanners-')));
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(dir, name), `#!/bin/sh\nD="${dir}"\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  const path = process.env.PATH;
  process.env.PATH = `${dir}:/usr/bin:/bin:/usr/sbin:/sbin`;
  return { dir, restore: () => { process.env.PATH = path; } };
}

// A secrets scanner: notes its arguments and folder, keeps a copy of what it was shown, and reports each AKIA line.
const SECRETS = `printf '%s\\n' "$@" > "$D/$(basename "$0").args"
pwd > "$D/cwd"
while [ $# -gt 0 ]; do case "$1" in dir) shift; root="$1";; -r) shift; rep="$1";; esac; shift; done
cp -R "$root" "$D/seen"
grep -rn AKIA "$root" | awk -F: 'BEGIN { printf "[" } { if (NR > 1) printf ","; printf "{\\"File\\":\\"%s\\",\\"StartLine\\":%s,\\"RuleID\\":\\"aws-access-token\\",\\"Description\\":\\"AWS\\",\\"Secret\\":\\"REDACTED\\"}", $1, $2 } END { printf "]" }' > "$rep"`;

// hadolint / actionlint: answer from a fixture named after the file, or fail if there's none
const FROM_FIXTURE = (tool: string, failCode: number) => `for a; do f="$a"; done
x="$D/${tool}-$(echo "$f" | tr / _).json"
[ -f "$x" ] || { echo "cannot read $f" >&2; exit 2; }
cat "$x"; exit ${failCode}`;

async function staged(files: Record<string, string>, base: Record<string, string> = {}) {
  const repo = tempRepo({ 'README.md': '# demo\n', ...base });
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(repo, p, '..'), { recursive: true });
    writeFileSync(join(repo, p), body);
  }
  sh(repo, 'add', '-A');
  const change: ChangeSpec = { mode: 'staged', cwd: repo, base: null, head: null };
  return { repo, change, files: await changedFiles(change) };
}

test('betterleaks sees only the added lines, never validates or redacts nothing, and runs outside the repo', async () => {
  const { repo, change, files } = await staged({
    'app.js': `const a = 1;\nconst key = "${FAKE_AWS}";\n`,
    '.betterleaks.toml': `# a change's own config must not steer its scan\n# "${FAKE_AWS}"\n`,
  }, { 'app.js': 'const a = 1;\n' });
  const t = fakeTools({ betterleaks: SECRETS });
  try {
    const r = await runScanner('betterleaks', 'scan-betterleaks', files, change);
    assert.equal(r.state.state, 'ran', r.state.error ?? '');
    assert.deepEqual(r.findings.map((f) => [f.file, f.line, f.source.scanner, f.source.rule, f.severity, f.category]),
      [['app.js', 2, 'betterleaks', 'aws-access-token', 'must_fix', 'secrets']]);
    assert.match(r.findings[0].scenario, /real AWS access token/);
    assert.ok(!JSON.stringify(r.findings).includes(FAKE_AWS), 'the secret itself is never kept');
    const args = readFileSync(join(t.dir, 'betterleaks.args'), 'utf8').split('\n');
    for (const a of ['--validation=false', '--redact', '--no-banner']) assert.ok(args.includes(a), a);
    assert.equal(readFileSync(join(t.dir, 'seen', 'app.js'), 'utf8'), `\nconst key = "${FAKE_AWS}";\n`, 'line 1 blank: it was already there');
    assert.ok(!existsSync(join(t.dir, 'seen', '.betterleaks.toml')), 'its own scanner config is never scanned or used');
    assert.notEqual(readFileSync(join(t.dir, 'cwd'), 'utf8').trim(), realpathSync(repo), "not run in the repo, where its config would apply");
  } finally { t.restore(); }
});

test('without betterleaks, gitleaks does the job; with neither, the scanner says betterleaks is missing', async () => {
  const { change, files } = await staged({ 'app.js': `const key = "${FAKE_AWS}";\n` });
  let t = fakeTools({ gitleaks: SECRETS });
  try {
    const r = await runScanner('betterleaks', 'scan-betterleaks', files, change);
    assert.equal(r.state.state, 'ran', r.state.error ?? '');
    assert.equal(r.findings[0].source.scanner, 'gitleaks', 'says which one ran');
    assert.ok(!readFileSync(join(t.dir, 'gitleaks.args'), 'utf8').includes('--validation'), "gitleaks has no such flag (and never validates)");
  } finally { t.restore(); }
  t = fakeTools({});
  try {
    const r = await runScanner('betterleaks', 'scan-betterleaks', files, change);
    assert.deepEqual([r.state.state, r.state.error], ['not installed', 'betterleaks is not on PATH']);
  } finally { t.restore(); }
  // a flow saved with gitleaks runs betterleaks
  t = fakeTools({ betterleaks: SECRETS });
  try {
    const r = await runScanner('gitleaks', 'scan-gitleaks', files, change);
    assert.equal(r.findings[0].source.scanner, 'betterleaks');
  } finally { t.restore(); }
});

test('a secrets scanner that writes no readable report fails, never a clean pass', async () => {
  const { change, files } = await staged({ 'app.js': 'x\n' });
  const t = fakeTools({ betterleaks: 'exit 0' });
  try {
    const r = await runScanner('betterleaks', 'b', files, change);
    assert.equal(r.state.state, 'failed');
    assert.match(r.state.error!, /no readable report/);
  } finally { t.restore(); }
});

test('hadolint: errors on added lines only, as consider; a file it couldn\'t read makes the scan partial', async () => {
  const { change, files } = await staged({
    'Dockerfile': 'FROM alpine\nRUN apt-get install curl\nRUN cd /tmp\n',
    'api/Dockerfile': 'FROM node\n',
  }, { 'Dockerfile': 'FROM alpine\n' });
  const t = fakeTools({ hadolint: FROM_FIXTURE('hadolint', 0) });
  writeFileSync(join(t.dir, 'hadolint-Dockerfile.json'), JSON.stringify([
    { line: 1, code: 'DL3006', message: 'Always tag the version of an image explicitly', level: 'error', file: 'Dockerfile' },   // not added
    { line: 2, code: 'DL3009', message: 'Delete the apt-get lists after installing something', level: 'error', file: 'Dockerfile' },
    { line: 3, code: 'DL3003', message: 'Use WORKDIR to switch to a directory', level: 'warning', file: 'Dockerfile' },          // not an error
  ]));
  try {
    const r = await runScanner('hadolint', 'scan-hadolint', files, change);
    assert.deepEqual(r.findings.map((f) => [f.file, f.line, f.source.rule, f.severity, f.category]), [['Dockerfile', 2, 'DL3009', 'consider', 'lint']]);
    assert.match(r.findings[0].title, /^Dockerfile problem: Delete the apt-get lists/);
    assert.equal(r.state.state, 'partial');
    assert.deepEqual(r.state.incomplete?.map((x) => x.file), ['api/Dockerfile']);
    assert.match(r.state.incomplete![0].reason, /hadolint exited 2: cannot read/);
  } finally { t.restore(); }
  // every file failing: failed, not a quiet "nothing found"
  const only = await staged({ 'Dockerfile': 'FROM node\n' });
  const t2 = fakeTools({ hadolint: FROM_FIXTURE('hadolint', 0) });
  try { assert.equal((await runScanner('hadolint', 'h', only.files, only.change)).state.state, 'failed'); } finally { t2.restore(); }
});

test('actionlint: workflow errors on added lines, as consider; nothing to check is n/a', async () => {
  const wf = '.github/workflows/ci.yml';
  const { change, files } = await staged({ [wf]: 'on: push\njobs:\n  x:\n    runs-on: ubuntu-latest\n' });
  const t = fakeTools({ actionlint: FROM_FIXTURE('actionlint', 1) });
  writeFileSync(join(t.dir, `actionlint-${wf.replace(/\//g, '_')}.json`), JSON.stringify([
    { message: '"steps" section is missing in job "x"', filepath: wf, line: 3, column: 3, kind: 'syntax-check' },
  ]));
  try {
    const r = await runScanner('actionlint', 'scan-actionlint', files, change);
    assert.equal(r.state.state, 'ran', r.state.error ?? '');
    assert.deepEqual(r.findings.map((f) => [f.file, f.line, f.source.rule, f.severity]), [[wf, 3, 'syntax-check', 'consider']]);
    const none = await staged({ 'app.js': 'x\n' });
    assert.equal((await runScanner('actionlint', 'a', none.files, none.change)).state.state, 'n/a');
    assert.equal((await runScanner('hadolint', 'h', none.files, none.change)).state.state, 'n/a');
  } finally { t.restore(); }
});

test('a secret dismissed when gitleaks found it keeps its identity now betterleaks finds it', () => {
  const f = (scanner: 'gitleaks' | 'betterleaks'): Finding => ({ id: 'x', file: 'app.js', line: 2, category: 'secrets', severity: 'must_fix',
    title: 'A secret', scenario: 's', source: { blockId: `scan-${scanner}`, kind: 'scanner', scanner, rule: 'aws-access-token' } });
  const content = 'a\nb\nc\n';
  assert.equal(fingerprint(f('betterleaks'), content), fingerprint(f('gitleaks'), content));
});

test("a secret raised by the old scan-gitleaks block is marked fixed when the full review's scan-betterleaks no longer finds it", async () => {
  const { openDb } = await import('../src/server/db.ts');
  const { applyLedger } = await import('../src/server/ledger.ts');
  const db = openDb(join(mkdtempSync(join(process.env.TMPDIR!, 'purr-db-')), 'purr.db'));
  const old: Finding = { id: 'x', file: 'app.js', line: 2, category: 'secrets', severity: 'must_fix', title: 'A secret', scenario: 's', fingerprint: 'fp-old',
    source: { blockId: 'scan-gitleaks', kind: 'scanner', scanner: 'gitleaks', rule: 'aws-access-token' } };
  db.putLedger({ fingerprint: 'fp-old', repoId: 'r1', branch: 'feat', state: 'open', flowId: 'default-review', finding: old, firstRunId: 'r0', lastRunId: 'r0', updatedAt: 'x' });
  const run = { id: 'r1run', repoId: 'r1', branch: 'feat', flowId: 'default-review', trigger: 'post-push', mode: 'range' } as any;
  applyLedger(db, run, [], new Set(['scan-betterleaks', 'context']));
  assert.equal(db.getLedger('fp-old', 'r1')?.state, 'fixed');
  db.close();
});

test('the default flows: pre-commit is betterleaks, pre-push the blocking three, the full review all five', () => {
  const scanners = (id: string) => DEFAULT_FLOWS.find((x) => x.id === id)!.blocks.filter((b) => b.type === 'scanner').map((b) => (b.config as any).scanner);
  assert.deepEqual(scanners('default-pre-commit'), ['betterleaks']);
  assert.deepEqual(scanners('default-pre-push'), ['betterleaks', 'zizmor', 'osv']);
  assert.deepEqual(scanners('default-review'), ['betterleaks', 'zizmor', 'osv', 'hadolint', 'actionlint']);
  const review = DEFAULT_FLOWS.find((x) => x.id === 'default-review')!;
  for (const s of ['hadolint', 'actionlint']) {
    assert.ok(review.edges.some((e) => e.source === `scan-${s}` && e.target === 'out'), `${s} straight to the results`);
    assert.ok(review.edges.some((e) => e.source === `scan-${s}` && e.target === 'context'), `${s} feeds the context`);
  }
  assert.ok(!JSON.stringify(DEFAULT_FLOWS).includes('gitleaks'));
});

test('a shared flow with a gitleaks scanner imports as betterleaks, and says so', () => {
  const flow = DEFAULT_FLOWS.find((x) => x.id === 'default-pre-commit')!;
  const json = exportFlow(flow).json.replace(/"betterleaks"/g, '"gitleaks"');
  const p = previewImport(json);
  assert.equal((p.blocks.find((b) => b.type === 'scanner')!.config as any).scanner, 'betterleaks');
  assert.ok(p.notes.some((n) => /gitleaks is now betterleaks/.test(n)), p.notes.join(' | '));
});

test('a scanner finding says which tool found it and what that tool is', () => {
  const by = (scanner: any, rule: string) => foundBy({ id: 'x', file: 'f', line: 1, category: 'c', severity: 'consider', title: 't', scenario: 's',
    source: { blockId: 'b', kind: 'scanner', scanner, rule } });
  assert.match(by('hadolint', 'DL3009'), /Found by \*\*hadolint\*\*.*\[`DL3009`\]\(https:\/\/github\.com\/hadolint\/hadolint\/wiki\/DL3009\)/);
  assert.match(by('betterleaks', 'aws-access-token'), /Found by \*\*betterleaks\*\*, an open-source tool that finds secrets/);
  assert.match(by('gitleaks', 'x'), /Found by \*\*gitleaks\*\*/, 'findings recorded before the switch still say what found them');
});
