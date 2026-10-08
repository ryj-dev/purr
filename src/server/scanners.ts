// Deterministic scanners on the lines a change ADDS, ported from tc-ai-reviewer (src/worker/scanners.py). Blocking:
// betterleaks (any hit), zizmor (high; the unpinned-* rules only consider), osv-scanner (new critical/high vulns vs
// base). Advice, never blocking: hadolint (error level, changed Dockerfiles) and actionlint (changed workflows), both
// consider. Repeats of one rule in one file become one finding with `lines`. Everything is offline except osv, which
// sends package names and versions.
//
// betterleaks (the gitleaks successor, same flags and report) runs on a sparse copy of each changed file holding only
// the added lines (others blank), so line numbers stay right. Only the rule id and description are kept, never the
// secret itself, and its live validation (which would send the secret to its provider) stays off. Without betterleaks,
// an installed gitleaks does the same job.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import type { Finding, ScannerName, ScannerState, Severity } from '../shared/types.ts';
import { type ChangeSpec, type ChangedFile, fileAt, fileAtBase } from './git.ts';
import { exec, newId, paths } from './util.ts';

const WF = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;
const DOCKERFILE = /(^|\/)(Dockerfile(\.[^/]+)?|[^/]+\.Dockerfile)$/;
// full pinned trees osv-scanner reads as they are (go.mod lists every module the build uses; osv can't parse go.sum)
const LOCKS = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|uv\.lock|poetry\.lock|pdm\.lock|Pipfile\.lock|requirements[^/]*\.txt|Gemfile\.lock|go\.mod|Cargo\.lock)$/;
// a change's own scanner config or ignore file must never steer the scan of that change, but a secret pasted into one
// is still a secret: it's scanned under a name the scanner doesn't load as config, and reported under its own
const SCAN_CONFIG = new Set(['.betterleaks.toml', '.gitleaks.toml', '.betterleaksignore', '.gitleaksignore']);
const AS_DATA = '.purr-scan';
const FILE_MS = 60_000;   // one hadolint / actionlint call (one file)

// zizmor rule -> [headline, what goes wrong, fix]
const ZIZMOR: Record<string, [string, string, string]> = {
  'unpinned-uses': ['Actions are pinned to a tag, not a commit',
    "If an action's owner moves the tag or is compromised, new code runs in this workflow with the repo's secrets.",
    'Pin each action to a full commit SHA and keep the tag as a comment, e.g. `actions/checkout@<sha> # v4`.'],
  'template-injection': ['Anyone opening a PR or issue can run commands in this workflow',
    "Text they control, like a title or branch name, is pasted straight into a shell step that has the repo's secrets.",
    'Pass the value through `env:` and use it as a quoted shell variable.'],
  'dangerous-triggers': ["A fork PR can run its own code with this repo's secrets",
    "`pull_request_target` and `workflow_run` have write access and secrets, so running the PR's code hands both to the fork.",
    "Use `pull_request`, or never check out or run the PR's code in this job."],
  'excessive-permissions': ['The workflow token can do far more than this job needs',
    'If any step or action is compromised, it can push code, edit releases or change the repo.',
    'Set `permissions:` to the minimum, e.g. `contents: read`.'],
  'artipacked': ['Checkout leaves the GitHub token on disk',
    'A later step or an uploaded artifact can read it and act on the repo.',
    'Add `persist-credentials: false` to `actions/checkout`.'],
  'cache-poisoning': ['A PR can poison the cache this release build uses',
    'A release job that restores a shared cache can ship whatever a PR put in it.',
    "Don't restore caches in release or publish jobs."],
  'unpinned-images': ['Container images are pinned to a tag, not a digest',
    'Whoever controls the image tag can change what runs in this job.',
    'Pin the image by `@sha256:` digest.'],
};
const ZIZMOR_CONSIDER = new Set(['unpinned-uses', 'unpinned-images']);

const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').slice(0, 300);

function hit(blockId: string, scanner: ScannerName, file: string, line: number | null, rule: string, category: string,
  title: string, scenario: string, fix: string, severity: Severity = 'must_fix'): Finding {
  return {
    id: newId('f-'), file, line, category, severity, title, scenario, fix, confidence: 1,
    source: { blockId, kind: 'scanner', scanner, rule },
  };
}

/** One finding per (scanner, rule, file): the first line is the anchor, `lines` lists them all. */
export function group(hits: Finding[]): Finding[] {
  const out = new Map<string, Finding>();
  for (const h of hits) {
    const k = `${h.source.scanner}|${h.source.rule}|${h.file}`;
    const prev = out.get(k);
    if (prev) prev.lines!.push(...(h.line != null ? [h.line] : []));
    else out.set(k, { ...h, lines: h.line != null ? [h.line] : [] });
  }
  for (const h of out.values()) {
    h.lines = [...new Set(h.lines)].sort((a, b) => a - b);
    h.line = h.lines[0] ?? h.line;
  }
  return [...out.values()];
}

function secretKind(rule: string) {
  const up = new Set(['aws', 'gcp', 'jwt', 'ssh', 'api', 'npm', 'pat']);
  return (rule || 'secret').split('-').filter((w) => w !== 'generic').map((w) => (up.has(w) ? w.toUpperCase() : w)).join(' ') || 'secret';
}

const safePath = (p: string) => !p.split('/').includes('..') && !p.startsWith('/');

const isMissing = (e: any) => e?.code === 'ENOENT';

/** betterleaks, or gitleaks if only that is installed: same report either way, findings say which one ran. */
async function secrets(blockId: string, files: ChangedFile[], work: string): Promise<Finding[] | null> {
  const root = join(work, 'secrets');
  let any = false;
  for (const f of files) {
    if (!f.added.size || f.binary || !safePath(f.path)) continue;
    const max = Math.max(...f.added.keys());
    const lines: string[] = [];
    for (let i = 1; i <= max; i++) lines.push(f.added.get(i) ?? '');
    const at = SCAN_CONFIG.has(basename(f.path)) ? f.path + AS_DATA : f.path;
    mkdirSync(dirname(join(root, at)), { recursive: true });
    writeFileSync(join(root, at), lines.join('\n') + '\n');
    any = true;
  }
  if (!any) return null;
  const rep = join(work, 'secrets.json');
  const common = ['dir', root, '--no-banner', '--no-color', '--redact', '-f', 'json', '-r', rep, '--exit-code', '0', '-l', 'error'];
  // run in the scratch folder, not the repo: a config file there must not steer the scan.
  // --validation=false: never send a found secret to its provider to check it (betterleaks' default; said on purpose)
  let tool: 'betterleaks' | 'gitleaks' = 'betterleaks';
  let r;
  try {
    r = await exec('betterleaks', [...common, '--validation=false'], { cwd: work, timeoutMs: 300_000 });
  } catch (e) {
    if (!isMissing(e)) throw e;
    tool = 'gitleaks';   // older installs: gitleaks has the same flags, and never validates
    r = await exec('gitleaks', common, { cwd: work, timeoutMs: 300_000 });
  }
  if (r.code !== 0) throw new Error(`${tool} exited ${r.code}: ${clean(r.stderr)}`);
  let hits: Array<Record<string, any>> | null = null;
  try { hits = existsSync(rep) ? JSON.parse(readFileSync(rep, 'utf8') || 'null') : null; } catch { /* below */ }
  if (!Array.isArray(hits)) throw new Error(`${tool} wrote no readable report`);   // never a silent pass
  const realPath = (p: string) => (p.endsWith(AS_DATA) && SCAN_CONFIG.has(basename(p.slice(0, -AS_DATA.length))) ? p.slice(0, -AS_DATA.length) : p);
  return hits.map((h) => hit(blockId, tool, realPath(relative(root, h.File)), h.StartLine ?? null, h.RuleID, 'secrets',
    'A secret is committed here; anyone with repo access can use it',
    `This line holds what looks like a real ${secretKind(h.RuleID)}. Anyone who can read the repo, or its history, can use it.`,
    "Revoke and rotate it now; deleting the line doesn't remove it from git history."));
}

async function zizmor(blockId: string, files: ChangedFile[], change: ChangeSpec, work: string): Promise<Finding[] | null> {
  const wf = files.filter((f) => WF.test(f.path) && f.status !== 'deleted' && safePath(f.path));
  if (!wf.length) return null;
  const root = join(work, 'zizmor');
  for (const f of wf) {
    mkdirSync(dirname(join(root, f.path)), { recursive: true });
    writeFileSync(join(root, f.path), (await fileAt(change, f.path)) ?? '');
  }
  const r = await exec('zizmor', ['--offline', '--no-progress', '--format', 'json', ...wf.map((f) => f.path)], { cwd: root, timeoutMs: 300_000 });
  let items: Array<Record<string, any>> = [];
  try { items = JSON.parse(r.stdout || '[]'); } catch { throw new Error(`zizmor output unreadable: ${clean(r.stderr)}`); }
  const out: Finding[] = [];
  for (const h of items) {
    if (String(h.determinations?.severity ?? '').toLowerCase() !== 'high') continue;
    const loc = h.locations?.[0];
    if (!loc) continue;
    const rel: string = loc.symbolic?.key?.Local?.given_path ?? wf[0].path;
    const s = loc.concrete.location.start_point.row + 1;
    const e = loc.concrete.location.end_point.row + 1;
    const f = wf.find((x) => x.path === rel);
    let touches = false;
    for (let i = s; i <= e; i++) if (f?.added.has(i)) touches = true;
    if (!touches) continue;
    const rule: string = h.ident;
    const [head, why, fix] = ZIZMOR[rule] ?? [`This workflow has a high-risk setting (${rule})`, clean(h.desc), `See zizmor's docs for \`${rule}\`.`];
    out.push(hit(blockId, 'zizmor', rel, s, rule, 'ci-security', head, why, fix, ZIZMOR_CONSIDER.has(rule) ? 'consider' : 'must_fix'));
  }
  return out;
}

type Vuln = { ver: string; sev: number; summary: string; fixed: string[] };
async function osvScan(path: string): Promise<Map<string, Vuln>> {
  // --no-resolve: the file is a full pinned tree, read as it is
  const r = await exec('osv-scanner', ['scan', 'source', '--no-resolve', '--all-packages', '--format', 'json', '-L', path], { timeoutMs: 120_000 });
  const vulns = new Map<string, Vuln>();
  if (r.code === 128) return vulns;   // no packages in the file
  let data: any = null;
  try { data = r.code === 0 || r.code === 1 ? JSON.parse(r.stdout) : null; } catch { /* below */ }
  // an unreadable result is never a clean pass
  if (!data || typeof data !== 'object') throw new Error(`osv-scanner failed (exit ${r.code}): ${clean(r.stderr)}`);
  for (const res of data.results ?? []) {
    for (const pk of res.packages ?? []) {
      const sev = Math.max(0, ...(pk.groups ?? []).map((g: any) => Number(g.max_severity || 0)));
      const name: string = pk.package.name;
      for (const v of pk.vulnerabilities ?? []) {
        const fixed: string[] = [];
        for (const a of v.affected ?? []) {
          if ((a.package?.name ?? '').toLowerCase() !== name.toLowerCase()) continue;
          for (const rg of a.ranges ?? []) for (const ev of rg.events ?? []) if (ev.fixed) fixed.push(ev.fixed);
        }
        vulns.set(`${name}\u0000${v.id}`, { ver: pk.package.version, sev, summary: v.summary ?? '', fixed });
      }
    }
  }
  return vulns;
}
const ver = (v: string) => (v.match(/\d+/g) ?? []).slice(0, 4).map(Number);
const cmpVer = (a: string, b: string) => {
  const x = ver(a), y = ver(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};
const normPkg = (n: string) => n.replace(/[-_.]+/g, '-').toLowerCase();
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function osv(blockId: string, files: ChangedFile[], change: ChangeSpec, work: string): Promise<Finding[] | null> {
  const locks = files.filter((f) => LOCKS.test(f.path) && f.status !== 'deleted');
  if (!locks.length) return null;
  const out: Finding[] = [];
  for (const f of locks) {
    const found: Record<'base' | 'head', Map<string, Vuln>> = { base: new Map(), head: new Map() };
    let headTxt = '';
    for (const tag of ['base', 'head'] as const) {
      const txt = tag === 'head' ? await fileAt(change, f.path)
        : f.status === 'added' ? '' : await fileAtBase(change, f.oldPath ?? f.path);
      if (tag === 'head') headTxt = txt ?? '';
      if (!txt) continue;
      const p = join(work, 'osv', tag, basename(f.path));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, txt);
      found[tag] = await osvScan(p);
    }
    type Pkg = { ver: string; sev: number; ids: string[]; summ: string[]; fixed: string[] };
    const by = new Map<string, Pkg>();
    for (const [key, v] of found.head) {
      if (found.base.has(key) || v.sev < 7) continue;
      const [pkg, id] = key.split('\u0000');
      const b = by.get(pkg) ?? { ver: v.ver, sev: 0, ids: [], summ: [], fixed: [] };
      b.sev = Math.max(b.sev, v.sev); b.ids.push(id); b.fixed.push(...v.fixed);
      if (v.summary && !b.summ.includes(clean(v.summary))) b.summ.push(clean(v.summary));
      by.set(pkg, b);
    }
    const lines = headTxt.split('\n');
    const where = (pkg: string) => {
      const re = new RegExp(`(^|[\\s"'/@])${escRe(normPkg(pkg))}($|[\\s"'=<>~!\\[;:@,])`);
      const i = lines.findIndex((l) => re.test(normPkg(l)));
      return i >= 0 ? i + 1 : null;
    };
    const indirect: Array<[string, Pkg, string]> = [];
    for (const [pkg, b] of [...by].sort((a, c) => c[1].sev - a[1].sev)) {
      const worst = b.sev >= 9 ? 'critical' : 'high';
      const n = b.ids.length;
      const fixTo = b.fixed.length ? b.fixed.reduce((m, x) => (cmpVer(x, m) > 0 ? x : m)) : null;
      const line = where(pkg);
      if (line == null) { indirect.push([pkg, b, worst]); continue; }
      out.push(hit(blockId, 'osv', f.path, line, b.ids[0], 'dependencies',
        `\`${pkg}\` ${b.ver} has ${n} known vulnerabilit${n === 1 ? 'y' : 'ies'} (worst: ${worst})`,
        `\`${pkg}@${b.ver}\`: ${b.summ.slice(0, 3).join('; ') || 'see the advisories'}. Advisories: ${b.ids.slice(0, 6).join(', ')}${n > 6 ? ' and more' : ''}.`,
        fixTo ? `Upgrade \`${pkg}\` to ${fixTo} or later.` : `Upgrade \`${pkg}\` to a version with the fixes.`));
    }
    if (indirect.length) {
      const names = indirect.map(([p, b]) => `\`${p}\` ${b.ver} (${b.ids.length})`).join(', ');
      const worst = indirect.some(([, , w]) => w === 'critical') ? 'critical' : 'high';
      out.push(hit(blockId, 'osv', f.path, null, indirect[0][1].ids[0], 'dependencies',
        `${indirect.length} indirect dependenc${indirect.length === 1 ? 'y' : 'ies'} with known ${worst} vulnerabilities`,
        `Pulled in by other packages, not listed directly: ${names} known vulnerabilities.`,
        'Upgrading the packages that depend on them usually brings fixed versions; otherwise pin them.'));
    }
  }
  return out;
}

type Incomplete = Array<{ file: string; reason: string }>;

/** Changed files matching `rx` that still exist, with their contents written under `root`. */
async function writeChanged(files: ChangedFile[], rx: RegExp, change: ChangeSpec, root: string) {
  const picked = files.filter((f) => rx.test(f.path) && f.status !== 'deleted' && safePath(f.path) && !f.path.endsWith('.dockerignore'));
  for (const f of picked) {
    mkdirSync(dirname(join(root, f.path)), { recursive: true });
    writeFileSync(join(root, f.path), (await fileAt(change, f.path)) ?? '');
  }
  return picked;
}

/**
 * Runs `args(path)` once per file, each with its own timeout -> [(file, parsed JSON list)]. A file whose run fails is
 * listed in `incomplete` (state partial); every file failing throws (state failed). Never a silent pass.
 */
async function eachFile(tool: string, picked: ChangedFile[], args: (path: string) => string[], cwd: string, ok: number[], incomplete: Incomplete) {
  const out: Array<[ChangedFile, Array<Record<string, any>>]> = [];
  for (const f of picked) {
    const r = await exec(tool, args(f.path), { cwd, timeoutMs: FILE_MS });   // a missing tool throws ENOENT: not installed
    if (r.timedOut) { incomplete.push({ file: f.path, reason: `timed out after ${FILE_MS / 1000}s` }); continue; }
    if (!ok.includes(r.code)) { incomplete.push({ file: f.path, reason: `${tool} exited ${r.code}: ${clean(r.stderr)}` }); continue; }
    let got: unknown = null;
    try { got = JSON.parse(r.stdout || 'null'); } catch { /* below */ }
    // actionlint prints nothing at all for a clean file
    if (got === null && tool === 'actionlint' && r.code === 0 && !r.stdout.trim()) got = [];
    if (!Array.isArray(got)) { incomplete.push({ file: f.path, reason: `${tool}'s output was unreadable` }); continue; }
    out.push([f, got]);
  }
  if (incomplete.length && !out.length) throw new Error(incomplete[0].reason);
  return out;
}

/**
 * Error-level hadolint results on lines this change adds (warnings, info and style are left out) -> consider findings.
 * A result sits on an instruction's first line, so an edit only to a later line of a multi-line RUN isn't raised.
 */
async function hadolint(blockId: string, files: ChangedFile[], change: ChangeSpec, work: string, incomplete: Incomplete): Promise<Finding[] | null> {
  const root = join(work, 'hadolint');
  const picked = await writeChanged(files, DOCKERFILE, change, root);
  if (!picked.length) return null;
  const out: Finding[] = [];
  for (const [f, res] of await eachFile('hadolint', picked, (p) => ['--no-fail', '--no-color', '-f', 'json', p], root, [0], incomplete)) {
    for (const h of res) {
      if (h.level !== 'error' || !f.added.has(h.line)) continue;
      out.push(hit(blockId, 'hadolint', f.path, h.line, h.code, 'lint', `Dockerfile problem: ${clean(h.message).slice(0, 120)}`,
        clean(h.message), `See hadolint's rule \`${h.code}\` for the fix.`, 'consider'));
    }
  }
  return out;
}

/** actionlint errors on lines this change adds to a workflow -> consider findings. Its shellcheck and pyflakes checks run
 * when those tools are installed. */
async function actionlint(blockId: string, files: ChangedFile[], change: ChangeSpec, work: string, incomplete: Incomplete): Promise<Finding[] | null> {
  const root = join(work, 'actionlint');
  const picked = await writeChanged(files, WF, change, root);
  if (!picked.length) return null;
  const out: Finding[] = [];
  for (const [f, res] of await eachFile('actionlint', picked, (p) => ['-no-color', '-format', '{{json .}}', p], root, [0, 1], incomplete)) {
    for (const h of res) {
      if (!f.added.has(h.line)) continue;
      out.push(hit(blockId, 'actionlint', f.path, h.line, h.kind, 'lint', `Workflow problem: ${clean(h.message).slice(0, 120)}`,
        clean(h.message), 'Fix the workflow so GitHub runs it as intended.', 'consider'));
    }
  }
  return out;
}

/** Runs one scanner. Never throws: a missing or failing tool is reported in the state and yields no findings. */
export async function runScanner(name: ScannerName, blockId: string, files: ChangedFile[], change: ChangeSpec):
  Promise<{ findings: Finding[]; state: ScannerState }> {
  const work = mkdtempSync(join(paths.scratch, `${name}-`));
  const t0 = Date.now();
  const incomplete: Incomplete = [];
  const secs = () => (Date.now() - t0) / 1000;
  try {
    // 'gitleaks': a flow saved before betterleaks replaced it
    const got = name === 'betterleaks' || name === 'gitleaks' ? await secrets(blockId, files, work)
      : name === 'zizmor' ? await zizmor(blockId, files, change, work)
      : name === 'hadolint' ? await hadolint(blockId, files, change, work, incomplete)
      : name === 'actionlint' ? await actionlint(blockId, files, change, work, incomplete)
      : await osv(blockId, files, change, work);
    const findings = got ? group(got) : [];
    if (got === null) return { findings, state: { state: 'n/a', secs: secs() } };
    return { findings, state: incomplete.length ? { state: 'partial', hits: findings.length, incomplete, secs: secs() } : { state: 'ran', hits: findings.length, secs: secs() } };
  } catch (e: any) {
    const missing = isMissing(e);
    const tool = name === 'gitleaks' ? 'betterleaks' : name;
    return { findings: [], state: { state: missing ? 'not installed' : 'failed', error: missing ? `${tool} is not on PATH` : String(e?.message ?? e), secs: secs() } };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
