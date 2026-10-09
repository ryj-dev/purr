// The five scanners, ported from tc-ai-reviewer: what each is called, what it checks, and the "Found by" line under
// its findings. Shared by the service (PR comments) and the UI (the flow editor, finding chips).
import type { Finding, ScannerName } from './types.ts';

/** The scanners a flow can use, in the order the editor lists them. */
export const SCANNERS: ScannerName[] = ['betterleaks', 'zizmor', 'osv', 'hadolint', 'actionlint'];

/** Short label for a scanner block. */
export const SCANNER_LABEL: Record<ScannerName, string> = {
  betterleaks: 'betterleaks · secrets',
  zizmor: 'zizmor · workflows',
  osv: 'osv · dependencies',
  hadolint: 'hadolint · Dockerfiles',
  actionlint: 'actionlint · workflow lint',
};

/** One line for the flow editor's picker. */
export const SCANNER_CHOICE: Record<ScannerName, string> = {
  betterleaks: 'betterleaks: secrets in added lines',
  zizmor: 'zizmor: GitHub Actions workflow risks',
  osv: 'osv-scanner: new vulnerable dependencies',
  hadolint: 'hadolint: Dockerfile errors (consider, never blocks)',
  actionlint: 'actionlint: workflow errors (consider, never blocks)',
};

/** What each tool is, for the "Found by" line. */
const ABOUT: Record<string, [string, string | null]> = {
  betterleaks: ['an open-source tool that finds secrets (API keys, tokens, passwords) in code. It only reads the lines this change adds', null],
  hadolint: ['an open-source Dockerfile linter. Only its errors on lines this change adds are raised', 'https://github.com/hadolint/hadolint/wiki/{rule}'],
  actionlint: ['an open-source checker for GitHub Actions workflow files. Only errors on lines this change adds are raised', null],
  zizmor: ['an open-source checker for security mistakes in GitHub Actions workflows', 'https://docs.zizmor.sh/audits/#{rule}'],
  osv: ["osv-scanner, Google's open-source dependency checker. It compares this change's dependencies with the base's against "
    + 'the OSV vulnerability database, sending only package names and versions', 'https://osv.dev/vulnerability/{rule}'],
};

/** "Found by …" markdown for a scanner finding, or ''. */
export function foundBy(f: Finding): string {
  const s = f.source.scanner;
  const about = s ? ABOUT[s] : undefined;
  if (!about) return '';
  const [what, wiki] = about;
  // hadolint also passes on ShellCheck's codes for RUN lines (SC1073…): those are documented on ShellCheck's wiki
  const url = s === 'hadolint' && f.source.rule?.startsWith('SC') ? 'https://www.shellcheck.net/wiki/{rule}' : wiki;
  const rule = f.source.rule ? (url ? `[\`${f.source.rule}\`](${url.replace('{rule}', f.source.rule)})` : `\`${f.source.rule}\``) : null;
  return `_Found by **${s}**, ${what}.${rule ? ` Rule: ${rule}.` : ''}_`;
}

/** The same without markdown, for a tooltip. */
export const foundByPlain = (f: Finding) => foundBy(f).replace(/\[`([^`]+)`\]\([^)]+\)/g, '$1').replace(/[_*`]/g, '');
