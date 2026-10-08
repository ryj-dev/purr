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
