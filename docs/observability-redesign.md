# Observability redesign: SQLite substrate for xtmux v2

Status: design brief for independent review
Owner bead: xtmux-ihu1
Scope: observability substrate only

## 1. Decision

Choose **Rung C**.

Reason:
- xtmux needs durable message/query substrate, not only faster grep.
- current JSONL rotation can separate `message.sent` from later `message.ack`, making `--unacked` wrong at file boundaries.
- xtmux already has stable local-shell workflow and can rely on system `sqlite3` without new dependency.
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
- **channel**: one implicit local channel namespace for xtmux observability; not user-created, not multi-topology
- **channel message**: durable short message between participants, equivalent to current `message.sent`
- **subscription/receipt**: durable per-participant state showing read cursor and optional ack state for messages addressed to that participant
- **event**: generic observability record, including message lifecycle and non-message telemetry

Explicitly omitted from xtmux subset:
- no `audience_json`
- no multi-party subscriptions by filter language
- no judges, topologies, stop conditions, or proposal/verdict schemas
- no claim that xtmux message channel equals full channels.md runtime

## 5. Storage design

Canonical v2 database location:
- `.specialists/db/observability.db` inside repo when repo context exists
- if current xtmux command is outside repo context, v2 for that invocation must fail closed back to legacy mode unless future work explicitly defines non-repo fallback

Rationale:
- repo-local database matches existing observability memory for specialists and keeps data migration-safe per worktree/repo
- brief pins one canonical DB path, not per-user global DB

### 5.1 Tables

```sql
CREATE TABLE participants (
  participant_id TEXT PRIMARY KEY,        -- canonical tmux #{session_id}
  session_name TEXT,                      -- optional human aid; non-canonical
  pane_id TEXT,                           -- optional last-seen pane
  bead_id TEXT,
  task_text TEXT,
  parent_session_id TEXT,
  last_seen_at_ms INTEGER NOT NULL
);

CREATE TABLE channel_messages (
  message_id TEXT PRIMARY KEY,            -- existing msg-<epoch>-<pid> or later stable id
  from_participant_id TEXT NOT NULL,
  to_participant_id TEXT NOT NULL,
  bead_id TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  created_at_ts TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  legacy_jsonl_offset INTEGER,            -- nullable breadcrumb for migration/debug
  FOREIGN KEY (from_participant_id) REFERENCES participants(participant_id),
  FOREIGN KEY (to_participant_id) REFERENCES participants(participant_id)
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
CREATE INDEX idx_channel_messages_to_created
  ON channel_messages(to_participant_id, created_at_epoch, message_id);

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
- `@agent_state`, `@agent_bead`, `@agent_task`, `@agent_parent_session` stay tmux pane/session options; SQLite mirrors latest values only for query context.
- every `channel_messages` row for recipient creates exactly one `message_receipts` row for same recipient.
- **read** means message shown/listed to recipient and sets `read_at_*` if empty.
- **ack** means explicit `message-ack` command and sets `ack_at_*` plus `ack_by_participant_id`.
- ack never deletes message.
- unacked means `ack_at_epoch IS NULL`; unread means `read_at_epoch IS NULL`.
- `events` stores generic observability facts, including `message.sent`, `message.read`, `message.ack`, `agent.turn.done`, telemetry, handoff, monitor, audit.
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
  - absence of `--unacked` must not imply read or ack side effect
  - if implementation later wants implicit read marking, it must be explicit and documented as post-MVP; this brief keeps list/read non-destructive

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
- create DB and schema if missing
- do **not** rewrite or delete existing JSONL
- optional backfill imports retained JSONL files into SQLite events/message tables using best-effort dedupe by `message_id + type + ts_epoch`
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
| canonical participants/channel messages/subscriptions or receipts | `participants`, `channel_messages`, `message_receipts` in §5.1 |
| indexed generic events | `events` table + indexes in §5.1-5.2 |
| explicit read-vs-ack semantics | §5.3 and §6.2 separate unread vs unacked; list does not auto-ack |
| non-destructive JSONL migration | §7.1 import/dual-write leaves JSONL untouched |
| v2 dual-write compatibility | §6.1 and §7.1 |
| size-triggered retention | §8 |
| unchanged operator pane options/addressing | §3, §5.3, §6.2 preserve tmux `#{session_id}` and `@agent_*` |
| preserve metadata options | §5.3 mirrors but does not replace `@agent_state/@agent_bead/@agent_task/@agent_parent_session` |
| flat one-hop routing | participant_id stays tmux `#{session_id}` only; no hierarchy in §4/§5.3 |
| legacy byte-identical when v2 off | §6.1 |
| no new dependency | sqlite3 CLI/system library only; no package add |
| subset, not full channels | §1 and §4 explicit |

## 10. Acceptance criteria

### 10.1 Implementation acceptance criteria
- only storage substrate changes behind existing commands
- no new user-facing command names or addressing formats
- v2-off path produces byte-identical JSONL rows and current command behavior
- v2-on path creates repo-local `.specialists/db/observability.db`
- `message-list --unacked` no longer depends on rotated JSONL history integrity
- read state and ack state represented separately in persistent schema
- current unread counter/status-line side effects remain unchanged

### 10.2 Test acceptance criteria
- golden test: `XTMUX_OBS_V2=0` output for `log emit`, `message-send`, `message-ack`, `message-list`, `log query` matches current fixture byte-for-byte
- migration test: import existing JSONL with rotated generations reconstructs same message/ack truth in SQLite
- orphan test: historical ack without send does not crash import; counted as warning/event only
- idempotency test: repeated import and repeated `message-ack` keep same logical state
- routing test: pane id, session name, session id, and shorthand still resolve to same canonical recipient session_id
- retention test: pruning never deletes unacked messages; may delete old acked messages/events
- compatibility test: v2 dual-write still produces legacy-readable JSONL `message.sent` and `message.ack`

### 10.3 Benchmark acceptance criteria
- `message-list --unacked` on dataset larger than current 10 MB JSONL cap completes without grep-over-rotations behavior dominating runtime
- `log query --since 1h --limit 100` scales with indexes, not full-file scans
- write path adds bounded SQLite transaction overhead acceptable for interactive tmux command use
- benchmark comparison must include current JSONL worst case with rotated files versus v2 indexed query path

## 11. Risks and open questions

- repo-local DB path for invocations outside git repo not yet specified; brief intentionally defers rather than invent global fallback
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
