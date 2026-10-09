import { createHash } from 'node:crypto';
import type { Finding, Severity } from '../../shared/types.ts';
import { newId } from '../util.ts';

export const SEV_RANK: Record<Severity, number> = { must_fix: 3, consider: 2, minor: 1 };
const SEVS = new Set(['must_fix', 'consider', 'minor']);

const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Model output -> Finding, or null if it doesn't name a file. */
export function normalizeFinding(raw: any, blockId: string, defaultCategory: string): Finding | null {
  if (!raw || typeof raw !== 'object') return null;
  const file = str(raw.file ?? raw.path, 500).replace(/^\.?\//, '').replace(/^[ab]\//, '');
  if (!file) return null;
  const lineN = Number(raw.line);
  const severity = (SEVS.has(raw.severity) ? raw.severity : SEVS.has(raw.label) ? raw.label : 'consider') as Severity;
  const scenario = str(raw.scenario) || str(raw.body) || str(raw.description);
  const title = str(raw.title ?? raw.headline, 200) || scenario.split(/(?<=[.!?])\s/)[0].slice(0, 120) || 'Untitled finding';
  const conf = Number(raw.confidence);
  return {
    id: newId('f-'),
    file,
    line: Number.isFinite(lineN) && lineN > 0 ? Math.floor(lineN) : null,
    symbol: str(raw.symbol, 200) || null,
    category: (str(raw.category, 60) || defaultCategory).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || defaultCategory,
    severity,
    title,
    scenario,
    evidence: str(raw.evidence) || undefined,
    fix: str(raw.fix) || undefined,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null,
    source: { blockId, kind: 'model' },
  };
}

/** Compact form for {{findings}} so prompts stay small. */
export const slim = (f: Finding) => ({
  id: f.id, file: f.file, line: f.line, symbol: f.symbol ?? null, category: f.category, severity: f.severity,
  title: f.title, scenario: f.scenario, evidence: f.evidence ?? null, fix: f.fix ?? null, confidence: f.confidence ?? null,
  source: f.source.scanner ? `scanner:${f.source.scanner}` : f.source.blockId,
});

/**
 * What makes two scanner hits the same issue: scanner, rule and file, and for actionlint the message too, since its
 * "rule" is a broad kind (expression, syntax-check...) covering unrelated errors. group() and dedupe() both use it.
 */
export const scannerIssueKey = (f: Finding) =>
  `${f.source.scanner}|${f.source.rule}|${f.file}${f.source.scanner === 'actionlint' ? `|${f.scenario.toLowerCase().replace(/\s+/g, ' ').trim()}` : ''}`;

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
function similarity(a: string, b: string) {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

/**
 * Conservative on purpose: two distinct bugs on adjacent lines must not merge (the severity step and the verifier
 * catch semantic duplicates later). Same place AND similar wording, with a lower bar when the category matches;
 * a scanner hit absorbs a model finding of the same category at the same place.
 */
export function sameIssue(a: Finding, b: Finding, lineWindow: number): boolean {
  if (a.file !== b.file) return false;
  if (a.source.kind === 'scanner' && b.source.kind === 'scanner') return scannerIssueKey(a) === scannerIssueKey(b);
  const near = a.line != null && b.line != null ? Math.abs(a.line - b.line) <= lineWindow
    : !!(a.symbol && b.symbol && a.symbol === b.symbol);
  if (!near) return false;
  const sameCat = a.category === b.category;
  if (sameCat && (a.source.kind === 'scanner' || b.source.kind === 'scanner')) return true;
  const sim = similarity(`${a.title} ${a.scenario}`, `${b.title} ${b.scenario}`);
  return sim >= (sameCat ? 0.3 : 0.5);
}

const better = (a: Finding, b: Finding) =>
  SEV_RANK[a.severity] !== SEV_RANK[b.severity] ? SEV_RANK[a.severity] > SEV_RANK[b.severity]
    : (a.source.kind === 'scanner') !== (b.source.kind === 'scanner') ? a.source.kind === 'scanner'
    : (a.confidence ?? 0.5) >= (b.confidence ?? 0.5);

/** Merges duplicates: keeps the more severe (then scanner, then more confident) copy, records who else found it. */
export function dedupe(findings: Finding[], lineWindow = 3): Finding[] {
  const kept: Finding[] = [];
  for (const f of findings) {
    const i = kept.findIndex((k) => k.id === f.id || sameIssue(k, f, lineWindow));
    if (i < 0) { kept.push({ ...f }); continue; }
    const k = kept[i];
    if (k.id === f.id) continue;
    const [win, lose] = better(k, f) ? [k, f] : [f, k];
    kept[i] = {
      ...win,
      alsoFoundBy: [...new Set([...(win.alsoFoundBy ?? []), lose.source.blockId, ...(lose.alsoFoundBy ?? [])])].filter((x) => x !== win.source.blockId),
      evidence: win.evidence || lose.evidence,
      fix: win.fix || lose.fix,
    };
  }
  return kept;
}

const norm = (s: string) => s.replace(/\/\/.*$|#.*$/g, '').replace(/\s+/g, '');

/** Stable identity across runs: category, file, symbol and the normalised code around the line. */
export function fingerprint(f: Finding, content: string | null): string {
  let window = '';
  if (content && f.line) {
    const lines = content.split('\n');
    window = lines.slice(Math.max(0, f.line - 4), f.line + 3).map(norm).join('\n');
  }
  // betterleaks is gitleaks' successor with the same rules: its findings keep gitleaks' identity, so a secret dismissed
  // or tracked before the switch stays that way
  const scanner = f.source.scanner === 'betterleaks' ? 'gitleaks' : f.source.scanner;
  const anchor = f.source.kind === 'scanner' ? `${scanner}:${f.source.rule}` : f.category;
  const tail = window || f.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return createHash('sha1').update([anchor, f.file, f.symbol ?? '', tail].join('|')).digest('hex').slice(0, 16);
}

export const countBySeverity = (fs: Finding[]) => ({
  must_fix: fs.filter((f) => f.severity === 'must_fix').length,
  consider: fs.filter((f) => f.severity === 'consider').length,
  minor: fs.filter((f) => f.severity === 'minor').length,
});
