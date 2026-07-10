# Observability redesign: SQLite substrate for xtmux v2

Status: design brief for independent review
Owner bead: xtmux-ihu
Scope: observability substrate only

## 1. Decision

Choose **Rung C**.

Reason:
- xtmux needs durable message/query substrate, not only faster grep.
- current JSONL rotation can separate `message.sent` from later `message.ack`, making `--unacked` wrong at file boundaries.
- xtmux already has stable local-shell workflow and can rely on Python 3 stdlib `sqlite3` (SQLite 3.46.1 in current environment) without new dependency.
- operator-facing pane routing and picker flows stay unchanged if storage moves under same commands.

Rung meanings for this brief:
- Rung A: keep JSONL only, patch grep/rotation.
- Rung B: add indexes/cache beside JSONL, keep JSONL canonical.
- **Rung C: SQLite becomes canonical v2 substrate for messages/events, JSONL remains compatibility output during migration.**
- Rung D: full channels runtime with topology/judging/pub-sub semantics.

xtmux intentionally stops at **Rung C**. It adopts only channels.md vocabulary needed for local observability/message durability. It does **not** claim full Channels implementation.

## 2. Goals and non-goals

### Goals
- make message delivery, reads, receipts durable across retention boundaries
- align names with channels.md subset: participants, channel messages, subscriptions/receipts, events
- separate **read** from **ack** semantics
- preserve current one-hop `#{session_id}` routing and pane metadata model
- keep legacy JSONL byte-identical when `XTMUX_OBS_V2` is unset or `0`
- allow `XTMUX_OBS_V2=1` dual-write so legacy readers still work during migration
- keep retention size-triggered and local-only

### Non-goals
- no broker, daemon, sockets, pub/sub runtime
- no cross-machine sync
- no hierarchy beyond current flat one-hop parent/session routing
- no operator-visible CLI/addressing change
- no full channels topology, judge, evidence, forensics, or authority lanes

## 3. Current-state facts from xtmux

Current commands in `bin/tmux-session-picker`:
- `log emit|tail|query` write/read JSONL events
- `message-send` appends `message.sent`
- `message-ack` appends `message.ack`
- `message-list --unacked` reconstructs state by grepping `message.sent` plus all retained rotated files for `message.ack`

Current invariants worth preserving:
- canonical live address already normalized to tmux `#{session_id}` when possible
- sender/recipient options `@agent_state`, `@agent_bead`, `@agent_task`, `@agent_parent_session` remain source of pane metadata
- operator still targets panes/sessions same way; storage change stays behind existing commands
- retention is size-triggered, opportunistic on write, no daemon

Failure source:
- JSONL rotation can split message event and later ack into different generations, or drop older generation before matching ack survives long enough for accurate `--unacked` reconstruction.

## 4. Canonical contract: xtmux subset of channels vocabulary

xtmux v2 uses channels.md words with narrower meaning:

- **participant**: routable local endpoint keyed by canonical tmux `#{session_id}`; optional pane metadata remains separate
- **channel**: one implicit local observability channel record for xtmux; not user-created, not multi-topology
- **channel message**: durable short message between participants with canonical `kind`, `message_family`, and `audience_json` fields, carrying current `message.sent` semantics
- **channel subscription**: durable per-participant cursor seam aligned with channels.md; present in schema but dormant in v2 MVP
- **receipt**: explicit per-message recipient state carrying current read/ack semantics
- **event**: generic observability record, including message lifecycle and non-message telemetry

Explicitly omitted from xtmux subset:
- no multi-party subscriptions by filter language at runtime
- no judges, topologies, stop conditions, or proposal/verdict schemas
- no claim that xtmux message channel equals full channels.md runtime

## 5. Storage design

Canonical v2 database location:
- `${XDG_STATE_HOME:-$HOME/.local/state}/xtmux/observability.db`
- in current operator environment, canonical absolute path is `/home/dawid/.local/state/xtmux/observability.db`

Rationale:
- xtmux runs both inside and outside repos
- DB must live beside legacy `events.jsonl` so migration covers whole existing local substrate
- one global local path preserves current operator mental model and avoids repo-detection branches

### 5.1 Tables

```sql
CREATE TABLE participants (
  participant_id TEXT PRIMARY KEY,        -- canonical tmux #{session_id}
  participant_kind TEXT NOT NULL DEFAULT 'session',
  session_name TEXT,                      -- optional human aid; non-canonical
  pane_id TEXT,                           -- optional last-seen pane
  bead_id TEXT,
  task_text TEXT,
  parent_session_id TEXT,
  last_seen_at_ms INTEGER NOT NULL
);

CREATE TABLE channels (
  channel_id TEXT PRIMARY KEY,            -- fixed single row: 'xtmux.local'
  kind TEXT NOT NULL,                     -- 'xtmux-local'
  topology TEXT NOT NULL,                 -- 'reactive-single-hop'
  status TEXT NOT NULL,                   -- 'open'
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE channel_messages (
  message_id TEXT PRIMARY KEY,            -- existing msg-<epoch>-<pid> or later stable id
  channel_id TEXT NOT NULL,
  message_family TEXT NOT NULL,           -- 'work' for current short messages
  kind TEXT NOT NULL,                     -- 'message.sent' for current send path
  from_participant_id TEXT NOT NULL,
  to_participant_id TEXT NOT NULL,
  audience_json TEXT NOT NULL,            -- minimal canonical subset; single action target today
  bead_id TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  created_at_ts TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  legacy_jsonl_file TEXT,
  legacy_jsonl_line INTEGER,
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id),
  FOREIGN KEY (from_participant_id) REFERENCES participants(participant_id),
  FOREIGN KEY (to_participant_id) REFERENCES participants(participant_id)
);

CREATE TABLE channel_subscriptions (
  channel_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  last_seen_message_id TEXT NOT NULL DEFAULT '',
  paused INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, participant_id),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id),
  FOREIGN KEY (participant_id) REFERENCES participants(participant_id)
);

CREATE TABLE message_receipts (
  message_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,           -- recipient session_id
  read_at_ts TEXT,
  read_at_epoch INTEGER,
  ack_at_ts TEXT,
  ack_at_epoch INTEGER,
  ack_by_participant_id TEXT,
  PRIMARY KEY (message_id, participant_id),
  FOREIGN KEY (message_id) REFERENCES channel_messages(message_id),
  FOREIGN KEY (participant_id) REFERENCES participants(participant_id)
);

CREATE TABLE events (
  event_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  ts_epoch INTEGER NOT NULL,
  type TEXT NOT NULL,
  pane_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  bead_id TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL              -- generic escaped key/value object payload
);
```

### 5.2 Indexes

```sql
CREATE INDEX idx_channel_messages_channel_to_created
  ON channel_messages(channel_id, to_participant_id, created_at_epoch, message_id);

CREATE INDEX idx_channel_messages_from_created
  ON channel_messages(from_participant_id, created_at_epoch, message_id);

CREATE INDEX idx_message_receipts_participant_ack
  ON message_receipts(participant_id, ack_at_epoch, read_at_epoch);

CREATE INDEX idx_events_type_ts
  ON events(type, ts_epoch);

CREATE INDEX idx_events_session_ts
  ON events(session_id, ts_epoch);

CREATE INDEX idx_events_bead_ts
  ON events(bead_id, ts_epoch);

CREATE INDEX idx_events_message
  ON events(message_id, ts_epoch);
```

### 5.3 Contract rules

- `participants.participant_id` is canonical routing key. It preserves flat one-hop `#{session_id}` addressing.
- `channels` contains one canonical row: `channel_id='xtmux.local'`.
- `channel_messages.kind`, `channel_messages.message_family`, and `channel_messages.audience_json` preserve channels.md vocabulary subset without claiming full channels runtime.
- `channel_subscriptions` exists as future cursor seam, but remains **dormant** in v2 MVP: `message-list` is pure read and does not advance subscription state.
- `@agent_state`, `@agent_bead`, `@agent_task`, `@agent_parent_session` stay tmux pane/session options; SQLite mirrors latest values only for query context.
- every `channel_messages` row for recipient creates exactly one `message_receipts` row for same recipient.
- **read** and **list** are separate concepts in v2 MVP. `message-list` is pure observation and does not mutate receipts or subscriptions.
- **ack** means explicit `message-ack` command and sets `ack_at_*` plus `ack_by_participant_id`.
- ack never deletes message.
- unacked means `ack_at_epoch IS NULL`; unread means `read_at_epoch IS NULL` until future explicit read-marking exists.
- `events` stores generic observability facts, including `message.sent`, optional future `message.read`, `message.ack`, `agent.turn.done`, telemetry, handoff, monitor, audit.
- v2 queries use SQLite as source of truth. JSONL becomes compatibility mirror only.

## 6. CLI behavior contract

Operator-visible commands stay same. Semantics pinned below.

### 6.1 Flag gate

- `XTMUX_OBS_V2` unset or `0`:
  - behavior byte-identical to current legacy implementation
  - write JSONL only
  - read/query/ack from JSONL only
  - no SQLite open, create, migrate, or side effects

- `XTMUX_OBS_V2=1`:
  - v2 path enabled
  - `log emit`, `message-send`, `message-ack`, `message-list`, `log query` write/read SQLite canonically
  - same operations also keep JSONL available for legacy readers during migration
  - JSONL output shape remains current shape for mirrored events
  - if SQLite write fails, command fails; brief rejects silent fallback after partial dual-write because migration-safe contract needs deterministic source of truth
  - if JSONL mirror write fails after SQLite success, command succeeds but must surface warning on stderr in future implementation; SQLite remains canonical

### 6.2 Exact command semantics under v2

- `message-send`
  - resolve `--to` and optional `--from` exactly like today
  - upsert participants for sender/recipient
  - insert `channel_messages`
  - insert recipient `message_receipts` with all read/ack fields null
  - insert `events(type='message.sent')`
  - keep current unread tmux option bump/display-message behavior unchanged

- `message-list --for X`
  - resolve `X` same as today
  - list from `channel_messages` filtered by `to_participant_id`
  - if `--unacked`, filter `message_receipts.ack_at_epoch IS NULL`
  - command is pure observation: no receipt mutation, no subscription cursor advance, no ack side effect
  - if implementation later adds explicit read-marking, it must be separate from list or explicitly opt-in; this brief keeps list pure

- `message-ack <message-id> --by X`
  - resolve `X` same as today or current session_id if omitted
  - update matching receipt only when `participant_id` matches recipient
  - insert `events(type='message.ack')`
  - keep tmux unread counter decrement behavior unchanged
  - duplicate ack is idempotent: second ack leaves prior ack timestamp intact or rewrites same logical state without changing meaning

- `log emit`
  - insert generic `events`
  - dual-write current JSONL row shape when v2 enabled

- `log query`
  - query `events` by same filters: `--type`, `--pane`, `--session/--for`, `--bead`, `--since`, `--limit`
  - output remains current line-oriented JSONL rows or stable equivalent defined during implementation; brief requires command compatibility, not SQL-shaped output

- `log tail`
  - may remain JSONL-tail in v2 compatibility period, because SQLite has no natural append-tail file
  - requirement: operator still has simple recent-event view; implementation may satisfy with SQL query over newest rows while keeping CLI unchanged

## 7. Migration and rollback

### 7.1 Migration approach

Non-destructive, local, repeatable.

Phase 0: legacy
- existing JSONL only

Phase 1: first v2 start
- create DB and schema if missing at `${XDG_STATE_HOME:-$HOME/.local/state}/xtmux/observability.db`
- do **not** rewrite, truncate, or delete existing `events.jsonl`
- non-destructively import existing `events.jsonl` plus retained backfiles `events.jsonl.1..N` into SQLite events/message tables
- import uses Python 3 stdlib `sqlite3`; no sqlite3 CLI dependency
- import dedupes by stable logical keys such as `message_id + type + ts_epoch` for message lifecycle rows and `(ts_epoch, type, payload_json)` fallback for generic events
- import must preserve legacy files untouched

Phase 2: dual-write
- new writes go to SQLite first, then mirrored JSONL
- legacy readers keep functioning from JSONL
- v2 readers use SQLite

Phase 3: steady state
- retention may prune SQLite rows by age/size policy and prune JSONL by current rotation policy
- JSONL remains compatibility feed until separate removal decision exists

### 7.2 Rollback

- turn off `XTMUX_OBS_V2`
- xtmux returns to byte-identical legacy JSONL path
- SQLite file remains inert history, not consulted
- no migration step mutates tmux options or addressing semantics, so rollback safe for operators

### 7.3 Deduplication and import rules

- imported `message.sent` becomes `channel_messages` + `message_receipts`
- imported `message.ack` updates receipt if matching `message_id` exists
- orphan `message.ack` from historical JSONL without matching send becomes `events` row only, plus migration warning count; no synthetic message row invented
- duplicate JSONL lines import once
- import order authoritative by `(ts_epoch, file_generation_order, line_order)` when rebuilding

## 8. Retention

Retention remains size-triggered, not daemon-based.

### 8.1 JSONL compatibility retention
- keep current rotate-on-write policy and env knobs for mirrored JSONL
- legacy files exist only for compatibility/readers during migration

### 8.2 SQLite retention
- trigger retention opportunistically on write when DB file exceeds configured size threshold
- prune oldest generic `events` first
- prune acknowledged `channel_messages` only when corresponding receipt has `ack_at_epoch` set and age exceeds retention floor
- never prune unacked messages by size alone
- receipts must be deleted in same transaction as pruned messages
- size policy values can reuse existing env naming family or add v2-specific env vars during implementation; brief does not require new operator knobs

Reason:
- fixes rotation-boundary orphaning without introducing daemon
- preserves actionable messages longer than noisy telemetry

## 9. Mapping requirements to schema/behavior/tests

| Requirement | Design answer |
| --- | --- |
| choose Rung C | §1 chooses SQLite canonical v2 with JSONL compatibility mirror |
| canonical participants/channel messages/subscriptions or receipts | `participants`, single-row `channels`, canonical `channel_messages`, dormant `channel_subscriptions`, and `message_receipts` in §5.1 |
| indexed generic events | `events` table + indexes in §5.1-5.2 |
| explicit read-vs-ack semantics | §5.3 and §6.2 separate unread vs unacked; list does not auto-ack |
| non-destructive JSONL migration | §7.1 import/dual-write leaves JSONL untouched |
| v2 dual-write compatibility | §6.1 and §7.1 |
| size-triggered retention | §8 |
| unchanged operator pane options/addressing | §3, §5.3, §6.2 preserve tmux `#{session_id}` and `@agent_*` |
| preserve metadata options | §5.3 mirrors but does not replace `@agent_state/@agent_bead/@agent_task/@agent_parent_session` |
| flat one-hop routing | participant_id stays tmux `#{session_id}` only; no hierarchy in §4/§5.3 |
| legacy byte-identical when v2 off | §6.1 |
| no new dependency | Python 3 stdlib `sqlite3` only; no package add |
| subset, not full channels | §1 and §4 explicit |

## 10. Acceptance criteria

### 10.1 Implementation acceptance criteria
- only storage substrate changes behind existing commands
- no new user-facing command names or addressing formats
- v2-off path produces byte-identical JSONL rows and current command behavior
- v2-on path creates `${XDG_STATE_HOME:-$HOME/.local/state}/xtmux/observability.db` and, in current environment, `/home/dawid/.local/state/xtmux/observability.db`
- `message-list --unacked` no longer depends on rotated JSONL history integrity
- read state and ack state represented separately in persistent schema
- current unread counter/status-line side effects remain unchanged

### 10.2 Test acceptance criteria
- golden test: `XTMUX_OBS_V2=0` output for `log emit`, `message-send`, `message-ack`, `message-list`, `log query` matches current fixture byte-for-byte
- migration test: import existing `events.jsonl` plus retained backfiles reconstructs same message/ack truth in SQLite
- orphan test: historical ack without send does not crash import; counted as warning/event only
- idempotency test: repeated import and repeated `message-ack` keep same logical state
- routing test: pane id, session name, session id, and shorthand still resolve to same canonical recipient session_id
- retention test: pruning never deletes unacked messages; may delete old acked messages/events
- compatibility test: v2 dual-write still produces legacy-readable JSONL `message.sent` and `message.ack`

### 10.3 Benchmark acceptance criteria
- corpus includes at least **100,000 `message.sent` rows** plus matching receipts and representative generic events
- `message-list --for X --unacked` on that corpus must hit **p50 < 100 ms** and **p99 < 100 ms** on review target hardware
- `log query --since 1h --limit 100` scales with indexes, not full-file scans
- write path adds bounded SQLite transaction overhead acceptable for interactive tmux command use
- benchmark comparison must include current JSONL worst case with rotated files versus v2 indexed query path

## 11. Risks and open questions

- single global DB beside legacy log increases shared-history surface across unrelated xtmux sessions; acceptable but should be reviewed for long-term retention growth
- exact env names for SQLite retention thresholds not pinned; implementation may reuse or introduce v2-specific vars
- `log tail` exact v2 backing behavior needs implementation choice because SQLite not append-only file
- participant registry freshness for session rename/close is best-effort mirror, not routing source; tmux remains routing authority
- backfill from malformed historical JSONL may lose some optional fields, though message/ack core should survive

## 12. Review checklist

Independent review should confirm:
- Rung C choice still minimal enough for epic
- channels vocabulary used accurately as subset, not overclaim
- read vs ack semantics are explicit and non-destructive
- rollback to legacy mode safe and exact
- retention cannot reintroduce orphaned-ack bug
- unchanged pane options/addressing guaranteed

## 13. v1 correctness contracts to inherit (fold-in from session addendum)

The messaging channel that Rung C replaces was hardened in the same session that filed this epic. The v2 substrate MUST preserve the following operator-visible behaviors — they are the contract, not the incidental JSONL implementation.

### 13.1 Address normalization at boundary (from xtmux-1hq / commit `a0f665f`)

- `message-send --to <target>` and `message-list --for <target>` canonicalize the argument through `resolve_to_session_id()` before touching storage. Recipients using name / `$N` / `%N` / `session:window.pane` shorthand all match the same rows.
- v2: `to` column stores `#{session_id}` (`$N` form). Resolution happens in the CLI layer, not the schema. `SELECT ... WHERE to = ?` uses the pre-resolved sid.
- v2 must keep the lenient-name fallback: plain-name targets that don't resolve (offline unit tests, legacy callers) get stored verbatim. Only `$N` / `%N` / `@N` unresolved ids exit nonzero.

### 13.2 Dead-target discipline (from xtmux-1hq / commit `a0f665f`)

- Unresolved `$N` / `%N` / `@N` target = exit nonzero + stderr + append `message.failed` event to the log. Silent black-hole delivery is a contract violation.
- v2: `message-send` still returns nonzero on unresolved tmux ids; the failed event goes into the `events` table (not `channel_messages`), keyed on the same `ts_epoch` and the original argument.

### 13.3 Delivery signal via tmux pane options (from xtmux-1hq / commit `a0f665f`)

- On successful `message-send`, set `@agent_unread_count` (increment) and `@agent_unread_since` (epoch stamp) on the **recipient session** (not pane), plus best-effort `tmux display-message -t <sid>` for any attached client.
- On successful `message-ack`, decrement `@agent_unread_count` on the acker's session; if it hits 0, unset `@agent_unread_since`.
- **This is operator-visible UX.** The picker badges recipient sessions with pending messages using these two options. v2 substrate changes MUST NOT touch this signaling — it stays a tmux-option write, orthogonal to storage.

### 13.4 Session-id parent binding (from xtmux-7ob / commit `85fccf5`)

- `@agent_parent_session` on a child pane holds the **parent's `#{session_id}`** (e.g. `$3`), never the mutable session name (`#S`). Set by `xt pi --role` launcher (core PR #362) at spawn time. Read by `extensions/pi-agent-state.ts` on `agent_end` to route `message-send --to $parent`.
- v2: `participants.session_id` is the FK. Parent-child topology is stored on the tmux pane (existing `@agent_parent_session` option) — v2 does NOT introduce a `parent_id` schema column. One-hop flat routing is the design intent (xtmux-1hq explicit non-goal for full pub/sub).

### 13.5 Unacked age column (from xtmux-1hq / commit `a0f665f`)

- `message-list --unacked` output includes a human age column (`Ns` / `Nm` / `Nh` / `Nd`) computed from `ts_epoch`.
- v2: same column in the CLI adapter, formatted via `format_age_short` from the SELECT'd row's `ts_epoch`.

### 13.6 Stopgaps that die with v2

- **Grep pre-filter in `message_list`** (xtmux-bje / commit `8deb7ad`). Added Jul 10 as a 60% CPU-hang bandaid. Whole `while read | sed` loop deletes when v2 lands — replaced by an indexed `SELECT`.
- **Size-triggered JSONL rotation** (`XTMUX_EVENT_LOG_MAX_BYTES` / `_KEEP` / `rotate_event_log_if_needed`). Retained under `XTMUX_OBS_V2=0` for compat; under v2, retention becomes SQL-level `DELETE WHERE ts_epoch < ?` with no cross-file boundary. This is what dissolves the ack-orphan boundary bug.
- **Per-line `sed`-based JSON field extraction** (`message_json_field`). Whole function deletes with v2. If Rung C substrate absolutely needs to fall back to a JSONL read (e.g. legacy import), do the parse in one Python pass, not per-line subshells.

### 13.7 Test coverage that must survive

`test/contract.sh` (xtmux-1hq commit `a0f665f`, xtmux-bje commit `8deb7ad`) currently covers:
- message channel: send prints TSV, list unacked, ack hides unacked
- unacked shows age column
- dead `$N` target exits nonzero
- log rotation on size threshold

v2 must ship equivalent coverage on the SQLite substrate (adapted names OK). Flag-off (`XTMUX_OBS_V2=0`) must still exercise the JSONL path and pass unchanged assertions.

### 13.8 Orthogonal to this epic (do NOT bundle)

Not touched by the messaging substrate — filed only for context so the implementer doesn't accidentally cross-scope:

- `xt pi --role` launcher (core PRs #364, #365 — e1o skill scaffold + 2dy pi argv passthrough)
- pi `process` tool PATH strip (specialists PR #177, doc-only workaround)

If v2 wants to change the `pi-agent-state.ts` publish path, only the storage backend changes — the tmux-option delivery signal and CLI surface stay identical.
