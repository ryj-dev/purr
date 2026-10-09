import type { BlockConfigMap, BlockType } from '../../shared/types.ts';
import { DEFAULT_ALLOWED_TOOLS, VERIFY_PROMPT } from './prompts.ts';

export interface BlockTypeInfo {
  type: BlockType;
  label: string;
  description: string;
  defaultConfig: BlockConfigMap[BlockType];
  maxInputs: number | null;
  startsSession: boolean;
  needsSession: boolean;
  models?: string[];
  tools?: string[];
}

export const MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
export const BUILTIN_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Task'];

export const BLOCK_TYPES: BlockTypeInfo[] = [
  {
    type: 'scanner', label: 'Code scanner', maxInputs: 0, startsSession: false, needsSession: false,
    description: 'Runs betterleaks, zizmor, osv-scanner, hadolint or actionlint on the lines this change adds. No Claude. Its findings can feed a context block or a gate.',
    defaultConfig: { scanner: 'betterleaks' },
  },
  {
    type: 'command', label: 'Command', maxInputs: 0, startsSession: false, needsSession: false,
    description: 'Runs a shell command in the reviewed checkout (type-check, lint, tests). Its output is available to context blocks as {{command_outputs}}.',
    defaultConfig: { command: 'npx tsc --noEmit', timeoutSec: 300, failOnNonZero: false },
  },
  {
    type: 'context', label: 'Context (seed session)', maxInputs: null, startsSession: true, needsSession: false,
    description: 'Starts a Claude session that gathers shared context. Its model and tool set are inherited by every fork downstream.',
    models: MODELS, tools: BUILTIN_TOOLS,
    defaultConfig: {
      model: 'sonnet', effort: null, tools: ['Read', 'Grep', 'Glob', 'Bash'], allowedTools: DEFAULT_ALLOWED_TOOLS, maxTurns: 40,
      prompt: 'Gather context for reviewing this change.\n\nChanged files:\n{{changed_files}}\n\nDiff:\n{{diff}}',
      includeDiff: true, includeFiles: false, budgetChars: 140_000,
    },
  },
  {
    type: 'branch', label: 'Branch', maxInputs: 1, startsSession: false, needsSession: true,
    description: 'Duplicates the upstream session once per outgoing connection. Nothing to configure: the next blocks send the prompts.',
    defaultConfig: {},
  },
  {
    type: 'prompt', label: 'Prompt', maxInputs: null, startsSession: false, needsSession: true,
    description: 'Sends a prompt to a fork of an upstream session (or of the block chosen in "fork from"). Outputs findings or text.',
    defaultConfig: {
      prompt: 'Review this change for …\n\nReturn ONLY a JSON array:\n{{finding_schema}}', maxTurns: 30,
      allowedTools: DEFAULT_ALLOWED_TOOLS, output: 'findings', forkFrom: null, category: 'general',
    },
  },
  {
    type: 'merge', label: 'Merge & dedupe', maxInputs: null, startsSession: false, needsSession: false,
    description: 'Joins findings from every input and merges duplicates (same file, nearby line or same symbol, same category).',
    defaultConfig: { lineWindow: 3 },
  },
  {
    type: 'verify', label: 'Verify (skeptic)', maxInputs: null, startsSession: false, needsSession: true,
    description: 'For each finding at the chosen severities, forks a session that tries to refute it. Refuted findings are dropped.',
    defaultConfig: {
      prompt: VERIFY_PROMPT, maxTurns: 15, allowedTools: DEFAULT_ALLOWED_TOOLS, forkFrom: null,
      appliesTo: ['must_fix'], failClosed: true, concurrency: 3,
    },
  },
  {
    type: 'gate', label: 'Gate', maxInputs: null, startsSession: false, needsSession: false,
    description: 'Fails when any input finding is at or above the chosen severity. On pre-commit and pre-push a failed gate blocks git.',
    defaultConfig: { blockOn: 'must_fix' },
  },
  {
    type: 'output', label: 'Output', maxInputs: null, startsSession: false, needsSession: false,
    description: "The run's final findings: everything connected here. Can send a desktop notification and post a PR comment.",
    defaultConfig: { notify: true, postPrComment: false },
  },
];

export const blockTypeInfo = (t: BlockType) => BLOCK_TYPES.find((b) => b.type === t)!;
