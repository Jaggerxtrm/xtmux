# JSON command API contract

This document defines the shipped machine boundary. Human output remains the default; selected commands accept `--json`. SQLite is authoritative in normal operation. `XTMUX_OBS_V2=0` is a temporary legacy escape hatch, not an alternate source for reply obligations or wakes.

## Conventions

- **Shape:** stdout is exactly one JSON object or array followed by `\n`. No universal `{ok,data}` envelope and no NDJSON in JSON mode.
- **Names:** public fields are camelCase. Existing names from `message-list --json`, `message-status`, `unread-count`, `health`, and `obligations list` remain unchanged.
- **Nullability:** stable result keys are present. Unknown or unavailable identity and timestamps are `null`, never `""`, `"-"`, or an inferred bystander value.
- **Time:** absolute times are integer Unix milliseconds named `*AtMs`; durations are integer milliseconds named `*Ms`. Human age labels never appear in JSON.
- **Identity:** authoritative tmux identities are `sessionId` (`$N`) and `paneId` (`%N`). `sessionName` is display metadata. With no valid `$TMUX` context, current identity is `null`; mutations require an explicit target. `TMUX_PANE` alone is not authority.
- **Ordering:** message arrays are newest-first by `createdAtMs`, then `messageKey`; event arrays are oldest-first by `createdAtMs`, then event key; monitors are `startedAtMs`, then `monitorId`; collisions are by `path`; audit findings are severity, kind, session name, then pane ID. Dashboard/session ordering preserves its documented attention ranking and uses IDs as final tie-breakers.
- **Bounds:** commands that expose `--limit` honor it and retain their documented default. Raw arrays are intentionally not wrapped solely to advertise truncation. `monitor-list --json` exposes no limit and currently returns full monitor history. A shortened string carries an adjacent `*Truncated: true` field; payloads are never silently cut.
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
| Message mutation | send: `messageKey`, `messageId`, `duplicate`, `senderId`, `senderPaneId`, `senderKind`, `recipientId`, `recipientKind`, `targetPaneId`, `beadId`, `expectsReply`, `createdAtMs`; ack: `messageKey`, `acked`, `ackedAtMs`, `ackedBy`, `status`; reply: `messageKey`, `messageId`, `duplicate`, `replyToMessageKey`, `fulfilledMessageKey`, `fulfilled`, `senderId`, `senderPaneId`, `recipientId`, `targetPaneId`, `createdAtMs`; cancel: `messageKey`, `cancelled`, `cancelledAtMs` |
| Message reply projection | `replyStatus`, `fulfilledAtMs`, `fulfilledByMessageKey`, `correlatedReply`; `correlatedReply` contains `messageKey`, `senderId`, `senderPaneId`, `recipientId`, `targetPaneId`, `summary`, `createdAtMs` |
| Monitor | `monitorId`, `waitId` when linked, `target`, `requesterSessionId`, `requesterPaneId`, `sessionId`, `paneId`, `state`, `startedAtMs`, `updatedAtMs`, `timeoutMs`, `intervalMs`, `terminalStatus`, `terminalAtMs`, `wakeDelivered`, `wakeConsumed`, `orphan` |
| Monitor mutation | arm: `monitorId`, `waitId`, `target`, `requesterSessionId`, `requesterPaneId`, `sessionId`, `paneId`, `state`, `startedAtMs`, `timeoutMs`, `intervalMs`, `terminalStatus`, `wakeDelivered`; kill: `monitorId`, `status` |
| Session inventory | `{ "mode", "sessions", "panes" }`; rows retain dashboard concepts as camelCase: IDs/names, state, bead/task, repo/branch, dirty/shared-worktree flags, idle age in milliseconds, and path |
| Topology snapshot | `schema_version`, `generated_at_ms`, `host`, `sessions[]` → `windows[]` → `panes[]`; snake_case is intentional cross-repository contract `xtrm.xtmux.topology.v1`, with stable `$N`/`@N`/`%N` IDs and optional `agent` metadata |
| Journal page | `schema_version`, `items[]`, `next_after_id`, `oldest_available_id`, `latest_available_id`, `has_more`; snake_case cross-repository contract `xtrm.xtmux.journal-page.v1`. Each item carries `journal_id` (the committed SQLite rowid — the only monotonic cursor; never page by timestamp or `event_key`), `event_type`, `occurred_at_ms`, `recorded_at_ms`, `host_id`, optional `session_id`/`pane_id`/`agent_instance_id`/`bead_id`/`correlation_id`, and `payload`. `--after-id` is **exclusive**; ordering is strictly `journal_id` ASC; an empty page echoes the requested cursor rather than rewinding to 0. A cursor predating retained history returns `XTMUX_CURSOR_EXPIRED` with `oldest_available_id` to re-anchor on — never a silent jump to the next surviving page |
| Pane capture | `schema_version`, `pane_id`, `captured_at_ms`, `requested_lines`, `returned_lines`, `max_lines`, `truncated`, `content`; snake_case cross-repository contract `xtrm.xtmux.pane-capture.v1`. `truncated` means only "there is more above what you were given" — a request clamped to `max_lines` against a shorter buffer still returns everything and is not truncated |
| Audit finding | `severity`, `kind`, `sessionId`, `sessionName`, `paneId`, `paneIndex`, `path`, `repo`, `detail` |
| Worktree collision | `path`, `sessionCount`, `paneCount`, `sessionNames` |
| Event | existing journal keys normalized to `createdAtMs`, `type`, `sessionId`, `paneId`, `beadId`, `correlationId`, and bounded `detail` |
| Handoff | `target`, `paneId`, `beadId`, `promptFile`, `sent`, `createdAtMs` |
| Wait | `waitId`, `target`, `requesterSessionId`, `requesterPaneId`, `targetSessionId`, `targetPaneId`, `state`, `monitorId`, `terminalStatus`, `wakeDelivered`, `wakeConsumed`, `replayed`, `startedAtMs`, `completedAtMs`, `timeoutMs`, `intervalMs` |

Domain-specific existing objects remain authoritative for `HealthReport`, `MessageStatus`, `UnreadStats`, migration reports, retention reports, shadow summaries, and obligation rows.

## Correlated coordination lifecycle

A send with `--bead` defaults to `expectsReply:true`; an FYI send opts out with
`--expects-reply=false`. The returned `messageKey` is the correlation handle:

```sh
xtmux message-send --to '$20' --to-pane '%8' --bead work-7 \
  --text 'status requested' --json
```

```json
{"messageKey":"msg-100","messageId":100,"duplicate":false,"senderId":"$10","senderPaneId":"%4","senderKind":"pane","recipientId":"$20","targetPaneId":"%8","recipientKind":"pane","beadId":"work-7","expectsReply":true,"createdAtMs":1784070000000}
```

Receipt and fulfilment are independent. Acking never changes `replyStatus`:

```sh
xtmux message-ack msg-100 --by '$20' --json
xtmux message-reply --in-reply-to msg-100 --text 'completed' --json
```

```json
{"messageKey":"msg-100","status":"acked","acked":true,"ackedAtMs":1784070000100,"ackedBy":"$20"}
```

```json
{"messageKey":"reply-msg-100","messageId":101,"duplicate":false,"replyToMessageKey":"msg-100","fulfilledMessageKey":"msg-100","fulfilled":true,"senderId":"$20","senderPaneId":"%8","recipientId":"$10","targetPaneId":"%4","createdAtMs":1784070000200}
```

`message-reply` derives reversed endpoints from the original row and requires the
live original recipient pane. `message-send --reply-to msg-100` exposes the same
correlation through the generic sender. The original owner may instead run
`message-cancel --message-key msg-100 --json`; cancellation and fulfilment are
terminal and race atomically.

`safe-send-pointer --reply-to msg-100 ... --json` returns a successful injection
plus fulfilment. Injection failure leaves the obligation pending:

```json
{"injection":{"target":"%4","paneId":"%4","state":"done","doubleEnter":false,"sent":true},"fulfilment":{"messageKey":"reply-msg-100","messageId":101,"duplicate":false,"replyToMessageKey":"msg-100","fulfilledMessageKey":"msg-100","fulfilled":true,"senderId":"$20","senderPaneId":"%8","recipientId":"$10","targetPaneId":"%4","createdAtMs":1784070000200}}
```

`message-list --expects-reply --json` and `message-status <messageKey> --json`
project `replyStatus` (`pending`, `fulfilled`, `cancelled`, or `null`) and the
linked reply. `--unacked` filters receipt state only. `obligations list --json`
is owned by the live sender session and pane and returns pending outgoing reply
expectations; it is not a recipient inbox alias.

## Durable waits and wakes

`wait-agent` and `monitor-agent` persist requester and target session/pane IDs in
`outbound_waits`. A wake can be delivered and consumed only by its requester.
`--wait-for-transition` requires a fresh working cycle; Claude's Stop gate also
requires the covering monitor to have started no earlier than the obligation.

```sh
xtmux wait-agent '%8' --wait-for-transition --consume \
  --timeout 30m --interval 30s --json
```

```json
{"waitId":"wait-100","target":"%8","requesterSessionId":"$10","requesterPaneId":"%4","targetSessionId":"$20","targetPaneId":"%8","state":"terminal","monitorId":"monitor-100","terminalStatus":"done","wakeDelivered":true,"wakeConsumed":true,"replayed":false,"startedAtMs":1784070000000,"completedAtMs":1784070002000,"timeoutMs":1800000,"intervalMs":30000}
```

Terminal unconsumed wakes survive process restart. `monitor-list --json`
reconciles terminal rows; `wait-agent <target> --consume --timeout 0 --interval 0
--json` claims the wake once. A direct monitor without a linked wait is legal for
compatibility but is `orphan:true` and cannot wake a requester.

## Coordination errors and failure behavior

All coordination errors follow the stderr object convention and leave partial
message/wait mutations rolled back. Public codes include:

- validation/identity: `XTMUX_INVALID_ARGUMENT`, `XTMUX_NOT_IN_TMUX`,
  `XTMUX_PANE_UNRESOLVED`, `XTMUX_WRONG_RECIPIENT`, `XTMUX_WRONG_PANE`,
  `XTMUX_ENDPOINT_OVERRIDE`, `XTMUX_ACK_WRONG_RECIPIENT`,
  `XTMUX_WAIT_NOT_OWNER`, `XTMUX_WAIT_TARGET_MISMATCH`;
- correlation/conflict: `XTMUX_INVALID_CORRELATION`,
  `XTMUX_ALREADY_FULFILLED`, `XTMUX_REPLY_TERMINAL`,
  `XTMUX_MESSAGE_KEY_CONFLICT`, `XTMUX_DB_BUSY`;
- absence/timing/mode: `XTMUX_MESSAGE_NOT_FOUND`, `XTMUX_WAIT_NOT_FOUND`,
  `XTMUX_TARGET_NOT_FOUND`, `XTMUX_WAIT_TIMEOUT`,
  `XTMUX_JSON_REQUIRES_V2`, `XTMUX_TARGET_WORKING`,
  `XTMUX_POINTER_REJECTED`, `XTMUX_DELIVERY_FAILED`.

Pi accepts only complete single coordination JSON envelopes. Incompatible or
malformed xtmux-shaped output degrades visibly instead of being treated as a
send/reply. The outgoing-obligation query is SQL-limited to 200 rows by default,
and the inbox passes `--limit 500`. `monitor-list --json` has no CLI limit: it
reads full monitor history, after which Pi fails closed if the parsed array
exceeds 500 rows. A successful cycle performs at most 20 SQLite mutations,
displays at most 20 reply keys and 22 widget rows, and bounds prompt/widget text.
Unsafe message keys, counterpart IDs, or bead IDs are hidden and require manual
inbox inspection; inbound summaries are never promoted to instructions.

## Upgrade boundary

Steady-state Claude and Pi coordination reads only SQLite. Legacy
`xtmux-reply-obligations`, `xtmux-outbound-expectations`, and
`xtmux-auto-monitor` runtime directories are not consulted and have no TTL or
operator-cleanup role. Upgrade the package, reload Pi, and start fresh Claude
sessions so the new hooks/extensions are loaded. Existing durable message and
wait rows remain queryable; inspect them with `obligations list`, `message-list
--expects-reply`, and `monitor-list`. Every install/update invokes `obs-migrate`
to import legacy JSONL/monitor-TSV data and run bounded, idempotent reconciliation
of former runtime markers against existing SQLite rows. Each accepted marker is
processed once; this cleanup does not make marker files operational state again.

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
| `picker:monitors` | agent-json | pretty-print of `monitor-list` for humans; `--json` passes the array through unchanged | .2 |
| `picker:safe-send-pointer` | guarded-admin | pane injection; retain dry-run and confirmation guards | .2 |
| `picker:worktree-collisions` | agent-json | TSV → collision array | .3 |
| `picker:dashboard` | agent-json | TSV header/rows → session inventory object | .3 |
| `picker:topology` | agent-json | one bounded `tmux list-panes -a -F` pass → versioned nested topology snapshot; no pane content | j46.3 |
| `picker:audit` | agent-json | TSV findings → audit finding array | .3 |
| `picker:context` | agent-json | `context --current --json` → `xtrm.runtime-origin.v1` for the invoking pane; read-only; exempt from the V2-mode gate (reads tmux + host-id file, not the store) | j46.2 |
| `picker:pane` | agent-json | `pane capture --pane %N [--lines N] --json` → `xtrm.xtmux.pane-capture.v1`; read-only; exempt from the V2-mode gate (reads live tmux, not the store) | j46.4 |
| `picker:bridge` | agent-json | `bridge --stdio` → execs the runtime's NDJSON bridge and hands it the pipe. Never captured: the stream is unbounded and a command substitution would swallow the signals meant to end it. Passes `XTMUX_PICKER` so the runtime can call back for `topology.snapshot` | j46.9 |
| `picker:handoff` | guarded-admin | creates prompt file and may inject pointer; explicit confirmation | .2 |
| `picker:mux-help` | interactive-only | human cheatsheet | — |
| `picker:help` | interactive-only | grouped command reference incl. `--json` output field names; text by design — a `--json` help would just be a second surface to keep in sync | .15 |
| `picker:--help` | interactive-only | alias of `help` | .15 |
| `picker:-h` | interactive-only | alias of `help` | .15 |
| `picker:log` | agent-json | split below; tail/query become arrays, emit stays guarded | .4 |
| `picker:log emit` | guarded-admin | internal event write; later typed events own normal writes | .4 |
| `picker:log tail` | agent-json | NDJSON → event array | .4 |
| `picker:log follow` | agent-json | NDJSON stream of committed journal items, each identical to a `log query` page item — deliberately NOT a second event schema. V2-only (the cursor is the committed SQLite rowid). Requires `--after-id`: a stream with no cursor cannot resume and would dump unbounded history. SIGINT/SIGTERM exit 0 | j46.6 |
| `picker:log query` | agent-json | NDJSON → filtered event array; `--after-id <n>` switches to the cursor-paged `xtrm.xtmux.journal-page.v1` envelope (V2-only — the cursor IS the committed SQLite rowid, which the legacy JSONL store does not have). Without `--after-id` the legacy array shape is unchanged | .4 / j46.5 |
| `picker:message-send` | agent-json | TSV mutation result → message mutation object | .2 |
| `picker:message-reply` | agent-json | correlated reply mutation object; fulfils only the named message | 3ua.4 |
| `picker:message-cancel` | agent-json | sender-owned obligation cancellation object | 3ua.4 |
| `picker:message-list` | agent-json | existing `--json` array retained and completed additively | .2 |
| `picker:message-status` | agent-json | existing `MessageStatus` object retained | .2 |
| `picker:unread-count` | agent-json | existing `UnreadStats` object retained | .2 |
| `picker:obligations` | agent-json | forwards `list` to the SQLite backend; live requester ownership remains mandatory | 3ua.5.1 |
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
| `obs:message-reply` | agent-json | correlated reply mutation object | 3ua.4 |
| `obs:message-cancel` | agent-json | sender-owned obligation cancellation object | 3ua.4 |
| `obs:message-list` | agent-json | existing JSON array retained | .2 |
| `obs:message-ack` | agent-json | ack object in JSON mode | .2 |
| `obs:message-status` | agent-json | existing object retained | .2 |
| `obs:unread-count` | agent-json | existing object retained | .2 |
| `obs:wait-agent` | agent-json | requester-owned durable wait and wake object; timeout remains rc 124 | 3ua.4 |
| `obs:monitor-agent` | agent-json | monitor plus requester-owned wait registration object | 3ua.4 |
| `obs:monitor-list` | agent-json | durable monitor and wake state array | 3ua.4 |
| `obs:log-emit` | guarded-admin | internal event write | .4 |
| `obs:log-tail` | agent-json | NDJSON → array in JSON mode | .4 |
| `obs:log-query` | agent-json | NDJSON → array in JSON mode | .4 |
| `obs:delivery-record` | guarded-admin | picker-internal delivery evidence | .4 |
| `obs:context` | agent-json | resolves the invoking pane → `xtrm.runtime-origin.v1`; cross-repo contract consumed by xtrm-dev/specialists; opens no DB | j46.2 |
| `obs:handoff` | agent-json | `handoff create` writes the durable handoff record and (optionally) registers its monitor in ONE SQLite transaction — a failed insert leaves neither, which two separate picker→runtime invocations could never guarantee. `handoff attempt` appends one delivery_attempts row per pointer injection. Idempotent on `handoff_key`: a retry reuses the record and the monitor, and only the attempt row is added | j46.8 |
| `obs:log-follow` | agent-json | polling stream over `journalPage()` — one item per line, same envelope as the page. Advances its cursor only AFTER a row is written, so a crash mid-line replays a row (absorbed by `event_key`) rather than skipping it | j46.6 |
| `obs:pane` | agent-json | `pane capture` → `xtrm.xtmux.pane-capture.v1`; bounded at `max_lines`, over-large requests clamped not rejected; opens no DB; content never journalled | j46.4 |
| `obs:bridge` | agent-json | `bridge --stdio` → `xtrm.xtmux.bridge.v1` NDJSON over the ssh pipe. The only REMOTELY reachable surface, so: methods are dispatched from an allowlist (default deny — a mutation name is refused with `XTMUX_BRIDGE_READ_ONLY`, an unrecognised one with `XTMUX_BRIDGE_UNKNOWN_METHOD`, and neither routes anywhere); frames are capped at `max_frame_bytes` and every caller-sizeable result reuses the local clamp; malformed input answers with an error and keeps serving. No listen/bind mode exists — OpenSSH owns transport | j46.9 |
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
