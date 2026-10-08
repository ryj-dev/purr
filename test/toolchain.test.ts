import './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/server/db.ts';
import { ensureDefaults } from '../src/server/flows/store.ts';
import { ClaudeRunner } from '../src/server/claude.ts';
import { RunManager } from '../src/server/manager.ts';
import { startHttp } from '../src/server/http.ts';
import { PostPushWatcher } from '../src/server/triggers.ts';
import { installMissing, installTool, refreshToolchain, signInCommand, toolchainStatus } from '../src/server/toolchain.ts';

// A PATH holding only fake tools (plus the system basics), and a fake brew that "installs" by writing a fake tool.
// Tests share one process, so PATH and PURR_BREW are put back afterwards.
function fakeWorld(opts: { brew: boolean; brewFails?: boolean; have: string[] }) {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'purr-tools-'));
  const write = (name: string, body: string) => { writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`); chmodSync(join(dir, name), 0o755); };
  const tool = (name: string) => {
    if (name === 'claude') write(name, `if [ "$1" = auth ]; then echo '{"loggedIn":true,"email":"me@example.com","orgName":"Example"}'; else echo "2.1.300 (Claude Code)"; fi`);
    else if (name === 'gh') write(name, `if [ "$1" = auth ]; then printf 'github.com\\n  ✓ Logged in to github.com account work-me (keyring)\\n  - Active account: false\\n  ✓ Logged in to github.com account me (keyring)\\n  - Active account: true\\n'; else echo "gh version 2.102.0 (2026-01-01)"; fi`);
    else write(name, `echo "${name} 1.2.3"`);
  };
  for (const t of opts.have) tool(t);
  const brewDir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'purr-brew-'));
  const brew = join(brewDir, 'brew');
  if (opts.brew) {
    writeFileSync(brew, opts.brewFails
      ? '#!/bin/sh\necho "==> Fetching $2"\necho "Error: no bottle available" >&2\nexit 1\n'
      // `brew install <formula>`, or `brew install --cask claude-code`, which provides `claude`
      : `#!/bin/sh\nn="$2"; [ "$2" = --cask ] && n="$3"; [ "$n" = claude-code ] && n=claude\necho "==> Fetching $n"\nprintf '#!/bin/sh\\necho "%s 9.9.9"\\n' "$n" > "${dir}/$n"\nchmod +x "${dir}/$n"\necho "$*" >> "${dir}/brew.log"\n`);
    chmodSync(brew, 0o755);
  }
  const saved = { PATH: process.env.PATH, PURR_BREW: process.env.PURR_BREW };
  process.env.PATH = `${dir}:/usr/bin:/bin:/usr/sbin:/sbin`;
  process.env.PURR_BREW = opts.brew ? brew : '';
  refreshToolchain();
  return {
    dir,
    restore() {
      process.env.PATH = saved.PATH;
      if (saved.PURR_BREW === undefined) delete process.env.PURR_BREW; else process.env.PURR_BREW = saved.PURR_BREW;
      refreshToolchain();
    },
  };
}

async function settled(name: string) {
  for (let i = 0; i < 100; i++) {
    refreshToolchain();
    const t = (await toolchainStatus()).tools.find((x) => x.name === name)!;
    if (t.job?.state !== 'running') return t;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${name} never finished installing`);
}

test('status: installed or not, version, and who is signed in to claude and gh', async () => {
  const w = fakeWorld({ brew: true, have: ['gitleaks', 'claude', 'gh'] });
  try {
    const s = await toolchainStatus();
    assert.equal(s.homebrew.installed, true);
    const by = Object.fromEntries(s.tools.map((t) => [t.name, t]));
    assert.deepEqual(s.tools.map((t) => t.name), ['gitleaks', 'zizmor', 'osv-scanner', 'claude', 'gh']);
    assert.equal(by.gitleaks.installed, true);
    assert.equal(by.gitleaks.version, '1.2.3');
    assert.equal(by.gitleaks.auth, null, 'scanners have no sign-in');
    assert.equal(by.zizmor.installed, false);
    assert.deepEqual(by.claude.auth, { signedIn: true, accounts: ['me@example.com'], detail: 'Example' });
    assert.deepEqual(by.gh.auth, { signedIn: true, accounts: ['me', 'work-me'] }, 'every account, the active one first');
    assert.equal(by.gh.version, '2.102.0');
  } finally { w.restore(); }
});

test('install with Homebrew: progress, then installed; a failing brew leaves a readable error', async () => {
  const w = fakeWorld({ brew: true, have: ['claude', 'gh'] });
  try {
    installTool('zizmor');
    assert.equal((await toolchainStatus()).tools.find((t) => t.name === 'zizmor')!.job?.state, 'running');
    const z = await settled('zizmor');
    assert.equal(z.job, null);
    assert.equal(z.installed, true);
    assert.equal(z.version, '9.9.9');
  } finally { w.restore(); }

  const w2 = fakeWorld({ brew: true, brewFails: true, have: [] });
  try {
    installTool('gitleaks');
    const g = await settled('gitleaks');
    assert.equal(g.installed, false);
    assert.equal(g.job?.state, 'failed');
    assert.match(g.job!.error!, /no bottle available/);
  } finally { w2.restore(); }
});

test('without Homebrew: brew tools ask for it first, and Install missing leaves them out', async () => {
  const w = fakeWorld({ brew: false, have: ['claude'] });
  try {
    const s = await toolchainStatus();
    assert.equal(s.homebrew.installed, false);
    assert.deepEqual(await installMissing(), [], 'everything installs with Homebrew');
    installTool('gh');
    const gh = await settled('gh');
    assert.equal(gh.job?.state, 'failed');
    assert.match(gh.job!.error!, /Install Homebrew first/);
  } finally { w.restore(); }
});

test('Install missing installs each missing tool in turn, claude as the claude-code cask', async () => {
  const w = fakeWorld({ brew: true, have: ['gh', 'gitleaks'] });
  try {
    assert.deepEqual(await installMissing(), ['zizmor', 'osv-scanner', 'claude']);
    for (const n of ['zizmor', 'osv-scanner', 'claude']) assert.equal((await settled(n)).installed, true, `${n} installed`);
    assert.deepEqual(readFileSync(join(w.dir, 'brew.log'), 'utf8').trim().split('\n'),
      ['install zizmor', 'install osv-scanner', 'install --cask claude-code'], 'one at a time, in order');
  } finally { w.restore(); }
});

test('sign-in commands quote the tool path for the shell', () => {
  assert.equal(signInCommand('claude', '/Users/a b/.local/bin/claude'), `'/Users/a b/.local/bin/claude' auth login`);
  assert.equal(signInCommand('gh', "/x/it's/gh"), `'/x/it'\\''s/gh' auth login --hostname github.com --web`);
});

test('HTTP: /api/tools, unknown tools, and scanners have nothing to sign in to', async () => {
  const w = fakeWorld({ brew: true, have: ['claude', 'gh', 'gitleaks', 'zizmor', 'osv-scanner'] });
  const db = openDb();
  ensureDefaults(db);
  const mgr = new RunManager(db, new ClaudeRunner(db));
  const server = startHttp(db, mgr, new PostPushWatcher(db, mgr), 0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const call = (method: string, path: string) => fetch(`http://127.0.0.1:${port}${path}`, { method });
  try {
    const r = await call('GET', '/api/tools');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.tools.length, 5);
    assert.ok(body.tools.every((t: { installed: boolean }) => t.installed));
    const st = await (await call('GET', '/api/state')).json();
    assert.deepEqual(st.tools, { gh: true, ghAuthed: true, gitleaks: true, zizmor: true, osv: true, claude: true });
    assert.equal((await call('POST', '/api/tools/nmap/install')).status, 404);
    const si = await call('POST', '/api/tools/gitleaks/signin');
    assert.equal(si.status, 400);
    assert.match((await si.json()).error, /doesn't need signing in/);
    assert.equal((await call('POST', '/api/tools/homebrew/install')).status, 400, 'already installed');
  } finally {
    server.close();
    db.close();
    w.restore();
  }
});
