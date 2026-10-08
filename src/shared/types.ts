// Shared between the daemon (src/server) and the web UI (web/): types plus two small constants,
// safe to import from either side.

export type TriggerKind = 'pre-commit' | 'pre-push' | 'post-push' | 'manual';
export const TRIGGERS: TriggerKind[] = ['pre-commit', 'pre-push', 'post-push', 'manual'];

export type Severity = 'must_fix' | 'consider' | 'minor';

export type BlockType =
  | 'scanner'   // gitleaks / zizmor / osv on the lines this change adds
  | 'command'   // any shell command (type-check, lint...); its output is text for later blocks
  | 'context'   // starts a Claude session (the seed) that gathers shared context
  | 'branch'    // pure duplicate: 1 session in, one fork per outgoing edge
  | 'prompt'    // sends a prompt to a fork of an upstream session
  | 'merge'     // unions + dedupes findings from all inputs (no Claude)
  | 'verify'    // one skeptic fork per finding at the chosen severities; drops the refuted
  | 'gate'      // pass/fail on findings; a failed gate blocks the commit/push
  | 'output';   // notification, results, optional PR comment

export type ScannerName = 'gitleaks' | 'zizmor' | 'osv';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ScannerConfig { scanner: ScannerName }
export interface CommandConfig { command: string; timeoutSec: number; failOnNonZero: boolean }
export interface ContextConfig {
  model: string;              // claude --model alias: opus / sonnet / haiku / fable, or a full id
  effort: Effort | null;
  tools: string[];            // --tools: the tool set every fork inherits (part of the cached prefix)
  allowedTools: string[];     // --allowedTools for the seed itself (permission only)
  maxTurns: number;
  prompt: string;             // template, see TEMPLATE_VARS
  includeDiff: boolean;
  includeFiles: boolean;      // full post-change contents of changed files, within budgetChars
  budgetChars: number;
}
export interface BranchConfig { [k: string]: never }
export interface PromptConfig {
  prompt: string;             // template; {{findings}} = upstream findings as JSON
  maxTurns: number;
  allowedTools: string[];     // narrows permissions; never changes the inherited tool set
  output: 'findings' | 'text';
  forkFrom: string | null;    // block id of a context/prompt block to fork, or null = nearest upstream session
  category: string;           // default category for findings that don't set one
}
export interface MergeConfig { lineWindow: number }
export interface VerifyConfig {
  prompt: string;             // template; {{finding}} = the one finding as JSON
  maxTurns: number;
  allowedTools: string[];
  forkFrom: string | null;
  appliesTo: Severity[];
  failClosed: boolean;        // unparseable verdict => drop to 'consider' instead of keeping
  concurrency: number;
}
export interface GateConfig { blockOn: Severity }   // fail if any finding at this severity or worse
export interface OutputConfig { notify: boolean; postPrComment: boolean }

/**
 * Block options that are preferences rather than flow logic: editable on any flow, including the read-only defaults,
 * via PATCH /api/flows/:id/blocks/:blockId/options. On a default flow they're stored as overrides that survive the
 * defaults being rewritten from code.
 */
export const PREFERENCE_OPTIONS: Partial<Record<BlockType, string[]>> = {
  output: ['notify', 'postPrComment'],
};

export interface BlockConfigMap {
  scanner: ScannerConfig; command: CommandConfig; context: ContextConfig; branch: BranchConfig;
  prompt: PromptConfig; merge: MergeConfig; verify: VerifyConfig; gate: GateConfig; output: OutputConfig;
}

export interface Block<T extends BlockType = BlockType> {
  id: string;
  type: T;
  label: string;
  position: { x: number; y: number };
  config: BlockConfigMap[T];
}

export interface Edge { id: string; source: string; target: string }

export interface Flow {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;         // shipped flows: read-only, can't be deleted, can be duplicated
  blocks: Block[];
  edges: Edge[];
  createdAt: string;
  updatedAt: string;
}
export type FlowMeta = Omit<Flow, 'blocks' | 'edges'> & { blockCount: number };

export interface Finding {
  id: string;                 // unique within a run
  file: string;
  line: number | null;
  lines?: number[];           // scanner repeats of one rule in one file
  symbol?: string | null;
  category: string;
  severity: Severity;
  title: string;
  scenario: string;
  evidence?: string;
  fix?: string;
  confidence?: number | null;
  source: { blockId: string; kind: 'scanner' | 'model'; scanner?: ScannerName; rule?: string };
  alsoFoundBy?: string[];     // block ids of merged duplicates
  verified?: { real: boolean; note: string } | null;
  fingerprint?: string;
  ledger?: 'new' | 'open' | 'regression' | 'dismissed' | 'tracked';
}

export interface SessionUse {
  sessionId: string;
  forkedFrom: string | null;
  model: string;
  usage: { input: number; cacheWrite: number; cacheRead: number; output: number };
  durationMs: number;
  turns: number;
  error?: string;
}

export interface ScannerState { state: 'ran' | 'n/a' | 'not installed' | 'failed'; hits?: number; secs: number; error?: string }

export interface BlockOutput {
  findings?: Finding[];
  text?: string;
  sessionId?: string;         // the session downstream blocks fork from
  pass?: boolean;             // gate
  scanner?: ScannerState;
  sessions?: SessionUse[];
  log?: string[];
}

export type RunStatus = 'queued' | 'running' | 'passed' | 'blocked' | 'failed' | 'cancelled' | 'superseded';
export type BlockStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'cancelled';

export interface Run {
  id: string;
  flowId: string;
  flowName: string;
  flow: Flow;                 // snapshot at run time
  trigger: TriggerKind;
  repoId: string | null;
  repoPath: string;
  branch: string | null;
  baseSha: string | null;
  headSha: string | null;
  mode: 'staged' | 'range';
  workdir: string | null;     // checkout the Claude sessions ran in (cd here to `claude --resume` one)
  pr: { number: number; title: string; body: string; url: string } | null;
  status: RunStatus;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  counts: { must_fix: number; consider: number; minor: number };
  error: string | null;
}

export interface BlockRun {
  runId: string;
  blockId: string;
  status: BlockStatus;
  startedAt: string | null;
  finishedAt: string | null;
  output: BlockOutput | null;
  error: string | null;
}

export interface RunDetail { run: Run; blocks: BlockRun[]; findings: Finding[] }

export interface Repo {
  id: string;
  path: string;
  name: string;
  remoteUrl: string | null;
  addedAt: string;
}

export interface TriggerAssignment { trigger: TriggerKind; repoId: string | null; flowId: string | null }

export interface Settings {
  claudeBin: string;
  claudeExtraArgs: string[];
  maxConcurrentClaude: number;
  dailySessionCap: number;
  pollIntervalSec: number;
  debounceSec: number;
  notifications: boolean;
  reviewsPaused: boolean;     // post-push reviews don't start (hooks and manual runs still do)
  postPushPrsOnly: boolean;   // review a push only when its branch has an open PR (needs gh; without gh every push is reviewed)
  port: number;
}

export interface Usage {
  fiveHour: number | null;    // 0..1 utilisation reported by Claude Code's rate_limit_event
  sevenDay: number | null;
  fiveHourResetsAt: string | null;
  sevenDayResetsAt: string | null;
  pausedUntil: string | null; // set when a limit is hit; the queue waits
  sessionsToday: number;
  updatedAt: string | null;
}

export interface LedgerItem {
  fingerprint: string;
  repoId: string;
  branch: string | null;
  state: 'open' | 'fixed' | 'dismissed' | 'tracked';
  flowId: string | null;      // flow of the last run that raised it: only that flow can mark it fixed
  finding: Finding;
  firstRunId: string;
  lastRunId: string;
  updatedAt: string;
}

export interface AppState {
  settings: Settings;
  usage: Usage;
  repos: Repo[];
  flows: FlowMeta[];
  triggers: TriggerAssignment[];
  tools: { gh: boolean; ghAuthed: boolean; gitleaks: boolean; zizmor: boolean; osv: boolean; claude: boolean };
  version: string;
  /** git's global core.hooksPath points at purr's hooks: commit/push checks cover every repo while purr runs */
  /** ownHooks: repo id -> the core.hooksPath that repo sets for itself, where PuRR's commit and push checks can't run */
  globalHooks: { active: boolean; hooksPath: string | null; ownHooks: Record<string, string> };
}

export interface ValidationIssue { blockId: string | null; level: 'error' | 'warning'; message: string }

/** Something an imported flow is allowed to do that the importer should read before trusting it. */
export interface ShareRisk { blockId: string; label: string; level: 'danger' | 'warn' | 'info'; message: string; detail?: string }

/** A shared flow, checked but not saved: what the Import dialog shows before you confirm. */
export interface ImportPreview {
  name: string;
  description: string;
  blocks: Block[];
  edges: Edge[];
  risks: ShareRisk[];
  notes: string[];             // what was dropped or repaired while reading it
  issues: ValidationIssue[];   // the usual flow validation
}

export interface FlowExport { text: string; json: string; bytes: number }

// Template variables available in context/prompt/verify prompts (documented in the UI).
export const TEMPLATE_VARS: Record<string, string> = {
  pr_title: 'PR title (empty without a PR)',
  pr_body: 'PR description, marked as untrusted',
  branch: 'Branch name',
  base: 'Base commit SHA',
  head: 'Head commit SHA',
  changed_files: 'List of changed files with +/- counts',
  diff: 'Unified diff of the change (context block: only if "include diff")',
  files: 'Full post-change contents of changed files within the budget',
  claude_md: "Repo's CLAUDE.md at head, framed as hints",
  scanner_findings: 'Findings from upstream scanner blocks, as JSON',
  command_outputs: 'Output of upstream command blocks',
  findings: 'Findings from upstream blocks, as JSON (prompt blocks)',
  finding: 'The single finding being verified, as JSON (verify blocks)',
  finding_schema: 'The JSON schema findings must follow',
};

export type ServerEvent =
  | { type: 'run'; run: Run }
  | { type: 'block'; runId: string; block: BlockRun }
  | { type: 'usage'; usage: Usage }
  | { type: 'state' }
  | { type: 'notify'; title: string; body: string; runId: string };   // shown natively by PuRR.app
