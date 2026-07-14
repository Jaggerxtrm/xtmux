# JSON command API contract

This document freezes the additive JSON boundary for `xtmux-d0a`. Runtime behavior is unchanged by this contract task. Human output remains the default; selected commands gain `--json`. `XTMUX_OBS_V2=0` remains the V1 escape hatch.

## Conventions

- **Shape:** stdout is exactly one JSON object or array followed by `\n`. No universal `{ok,data}` envelope and no NDJSON in JSON mode.
- **Names:** public fields are camelCase. Existing names from `message-list --json`, `message-status`, `unread-count`, `health`, and `obligations list` remain unchanged.
- **Nullability:** stable result keys are present. Unknown or unavailable identity and timestamps are `null`, never `""`, `"-"`, or an inferred bystander value.
- **Time:** absolute times are integer Unix milliseconds named `*AtMs`; durations are integer milliseconds named `*Ms`. Human age labels never appear in JSON.
- **Identity:** authoritative tmux identities are `sessionId` (`$N`) and `paneId` (`%N`). `sessionName` is display metadata. With no valid `$TMUX` context, current identity is `null`; mutations require an explicit target. `TMUX_PANE` alone is not authority.
- **Ordering:** message arrays are newest-first by `createdAtMs`, then `messageKey`; event arrays are oldest-first by `createdAtMs`, then event key; monitors are `startedAtMs`, then `monitorId`; collisions are by `path`; audit findings are severity, kind, session name, then pane ID. Dashboard/session ordering preserves its documented attention ranking and uses IDs as final tie-breakers.
- **Bounds:** list commands honor `--limit` and retain their documented default. Raw arrays are intentionally not wrapped solely to advertise truncation. A shortened string carries an adjacent `*Truncated: true` field; payloads are never silently cut.
- **Errors:** JSON-mode failures leave stdout empty and write one `{ "code": string, "message": string, "detail": object }` object plus `\n` to stderr. `detail` is bounded and excludes message bodies, secrets, tokens, credentials, and raw command output.
- **Exit status:** preserve the command's exact semantic status: `0` success; `1` missing/external failure where already defined; `2` usage or invalid input; `3` structured storage/schema failure; `4` authority/conflict rejection; `5` not found; `75` working-target refusal; `124` timeout. JSON changes the representation, never the control signal.
- **Mutations:** validation completes before state changes. Cancellation or failed confirmation leaves state unchanged. Results identify the affected resource and outcome; they do not echo sensitive input.

Types belong beside the owning implementation in `.2`–`.4`; adding an unused universal type module here would freeze speculation rather than a consumed contract.

## Stable result fields

These are domain result models, not a common envelope.

`xtmux help` documents the same field names per command, because agents read the CLI and
not this file — that is how `id`/`text` came to be guessed for messages instead of
`messageKey`/`summary`. The two are kept honest by `test/contract.sh`, which checks the
help text against **live** `--json` output and against the Message row below. Change a
field name here or there and the contract test fails.

| Result | Stable fields |
|---|---|
| Message | `messageKey`, `senderId`, `senderPaneId`, `senderKind`, `recipientId`, `targetPaneId`, `recipientKind`, `beadId`, `summary`, `createdAtMs`, `expectsReply`, `acked`, `ackedAtMs`, `ackedBy` |
| Message mutation | send: `messageKey`, `senderId`, `senderKind`, `recipientId`, `recipientKind`, `targetPaneId`, `beadId`, `expectsReply`, `createdAtMs`; ack: `messageKey`, `acked`, `ackedAtMs`, `ackedBy`, `status` |
| Monitor | `monitorId`, `target`, `sessionId`, `paneId`, `state`, `startedAtMs`, `updatedAtMs`, `timeoutMs`, `intervalMs`, `terminalStatus`, `terminalAtMs`, `terminalDetail` |
| Monitor mutation | arm: `monitorId`, `target`, `sessionId`, `paneId`, `state`, `startedAtMs`; kill: `monitorId`, `status` |
| Session inventory | `{ "mode", "sessions", "panes" }`; rows retain dashboard concepts as camelCase: IDs/names, state, bead/task, repo/branch, dirty/shared-worktree flags, idle age in milliseconds, and path |
| Topology snapshot | `schema_version`, `generated_at_ms`, `host`, `sessions[]` → `windows[]` → `panes[]`; snake_case is intentional cross-repository contract `xtrm.xtmux.topology.v1`, with stable `$N`/`@N`/`%N` IDs and optional `agent` metadata |
| Pane capture | `schema_version`, `pane_id`, `captured_at_ms`, `requested_lines`, `returned_lines`, `max_lines`, `truncated`, `content`; snake_case cross-repository contract `xtrm.xtmux.pane-capture.v1`. `truncated` means only "there is more above what you were given" — a request clamped to `max_lines` against a shorter buffer still returns everything and is not truncated |
| Audit finding | `severity`, `kind`, `sessionId`, `sessionName`, `paneId`, `paneIndex`, `path`, `repo`, `detail` |
| Worktree collision | `path`, `sessionCount`, `paneCount`, `sessionNames` |
| Event | existing journal keys normalized to `createdAtMs`, `type`, `sessionId`, `paneId`, `beadId`, `correlationId`, and bounded `detail` |
| Handoff | `target`, `paneId`, `beadId`, `promptFile`, `sent`, `createdAtMs` |
| Wait | `target`, `sessionId`, `paneId`, `state`, `status`, `startedAtMs`, `completedAtMs`, `timeoutMs`, `intervalMs` |

Domain-specific existing objects remain authoritative for `HealthReport`, `MessageStatus`, `UnreadStats`, migration reports, retention reports, shadow summaries, and obligation rows.

## Picker dispatcher matrix

Categories are closed: **agent-json** gains/retains structured output for agents; **interactive-only** stays human/fzf plumbing; **guarded-admin** is internal, destructive, installation, or arbitrary-command behavior and is not a normal LLM tool. The owner is the implementation bead; `.5` adds picker-wide forwarding after domain outputs exist.

| Command | Category | Current format / decision | Owner |
|---|---|---|---|
| `picker:list` | interactive-only | fzf row wire format; use dashboard for agents | — |
| `picker:list-active` | interactive-only | fzf reload using persisted filter | — |
| `picker:mode-toggle` | interactive-only | persisted UI state, no useful result | — |
| `picker:wait-agent` | agent-json | text completion → `Wait` object | .2 |
| `picker:monitor-agent` | agent-json | text/monitor registration → monitor mutation object | .2 |
| `picker:monitor-run` | guarded-admin | background poller implementation detail | — |
| `picker:monitor-list` | agent-json | 10-column TSV → monitor array | .2 |
| `picker:monitor-kill` | guarded-admin | destructive; explicit monitor ID and confirmation in native tools | .2 |
| `picker:safe-send-pointer` | guarded-admin | pane injection; retain dry-run and confirmation guards | .2 |
| `picker:worktree-collisions` | agent-json | TSV → collision array | .3 |
| `picker:dashboard` | agent-json | TSV header/rows → session inventory object | .3 |
| `picker:topology` | agent-json | one bounded `tmux list-panes -a -F` pass → versioned nested topology snapshot; no pane content | j46.3 |
| `picker:audit` | agent-json | TSV findings → audit finding array | .3 |
| `picker:context` | agent-json | `context --current --json` → `xtrm.runtime-origin.v1` for the invoking pane; read-only; exempt from the V2-mode gate (reads tmux + host-id file, not the store) | j46.2 |
| `picker:pane` | agent-json | `pane capture --pane %N [--lines N] --json` → `xtrm.xtmux.pane-capture.v1`; read-only; exempt from the V2-mode gate (reads live tmux, not the store) | j46.4 |
| `picker:handoff` | guarded-admin | creates prompt file and may inject pointer; explicit confirmation | .2 |
| `picker:mux-help` | interactive-only | human cheatsheet | — |
| `picker:help` | interactive-only | grouped command reference incl. `--json` output field names; text by design — a `--json` help would just be a second surface to keep in sync | .15 |
| `picker:--help` | interactive-only | alias of `help` | .15 |
| `picker:-h` | interactive-only | alias of `help` | .15 |
| `picker:log` | agent-json | split below; tail/query become arrays, emit stays guarded | .4 |
| `picker:log emit` | guarded-admin | internal event write; later typed events own normal writes | .4 |
| `picker:log tail` | agent-json | NDJSON → event array | .4 |
| `picker:log query` | agent-json | NDJSON → filtered event array | .4 |
| `picker:message-send` | agent-json | TSV mutation result → message mutation object | .2 |
| `picker:message-list` | agent-json | existing `--json` array retained and completed additively | .2 |
| `picker:message-status` | agent-json | existing `MessageStatus` object retained | .2 |
| `picker:unread-count` | agent-json | existing `UnreadStats` object retained | .2 |
| `picker:message-ack` | agent-json | TSV mutation result → ack object; wrong-recipient remains no-op | .2 |
| `picker:telemetry` | guarded-admin | byte-transparent arbitrary-command proxy; explicit exception with no JSON mode | — |
| `picker:border-label` | interactive-only | fzf label text | — |
| `picker:preview` | interactive-only | human preview | — |
| `picker:popup` | interactive-only | tmux client UI | — |
| `picker:jump` | interactive-only | tmux client navigation | — |
| `picker:kill` | guarded-admin | destructive pane/session action | — |
| `picker:act` | guarded-admin | approve/interrupt/message injection | — |
| `picker:attn-jump` | interactive-only | navigation | — |
| `picker:jump-back` | interactive-only | navigation | — |
| `picker:kill-confirm` | guarded-admin | internal confirmation continuation | — |
| `picker:bulk-kill` | guarded-admin | destructive multi-target action | — |
| `picker:bulk-kill-confirm` | guarded-admin | internal confirmation continuation | — |
| `picker:rename` | guarded-admin | mutates tmux names through prompt | — |
| `picker:rename-apply` | guarded-admin | internal rename continuation | — |
| `picker:clear-cache` | guarded-admin | maintenance mutation | — |
| `picker:filter-menu` | interactive-only | fzf/prompt UI | — |
| `picker:filter-clear` | interactive-only | persisted UI filter | — |
| `picker:prompt-label` | interactive-only | fzf prompt text | — |
| `picker:install-hooks` | guarded-admin | tmux installation mutation | — |

## Compiled CLI matrix

Compiled plumbing remains documented even when it is not exposed as a picker or native Pi tool.

| Command | Category | Current format / decision | Owner |
|---|---|---|---|
| `obs:health` | agent-json | existing `HealthReport` object | .4 |
| `obs:migrate` | guarded-admin | schema mutation; existing migration object | .4 |
| `obs:version` | agent-json | scalar text → `{ "schemaVersion" }` in JSON mode | .4 |
| `obs:obligations` | agent-json | dispatcher for list | .4 |
| `obs:obligations:list` | agent-json | no-flag behavior retained; additive `--json` requires explicit pane and returns an obligation array, otherwise JSON error/rc 2 with empty stdout | .4 |
| `obs:obs-migrate` | guarded-admin | legacy import/status; explicit mode | .4 |
| `obs:shadow-summary` | agent-json | existing summary array | .4 |
| `obs:retention` | guarded-admin | destructive maintenance; existing report object | .4 |
| `obs:shadow-record` | guarded-admin | picker-internal best-effort write | .4 |
| `obs:message-send` | agent-json | mutation object in JSON mode | .2 |
| `obs:message-list` | agent-json | existing JSON array retained | .2 |
| `obs:message-ack` | agent-json | ack object in JSON mode | .2 |
| `obs:message-status` | agent-json | existing object retained | .2 |
| `obs:unread-count` | agent-json | existing object retained | .2 |
| `obs:log-emit` | guarded-admin | internal event write | .4 |
| `obs:log-tail` | agent-json | NDJSON → array in JSON mode | .4 |
| `obs:log-query` | agent-json | NDJSON → array in JSON mode | .4 |
| `obs:delivery-record` | guarded-admin | picker-internal delivery evidence | .4 |
| `obs:context` | agent-json | resolves the invoking pane → `xtrm.runtime-origin.v1`; cross-repo contract consumed by xtrm-dev/specialists; opens no DB | j46.2 |
| `obs:pane` | agent-json | `pane capture` → `xtrm.xtmux.pane-capture.v1`; bounded at `max_lines`, over-large requests clamped not rejected; opens no DB; content never journalled | j46.4 |
| `obs:monitor` | agent-json | mixed dispatcher; only list is a normal query | .2 |
| `obs:monitor:register` | guarded-admin | poller-internal mutation | .2 |
| `obs:monitor:adopt` | guarded-admin | poller-internal mutation | .2 |
| `obs:monitor:heartbeat` | guarded-admin | poller-internal mutation | .2 |
| `obs:monitor:terminate` | guarded-admin | poller-internal mutation | .2 |
| `obs:monitor:list` | agent-json | TSV → monitor array in JSON mode | .2 |
| `obs:monitor:kill` | guarded-admin | destructive mutation | .2 |
| `obs:telemetry` | guarded-admin | internal correlated-run dispatcher | .4 |
| `obs:telemetry:start` | guarded-admin | wrapper-internal write | .4 |
| `obs:telemetry:finish` | guarded-admin | wrapper-internal write | .4 |
| `obs:audit` | guarded-admin | persistence dispatcher, not the read-only picker audit | .3 |
| `obs:audit:ingest` | guarded-admin | stdin persistence path | .3 |
| `obs:help` | interactive-only | human usage | — |
| `obs:--help` | interactive-only | human usage | — |

## Accepted decisions

1. Agent-facing fields are camelCase and compact single-line JSON. Existing snake_case/pretty admin reports are grandfathered and remain non-tool surfaces.
2. Failures are one JSON object on stderr with empty stdout; exact semantic exit codes, including `75` and `124`, are preserved.
3. `telemetry <git|bd|gh> -- …` remains a byte-transparent passthrough with no JSON mode.
4. `obligations list` keeps no-flag compatibility; additive `--json` requires a pane and otherwise returns a JSON error with rc 2 and no stdout.
5. Bash-owned dashboard/audit/collision walks serialize their pre-color rows in bash; they are not ported to TypeScript.
6. Dependency order is `.1 → .5 → {.2,.3,.4} → .6` so domains share forwarding instead of hand-rolling it.
7. Gate `.6` rebuilds `bin/xtmux-obs` before any picker/compiled equivalence smoke.

## Migration and compatibility gates

| Owner | Runtime scope | Required evidence before close |
|---|---|---|
| .5 | picker capability/forwarding scaffold | lands first; classified commands opt into one quoted-argv path, unsupported/V1 combinations fail instead of returning text |
| .2 | messages, waits, monitors, handoffs | uses .5 scaffold; success/error JSON, identity-null cases, mutation no-op failures, unchanged V1 fixtures |
| .3 | bash-owned dashboard, audit, worktree collisions | uses .5 scaffold; serialize pre-color rows in bash, deterministic arrays, hostile tmux data, unchanged fzf/list and V1 output |
| .4 | logs, version, obligations and selected operational queries | uses .5 scaffold; valid single-document JSON, bounded errors, no payload leakage; telemetry passthrough and admin writers remain explicit exceptions |
| .6 | first completion gate | rebuild first, then matrix coverage, JSON parse/schema assertions, V1 byte differential, hostile environment, live tmux smoke, typecheck |

### Gate critical paths

| Boundary | Automated evidence |
|---|---|
| picker → compiled serializer | `json-forwarding.test.ts`, `json-coordination.test.ts`, `json-operations.test.ts` |
| mutation → durable ID/event/redaction | `json-coordination.test.ts`, live message send→status→ack smoke |
| tmux identity → session/pane JSON | `json-session-queries.test.ts`, `hostile-env.test.ts`, isolated live tmux smoke |
| explicit V1 escape/no-flag compatibility | `differential-v1-v2.test.ts`, `capture-v1-fixtures.sh --check`, shell contracts |
| error schema and exact exits | coordination/operations negative cases, including `4`, `5`, `75`, and `124` |
| compiled freshness | `verify-json-api.sh` rebuilds first and rejects newer `src/**/*.ts` inputs |
| schema/storage failures | integration schema/concurrency tests included by `bun test`; full logs retained in the gate artifact directory |

Executable baseline and gate commands:

```bash
scripts/verify-json-api.sh  # canonical .6 gate; retains per-command logs + results.tsv

# Individual checks:
bun run build
# Gate zero: bin/xtmux-obs must be newer than every src/ input before picker smoke.
bun test tests/contracts/json-command-matrix.test.ts
bash scripts/capture-v1-fixtures.sh --check
bun test tests/contracts/differential-v1-v2.test.ts tests/contracts/hostile-env.test.ts
bash test/contract.sh
bun run typecheck
```

V1 fixtures live under `tests/fixtures/golden/v1/`; `scripts/capture-v1-fixtures.sh --check` is the byte-identity oracle. JSON fixtures added by `.2`–`.4` belong under `tests/fixtures/json/` and are exercised together by `.6`. No implementation may begin by changing a V1 golden.
