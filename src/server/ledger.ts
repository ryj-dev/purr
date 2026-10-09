// Findings memory across runs: a finding keeps its identity (fingerprint) so it is raised once, recognised when it
// comes back after a fix (regression), and stays quiet once dismissed. Modelled on tc-ai-reviewer's memory.py.
import { createHash } from 'node:crypto';
import type { Finding, LedgerItem, Run } from '../shared/types.ts';
import type { DB } from './db.ts';
import { fingerprint } from './engine/findings.ts';
import type { Material } from './engine/material.ts';
import { now } from './util.ts';

export async function fingerprintAll(findings: Finding[], material: Material): Promise<void> {
  const used = new Set<string>();
  for (const f of findings) {
    let fp = f.fingerprint ?? fingerprint(f, await material.content(f.file));
    // two different issues on the same line and category would collide: tell them apart by their title
    if (used.has(fp)) fp = createHash('sha1').update(`${fp}|${f.title.toLowerCase()}`).digest('hex').slice(0, 16);
    used.add(fp);
    f.fingerprint = fp;
  }
}

/**
 * Rules gitleaks raised on text betterleaks doesn't flag (checked with both tools: a bare AWS access key id, and the
 * generic-api-key gitleaks adds beside an AWS key pair). betterleaks not finding them says nothing.
 */
const GITLEAKS_ONLY = new Set(['aws-access-token', 'generic-api-key']);

/**
 * Marks each finding new / open / regression / dismissed / tracked and records it. When `completeBlocks` is given
 * (every block finished), open items this branch raised before from one of those blocks, and not raised now, become fixed.
 */
export function applyLedger(db: DB, run: Run, findings: Finding[], completeBlocks: Set<string> | null,
  unchecked: Map<string, Set<string>> = new Map()): void {
  if (!run.repoId) return;
  const ts = now();
  const seen = new Set<string>();
  for (const f of findings) {
    if (!f.fingerprint) continue;
    seen.add(f.fingerprint);
    const prev = db.getLedger(f.fingerprint, run.repoId);
    let state: LedgerItem['state'] = 'open';
    if (!prev) f.ledger = 'new';
    else if (prev.state === 'dismissed') { f.ledger = 'dismissed'; state = 'dismissed'; }
    else if (prev.state === 'tracked') { f.ledger = 'tracked'; state = 'tracked'; }
    else if (prev.state === 'fixed') f.ledger = 'regression';
    else f.ledger = 'open';
    db.putLedger({
      fingerprint: f.fingerprint, repoId: run.repoId, branch: run.branch, state, flowId: run.flowId, finding: f,
      firstRunId: prev?.firstRunId ?? run.id, lastRunId: run.id, updatedAt: ts,
    });
  }
  // Only a complete review of the whole branch by the same flow can say an issue is gone: a pre-push scan only sees
  // the commits being pushed, and another flow may simply not look for it.
  const wholeBranch = run.trigger === 'post-push' || run.trigger === 'manual';
  if (completeBlocks && run.branch && run.mode === 'range' && wholeBranch) {
    for (const item of db.listLedger(run.repoId, 'open')) {
      if (item.branch !== run.branch || item.flowId !== run.flowId || seen.has(item.fingerprint)) continue;
      // the default flows' secrets block was scan-gitleaks before betterleaks replaced it: the same block, renamed. But
      // betterleaks doesn't raise everything gitleaks did (a bare AWS key id, some generic API keys), so its silence
      // can't close those: they stay open until dismissed, or until gitleaks itself (the fallback) runs and agrees
      const gitleaksEra = item.finding.source.blockId === 'scan-gitleaks' && !completeBlocks.has('scan-gitleaks');
      if (gitleaksEra && GITLEAKS_ONLY.has(item.finding.source.rule ?? '')) continue;
      const by = gitleaksEra ? 'scan-betterleaks' : item.finding.source.blockId;
      if (!completeBlocks.has(by)) continue;
      if (unchecked.get(by)?.has(item.finding.file)) continue;   // a file this run's scanner couldn't check: still open
      db.putLedger({ ...item, state: 'fixed', lastRunId: run.id, updatedAt: ts });
    }
  }
}

/** Findings that count: not dismissed or tracked. */
export const active = (findings: Finding[]) => findings.filter((f) => f.ledger !== 'dismissed' && f.ledger !== 'tracked');
