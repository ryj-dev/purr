// Deterministic scanners on the lines a change ADDS, ported from tc-ai-reviewer (src/worker/scanners.py):
// gitleaks (any hit), zizmor (high severity), osv-scanner (new critical/high vulns vs base).
// gitleaks runs on a sparse copy of each changed file holding only the added lines (others blank), so line numbers
// stay right. Only the rule id and description are kept, never the secret itself.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import type { Finding, ScannerName, ScannerState, Severity } from '../shared/types.ts';
import { type ChangeSpec, type ChangedFile, fileAt, fileAtBase } from './git.ts';
import { exec, newId, paths } from './util.ts';

const WF = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;
const LOCKS = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|uv\.lock|poetry\.lock|Pipfile\.lock|requirements[^/]*\.txt|Gemfile\.lock|go\.sum|Cargo\.lock)$/;

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

async function gitleaks(blockId: string, files: ChangedFile[], work: string): Promise<Finding[] | null> {
  const root = join(work, 'gitleaks');
  let any = false;
  for (const f of files) {
    if (!f.added.size || f.binary || !safePath(f.path)) continue;
    const max = Math.max(...f.added.keys());
    const lines: string[] = [];
    for (let i = 1; i <= max; i++) lines.push(f.added.get(i) ?? '');
    mkdirSync(dirname(join(root, f.path)), { recursive: true });
    writeFileSync(join(root, f.path), lines.join('\n') + '\n');
    any = true;
  }
  if (!any) return null;
  const rep = join(work, 'gitleaks.json');
  const r = await exec('gitleaks', ['dir', root, '--no-banner', '--redact', '-f', 'json', '-r', rep, '--exit-code', '0', '-l', 'error'],
    { timeoutMs: 300_000 });
  if (r.code !== 0 && !existsSync(rep)) throw new Error(`gitleaks exited ${r.code}: ${clean(r.stderr)}`);
  const hits = existsSync(rep) ? (JSON.parse(readFileSync(rep, 'utf8') || '[]') as Array<Record<string, any>>) : [];
  return hits.map((h) => hit(blockId, 'gitleaks', relative(root, h.File), h.StartLine ?? null, h.RuleID, 'secrets',
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
  const r = await exec('osv-scanner', ['scan', 'source', '-L', path, '--format', 'json'], { timeoutMs: 300_000 });
  const vulns = new Map<string, Vuln>();
  let data: any = {};
  try { data = JSON.parse(r.stdout || '{}'); } catch { if (r.code > 1) throw new Error(`osv-scanner failed: ${clean(r.stderr)}`); }
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

/** Runs one scanner. Never throws: a missing or failing tool is reported in the state and yields no findings. */
export async function runScanner(name: ScannerName, blockId: string, files: ChangedFile[], change: ChangeSpec):
  Promise<{ findings: Finding[]; state: ScannerState }> {
  const work = mkdtempSync(join(paths.scratch, `${name}-`));
  const t0 = Date.now();
  try {
    const got = name === 'gitleaks' ? await gitleaks(blockId, files, work)
      : name === 'zizmor' ? await zizmor(blockId, files, change, work)
      : await osv(blockId, files, change, work);
    const findings = got ? group(got) : [];
    return { findings, state: got === null ? { state: 'n/a', secs: (Date.now() - t0) / 1000 } : { state: 'ran', hits: findings.length, secs: (Date.now() - t0) / 1000 } };
  } catch (e: any) {
    const missing = e?.code === 'ENOENT';
    return { findings: [], state: { state: missing ? 'not installed' : 'failed', error: missing ? `${name} is not on PATH` : String(e?.message ?? e), secs: (Date.now() - t0) / 1000 } };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
