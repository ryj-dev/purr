// Imported first by every test: points PuRR at a throwaway home so tests never touch ~/.purr.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const base = process.env.TMPDIR || tmpdir();
// tests drive fake gh binaries: a real token in the environment would reach them (and could show up in a failure)
delete process.env.GH_TOKEN;
delete process.env.GITHUB_TOKEN;
process.env.PURR_HOME = mkdtempSync(join(base, 'purr-test-home-'));
// Tests never see the user's ~/.gitconfig (e.g. PuRR's own global core.hooksPath would bypass per-repo test hooks).
process.env.GIT_CONFIG_GLOBAL = join(mkdtempSync(join(base, 'purr-test-gitglobal-')), 'gitconfig');
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
export const FAKE_CLAUDE = new URL('./fake-claude.mjs', import.meta.url).pathname;

export function tempRepo(files: Record<string, string> = { 'README.md': '# demo\n' }): string {
  const dir = mkdtempSync(join(base, 'purr-test-repo-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  git('add', '-A');
  git('commit', '-q', '-m', 'init', '--no-verify');
  return dir;
}

export function sh(dir: string, ...a: string[]) {
  return execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString().trim();
}

// A real-looking GitHub token that betterleaks and gitleaks both flag (not a live credential). betterleaks doesn't flag
// a bare AWS access key id on its own (only with its secret), which gitleaks did.
export const FAKE_SECRET = 'ghp_' + 'Zq3XvT9mK2pL8wR4nY6bD1cF5hJ7sA0eG3uI';
