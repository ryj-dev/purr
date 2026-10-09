# purr daemon HTTP API

Base URL: `http://127.0.0.1:<settings.port>` (default 7878). JSON in and out. Types are in `src/shared/types.ts`.
Errors: non-2xx with `{ "error": "message" }`.

## State and settings
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/state` | | `AppState` |
| PUT | `/api/settings` | `Partial<Settings>` | `Settings` |
| GET | `/api/usage` | | `Usage` |
| GET | `/api/block-types` | | `BlockTypeInfo[]` (below) |

```ts
interface BlockTypeInfo {
  type: BlockType; label: string; description: string;
  defaultConfig: object;          // used when adding a block from the palette
  maxInputs: number | null;       // null = any
  startsSession: boolean;         // context
  needsSession: boolean;          // prompt, verify
  models?: string[];              // context only
  tools?: string[];               // context only: the built-in tool names
}
```

## Toolchain
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/tools` | `?fresh=1` skips the short status cache | `Toolchain` |
| POST | `/api/tools/:name/install` | | 202; progress shows in the tool's `job` |
| POST | `/api/tools/install-missing` | | 202 `{ installing: ToolName[] }`, installed one at a time |
| POST | `/api/tools/homebrew/install` | | opens Terminal on Homebrew's installer |
| POST | `/api/tools/:name/signin` | | `claude` or `gh`: opens Terminal on its login (for gh, also adds another account) |

`:name` is `gitleaks`, `zizmor`, `osv-scanner`, `claude` or `gh`. All of them install with Homebrew (`brew install`, claude as `--cask claude-code`). Each change to an install sends a `tools` event, and a finished or failed one also sends `state`.

```ts
interface Toolchain { homebrew: { installed: boolean; path: string | null }; tools: ToolStatus[] }
interface ToolStatus {
  name: ToolName; purpose: string; installed: boolean; path: string | null; version: string | null;
  source: 'homebrew' | 'claude-installer' | 'other' | null;   // from its path
  auth: { signedIn: boolean; accounts: string[]; detail?: string } | null;   // claude and gh only
  job: { state: 'running' | 'failed'; step: string; error?: string } | null;
}
```

## Flows
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/flows` | | `FlowMeta[]` |
| GET | `/api/flows/:id` | | `Flow` |
| POST | `/api/flows` | `{ name, description?, blocks?, edges? }` or `{ duplicateOf: id, name? }` | `Flow` (201) |
| PUT | `/api/flows/:id` | `{ name?, description?, blocks?, edges? }` | `Flow`; **403** for a default flow |
| PATCH | `/api/flows/:id/blocks/:blockId/options` | preference options only, e.g. `{ notify: false }` (see `PREFERENCE_OPTIONS`: output → `notify`, `postPrComment`) | `Flow`. **Allowed on default flows too**: kept as overrides that survive the defaults being rewritten. 400 for any other key |
| DELETE | `/api/flows/:id` | | 204; **403** for a default flow. Trigger assignments pointing at it fall back to the default for that trigger |
| POST | `/api/flows/validate` | `{ blocks, edges }` | `ValidationIssue[]` |
| GET | `/api/flows/:id/export` | | `FlowExport`: `{ text, json, bytes }`. `text` is `purr-flow:v1:` + base64url(deflate-raw(JSON)) |
| POST | `/api/flows/import/preview` | `{ text }` (share text or the JSON) | `ImportPreview`: the rebuilt blocks and edges, `risks` (shell commands, tool permissions, PR comments), `notes` (what was dropped or repaired) and `issues` (validation). Nothing is saved |
| POST | `/api/flows/import` | `{ text, name? }` | `Flow` (201): a new editable flow, not assigned to any trigger. A clashing name gets " (imported)" |

## Triggers
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/triggers` | | `TriggerAssignment[]` (global rows have `repoId: null`) |
| PUT | `/api/triggers` | `TriggerAssignment` (`flowId: null` = trigger disabled). For a repo row, send `{ trigger, repoId, flowId: "inherit" }` to delete the override | `TriggerAssignment[]` |

## Repos
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/repos` | | `Repo[]` |
| POST | `/api/repos` | `{ path }` | `Repo` (201) |
| DELETE | `/api/repos/:id` | | 204 (it's re-added on its next commit or push) |

## Runs
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/runs?limit=50&repoId=` | | `Run[]` newest first |
| GET | `/api/runs/:id` | | `RunDetail` |
| POST | `/api/runs` | `{ repoId, flowId?, base?, head? }` manual run (defaults: assigned manual flow, base = merge-base with the default branch, head = HEAD) | `Run` (201) |
| POST | `/api/runs/:id/cancel` | | `Run` |

## Findings ledger
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/ledger?repoId=&state=` | | `LedgerItem[]` |
| POST | `/api/ledger/:fingerprint` | `{ state: 'open' \| 'dismissed' \| 'tracked' }` | `LedgerItem` |

## Live events
`GET /api/events` is Server-Sent Events. Each `data:` line is a JSON `ServerEvent`.

## Hook endpoints (used by the CLI)
| Method | Path | Body |
|---|---|---|
| POST | `/api/hooks/notify` | `{ runId }`: a CLI-run hook flow finished; rebroadcast it |
| POST | `/api/hooks/push-intent` | `{ repoPath, branch, sha, remote }`: from pre-push; the daemon confirms the remote moved, debounces, and queues the post-push flow |
