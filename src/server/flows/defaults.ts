import type { Block, BlockConfigMap, BlockType, Edge, Flow, ScannerName, TriggerKind } from '../../shared/types.ts';
import { SCANNER_LABEL } from '../../shared/scanners.ts';
import { blockTypeInfo } from './blockTypes.ts';
import { CONTEXT_PROMPT, DEFAULT_ALLOWED_TOOLS, LENS_PROMPTS, SEVERITY_PROMPT, VERIFY_PROMPT } from './prompts.ts';

const COL = 300, ROW = 110;

function block<T extends BlockType>(id: string, type: T, label: string, col: number, row: number, config?: Partial<BlockConfigMap[T]>): Block {
  return {
    id, type, label, position: { x: col * COL, y: row * ROW },
    config: { ...(blockTypeInfo(type).defaultConfig as BlockConfigMap[T]), ...(config ?? {}) } as BlockConfigMap[T],
  };
}
const edge = (source: string, target: string): Edge => ({ id: `e-${source}-${target}`, source, target });
const scanner = (name: ScannerName, col: number, row: number) => block(`scan-${name}`, 'scanner', SCANNER_LABEL[name], col, row, { scanner: name });

const STAMP = '2026-10-07T00:00:00.000Z';

function preCommit(): Flow {
  const blocks = [
    scanner('betterleaks', 0, 1),
    block('gate', 'gate', 'Block commit on must-fix', 1, 1, { blockOn: 'must_fix' }),
    block('out', 'output', 'Results', 2, 1, { notify: false, postPrComment: false }),
  ];
  return {
    id: 'default-pre-commit', name: 'Default · Pre-commit scan', isDefault: true, createdAt: STAMP, updatedAt: STAMP,
    description: 'betterleaks on the staged lines. A secret blocks the commit. No Claude, so it adds no quota and runs in a second or two.',
    blocks, edges: [edge('scan-betterleaks', 'gate'), edge('gate', 'out'), edge('scan-betterleaks', 'out')],
  };
}

function prePush(): Flow {
  const blocks = [
    // the blocking three only: hadolint and actionlint advise (consider), so they wait for the review after the push
    scanner('betterleaks', 0, 0), scanner('zizmor', 0, 1), scanner('osv', 0, 2),
    block('gate', 'gate', 'Block push on must-fix', 1, 1, { blockOn: 'must_fix' }),
    block('out', 'output', 'Results', 2, 1, { notify: false, postPrComment: false }),
  ];
  const s = ['scan-betterleaks', 'scan-zizmor', 'scan-osv'];
  return {
    id: 'default-pre-push', name: 'Default · Pre-push scan', isDefault: true, createdAt: STAMP, updatedAt: STAMP,
    description: 'betterleaks, zizmor and osv-scanner on the commits being pushed. A must-fix hit blocks the push. No Claude.',
    blocks, edges: [...s.map((x) => edge(x, 'gate')), ...s.map((x) => edge(x, 'out')), edge('gate', 'out')],
  };
}

function fullReview(): Flow {
  const lensKeys = Object.keys(LENS_PROMPTS);
  const blocks: Block[] = [
    scanner('betterleaks', 0, 0.5), scanner('zizmor', 0, 1.5), scanner('osv', 0, 2.5), scanner('hadolint', 0, 3.5), scanner('actionlint', 0, 4.5),
    block('context', 'context', 'Context · gather facts', 1, 2.5, {
      model: 'opus', effort: 'medium', tools: ['Read', 'Grep', 'Glob', 'Bash'], allowedTools: DEFAULT_ALLOWED_TOOLS,
      maxTurns: 40, prompt: CONTEXT_PROMPT, includeDiff: true, includeFiles: true, budgetChars: 140_000,
    }),
    block('branch', 'branch', `Branch ×${lensKeys.length}`, 2, 2.5),
    ...lensKeys.map((k, i) => block(`lens-${k}`, 'prompt', LENS_PROMPTS[k].label, 3, i, {
      prompt: LENS_PROMPTS[k].prompt, category: LENS_PROMPTS[k].category, output: 'findings', maxTurns: 30,
      allowedTools: DEFAULT_ALLOWED_TOOLS, forkFrom: null,
    })),
    block('merge', 'merge', 'Merge & dedupe', 4, 2.5, { lineWindow: 3 }),
    block('severity', 'prompt', 'Severity check', 5, 2.5, {
      prompt: SEVERITY_PROMPT, output: 'findings', forkFrom: 'context', maxTurns: 20, allowedTools: DEFAULT_ALLOWED_TOOLS, category: 'general',
    }),
    block('verify', 'verify', 'Verify must-fixes', 6, 2.5, {
      prompt: VERIFY_PROMPT, forkFrom: 'context', appliesTo: ['must_fix'], failClosed: true, concurrency: 3, maxTurns: 15,
      allowedTools: DEFAULT_ALLOWED_TOOLS,
    }),
    block('out', 'output', 'Results', 7, 2.5, { notify: true, postPrComment: false }),
  ];
  const scans = ['scan-betterleaks', 'scan-zizmor', 'scan-osv', 'scan-hadolint', 'scan-actionlint'];
  const edges: Edge[] = [
    ...scans.map((s) => edge(s, 'context')),
    ...scans.map((s) => edge(s, 'out')),            // scanner hits are deterministic: straight to the results
    edge('context', 'branch'),
    ...lensKeys.map((k) => edge('branch', `lens-${k}`)),
    ...lensKeys.map((k) => edge(`lens-${k}`, 'merge')),
    edge('merge', 'severity'),
    edge('severity', 'verify'),
    edge('verify', 'out'),
  ];
  return {
    id: 'default-review', name: 'Default · Full review', isDefault: true, createdAt: STAMP, updatedAt: STAMP,
    description: 'Scanners feed a seed session that gathers context once, then branches into six specialist lenses. Findings are merged, '
      + 'severity-checked and must-fixes verified by skeptic forks of the seed. Modelled on tc-ai-reviewer.',
    blocks, edges,
  };
}

export const DEFAULT_FLOWS: Flow[] = [preCommit(), prePush(), fullReview()];

export const DEFAULT_TRIGGERS: Record<TriggerKind, string> = {
  'pre-commit': 'default-pre-commit',
  'pre-push': 'default-pre-push',
  'post-push': 'default-review',
  manual: 'default-review',
};
