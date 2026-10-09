// The five scanners, with fake tools on PATH: what each is given, and what PuRR makes of what it says.
import { FAKE_SECRET, sh, tempRepo } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Cancelled, isDockerfile, limits, runScanner } from '../src/server/scanners.ts';
import { changedFiles, type ChangeSpec } from '../src/server/git.ts';
import { fingerprint } from '../src/server/engine/findings.ts';
import { DEFAULT_FLOWS } from '../src/server/flows/defaults.ts';
import { exportFlow, previewImport } from '../src/server/flows/share.ts';
import { foundBy } from '../src/shared/scanners.ts';
import { paths } from '../src/server/util.ts';
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

// A secrets scanner: notes its arguments and folder, keeps a copy of what it was shown, and reports each GitHub-token line.
const SECRETS = `printf '%s\\n' "$@" > "$D/$(basename "$0").args"
pwd -P > "$D/cwd"
while [ $# -gt 0 ]; do case "$1" in dir) shift; root="$1";; -r) shift; rep="$1";; esac; shift; done
cp -R "$root" "$D/seen"
grep -rn ghp_ "$root" | awk -F: 'BEGIN { printf "[" } { if (NR > 1) printf ","; printf "{\\"File\\":\\"%s\\",\\"StartLine\\":%s,\\"RuleID\\":\\"github-pat\\",\\"Description\\":\\"GitHub token\\",\\"Secret\\":\\"REDACTED\\"}", $1, $2 } END { printf "]" }' > "$rep"`;

// hadolint / actionlint: answer from a fixture named after the file, or fail if there's none
const FROM_FIXTURE = (tool: string, failCode: number) => `for a; do f="$a"; done
x="$D/${tool}-$(echo "$f" | tr / _).json"
[ -f "$x" ] || { echo "cannot read $f" >&2; exit 2; }
cat "$x"; exit ${failCode}`;

async function staged(files: Record<string, string>, base: Record<string, string> = {}) {
  const repo = tempRepo({ 'README.md': '# demo\n' });
  const write = (set: Record<string, string>) => {
    for (const [p, body] of Object.entries(set)) {
      mkdirSync(join(repo, p, '..'), { recursive: true });
      writeFileSync(join(repo, p), body);
    }
  };
  if (Object.keys(base).length) {   // the base version, committed (folders and all)
    write(base);
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-qm', 'base', '--no-verify');
  }
  write(files);
  sh(repo, 'add', '-A');
  const change: ChangeSpec = { mode: 'staged', cwd: repo, base: null, head: null };
  return { repo, change, files: await changedFiles(change) };
}

test('betterleaks sees only the added lines, never validates or redacts nothing, and runs outside the repo', async () => {
  const { repo, change, files } = await staged({
    'app.js': `const a = 1;\nconst key = "${FAKE_SECRET}";\n`,
    '.betterleaks.toml': `# a change's own config must not steer its scan\n# "${FAKE_SECRET}"\n`,
    '.gitleaks.toml': `[allowlist]\nregexes = ["${FAKE_SECRET}"]\n`,
    '.gitleaksignore': `app.js:github-pat:2\n`,
    '.betterleaksignore': `app.js:github-pat:2\n`,
  }, { 'app.js': 'const a = 1;\n' });
  const t = fakeTools({ betterleaks: SECRETS });
  try {
    const r = await runScanner('betterleaks', 'scan-betterleaks', files, change);
    assert.equal(r.state.state, 'ran', r.state.error ?? '');
    // a secret pasted into a scanner config file is still a secret, reported where it really is
    assert.deepEqual(r.findings.map((f) => [f.file, f.line, f.source.scanner, f.source.rule, f.severity, f.category])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [['.betterleaks.toml', 2, 'betterleaks', 'github-pat', 'must_fix', 'secrets'],
        ['.gitleaks.toml', 2, 'betterleaks', 'github-pat', 'must_fix', 'secrets'],
        ['app.js', 2, 'betterleaks', 'github-pat', 'must_fix', 'secrets']]);
    assert.match(r.findings.find((f) => f.file === 'app.js')!.scenario, /real github PAT/i);
    assert.ok(!JSON.stringify(r.findings).includes(FAKE_SECRET), 'the secret itself is never kept');
    const args = readFileSync(join(t.dir, 'betterleaks.args'), 'utf8').split('\n');
    for (const a of ['--validation=false', '--redact', '--no-banner']) assert.ok(args.includes(a), a);
    assert.equal(readFileSync(join(t.dir, 'seen', 'app.js'), 'utf8'), `\nconst key = "${FAKE_SECRET}";\n`, 'line 1 blank: it was already there');
    for (const c of ['.betterleaks.toml', '.gitleaks.toml', '.gitleaksignore', '.betterleaksignore']) {
      assert.ok(!existsSync(join(t.dir, 'seen', c)), `${c} is never where the scanner would load it as config`);
      assert.ok(existsSync(join(t.dir, 'seen', c + '.purr-scan')), `${c} is scanned as plain text`);
    }
    const cwd = readFileSync(join(t.dir, 'cwd'), 'utf8').trim();   // physical: the folder itself is gone by now
    assert.notEqual(cwd, realpathSync(repo), 'not run in the repo, where its config would apply');
    assert.equal(join(cwd, '..'), realpathSync(paths.scratch), "run in PuRR's own scratch folder");
    assert.match(basename(cwd), /^betterleaks-/);
  } finally { t.restore(); }
});

test('without betterleaks, the secrets scanner says it is missing', async () => {
  const { change, files } = await staged({ 'app.js': `const key = "${FAKE_SECRET}";\n` });
  const t = fakeTools({});
  try {
    const r = await runScanner('betterleaks', 'scan-betterleaks', files, change);
    assert.deepEqual([r.state.state, r.state.error], ['not installed', 'betterleaks is not on PATH']);
  } finally { t.restore(); }
});

test('a secrets scanner that writes no readable report, or exits non-zero, fails: never a clean pass', async () => {
  const { change, files } = await staged({ 'app.js': 'x\n' });
  let t = fakeTools({ betterleaks: 'exit 0' });
  try {
    const r = await runScanner('betterleaks', 'b', files, change);
    assert.equal(r.state.state, 'failed');
    assert.match(r.state.error!, /no readable report/);
  } finally { t.restore(); }
  // a report written, then a non-zero exit (it's run with --exit-code 0, so anything else is it going wrong)
  t = fakeTools({ betterleaks: `while [ $# -gt 0 ]; do case "$1" in -r) shift; rep="$1";; esac; shift; done\necho '[]' > "$rep"\necho 'config error' >&2\nexit 1` });
  try {
    const r = await runScanner('betterleaks', 'b', files, change);
    assert.equal(r.state.state, 'failed');
    assert.match(r.state.error!, /betterleaks exited 1: config error/);
  } finally { t.restore(); }
  // a report with a secret, then a non-zero exit: failed, but the secret it found still counts (a gate still blocks)
  const leak = await staged({ 'app.js': `const k = "${FAKE_SECRET}";\n` });
  t = fakeTools({ betterleaks: `${SECRETS}\necho 'crashed late' >&2\nexit 1` });
  try {
    const r = await runScanner('betterleaks', 'b', leak.files, leak.change);
    assert.equal(r.state.state, 'failed');
    assert.match(r.state.error!, /exited 1: crashed late/);
    assert.deepEqual(r.findings.map((f) => [f.file, f.severity]), [['app.js', 'must_fix']]);
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
  // the workflow already had its first two lines; this change adds the job
  const { change, files } = await staged({ [wf]: 'on: push\njobs:\n  x:\n    runs-on: ubuntu-latest\n' }, { [wf]: 'on: push\njobs:\n' });
  const t = fakeTools({ actionlint: FROM_FIXTURE('actionlint', 1) });
  writeFileSync(join(t.dir, `actionlint-${wf.replace(/\//g, '_')}.json`), JSON.stringify([
    { message: 'unexpected key "on" in workflow', filepath: wf, line: 1, column: 1, kind: 'syntax-check' },   // unchanged line
    { message: '"steps" section is missing in job "x"', filepath: wf, line: 3, column: 3, kind: 'syntax-check' },
  ]));
  try {
    const r = await runScanner('actionlint', 'scan-actionlint', files, change);
    assert.equal(r.state.state, 'ran', r.state.error ?? '');
    assert.deepEqual(r.findings.map((f) => [f.file, f.line, f.source.rule, f.severity]), [[wf, 3, 'syntax-check', 'consider']],
      'only the error on a line this change adds');
    // a clean workflow: actionlint prints nothing and exits 0
    writeFileSync(join(t.dir, `actionlint-${wf.replace(/\//g, '_')}.json`), '');
    writeFileSync(join(t.dir, 'actionlint'), `#!/bin/sh\nexit 0\n`);
    const clean = await runScanner('actionlint', 'scan-actionlint', files, change);
    assert.deepEqual([clean.state.state, clean.findings.length], ['ran', 0]);
    const none = await staged({ 'app.js': 'x\n' });
    assert.equal((await runScanner('actionlint', 'a', none.files, none.change)).state.state, 'n/a');
    assert.equal((await runScanner('hadolint', 'h', none.files, none.change)).state.state, 'n/a');
  } finally { t.restore(); }
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

test('a scanner finding says which tool found it and what that tool is', () => {
  const by = (scanner: any, rule: string) => foundBy({ id: 'x', file: 'f', line: 1, category: 'c', severity: 'consider', title: 't', scenario: 's',
    source: { blockId: 'b', kind: 'scanner', scanner, rule } });
  assert.match(by('hadolint', 'DL3009'), /Found by \*\*hadolint\*\*.*\[`DL3009`\]\(https:\/\/github\.com\/hadolint\/hadolint\/wiki\/DL3009\)/);
  assert.match(by('hadolint', 'SC1073'), /\[`SC1073`\]\(https:\/\/www\.shellcheck\.net\/wiki\/SC1073\)/, "a ShellCheck code links to ShellCheck's wiki");
  assert.match(by('betterleaks', 'aws-access-token'), /Found by \*\*betterleaks\*\*, an open-source tool that finds secrets/);
});

// osv-scanner: answers from what's in the file it's given (the last argument), and notes what it was asked to read
const OSV = `printf '%s\\n' "$@" > "$D/osv.args"
for a; do f="$a"; done
echo "$f" >> "$D/osv.files"
case "$(cat "$f")" in *EXIT128*) exit 128;; *EXIT2*) echo boom >&2; exit 2;; *GARBAGE*) echo not json; exit 0;; esac
vulns=""
for id in VULN-A VULN-B; do
  grep -q "$id" "$f" || continue
  [ -n "$vulns" ] && vulns="$vulns,"
  vulns="$vulns{\\"id\\":\\"GHSA-$id\\",\\"summary\\":\\"bad $id\\",\\"affected\\":[{\\"package\\":{\\"name\\":\\"lodash\\"},\\"ranges\\":[{\\"events\\":[{\\"fixed\\":\\"4.17.21\\"}]}]}]}"
done
[ -z "$vulns" ] && { echo '{"results":[]}'; exit 0; }
printf '{"results":[{"packages":[{"package":{"name":"lodash","version":"4.17.0"},"groups":[{"max_severity":"9.8"}],"vulnerabilities":[%s]}]}]}' "$vulns"
exit 1`;

test('osv-scanner: only vulnerabilities new on this change, an empty file is fine, a failed or unreadable scan fails, go.mod is read', async () => {
  const lock = (marks: string) => `{\n  "name": "app",\n  "dependencies": {\n    "lodash": "4.17.0"\n  }\n}\n// ${marks}\n`;
  const t = fakeTools({ 'osv-scanner': OSV });
  try {
    // B is new on this change (critical), A was already on the base branch: only B is raised, on lodash's line
    const a = await staged({ 'package-lock.json': lock('VULN-A VULN-B') }, { 'package-lock.json': lock('VULN-A') });
    const r = await runScanner('osv', 'scan-osv', a.files, a.change);
    assert.equal(r.state.state, 'ran', r.state.error ?? '');
    assert.deepEqual(r.findings.map((f) => [f.file, f.line, f.source.rule, f.severity]), [['package-lock.json', 4, 'GHSA-VULN-B', 'must_fix']]);
    assert.match(r.findings[0].title, /`lodash` 4\.17\.0 has 1 known vulnerability \(worst: critical\)/);
    assert.match(r.findings[0].fix!, /4\.17\.21/);
    const args = readFileSync(join(t.dir, 'osv.args'), 'utf8').split('\n');
    assert.ok(args.includes('--no-resolve') && args.includes('--all-packages'), 'the lockfile is read as the full pinned tree it is');
    // the same vulnerabilities on both sides: nothing new
    const same = await staged({ 'package-lock.json': lock('VULN-A x') }, { 'package-lock.json': lock('VULN-A') });
    assert.deepEqual((await runScanner('osv', 'o', same.files, same.change)).findings, []);
    // exit 128 is osv's "no packages in this file": a clean run
    const empty = await staged({ 'package-lock.json': 'EXIT128\n' });
    assert.deepEqual(await runScanner('osv', 'o', empty.files, empty.change).then((x) => [x.state.state, x.findings.length]), ['ran', 0]);
    for (const bad of ['EXIT2', 'GARBAGE']) {
      const b = await staged({ 'package-lock.json': `${bad}\n` });
      const x = await runScanner('osv', 'o', b.files, b.change);
      assert.equal(x.state.state, 'failed', bad);
      assert.match(x.state.error!, /osv-scanner failed/);
    }
    // one lockfile osv can't read beside one with a new critical vulnerability: partial, and the vulnerability is raised
    const mixed = await staged({ 'package-lock.json': lock('VULN-B'), 'go.mod': 'EXIT2\n' });
    const m = await runScanner('osv', 'scan-osv', mixed.files, mixed.change);
    assert.equal(m.state.state, 'partial');
    assert.deepEqual(m.state.incomplete?.map((x) => x.file), ['go.mod']);
    assert.match(m.state.incomplete![0].reason, /osv-scanner failed \(exit 2\)/);
    assert.deepEqual(m.findings.map((f) => [f.file, f.source.rule, f.severity]), [['package-lock.json', 'GHSA-VULN-B', 'must_fix']],
      'still a must-fix, so the pre-push gate still blocks');
    // go.mod on its own: start a fresh log, so an earlier case's go.mod can't answer for this one
    rmSync(join(t.dir, 'osv.files'), { force: true });
    const go = await staged({ 'go.mod': 'module x\n\nrequire example.com/y v1.0.0\n' });
    assert.equal((await runScanner('osv', 'o', go.files, go.change)).state.state, 'ran');
    const read = readFileSync(join(t.dir, 'osv.files'), 'utf8').trim().split('\n');
    assert.equal(read.length, 1, read.join('\n'));
    assert.ok(read[0].endsWith('/go.mod'), 'go.mod is read (osv can\'t parse go.sum)');
  } finally { t.restore(); }
});

test("osv-scanner can't read the base branch's lockfile: new can't be told from old, so that file is unchecked, saying why", async () => {
  const lock = (marks: string) => `{\n  "name": "app",\n  "dependencies": {\n    "lodash": "4.17.0"\n  }\n}\n// ${marks}\n`;
  const t = fakeTools({ 'osv-scanner': OSV });
  try {
    // the only lockfile: the scan fails
    const one = await staged({ 'package-lock.json': lock('VULN-B') }, { 'package-lock.json': 'EXIT2\n' });
    const r = await runScanner('osv', 'o', one.files, one.change);
    assert.equal(r.state.state, 'failed');
    assert.match(r.state.error ?? '', /base branch/);
    // beside a second lockfile osv reads on both sides: partial, the unread one listed with the base branch named
    const two = await staged({ 'package-lock.json': lock('VULN-B'), 'sub/package-lock.json': lock('VULN-A VULN-B') },
      { 'package-lock.json': 'EXIT2\n', 'sub/package-lock.json': lock('VULN-A') });
    const x = await runScanner('osv', 'o', two.files, two.change);
    assert.equal(x.state.state, 'partial');
    assert.deepEqual(x.state.incomplete?.map((i) => i.file), ['package-lock.json']);
    assert.match(x.state.incomplete![0].reason, /base branch/);
    assert.deepEqual(x.findings.map((f) => [f.file, f.source.rule]), [['sub/package-lock.json', 'GHSA-VULN-B']], 'the readable one is still checked');
  } finally { t.restore(); }
});

test("a scanner that couldn't check a file can't call its findings there fixed; a failed one can't call any fixed", async () => {
  const { completeBlocks } = await import('../src/server/manager.ts');
  const { openDb } = await import('../src/server/db.ts');
  const { applyLedger } = await import('../src/server/ledger.ts');
  const br = (state: string | null, incomplete: string[] = []) => ({ runId: 'r', blockId: 'x', status: 'done', startedAt: null, finishedAt: null, error: null,
    output: state ? { scanner: { state, secs: 1, incomplete: incomplete.map((file) => ({ file, reason: 'timed out' })) } } : {} }) as any;
  const runs = new Map([['scan-hadolint', br('partial', ['api/Dockerfile'])], ['scan-actionlint', br('failed')], ['scan-osv', br('n/a')],
    ['context', br(null)], ['scan-zizmor', { ...br('ran'), status: 'skipped' }], ['scan-betterleaks', br('not installed')]]);
  const got = completeBlocks(['scan-hadolint', 'scan-actionlint', 'scan-osv', 'context', 'scan-zizmor', 'scan-betterleaks'].map((id) => ({ id })), runs);
  assert.deepEqual([...got.complete].sort(), ['context', 'scan-hadolint', 'scan-osv'], 'not the failed one, one that never ran, nor one not installed');
  assert.deepEqual([...got.unchecked.get('scan-hadolint')!], ['api/Dockerfile']);

  const db = openDb(join(mkdtempSync(join(process.env.TMPDIR!, 'purr-db-')), 'purr.db'));
  const open = (fp: string, file: string, blockId: string) => db.putLedger({ fingerprint: fp, repoId: 'r1', branch: 'feat', state: 'open', flowId: 'default-review',
    finding: { id: fp, file, line: 1, category: 'lint', severity: 'consider', title: 't', scenario: 's', source: { blockId, kind: 'scanner' } },
    firstRunId: 'r0', lastRunId: 'r0', updatedAt: 'x' });
  open('checked', 'Dockerfile', 'scan-hadolint');
  open('unchecked', 'api/Dockerfile', 'scan-hadolint');
  open('failed', '.github/workflows/ci.yml', 'scan-actionlint');
  open('secret', 'app.js', 'scan-betterleaks');
  applyLedger(db, { id: 'r1run', repoId: 'r1', branch: 'feat', flowId: 'default-review', trigger: 'post-push', mode: 'range' } as any, [], got.complete, got.unchecked);
  assert.deepEqual(['checked', 'unchecked', 'failed', 'secret'].map((fp) => db.getLedger(fp, 'r1')?.state), ['fixed', 'open', 'open', 'open'],
    'betterleaks missing this time: its open secrets stay open');
  db.close();
});

test("a PR comment says which tool found a scanner finding, and nothing of the kind under Claude's", async () => {
  const { renderComment } = await import('../src/server/manager.ts');
  const f = (kind: 'scanner' | 'model', title: string): Finding => ({ id: title, file: 'Dockerfile', line: 2, category: 'lint', severity: 'consider', title,
    scenario: 's', source: kind === 'scanner' ? { blockId: 'scan-hadolint', kind, scanner: 'hadolint', rule: 'DL3009' } : { blockId: 'lens', kind } });
  const text = renderComment({ flowName: 'Full review', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) } as any, [f('scanner', 'From hadolint'), f('model', 'From Claude')]);
  const lines = text.split('\n');
  const at = (title: string) => lines.findIndex((l) => l.includes(title));
  assert.match(lines[at('From hadolint') + 1], /^  _?Found by \*\*hadolint\*\*/);
  assert.doesNotMatch(lines[at('From Claude') + 1] ?? '', /Found by/);
  assert.equal(text.match(/Found by/g)?.length, 1);
});

test("hadolint and actionlint use the repo's own config from the reviewed commit; none, no flag", async () => {
  const wf = '.github/workflows/ci.yml';
  const { change, files } = await staged({
    [wf]: 'on: push\njobs:\n  a:\n    runs-on: [self-hosted, gpu]\n',
    'Dockerfile': 'FROM node:20\n',
    '.github/actionlint.yaml': 'self-hosted-runner:\n  labels: [gpu]\n',
    '.hadolint.yaml': 'ignored: [DL3006]\n',
  });
  // each fake notes its arguments and keeps a copy of the config it was pointed at
  const RECORD = (tool: string, flag: string) => `printf '%s\\n' "$@" > "$D/${tool}.args"
prev=""; for a; do [ "$prev" = "${flag}" ] && cp "$a" "$D/${tool}.config"; prev="$a"; done
echo '[]'`;
  const t = fakeTools({ actionlint: RECORD('actionlint', '-config-file'), hadolint: RECORD('hadolint', '--config') });
  try {
    assert.equal((await runScanner('actionlint', 'a', files, change)).state.state, 'ran');
    assert.match(readFileSync(join(t.dir, 'actionlint.args'), 'utf8'), /-config-file\n.*\.github\/actionlint\.yaml\n/);
    assert.match(readFileSync(join(t.dir, 'actionlint.config'), 'utf8'), /labels: \[gpu\]/, "the repo's runner labels");
    assert.equal((await runScanner('hadolint', 'h', files, change)).state.state, 'ran');
    assert.match(readFileSync(join(t.dir, 'hadolint.config'), 'utf8'), /DL3006/);
  } finally { t.restore(); }

  const bare = await staged({ [wf]: 'on: push\n' });
  const t2 = fakeTools({ actionlint: RECORD('actionlint', '-config-file') });
  try {
    await runScanner('actionlint', 'a', bare.files, bare.change);
    assert.doesNotMatch(readFileSync(join(t2.dir, 'actionlint.args'), 'utf8'), /-config-file/, 'no config in the repo: no flag');
  } finally { t2.restore(); }
});

test('two different actionlint errors of one kind in a file stay two findings; repeats of one error group', async () => {
  const wf = '.github/workflows/ci.yml';
  const body = Array.from({ length: 45 }, (_, i) => `k${i + 1}: v${i + 1}`).join('\n') + '\n';
  const { change, files } = await staged({ [wf]: body });
  const t = fakeTools({ actionlint: FROM_FIXTURE('actionlint', 1) });
  const err = (line: number, message: string) => ({ line, column: 1, kind: 'expression', message, filepath: wf });
  writeFileSync(join(t.dir, `actionlint-${wf.replace(/\//g, '_')}.json`), JSON.stringify([
    err(10, 'property "foo" is not defined in object type'), err(40, 'undefined variable "secretz"'),
    err(42, 'undefined variable "secretz"'),
  ]));
  try {
    const r = await runScanner('actionlint', 'scan-actionlint', files, change);
    const got = r.findings.map((f) => [f.line, f.lines, f.scenario]);
    assert.deepEqual(got, [
      [10, [10], 'property "foo" is not defined in object type'],
      [40, [40, 42], 'undefined variable "secretz"'],
    ]);
    const content = readFileSync(join(change.cwd, wf), 'utf8');
    assert.notEqual(fingerprint(r.findings[0], content), fingerprint(r.findings[1], content), 'each its own identity');
  } finally { t.restore(); }
});

test('a hadolint / actionlint call that runs past its time: that file unchecked (partial); every file, failed', async () => {
  const { change, files } = await staged({ 'Dockerfile': 'FROM a\n', 'svc/Dockerfile': 'FROM b\n' });
  const SLOW_ON = (match: string) => `for a; do f="$a"; done
case "$f" in *${match}*) sleep 5;; esac
echo '[]'`;
  const before = limits.fileMs;
  limits.fileMs = 2000;
  const t = fakeTools({ hadolint: SLOW_ON('svc/') });
  try {
    const r = await runScanner('hadolint', 'h', files, change);
    assert.equal(r.state.state, 'partial', JSON.stringify(r.state));
    assert.deepEqual(r.state.incomplete!.map((i) => i.file), ['svc/Dockerfile']);
    assert.match(r.state.incomplete![0].reason, /timed out/);
  } finally { t.restore(); }
  const t2 = fakeTools({ hadolint: SLOW_ON('Dockerfile') });
  try {
    const r = await runScanner('hadolint', 'h', files, change);
    assert.equal(r.state.state, 'failed');
    assert.match(r.state.error ?? '', /timed out/);
  } finally { t2.restore(); limits.fileMs = before; }
});

test('Dockerfiles for hadolint: Dockerfile, Dockerfile.<variant> and *.Dockerfile, not docs or templates named after one', () => {
  for (const p of ['Dockerfile', 'api/Dockerfile', 'Dockerfile.dev', 'docker/Dockerfile.prod', 'web.Dockerfile', 'ci/test.Dockerfile']) {
    assert.equal(isDockerfile(p), true, p);
  }
  for (const p of ['docs/Dockerfile.md', 'Dockerfile.txt', 'Dockerfile.j2', 'Dockerfile.tpl', 'Dockerfile.tmpl', 'Dockerfile.jinja',
    'templates/Dockerfile.erb', 'Dockerfile.example', 'Dockerfile.sample', 'Dockerfile.dev.md', 'README.md', 'Dockerfile/notes', '.dockerignore']) {
    assert.equal(isDockerfile(p), false, p);
  }
});

test('a cancelled review stops its scanner between files and kills the one running: cancelled, not failed or partial', async () => {
  const { change, files } = await staged({ 'a/Dockerfile': 'FROM a\n', 'b/Dockerfile': 'FROM b\n', 'c/Dockerfile': 'FROM c\n' });
  const t = fakeTools({ hadolint: `for a; do f="$a"; done\necho "$f" >> "$D/ran"\nsleep 5\necho '[]'` });
  try {
    const ac = new AbortController();
    // cancel once the first file's run has started (a newer push superseding the review mid-scan)
    const started = setInterval(() => { if (existsSync(join(t.dir, 'ran'))) { clearInterval(started); ac.abort(); } }, 20);
    const t0 = Date.now();
    await assert.rejects(runScanner('hadolint', 'h', files, change, ac.signal), Cancelled);
    assert.ok(Date.now() - t0 < 4_000, `stopped promptly (${Date.now() - t0}ms), not after every file's 5s`);
    assert.deepEqual(readFileSync(join(t.dir, 'ran'), 'utf8').trim().split('\n'), ['a/Dockerfile'], 'the later files never ran');
    await assert.rejects(runScanner('hadolint', 'h', files, change, AbortSignal.abort()), Cancelled, 'cancelled before it started');
  } finally { t.restore(); }
});

test("a missing osv-scanner shows as not installed, not failed or partial", async () => {
  const { change, files } = await staged({ 'package-lock.json': '{"lockfileVersion":3,"packages":{}}\n' });
  const t = fakeTools({});
  try {
    const r = await runScanner('osv', 'o', files, change);
    assert.equal(r.state.state, 'not installed', JSON.stringify(r.state));
  } finally { t.restore(); }
});

// The real tools, where installed: PuRR's flags must be ones they accept. Skipped where a tool isn't on PATH.
const installed = (tool: string) => { try { execFileSync('which', [tool], { stdio: 'pipe' }); return true; } catch { return false; } };

test('the real betterleaks accepts PuRR\'s flags and finds a committed GitHub token', { skip: !installed('betterleaks') && 'betterleaks is not installed here' }, async () => {
  // FAKE_SECRET is a GitHub token's shape, not a real one, which betterleaks flags
  // the change also adds config and ignore files that would allowlist the token, if the scanner loaded them
  const { change, files } = await staged({
    'app.js': `const k = "${FAKE_SECRET}";\n`,
    '.betterleaks.toml': `[extend]\nuseDefault = true\n[allowlist]\nregexes = ['''ghp_[A-Za-z0-9]{36}''']\n`,
    '.gitleaks.toml': `[extend]\nuseDefault = true\n[allowlist]\nregexes = ['''ghp_[A-Za-z0-9]{36}''']\n`,
    '.gitleaksignore': 'app.js:github-pat:1\n',
  });
  const r = await runScanner('betterleaks', 's', files, change);
  assert.equal(r.state.state, 'ran', JSON.stringify(r.state));
  assert.equal(r.findings.filter((f) => f.file === 'app.js').length, 1, 'still flagged: the change\'s own allowlist is not loaded');
  r.findings = r.findings.filter((f) => f.file === 'app.js');
  assert.equal(r.findings[0].file, 'app.js');
  assert.equal(r.findings[0].severity, 'must_fix');
});

test('the real hadolint accepts PuRR\'s flags and raises an error-level rule on an added line', { skip: !installed('hadolint') && 'hadolint is not installed here' }, async () => {
  const { change, files } = await staged({ 'Dockerfile': 'FROM alpine:3.20\nWORKDIR relative/path\n' });   // DL3000: an error
  const r = await runScanner('hadolint', 'h', files, change);
  assert.equal(r.state.state, 'ran', JSON.stringify(r.state));
  assert.ok(r.findings.some((f) => f.source.rule === 'DL3000' && f.line === 2), JSON.stringify(r.findings));
});

test('the real osv-scanner accepts PuRR\'s flags and raises a new critical vulnerability in a lockfile', { skip: !installed('osv-scanner') && 'osv-scanner is not installed here' }, async (t) => {
  // minimist 1.2.0 has a critical advisory (prototype pollution); the base branch's lockfile doesn't have it
  const lock = (deps: Record<string, string>) => JSON.stringify({
    name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: {
      '': { name: 'app', version: '1.0.0', dependencies: deps },
      ...Object.fromEntries(Object.entries(deps).map(([n, v]) => [`node_modules/${n}`, { version: v, resolved: `https://registry.npmjs.org/${n}/-/${n}-${v}.tgz` }])),
    },
  }, null, 2) + '\n';
  const { change, files } = await staged({ 'package-lock.json': lock({ minimist: '1.2.0' }) }, { 'package-lock.json': lock({}) });
  const r = await runScanner('osv', 'o', files, change);
  // it asks the OSV database over the network (package names and versions only): offline, there's nothing to check
  if (r.state.state !== 'ran' && /network|dial|lookup|connect|timeout|api\.osv\.dev/i.test(JSON.stringify(r.state))) {
    t.skip(`osv-scanner couldn't reach the OSV database: ${JSON.stringify(r.state)}`);
    return;
  }
  assert.equal(r.state.state, 'ran', JSON.stringify(r.state));
  const hit = r.findings.find((f) => /minimist/.test(f.title));
  assert.ok(hit, JSON.stringify(r.findings));
  assert.equal(hit!.severity, 'must_fix');
});

test('the real actionlint accepts PuRR\'s flags and raises a workflow error on an added line', { skip: !installed('actionlint') && 'actionlint is not installed here' }, async () => {
  const wf = 'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    needs: missing-job\n    steps:\n      - run: echo hi\n';
  const { change, files } = await staged({ '.github/workflows/ci.yml': wf });
  const r = await runScanner('actionlint', 'a', files, change);
  assert.equal(r.state.state, 'ran', JSON.stringify(r.state));
  // actionlint puts a `needs:` error on the job's own line
  assert.ok(r.findings.some((f) => f.source.rule === 'job-needs' && f.line === 3), JSON.stringify(r.findings));
});

test('a review cancelled mid-scan: the scanner block ends cancelled, not failed, and the ledger closes nothing', async () => {
  const { executeFlow } = await import('../src/server/engine/executor.ts');
  const { completeBlocks } = await import('../src/server/manager.ts');
  const { applyLedger } = await import('../src/server/ledger.ts');
  const { openDb } = await import('../src/server/db.ts');
  const { change, files, repo } = await staged({ 'a/Dockerfile': 'FROM a\n', 'b/Dockerfile': 'FROM b\n' });
  const t = fakeTools({ hadolint: `for a; do f="$a"; done\necho "$f" >> "$D/ran"\nsleep 5\necho '[]'` });
  const db = openDb(join(mkdtempSync(join(process.env.TMPDIR!, 'purr-db-')), 'purr.db'));
  try {
    const flow = { id: 'f', name: 'scan', blocks: [{ id: 'scan-hadolint', type: 'scanner', label: 'hadolint', position: { x: 0, y: 0 }, config: { scanner: 'hadolint' } }],
      edges: [] } as any;
    const run = { id: 'r-cancel', repoId: 'r1', branch: 'feat', flowId: 'f', trigger: 'post-push', mode: 'staged' } as any;
    const ac = new AbortController();
    const started = setInterval(() => { if (existsSync(join(t.dir, 'ran'))) { clearInterval(started); ac.abort(); } }, 20);
    const t0 = Date.now();
    const result = await executeFlow({ run, flow, change, files, cwd: repo }, { claude: {} as any, signal: ac.signal, onBlock: () => {} });
    assert.ok(Date.now() - t0 < 4_000, `stopped promptly (${Date.now() - t0}ms)`);
    assert.equal(result.blocks.get('scan-hadolint')?.status, 'cancelled');
    assert.deepEqual(result.failedBlocks, [], 'cancelled is not failed');
    // an open finding of that block stays open: a cancelled scan says nothing about what's fixed
    db.putLedger({ fingerprint: 'df', repoId: 'r1', branch: 'feat', state: 'open', flowId: 'f', firstRunId: 'r0', lastRunId: 'r0', updatedAt: 'x',
      finding: { id: 'df', file: 'a/Dockerfile', line: 1, category: 'lint', severity: 'consider', title: 't', scenario: 's', source: { blockId: 'scan-hadolint', kind: 'scanner' } } });
    const checked = completeBlocks(flow.blocks, result.blocks);
    assert.equal(checked.complete.has('scan-hadolint'), false);
    applyLedger(db, { ...run, mode: 'range' }, result.findings, checked.complete, checked.unchecked);
    assert.equal(db.getLedger('df', 'r1')?.state, 'open');
  } finally { t.restore(); db.close(); }
});

test('two different actionlint errors of one kind in a workflow both reach the review\'s results', async () => {
  const { executeFlow } = await import('../src/server/engine/executor.ts');
  const wf = '.github/workflows/ci.yml';
  const body = Array.from({ length: 45 }, (_, i) => `      - run: echo step-${i + 1}`).join('\n') + '\n';   // not comments: fingerprints skip those
  const { change, files, repo } = await staged({ [wf]: body });
  const t = fakeTools({ actionlint: FROM_FIXTURE('actionlint', 1) });
  writeFileSync(join(t.dir, `actionlint-${wf.replace(/\//g, '_')}.json`), JSON.stringify([
    { message: 'property "foo" is not defined in object type', filepath: wf, line: 10, column: 3, kind: 'expression' },
    { message: 'undefined variable "bar"', filepath: wf, line: 40, column: 3, kind: 'expression' },
  ]));
  try {
    const flow = { id: 'f', name: 'scan', edges: [{ id: 'e', source: 'scan-actionlint', target: 'out' }], blocks: [
      { id: 'scan-actionlint', type: 'scanner', label: 'actionlint', position: { x: 0, y: 0 }, config: { scanner: 'actionlint' } },
      { id: 'out', type: 'output', label: 'Results', position: { x: 1, y: 0 }, config: { notify: false, postPrComment: false } }] } as any;
    const run = { id: 'r-al', repoId: 'r1', branch: 'feat', flowId: 'f', trigger: 'post-push', mode: 'staged' } as any;
    const result = await executeFlow({ run, flow, change, files, cwd: repo }, { claude: {} as any, signal: new AbortController().signal, onBlock: () => {} });
    assert.deepEqual(result.findings.map((f) => f.line).sort((a, b) => (a ?? 0) - (b ?? 0)), [10, 40],
      `not merged into one at the results: ${JSON.stringify([...result.blocks.values()].map((b: any) => [b.blockId, b.status, b.error, b.output?.scanner, b.output?.findings?.length]))}`);
  } finally { t.restore(); }
});

test('cancelling an osv-scanner or secrets scan stops it promptly, as cancelled', async () => {
  const slow = (tool: string) => `echo "$@" >> "$D/ran"\nsleep 5\n${tool === 'osv' ? "echo '{\"results\":[]}'" : ''}`;
  const lock = '{"lockfileVersion":3,"packages":{}}\n';
  const two = await staged({ 'package-lock.json': lock, 'sub/package-lock.json': lock });
  let t = fakeTools({ 'osv-scanner': slow('osv') });
  try {
    const ac = new AbortController();
    const started = setInterval(() => { if (existsSync(join(t.dir, 'ran'))) { clearInterval(started); ac.abort(); } }, 20);
    const t0 = Date.now();
    await assert.rejects(runScanner('osv', 'o', two.files, two.change, ac.signal), Cancelled);
    assert.ok(Date.now() - t0 < 4_000, `osv stopped promptly (${Date.now() - t0}ms)`);
  } finally { t.restore(); }
  const leak = await staged({ 'app.js': `const k = "${FAKE_SECRET}";\n` });
  t = fakeTools({ betterleaks: slow('betterleaks') });
  try {
    const ac = new AbortController();
    const started = setInterval(() => { if (existsSync(join(t.dir, 'ran'))) { clearInterval(started); ac.abort(); } }, 20);
    const t0 = Date.now();
    await assert.rejects(runScanner('betterleaks', 'b', leak.files, leak.change, ac.signal), Cancelled);
    assert.ok(Date.now() - t0 < 4_000, `betterleaks stopped promptly (${Date.now() - t0}ms)`);
  } finally { t.restore(); }
});

test('osv-scanner running past its time says it timed out, not a bare exit code', async () => {
  const t = fakeTools({ 'osv-scanner': 'sleep 5' });
  const was = limits.osvMs;
  limits.osvMs = 500;
  try {
    const one = await staged({ 'package-lock.json': '{"lockfileVersion":3,"packages":{}}\n' });
    const r = await runScanner('osv', 'scan-osv', one.files, one.change);
    assert.equal(r.state.state, 'failed');
    assert.match(r.state.error ?? JSON.stringify(r.state.incomplete), /osv-scanner timed out after 0\.5s/);
  } finally { limits.osvMs = was; t.restore(); }
});

test('two actionlint errors of one kind on one line, with different messages, keep two identities', async () => {
  const { fingerprintAll } = await import('../src/server/ledger.ts');
  const err = (message: string): Finding => ({ id: message, file: '.github/workflows/ci.yml', line: 7, category: 'lint', severity: 'consider',
    title: `Workflow problem: ${message}`, scenario: message, source: { blockId: 'scan-actionlint', kind: 'scanner', scanner: 'actionlint', rule: 'expression' } });
  const fs = [err('property "foo" is not defined in object type'), err('receiver of object dereference "bar" must be type of object')];
  await fingerprintAll(fs, { content: async () => 'jobs:\n  build:\n    steps:\n      - run: echo\n      - run: echo\n      - run: echo\n      - run: echo ${{ x.foo.bar }}\n' } as any);
  assert.ok(fs[0].fingerprint && fs[1].fingerprint);
  assert.notEqual(fs[0].fingerprint, fs[1].fingerprint);
});

test("a secret finding's identity is pinned: a change to it would reopen every dismissed secret", () => {
  const f = { id: 'x', file: 'app.js', line: 2, category: 'secrets', severity: 'must_fix', title: 'GitHub token', scenario: 's',
    source: { blockId: 'scan-betterleaks', kind: 'scanner', scanner: 'betterleaks', rule: 'github-pat' } } as Finding;
  assert.equal(fingerprint(f, 'a\nconst token = "x";\nb'), '23236a4b2fbbe8f7');
});

test('a scanner block naming a scanner PuRR has no longer is a flow error, and never runs another scanner', async () => {
  const { validateFlow } = await import('../src/server/flows/validate.ts');
  const blocks = [{ id: 's', type: 'scanner', config: { scanner: 'gitleaks' } }, { id: 'out', type: 'output', config: { notify: false, postPrComment: false } }] as any;
  const errors = validateFlow(blocks, [{ id: 'e', source: 's', target: 'out' }] as any).filter((i) => i.level === 'error').map((i) => i.message);
  assert.ok(errors.includes('Unknown scanner "gitleaks"'), errors.join(' | '));
  const r = await runScanner('gitleaks' as any, 's', [], { mode: 'staged' } as any);
  assert.equal(r.state.state, 'failed');
  assert.match(r.state.error ?? '', /unknown scanner "gitleaks"/);
});
