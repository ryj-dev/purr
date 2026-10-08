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
import { asString, installMissing, installTool, onToolchainChange, openSignIn, refreshToolchain, signInCommand, toolchainStatus } from '../src/server/toolchain.ts';
import { expectGhSignIn, forgetGhAccounts, ghAccounts } from '../src/server/gh.ts';

// A PATH holding only fake tools (plus the system basics), and a fake brew that "installs" by writing a fake tool.
// Tests share one process, so PATH and PURR_BREW are put back afterwards.
function fakeWorld(opts: { brew: boolean; brewFails?: boolean; hold?: boolean; have: string[] }) {
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
      // `brew install <formula>`, or `brew install --cask claude-code`, which provides `claude`. It notes in the log
      // if another brew was running when it started, and with `hold` it doesn't finish until the test says so.
      : `#!/bin/sh
[ -e "${dir}/brew.lock" ] && echo OVERLAP >> "${dir}/brew.log"
touch "${dir}/brew.lock"
n="$2"; [ "$2" = --cask ] && n="$3"; [ "$n" = claude-code ] && n=claude
echo "==> Fetching $n"
${opts.hold ? `while [ ! -e "${dir}/go" ]; do sleep 0.02; done` : ''}
printf '#!/bin/sh\\necho "%s 9.9.9"\\n' "$n" > "${dir}/$n"
chmod +x "${dir}/$n"
echo "$*" >> "${dir}/brew.log"
rm -f "${dir}/brew.lock"
`);
    chmodSync(brew, 0o755);
  }
  const saved = { PATH: process.env.PATH, PURR_BREW: process.env.PURR_BREW };
  process.env.PATH = `${dir}:/usr/bin:/bin:/usr/sbin:/sbin`;
  process.env.PURR_BREW = opts.brew ? brew : '';
  refreshToolchain();
  return {
    dir,
    /** lets a held brew finish */
    release() { writeFileSync(join(dir, 'go'), ''); },
    restore() {
      writeFileSync(join(dir, 'go'), '');   // never leave a held brew running, even when the test failed early
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
  const w = fakeWorld({ brew: true, hold: true, have: ['claude', 'gh'] });
  try {
    installTool('zizmor');
    assert.equal((await toolchainStatus()).tools.find((t) => t.name === 'zizmor')!.job?.state, 'running');
    w.release();
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

test('installs never run two brews at once, and a tool is never queued twice', async () => {
  const w = fakeWorld({ brew: true, hold: true, have: ['claude', 'gh'] });
  try {
    installTool('zizmor');
    installTool('zizmor');   // a double click
    // Install missing, twice at once, while zizmor is still installing
    const [a, b] = await Promise.all([installMissing(), installMissing()]);
    assert.deepEqual([...a, ...b].sort(), ['gitleaks', 'osv-scanner'], 'each missing tool queued once, zizmor not again');
    const st = (await toolchainStatus()).tools;
    assert.equal(st.find((t) => t.name === 'gitleaks')!.job?.step, 'Queued');
    w.release();
    for (const n of ['zizmor', 'gitleaks', 'osv-scanner']) assert.equal((await settled(n)).installed, true, `${n} installed`);
    assert.deepEqual(readFileSync(join(w.dir, 'brew.log'), 'utf8').trim().split('\n'),
      ['install zizmor', 'install gitleaks', 'install osv-scanner'], 'one brew at a time, each once');
  } finally { w.restore(); }
});

test('sign-in commands quote the tool path for the shell, then for AppleScript', () => {
  assert.equal(signInCommand('claude', '/Users/a b/.local/bin/claude'), `'/Users/a b/.local/bin/claude' auth login`);
  const gh = signInCommand('gh', '/x/it\'s "q" \\ b/gh');
  assert.equal(gh, `'/x/it'\\''s "q" \\ b/gh' auth login --hostname github.com --web`);
  // what Terminal's `do script` receives is exactly that command
  assert.equal(asString(gh), `"'/x/it'\\\\''s \\"q\\" \\\\ b/gh' auth login --hostname github.com --web"`);
  const back = JSON.parse(asString(gh));   // AppleScript and JSON escape quotes and backslashes the same way
  assert.equal(back, gh);
});

test('after a gh sign-in starts, a new account shows up within seconds, not after the five-minute cache', async (t) => {
  const w = fakeWorld({ brew: false, have: [] });
  const accounts = join(w.dir, 'accounts');
  writeFileSync(join(w.dir, 'gh'), `#!/bin/sh\nwhile read a; do printf '  ✓ Logged in to github.com account %s (keyring)\\n  - Active account: false\\n' "$a"; done < "${accounts}"\n`);
  chmodSync(join(w.dir, 'gh'), 0o755);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    writeFileSync(accounts, 'me\n');
    forgetGhAccounts();
    assert.deepEqual(await ghAccounts(), ['me']);
    expectGhSignIn();                        // Sign in clicked: Terminal is open, the login isn't done yet
    assert.deepEqual(await ghAccounts(), ['me'], 'read again at once, still the old list');
    writeFileSync(accounts, 'me\nwork-me\n');   // the login finishes
    t.mock.timers.tick(6_000);
    assert.deepEqual(await ghAccounts(), ['me', 'work-me'], 'seen on the next check after a few seconds');
    writeFileSync(accounts, 'me\nwork-me\nthird\n');
    t.mock.timers.tick(11 * 60_000);         // the sign-in window is over: back to the five-minute cache
    assert.equal((await ghAccounts()).length, 3);
    writeFileSync(accounts, 'me\n');
    t.mock.timers.tick(10_000);
    assert.equal((await ghAccounts()).length, 3, 'cached again');
  } finally { t.mock.timers.reset(); expectGhSignIn(0); w.restore(); }   // end the sign-in window for later tests
});

test('Sign in for gh opens its login in Terminal, then looks for the new account every few seconds', async (t) => {
  const w = fakeWorld({ brew: false, have: [] });
  const accounts = join(w.dir, 'accounts');
  const ran = join(w.dir, 'osascript.log');
  writeFileSync(join(w.dir, 'gh'), `#!/bin/sh\nwhile read a; do printf '  ✓ Logged in to github.com account %s (keyring)\\n  - Active account: false\\n' "$a"; done < "${accounts}"\n`);
  writeFileSync(join(w.dir, 'osascript'), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${ran}"\n`);
  chmodSync(join(w.dir, 'gh'), 0o755);
  chmodSync(join(w.dir, 'osascript'), 0o755);
  process.env.PURR_OSASCRIPT = join(w.dir, 'osascript');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    writeFileSync(accounts, 'me\n');
    forgetGhAccounts();
    assert.deepEqual(await ghAccounts(), ['me']);
    await openSignIn('gh');
    assert.match(readFileSync(ran, 'utf8'), /do script ".*gh' auth login --hostname github\.com --web"/);
    assert.deepEqual(await ghAccounts(), ['me']);
    writeFileSync(accounts, 'me\nwork-me\n');   // the login finishes
    t.mock.timers.tick(6_000);
    assert.deepEqual(await ghAccounts(), ['me', 'work-me'], 'not the five-minute cache');
  } finally { t.mock.timers.reset(); expectGhSignIn(0); delete process.env.PURR_OSASCRIPT; w.restore(); }
});

test('HTTP: /api/tools, installing, unknown tools, and scanners have nothing to sign in to', async () => {
  const w = fakeWorld({ brew: true, hold: true, have: ['claude', 'gh', 'gitleaks', 'osv-scanner'] });
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
    assert.equal(body.homebrew.installed, true);
    assert.deepEqual(body.tools.filter((t: { installed: boolean }) => !t.installed).map((t: { name: string }) => t.name), ['zizmor']);
    const st = await (await call('GET', '/api/state')).json();
    assert.deepEqual(st.tools, { gh: true, ghAuthed: true, gitleaks: true, zizmor: false, osv: true, claude: true });

    const one = await call('POST', '/api/tools/zizmor/install');
    assert.equal(one.status, 202);
    assert.deepEqual(await one.json(), { ok: true });
    const all = await call('POST', '/api/tools/install-missing');
    assert.equal(all.status, 202);
    assert.deepEqual(await all.json(), { installing: [] }, 'zizmor is already queued');
    // wait on the install itself, not by re-reading (which would clear the sidebar's cache and hide a stale one)
    const done = new Promise<void>((r) => { const off = onToolchainChange((s) => { if (s) { off(); r(); } }); });
    w.release();                              // brew held zizmor until now, so it couldn't finish first and be queued again
    await done;
    assert.equal((await (await call('GET', '/api/state')).json()).tools.zizmor, true, 'the sidebar summary updates after an install');
    assert.equal((await settled('zizmor')).installed, true);

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
