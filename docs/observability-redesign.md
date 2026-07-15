# xtmux Observability Redesign — SQLite-backed runtime

Epic: **xtmux-3xs** (supersedes xtmux-ihu).
PRD: [`docs/ts-sqlite.md`](./ts-sqlite.md) — normative for scope, non-goals, phase sequence.
This began as the Phase 1 design record and now documents the shipped post-cutover runtime. V2 is default-on; set `XTMUX_OBS_V2=0` only for rollback or compatibility testing. The architecture, schema, identity, migration, compatibility, and benchmark decisions below remain the implementation record.

Anything not stated here inherits the PRD by reference. Shipped amendments in this document supersede earlier phase language.

---

## 1. Architecture decision

**Chosen rung:** C — SQLite-backed runtime with typed domain tables and indexed queries, implemented in Bun/TypeScript, invoked by the existing shell picker as a delegated durable-runtime backend.

Rejected alternatives:

- **Rung A** (awk single-pass parse of `events.jsonl`): kills per-line `sed` forks and delivers a real speedup, but leaves ack orphaning on rotation and type-mixing scan cost. Not an acceptable end state; keep as a benchmark baseline only.
- **Rung B** (per-type JSONL files with lockstep ack rotation): fixes ack orphaning and eliminates cross-type scan cost, but does not give indexed reads, does not correlate turn/message/handoff lifecycles, does not give a monitor-lease/heartbeat model, and does not align vocabulary with the Channels canonical.
- **One generic hot SQL table** (mirror of `events.jsonl` in SQLite): explicitly rejected by PRD §1. Typed domain tables + a compatibility journal is normative.

**Runtime split** (PRD §3):

- `bin/tmux-session-picker` remains the public entry point (shell). It owns tmux/fzf interaction, session/pane discovery, `capture-pane`, ANSI rendering, switch/jump/rename/interrupt/approve/kill, and V1 codepaths while V2 is disabled.
- Bun/TypeScript owns SQLite connection + schema + migrations, transactional domain mutations, message/receipt queries, runtime-object state machines, retention/reconciliation, legacy migration, contract tests, benchmark harness, structured errors, output formatting for delegated commands.
- Prefer Bun's native SQLite; do not spawn `sqlite3` CLI (PRD §3, §25).
- No mandatory daemon or broker. Each invocation opens the DB, verifies schema, runs one command, and closes; lock waits are bounded, but commands without a public limit may read full history.

Database path: `${XDG_STATE_HOME:-$HOME/.local/state}/xtmux/observability.db`.

---

## 2. Channels audit — inherited and excluded

_Source: `~/dev/xtrm/docs/channels/` (canonical, upgrade, forensic-attention proposal), plus the specialists runtime implementation backed by `observability.db`._

### Inherited invariants (borrowed vocabulary + structural rules)

Sources: `channels.md` §5.1–5.5, §5.7, §10.5, §11; `channels-upgrade.md` §5, §8, §10, §18; `channels-forensic-attention-proposal.md` §A1–A4. Materialization reference: `~/dev/specialists/src/specialist/observability-sqlite.ts` L212–294 (`specialist_forensic_events`, WAL pragmas, cursor tables).

| # | Invariant | Why | xtmux analog |
|---|---|---|---|
| A1 | **One SQLite writer per DB connection, WAL mode.** | Serializes concurrent mutations with bounded lock waits. | Picker/runtime commands open `observability.db`; immediate transactions and `busy_timeout=3000` protect multi-row state changes. |
| A2 | **Delivery cursor = table-wide `AUTOINCREMENT id`; per-channel `seq` is display ordinal only.** `ORDER BY id`, never `seq`. | Correctness never depends on ordinal collisions. | `messages.id` is the cursor; sender-supplied `message_key` is dedup handle; no separate `seq`. |
| A3 | **`readSince` pure; `markSeen` effectful. Cursor advances only through the highest *successfully processed* id.** | Crash between "enqueue action" and ack is replay-safe. | `message-list` is a pure read; `message-ack` mutates only receipts; ack idempotent (PRD §6). |
| A4 | **Reducer / after-hook split per tick.** Pass 1 derives state without I/O; pass 2 runs side effects deduped by `(channel_id, msg_id)` idempotency keys. | Prevents double-wake on replay. | Turn-completion + parent-message + tmux-projection split into (a) atomic durable insert, (b) best-effort projection write. |
| A5 | **Message body never grants authority.** `participant_id` / `job_id` come from the runtime, not the body. | Bodies are untrusted. | `--from` on `message-send` must be resolved against tmux `#{session_id}` / `#{pane_id}`, not trusted verbatim. |
| A6 | **Audience is the addressing model.** `action_targets[]`, `visibility`, `scope_refs[]`, `urgency`; legacy `target_key` = bridge alias for `action_targets[0]`. | Single-target wake without privileged coupling. | xtmux stays single-target for now: `recipient_id` = `action_targets[0]`. Multi-target is a future migration, not a current schema shape. |
| A7 | **Message families with discriminated union.** Validate on write; malformed → `runtime.message_rejected` written to the stream, no wake. | Self-contained post-mortem replay. | xtmux subset: `work.turn`, `control.steer`, `system.done`, `runtime.error`. Malformed → `event_journal` envelope with `type=runtime.message_rejected` + rejection reason, no `messages` row. |
| A8 | **Lifecycle: `open → draining → closed`, `→ aborted`.** Terminal flip is immediate; readers still drain unread. Pruning excludes non-closed. | Prevents dropping in-flight acks at shutdown. | Maps to `agent_instances` lifecycle (`ended_at_ms`, `end_reason`) + `handoffs` state machine. Session/pane exit does NOT delete rows; retention (§6) is the only pruner and it preserves unacked / active / incomplete. |
| A9 | **Idempotency keys declared per side-effect kind.** Resume-intent key = `(channel_id, msg_id, target_id)`; forensic write key = deterministic. | Replay-safe wake path. | `messages.message_key` for sender-side dedup; `event_journal.event_key` for legacy import; `delivery_attempts` has no natural key (append-only). |
| A10 | **Channel routing ≠ forensic events.** Important writes dual-emit: typed row + forensic envelope. Metrics are projections only, never source of truth. | Metrics view rebuildable without corrupting channel state. | Typed domain tables + `event_journal` split matches this exactly. Tmux `@agent_*` options and `@agent_unread_*` are projections; SQLite is authority (PRD §6, §9, §15). |
| A11 | **`runtime.error` / `runtime.message_rejected` written to the stream, not just returned.** | Self-contained replay of why a send failed. | Every rejection / busy-failure writes an `event_journal` envelope with `domain=<domain>`, `type=<domain>.rejected` (or `db.busy`), `payload_json=<structured reason>`. Replaces silent `2>/dev/null || true`. |
| A12 | **Anti-spam: `work.turn` body ≤ 500 chars + refs; verbose text lives elsewhere.** | Cursor-driven readers don't scan multi-KB rows. | `agent_turns.summary` and `messages.summary` are bounded; long payload → `payload_json` and/or external file with pointer + hash (matches handoff prompt-file rule §4.7). Existing `MAX_LAST_MESSAGE` (~600) in `publishTurnDone` is the current ceiling; preserve it. |
| A13 | **Stop conditions: declared list, first-fires-wins.** | Bounded monitor loops. | `monitors.terminal_status` closed set + `timeout_ms` + `lease_expires_at_ms` implement this: any stop cause fires exactly one terminal row-state update. |

### Explicitly not inherited (PRD §2)

- Specialist judges
- Channel topologies
- Consensus / quorum
- Capability negotiation
- Specialist subscription expressions
- Evidence grants
- Work-graph derivation
- Node supervision
- Self-activation
- Freeform multi-agent routing
- Cross-container channels
- Cross-machine synchronization

xtmux remains a **local session-routing and observability runtime** keyed on tmux `session_id` and `pane_id`.

---

## 3. Identity model

- **Recipient** = tmux `#{session_id}` (stable per-instance handle, e.g. `$1732`). Never `#S` (mutable session name).
- **Pane** = tmux `#{pane_id}` (e.g. `%1931`).
- **Instance** = one agent activation; a new row in `agent_instances` per activation, even when a pane is reused. `instance_id` is the primary handle. Panes may be reused; instances are not.
- **Bead** = beads issue id (e.g. `xtmux-3xs.4`); free-text `bead_id` on rows that reference one.
- **Correlation** = `correlation_id` (opaque, propagated across a turn/handoff/command-run chain to link typed-table rows with their journal envelopes).
- **Message key** = `message_key` (external stable id from sender; used for idempotency).
- **Event key** = `event_key` (unique per source line; used by legacy import for deterministic idempotency).

Rule: session/recipient normalization to `#{session_id}` happens once at the boundary; internal code never re-normalizes.

Reference memory (bd): `agent-parent-session-must-be-tmux-session-id` — reader side patched in `extensions/pi-agent-state.ts` (8f4d46b), writer side in specialists core PR #362 (`worktree-session.ts`).

---

## 4. Schema

All tables live in `observability.db`. Pragmas set on every open:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA busy_timeout = 3000;
PRAGMA foreign_keys = ON;
```

On close, per SQLite's own guidance and xtmux-3xs.15:

```sql
PRAGMA optimize;   -- best-effort; opt out with XTMUX_OBS_SKIP_PRAGMA_OPTIMIZE=1
```

Any deviation requires benchmark or reliability evidence appended to §11 of this doc.

### 4.1 `schema_migrations`

Bookkeeping. One row per applied migration:

```sql
CREATE TABLE schema_migrations (
    version         INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    applied_at_ms   INTEGER NOT NULL,
    checksum        TEXT NOT NULL
);
```

### 4.2 `event_journal` (compatibility + custom + drilldown)

Purpose: append-only envelope for `log emit`, arbitrary custom events, `log tail`/`log query` compatibility, mutation audit envelopes for every typed-table write, unsupported/future event kinds, migration provenance, runtime failures.

Not the primary read path for messages, monitors, agent state, telemetry, handoffs, or audit findings — those live in typed tables.

```sql
CREATE TABLE event_journal (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_key       TEXT UNIQUE,
    type            TEXT NOT NULL,
    domain          TEXT NOT NULL,
    session_id      TEXT,
    pane_id         TEXT,
    instance_id     TEXT,
    bead_id         TEXT,
    correlation_id  TEXT,
    payload_json    TEXT NOT NULL,
    created_at_ms   INTEGER NOT NULL
);

CREATE INDEX ev_type_id      ON event_journal(type, id);
CREATE INDEX ev_session_id   ON event_journal(session_id, id);
CREATE INDEX ev_pane_id      ON event_journal(pane_id, id);
CREATE INDEX ev_bead_id      ON event_journal(bead_id, id);
CREATE INDEX ev_correlation  ON event_journal(correlation_id);
CREATE INDEX ev_domain_id    ON event_journal(domain, id);
```

Typed-table mutation + journal envelope insertion happen in the same transaction when both are required.

### 4.3 `messages` + `message_receipts` (PRD §6)

```sql
CREATE TABLE messages (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    message_key              TEXT NOT NULL UNIQUE,
    sender_id                TEXT NOT NULL,
    sender_pane_id           TEXT,
    recipient_id             TEXT NOT NULL,
    target_pane_id           TEXT,
    bead_id                  TEXT,
    summary                  TEXT NOT NULL,
    payload_json             TEXT,
    expects_reply            INTEGER NOT NULL DEFAULT 0 CHECK (expects_reply IN (0,1)),
    created_at_ms            INTEGER NOT NULL,
    reply_to_message_id      INTEGER REFERENCES messages(id) ON DELETE RESTRICT,
    fulfilled_by_message_id  INTEGER REFERENCES messages(id) ON DELETE RESTRICT,
    fulfilled_at_ms          INTEGER,
    cancelled_at_ms          INTEGER,
    cancel_reason            TEXT,
    CHECK (reply_to_message_id IS NULL OR reply_to_message_id <> id),
    CHECK ((fulfilled_by_message_id IS NULL AND fulfilled_at_ms IS NULL)
        OR (fulfilled_by_message_id IS NOT NULL AND fulfilled_at_ms IS NOT NULL)),
    CHECK (cancelled_at_ms IS NULL OR fulfilled_at_ms IS NULL)
);
CREATE INDEX msg_recipient_id ON messages(recipient_id, id);
CREATE INDEX msg_target_pane  ON messages(target_pane_id, id);
CREATE INDEX msg_bead_id      ON messages(bead_id, id);
CREATE UNIQUE INDEX msg_one_reply_per_request ON messages(reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;
CREATE INDEX msg_pending_obligation ON messages(sender_id, sender_pane_id, created_at_ms, id)
  WHERE expects_reply = 1 AND fulfilled_at_ms IS NULL AND cancelled_at_ms IS NULL;
CREATE INDEX msg_reply_target ON messages(reply_to_message_id, sender_id, sender_pane_id, id);
CREATE INDEX msg_fulfilled_retention ON messages(fulfilled_at_ms, cancelled_at_ms, id)
  WHERE expects_reply = 1;

CREATE TABLE message_receipts (
    message_id      INTEGER NOT NULL,
    recipient_id    TEXT NOT NULL,
    read_at_ms      INTEGER,
    acked_at_ms     INTEGER,
    acked_by        TEXT,
    PRIMARY KEY (message_id, recipient_id),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);
CREATE INDEX rcpt_unacked ON message_receipts(recipient_id, acked_at_ms);
```

**Pane-level addressing deviation from PRD §6 DDL.** PRD §6 lists only
`sender_id` / `recipient_id`. Two panes of the same tmux session collapse to
the same `session_id`, so pure session-level addressing loses sender identity
when panes of the same session need to message each other (a real xtmux
runtime case — `xtmux:1.1` and `xtmux:1.2` both resolve to `$1732`).
`sender_pane_id` and `target_pane_id` are optional finer-grained hints;
`recipient_id` remains the durable session-level identity. `list` filters
`target_pane_id = ? OR IS NULL` so session broadcasts still land at every
pane. Reported by xtmux:1.2 during Phase 1 fixture capture.

**Reader note.** `message-list` prints session ids only (V1 stdout shape
preserved). The pane-level discrimination lives in the row columns, not in
the stdout. Verify the fix by inspecting the row directly, e.g.
`sqlite3 observability.db 'SELECT sender_pane_id, target_pane_id FROM messages ORDER BY id DESC LIMIT 1'`.
Trusting stdout alone will make the fix look absent when it is in fact
working end-to-end (verified by xtmux:1.2 on merged main).

Invariants:

- Recipient `recipient_id` normalized to `#{session_id}` before insert.
- `target_pane_id` / `sender_pane_id` normalized to `#{pane_id}` when provided.
- Message + receipt inserted in one transaction.
- `message-list` is a pure read; `message-ack` is the sole ack mutation and is idempotent. Ack does not modify reply columns.
- Machine queries avoid formatted-message scans: `message-status <message_key> --json` and `message-list --expects-reply --json` expose `replyStatus`, fulfilment fields, and the correlated reply; `unread-count --for <recipient> [--pane %N]` is pane-scoped.
- `message-send --expects-reply[=true|false]` stores sender intent. A bead defaults it to true; explicit false is the FYI opt-out. `message-reply` reverses the original endpoints, validates the live recipient pane, inserts one reply, and fulfils the original in one transaction. `message-cancel` is owner-only and terminal.
- Pi and Claude query pending obligations from `msg_pending_obligation`; no local marker or acknowledgement heuristic fulfils work.
- Foreign key cascade: a receipt cannot exist without its message.
- Retention never removes an unacked message (PRD §17).
- tmux projection failure does NOT fail the durable mutation.
- Recipient-query complexity depends on queue size × limit, not on global observability volume.

Live tmux projections (best-effort, not authoritative):

- `@agent_unread_count`
- `@agent_unread_since`

Reconciliation from SQLite runs on: picker open/refresh, projection-write failure, explicit repair command, shadow-mode divergence.

### 4.4 `delivery_attempts` (PRD §7)

Distinguishes durable message insertion from best-effort pane / tmux injection.

```sql
CREATE TABLE delivery_attempts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    kind                TEXT NOT NULL,
    source_session_id   TEXT,
    target_session_id   TEXT,
    target_pane_id      TEXT,
    related_message_id  INTEGER,
    related_handoff_id  TEXT,
    payload_summary     TEXT,
    attempted_at_ms     INTEGER NOT NULL,
    succeeded           INTEGER NOT NULL,
    failure_code        TEXT,
    details_json        TEXT,
    FOREIGN KEY (related_message_id) REFERENCES messages(id) ON DELETE SET NULL
);
CREATE INDEX da_target ON delivery_attempts(target_session_id, id);
CREATE INDEX da_kind   ON delivery_attempts(kind, id);
```

Kinds (initial closed set; extendable in future migrations):

- `send_keys` — raw `tmux send-keys`
- `display_message` — `tmux display-message`
- `unread_projection` — write of `@agent_unread_count`/`@agent_unread_since`
- `second_enter` — Claude second-Enter injection
- `picker_action` — approve/interrupt/message from picker
- `pane_pointer` — `safe-send-pointer` invocation
- `handoff_pointer` — handoff-driven pointer injection

Semantic separation from messages:

- `message.sent` = durable insert into `messages`
- `delivery.attempted` = row in `delivery_attempts` (may or may not have `related_message_id`)

Never the same event type.

### 4.5 `agent_instances` + `agent_state_transitions` + `agent_turns` (PRD §8–10)

```sql
CREATE TABLE agent_instances (
    instance_id          TEXT PRIMARY KEY,
    session_id           TEXT NOT NULL,
    session_name         TEXT,
    pane_id              TEXT NOT NULL,
    runtime              TEXT,
    role                 TEXT,
    bead_id              TEXT,
    task                 TEXT,
    prompt_file          TEXT,
    parent_session_id    TEXT,
    started_at_ms        INTEGER NOT NULL,
    ended_at_ms          INTEGER,
    end_reason           TEXT,
    last_state           TEXT,
    last_transition_ms   INTEGER
);
CREATE INDEX ai_session_id ON agent_instances(session_id, started_at_ms);
CREATE INDEX ai_pane_id    ON agent_instances(pane_id, started_at_ms);
CREATE INDEX ai_bead_id    ON agent_instances(bead_id);
CREATE INDEX ai_active     ON agent_instances(ended_at_ms) WHERE ended_at_ms IS NULL;

CREATE TABLE agent_state_transitions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id         TEXT,
    session_id          TEXT,
    pane_id             TEXT NOT NULL,
    state               TEXT NOT NULL,
    source_event        TEXT,
    bead_id             TEXT,
    task                TEXT,
    prompt_file         TEXT,
    parent_session_id   TEXT,
    created_at_ms       INTEGER NOT NULL,
    FOREIGN KEY (instance_id) REFERENCES agent_instances(instance_id)
);
CREATE INDEX ast_instance ON agent_state_transitions(instance_id, id);
CREATE INDEX ast_pane     ON agent_state_transitions(pane_id, id);
CREATE INDEX ast_session  ON agent_state_transitions(session_id, id);

CREATE TABLE agent_turns (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id         TEXT,
    session_id          TEXT NOT NULL,
    pane_id             TEXT NOT NULL,
    bead_id             TEXT,
    parent_session_id   TEXT,
    turn_index          INTEGER,
    summary             TEXT,
    completed_at_ms     INTEGER NOT NULL,
    parent_message_id   INTEGER,
    UNIQUE(instance_id, turn_index),
    FOREIGN KEY (instance_id)       REFERENCES agent_instances(instance_id),
    FOREIGN KEY (parent_message_id) REFERENCES messages(id) ON DELETE SET NULL
);
CREATE INDEX at_session ON agent_turns(session_id, id);
CREATE INDEX at_bead    ON agent_turns(bead_id, id);
```

Instance-open sources: `agent.role.launched`, Pi `session_start`, Claude `SessionStart`, first valid `agent.state` when no instance exists.
Terminal sources: `session_shutdown`, `state=off`, pane-disappearance reconciliation, explicit kill/stop.

Same-state debounce preserved from `XTMUX_PI_STATE_DEBOUNCE_MS`.
Operator-facing pane options (`@agent_state`, `@agent_bead`, `@agent_task`, `@agent_prompt_file`, `@agent_parent_session`, `@agent_last_transition`) retain their exact current meaning as best-effort UI projections.

Turn-completion + parent-message atomic sequence:

1. insert turn
2. insert parent message + receipt
3. link `agent_turns.parent_message_id`
4. commit
5. update tmux projections best-effort

### 4.6 `monitors` (PRD §11)

```sql
CREATE TABLE monitors (
    id                  TEXT PRIMARY KEY,
    owner_pid           INTEGER,
    target              TEXT NOT NULL,
    session_id          TEXT,
    pane_id             TEXT NOT NULL,
    instance_id         TEXT,
    state               TEXT NOT NULL,
    started_at_ms       INTEGER NOT NULL,
    updated_at_ms       INTEGER NOT NULL,
    heartbeat_at_ms     INTEGER,
    lease_expires_at_ms INTEGER,
    timeout_ms          INTEGER,
    interval_ms         INTEGER NOT NULL,
    terminal_status     TEXT,
    terminal_at_ms      INTEGER,
    terminal_detail     TEXT,
    FOREIGN KEY (instance_id) REFERENCES agent_instances(instance_id)
);
CREATE INDEX mon_active     ON monitors(state, updated_at_ms) WHERE terminal_status IS NULL;
CREATE INDEX mon_pane       ON monitors(pane_id);
CREATE INDEX mon_owner_pid  ON monitors(owner_pid);
CREATE INDEX mon_lease      ON monitors(lease_expires_at_ms) WHERE terminal_status IS NULL;
```

Terminal-status closed set: `done`, `timeout`, `killed`, `target_gone`, `process_gone`, `error`.

Heartbeat is an in-place update of `updated_at_ms` + `heartbeat_at_ms`. Never inserts a historical row per poll tick.

`wait-agent` and `monitor-agent` accept `--wait-for-transition` for reply monitoring: an initially terminal target must first become working, then return terminal before completion. Without the flag, both retain their immediate-terminal behavior. The send hooks use the flag so an idle recipient does not consume its monitor before handling the next message.

### 4.6a `outbound_waits`

```sql
CREATE TABLE outbound_waits (
    id                    TEXT PRIMARY KEY,
    requester_session_id  TEXT NOT NULL,
    requester_pane_id     TEXT NOT NULL,
    target_session_id     TEXT NOT NULL,
    target_pane_id        TEXT NOT NULL,
    related_message_id    INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    monitor_id            TEXT REFERENCES monitors(id) ON DELETE SET NULL,
    state                 TEXT NOT NULL CHECK (state IN
      ('unarmed','armed','terminal-unconsumed','consumed','cancelled','expired')),
    terminal_status       TEXT,
    terminal_at_ms        INTEGER,
    wake_delivered_at_ms  INTEGER,
    wake_consumed_at_ms   INTEGER,
    created_at_ms         INTEGER NOT NULL,
    updated_at_ms         INTEGER NOT NULL,
    expires_at_ms         INTEGER
);
CREATE UNIQUE INDEX ow_monitor_once ON outbound_waits(monitor_id)
  WHERE monitor_id IS NOT NULL;
CREATE INDEX ow_requester_pending
  ON outbound_waits(requester_session_id, requester_pane_id, state, updated_at_ms)
  WHERE state IN ('unarmed','armed','terminal-unconsumed');
CREATE INDEX ow_target_active
  ON outbound_waits(target_session_id, target_pane_id, state, updated_at_ms)
  WHERE state IN ('unarmed','armed');
CREATE INDEX ow_wake_delivery
  ON outbound_waits(requester_session_id, requester_pane_id, wake_delivered_at_ms, id)
  WHERE state = 'terminal-unconsumed' AND wake_consumed_at_ms IS NULL;
CREATE INDEX ow_retention ON outbound_waits(updated_at_ms, state);
```

A target never implies its requester. Registration, arm, terminalization,
delivery, replay, and consumption validate both requester columns. Terminal
unconsumed wakes are durable; consumption is one-time and idempotent.

### 4.7 `handoffs` (PRD §12)

```sql
CREATE TABLE handoffs (
    id                    TEXT PRIMARY KEY,
    handoff_key           TEXT UNIQUE,
    monitor_id            TEXT,
    source_instance_id    TEXT,
    source_session_id     TEXT,
    target_session_id     TEXT,
    target_pane_id        TEXT NOT NULL,
    bead_id               TEXT NOT NULL,
    parent_session_id     TEXT,
    prompt_file           TEXT NOT NULL,
    prompt_file_hash      TEXT,
    summary               TEXT,
    state                 TEXT NOT NULL,
    created_at_ms         INTEGER NOT NULL,
    sent_at_ms            INTEGER,
    accepted_at_ms        INTEGER,
    completed_at_ms       INTEGER,
    failure_code          TEXT,
    delivery_attempt_id   INTEGER,
    FOREIGN KEY (source_instance_id)  REFERENCES agent_instances(instance_id),
    FOREIGN KEY (delivery_attempt_id) REFERENCES delivery_attempts(id) ON DELETE SET NULL
);
CREATE INDEX ho_target  ON handoffs(target_session_id, id);
CREATE INDEX ho_bead    ON handoffs(bead_id);
CREATE INDEX ho_state   ON handoffs(state, created_at_ms);
```

State closed set: `created`, `sent`, `delivery_failed`, `accepted`, `completed`, `cancelled`.

Prompt-file body is NEVER stored — only path + hash + short summary. Readiness-aware
handoffs validate an existing local file before delivery. The handoff key is the
idempotency handle: duplicate creates reuse one row and, when requested, one linked
monitor. Monitor registration and handoff intent commit in one transaction. Pointer
injection appends `delivery_attempts`; `send-keys` success is not acceptance.

### 4.8 `command_runs` (PRD §13)

```sql
CREATE TABLE command_runs (
    id                  TEXT PRIMARY KEY,
    tool                TEXT NOT NULL,
    operation           TEXT NOT NULL,
    owner_pid           INTEGER,                        -- deviation from PRD §13, see below
    session_id          TEXT,
    pane_id             TEXT,
    instance_id         TEXT,
    bead_id             TEXT,
    cwd                 TEXT,
    repo                TEXT,
    argv                TEXT,
    branch_before       TEXT,
    head_before         TEXT,
    branch_after        TEXT,
    head_after          TEXT,
    started_at_ms       INTEGER NOT NULL,
    finished_at_ms      INTEGER,
    exit_code           INTEGER,
    terminal_status     TEXT,
    CHECK (tool IN ('git','bd','gh')),
    CHECK (terminal_status IS NULL OR terminal_status IN ('success','failed','interrupted')),
    FOREIGN KEY (instance_id) REFERENCES agent_instances(instance_id)
);
CREATE INDEX cr_tool_op    ON command_runs(tool, operation, started_at_ms);
CREATE INDEX cr_bead       ON command_runs(bead_id, started_at_ms);
CREATE INDEX cr_incomplete ON command_runs(started_at_ms) WHERE finished_at_ms IS NULL;
```

`terminal_status` closed set: `success`, `failed`, `interrupted`.

**Deviation from PRD §13 DDL** (approved during Phase 1/2 by xtmux:1.1, delta drafted by xtmux:1.2):
- `owner_pid INTEGER` added to make `terminal_status=interrupted` detection authoritative rather than a pure age-threshold guess. Same pattern as `monitors.owner_pid`. Reconciliation query: `finished_at_ms IS NULL AND owner_pid NOT IN (running pids)`.
- CHECK constraints promote the tool taxonomy and terminal-status enum to schema invariants rather than convention.

**Invocation identity boundary (V2).** The picker derives current session, pane,
and `@agent_bead` only when the invoking context has `$TMUX`. With `$TMUX`
unset, it omits unknown optional identity arguments so `command_runs.session_id`,
`pane_id`, and `bead_id` remain `NULL`; a stale `$TMUX` socket also produces
`NULL` rather than falling back to tmux's default server and a bystander pane.
V1 keeps its historical best-effort lookup for byte-identity compatibility. The
same guarded helpers cover inferred identity on V2 message send/ack, monitor
registration, audit-run ingestion, and safe-send delivery source. The agent-state
hook and Pi turn-done publisher also no-op without `$TMUX`; explicit target
resolution and pane/session enumeration are not current-context inference.

### 4.9 `audit_runs` + `audit_findings` (PRD §14)

```sql
CREATE TABLE audit_runs (
    id                  TEXT PRIMARY KEY,
    session_id          TEXT,
    started_at_ms       INTEGER NOT NULL,
    completed_at_ms     INTEGER,
    warning_count       INTEGER,
    cleanup_count       INTEGER
);

CREATE TABLE audit_findings (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id              TEXT NOT NULL,                  -- run that FIRST saw the finding
    last_run_id         TEXT NOT NULL,                  -- run that saw it MOST RECENTLY (deviation, see below)
    fingerprint         TEXT NOT NULL,
    severity            TEXT NOT NULL,
    kind                TEXT NOT NULL,
    session_id          TEXT,                           -- live-instance pointer ($N)
    session_name        TEXT,                           -- durable identity (deviation, see below)
    pane_id             TEXT,
    repo                TEXT,
    path                TEXT,
    detail_json         TEXT,
    first_seen_ms       INTEGER NOT NULL,
    last_seen_ms        INTEGER NOT NULL,
    resolved_at_ms      INTEGER,
    CHECK (severity IN ('warning','cleanup')),
    CHECK (kind IN ('missing-path','stale-specialist','dirty-worktree','shared-worktree',
                    'working-do-not-kill','naming-convention','agent-pane-without-bead')),
    FOREIGN KEY (run_id)      REFERENCES audit_runs(id),
    FOREIGN KEY (last_run_id) REFERENCES audit_runs(id)
);
CREATE UNIQUE INDEX af_fingerprint ON audit_findings(fingerprint);
CREATE INDEX af_unresolved ON audit_findings(kind, last_seen_ms) WHERE resolved_at_ms IS NULL;
```

Finding-kind closed set: `missing-path`, `stale-specialist`, `dirty-worktree`, `shared-worktree`, `working-do-not-kill`, `naming-convention`, `agent-pane-without-bead`.
Severity closed set: `warning`, `cleanup` (matches `audit_runs.warning_count` / `cleanup_count` bucket shape from PRD §14).

**Deviations from PRD §14 DDL** (approved during Phase 1/2 by xtmux:1.1, delta drafted by xtmux:1.2):
- `last_run_id` added: without it, `run_id` pins to the first-observing run, so resolution keyed on `run_id ≠ latest` matches nothing ever. Resolution query becomes `resolved_at_ms IS NULL AND last_run_id ≠ :run_id`, executed in the same transaction as the completed_at_ms write on the current run.
- `session_name` added: tmux `session_id` (`$N`) is per-instance — destroy + recreate a session and every finding re-fingerprints as new, silently breaking dedup. Fingerprints key on `session_name` (durable via naming convention); `session_id` stays as the live pointer.
- CHECK constraints promote severity and kind to schema invariants.
- `UNIQUE (fingerprint)` — the dedup rule *is* this constraint. A repeat observation UPDATEs `last_seen_ms` + `last_run_id`; it never inserts.

Fingerprint recipe per kind: **Phase 8 owner (xtmux-3xs.8) writes and commits this section.** Rule: fingerprint is deterministic from `(kind, session_id?, pane_id?, repo?, path?, salient-detail-fields)` — no timestamps in the fingerprint.

### 4.10 `migration_runs`

```sql
CREATE TABLE migration_runs (
    id                  TEXT PRIMARY KEY,
    started_at_ms       INTEGER NOT NULL,
    completed_at_ms     INTEGER,
    mode                TEXT NOT NULL,
    source_manifest     TEXT NOT NULL,
    counts_json         TEXT,
    orphan_acks         INTEGER,
    malformed_records   INTEGER,
    unsupported_types   INTEGER,
    duplicates_skipped  INTEGER
);
```

`mode` closed set: `dry-run`, `apply`.

### 4.11 `shadow_divergences`

Phase 9 staging table for shadow-mode comparisons; separate from `event_journal` to keep divergence reads cheap and to avoid polluting historical envelopes.

```sql
CREATE TABLE shadow_divergences (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    domain              TEXT NOT NULL,
    command             TEXT NOT NULL,
    diff_kind           TEXT NOT NULL,
    v1_snippet          TEXT,
    v2_snippet          TEXT,
    detail_json         TEXT,
    detected_at_ms      INTEGER NOT NULL
);
CREATE INDEX sd_domain ON shadow_divergences(domain, detected_at_ms);
```

---

## 5. Transaction and storage invariants (PRD §16)

1. SQLite is the durable operational source of truth when V2 is authoritative.
2. Every multi-table mutation uses an explicit transaction.
3. Message + receipt creation atomic.
4. Turn + parent-message correlation atomic.
5. Typed-table write + journal envelope atomic when both required.
6. Reads never mutate ack state.
7. Unacked messages never silently expired.
8. tmux projection failure does not fail the durable mutation.
9. Runtime-object state transitions validated (illegal transitions rejected).
10. Schema migrations versioned + idempotent.
11. Every command uses bounded database lock waits (`busy_timeout=3000`).
12. Busy failures return a distinct actionable structured error (`XTMUX_DB_BUSY`).
13. No shell or TS loop performs one DB process / query per result row.
14. Prepared statements reused within one invocation.
15. Foreign keys enabled.
16. Tests use isolated tmpdir databases.

---

## 6. Retention policy (PRD §17)

Envs (defaults set by Phase 10 based on benchmark results):

- `XTMUX_OBS_DB_MAX_BYTES`
- `XTMUX_OBS_MESSAGE_RETENTION_DAYS`
- `XTMUX_OBS_REPLY_RETENTION_DAYS`
- `XTMUX_OBS_WAIT_RETENTION_DAYS`
- `XTMUX_OBS_AGENT_STATE_RETENTION_DAYS`
- `XTMUX_OBS_TURN_RETENTION_DAYS`
- `XTMUX_OBS_TELEMETRY_RETENTION_DAYS`
- `XTMUX_OBS_AUDIT_RETENTION_DAYS`
- `XTMUX_OBS_DELIVERY_RETENTION_DAYS`

Preservation rules:

- Unacked messages and pending reply obligations are never deleted by ordinary retention.
- Fulfilled original/reply pairs are deleted together only after both are acknowledged and both message/reply windows pass; cancelled originals retain terminal state through the window.
- `unarmed`, `armed`, and `terminal-unconsumed` waits are preserved. Only old `consumed`, `cancelled`, and `expired` waits are pruned.
- Active agent instances (no `ended_at_ms`): preserved.
- Active monitors (no `terminal_status`): preserved.
- Incomplete handoffs (state not in terminal set): preserved.
- Incomplete command runs (no `finished_at_ms`): preserved.
- Unresolved audit findings (no `resolved_at_ms`): preserved.
- Agent-state history: may be compacted while preserving latest state per instance.

Cleanup runs transactionally per domain, independent. WAL checkpoint after cleanup allowed. `VACUUM` does NOT run on every threshold crossing — Phase 10 sets an explicit trigger threshold.

### 6.1 Scheduling (xtmux-3xs.16)

Retention is intentionally NOT auto-run on picker invocation (no in-process
scheduler — PRD §25 forbids mandatory daemons). Operators wire it externally.
The CLI exposes:

```bash
xtmux-obs retention   # prints a RetentionReport JSON; exits 0 on success
```

Two vetted patterns:

**systemd user timer** (`~/.config/systemd/user/xtmux-obs-retention.{service,timer}`):

```ini
# xtmux-obs-retention.service
[Unit]
Description=xtmux observability retention

[Service]
Type=oneshot
ExecStart=/home/%u/dev/xtmux/bin/xtmux-obs retention
Environment=XTMUX_OBS_MESSAGE_RETENTION_DAYS=30

# xtmux-obs-retention.timer
[Unit]
Description=Run xtmux observability retention daily

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

Enable: `systemctl --user enable --now xtmux-obs-retention.timer`.

**crontab** (`crontab -e`):

```cron
17 3 * * * XTMUX_OBS_MESSAGE_RETENTION_DAYS=30 /home/USER/dev/xtmux/bin/xtmux-obs retention >> ~/.local/state/xtmux/retention.log 2>&1
```

Retention env references (all defaults chosen in Phase 10; see
`src/db/retention.ts::DEFAULTS`):

- `XTMUX_OBS_MESSAGE_RETENTION_DAYS` (default 30)
- `XTMUX_OBS_REPLY_RETENTION_DAYS` (default 30)
- `XTMUX_OBS_WAIT_RETENTION_DAYS` (default 30)
- `XTMUX_OBS_AGENT_STATE_RETENTION_DAYS` (default 14)
- `XTMUX_OBS_TURN_RETENTION_DAYS` (default 60)
- `XTMUX_OBS_TELEMETRY_RETENTION_DAYS` (default 30)
- `XTMUX_OBS_AUDIT_RETENTION_DAYS` (default 90)
- `XTMUX_OBS_DELIVERY_RETENTION_DAYS` (default 7)
- `XTMUX_OBS_DB_MAX_BYTES` (default unset — no size cap)

---

## 7. Feature-flag modes (PRD §18)

| `XTMUX_OBS_V2` | V1 behavior | V2 behavior | Read auth |
|---|---|---|---|
| unset / `1` | not invoked | authoritative | V2 |
| `0` | authoritative legacy rollback | not invoked | V1 |
| `shadow` | authoritative | mirrored writes; divergences recorded to `shadow_divergences`; stdout unchanged | V1 |

Divergence comparators cover: recipient normalization, message ordering, message IDs, ack state, unread counts, monitor state, agent latest state, turn correlation, telemetry result, audit findings.

---

## 8. Legacy migration (PRD §19)

Command:

```bash
tmux-session-picker obs-migrate --dry-run
tmux-session-picker obs-migrate --apply
tmux-session-picker obs-migrate --status
```

Sources:

- `events.jsonl`
- `events.jsonl.1` … `events.jsonl.N`
- legacy monitor TSV directory (`/tmp/xtmux-monitor-*`)
- optional agent-state audit log

This importer does not read the former Pi/Claude coordination marker directories.
Messages and waits already persisted in SQLite remain authoritative; marker-only
age, target, or filename data cannot establish requester ownership or fulfilment.

Rules:

- All source files preserved (importer never deletes).
- Deterministic legacy `event_key = sha256(source_path + ':' + line_number + ':' + payload)` — enables safe rerun without duplicate imports.
- Idempotent: reapply → zero new rows.
- Malformed records: reported with `source_path:line`, never silently dropped.
- Unknown event types: preserved in `event_journal` with `type` intact.
- Orphan acks (message.ack without matching message.sent): reported, not linked.
- Ambiguous historical start/end correlation: preserve both records in journal + report unresolved rather than invent a link.

Report shape: `migration_runs` row + human summary covering PRD §19 minimum fields.

---

## 9. Compatibility and output contracts (PRD §20)

Golden fixtures captured under `tests/fixtures/golden/v1/` for every command in PRD §20. Rule: with `XTMUX_OBS_V2=0`, stdout + stderr + exit status byte-identical to pre-epic. With `XTMUX_OBS_V2=1`, backwards-compatible unless a documented V2-only field/mode is used.

Structured internal data must not leak into existing human-readable output.

Phase 1 captured fixtures (this session):

- `message-list --for nonexistent-session` (empty)
- `message-list --for nonexistent-session --unacked` (empty)
- `monitor-list` (empty)
- `log tail` (live traffic sample)
- `log query --type message.sent` (live traffic sample)
- `audit` (live noop-clean sample)

Remaining fixtures — captured across Phase 3–8 as each command becomes routable:
`message-send`, `message-ack`, `monitor-agent`, `monitor-kill`, `handoff`, `safe-send-pointer`, `telemetry`.

### Test-time hostile and differential contracts

`tests/contracts/hostile-env.test.ts` runs V2 commands under degraded invocation conditions: absent invocation metadata, panes without bead/state options, and a missing `tmux` binary. It asserts explicit `NULL`/`unknown` handling and no partial durable write on rejection. Add one matrix row for each new V2 route rather than relying on an in-tmux happy-path test.

`tests/contracts/differential-v1-v2.test.ts` runs V1 and V2 from the same isolated tmux state and compares stdout, stderr, and exit status after normalizing volatile timestamps. Message send/list/unacked/ack are covered now. Under `XTMUX_OBS_V2=1`, `audit --stable` sorts display rows by severity, kind, session name, and path; default audit output and persistence retain observed V1 order.

---

## 10. Performance target and benchmark plan (PRD §21)

Benchmarks measure **full-command latency**: runtime startup, database open, schema verification, query execution, formatting, process exit. Raw SQL alone is not measured.

Corpora (Phase 10 generates these):

- **A** — 100k messages / 100 recipients
- **B** — 100k total records: 5k messages + 95k other event types
- **C** — 1M total records: one hot recipient with 10k messages, 1k unacked
- **D** — concurrent workload: Pi state transitions + monitor heartbeat + message send/list/ack + telemetry finish + dashboard/audit reader

Measured commands: `message-list --for X`, `message-list --for X --unacked`, `message-send`, `message-ack`, `monitor-list`, latest agent state, recent completed turns, audit unresolved findings, `log query` by type, `log query` by bead, concurrent read/write behavior. Cold and warm cache. p50 / p95 / p99 / max.

Acceptance:

- `message-list --for X` p99 < 100 ms on corpus A
- Unrelated event volume does not materially change recipient-query latency
- No per-row process spawning
- Monitor / state / telemetry writes do not starve message routing
- Process startup does not invalidate the latency target
- Database-busy behavior is bounded
- No lost or duplicated mutation under tested concurrency

---

## 11. Deviations from PRD defaults

### 11.1 Benchmark result (Corpus A, 100k messages × 100 recipients)

Full-command latency including runtime startup + DB open + schema verification +
query + formatting + exit. `src/benchmarks/messages.ts`, 200 samples with 5
warmup iterations, run under XTMUX_OBS_V2=1 against the hot recipient.

Two runtimes measured back-to-back on the same machine:

| Percentile | `bun run src/cli.ts` (baseline) | `bin/xtmux-obs` (compiled) | Δ      |
| ---------: | ------------------------------: | -------------------------: | -----: |
| p50        | 72.9 ms                         | 59.6 ms                    | −18%   |
| p95        | 110.8 ms                        | 76.4 ms                    | −31%   |
| p99        | 134.2 ms                        | 93.0 ms                    | −31%   |
| max        | 135.9 ms                        | 97.2 ms                    | −29%   |

The query itself is under 5 ms (LEFT JOIN receipts, indexed by
`msg_recipient_id (recipient_id, id)`); the remaining floor is runtime
startup + module resolution + schema verification. `bun build --compile` (xtmux-3xs.11)
produces a single-file 101 MB binary that ships the Bun runtime inline; startup
drops by ~13 ms at p50 and ~40 ms at p99 versus `bun run`, moving p99 under
the PRD §21 100 ms target.

**Status vs PRD §21 target (`p99 < 100 ms on 100k-message corpus`): PASS**
under the compiled binary. Fallback path (`bun run src/cli.ts`, used when
`bin/xtmux-obs` is absent) remains FAIL on p99, PASS on p95 — the picker
prefers the binary automatically when present.

### 11.2 Cutover — done (xtmux-3xs.31)

`XTMUX_OBS_V2` **defaults to on**. Explicit `XTMUX_OBS_V2=0` opts out.
`shadow` retains its mirror-mode behavior for regression comparison.

Cutover gates, all met:

- Runtime p99 ≤ 100 ms (xtmux-3xs.11) ✅
- Shadow-mode wiring correct (xtmux-3xs.12 + fc3195e REPLY-clobber fix) ✅
- V1/V2 differential oracle green (xtmux-3xs.19) ✅
- Timestamp column byte-parity (xtmux-3xs.27) ✅
- Message correctness: 150 bun + 140 contract tests green
- Migration idempotent: verified via runMigration rerun test
- Retention preservation rules: all-green (unacked never deleted, active instances/monitors/incomplete-runs/unresolved-findings preserved, agent-state compacts to latest per instance)
- Rollback procedure documented (§13)
- No mandatory daemon or broker introduced

The "shadow-clean on production traffic sample" gate was retired: for a
single-user tool the sample IS the operator, and gating on a burn-in window
delivered nothing but delay.

---

## 12. Log / telemetry contract (planning-level)

Every durable mutation writes both its typed-table row(s) and one journal envelope in the same transaction. Envelope conventions:

- `domain` = one of `messages`, `deliveries`, `agents`, `monitors`, `handoffs`, `telemetry`, `audit`, `db`, `migration`
- `type` = `<domain>.<event>` (`messages.sent`, `monitors.state.started.done`, `db.open`, `db.busy`, `migration.apply.completed`, …)
- `correlation_id` links a chain (turn → parent-message, handoff → delivery attempt, command-run start → finish)
- `payload_json` is the smallest structured snapshot needed to reproduce the write for audit
- Never logs: secrets, credentials, prompt-file bodies, full stdout/stderr of wrapped commands, raw PII

Self-check surface: every domain phase's tests include a grep/query assertion against `event_journal` proving the envelope was written for each covered mutation.

---

## 13. Cutover and operator boundary

SQLite is default-on when `XTMUX_OBS_V2` is unset. `XTMUX_OBS_V2=0` is a
short-lived compatibility rollback for legacy command behavior; it does not
turn runtime marker directories into coordination state. Do not delete
`observability.db` to troubleshoot a reply or wake. Inspect the typed state:

```sh
xtmux-obs health
xtmux obligations list --pane "$TMUX_PANE" --json
xtmux message-list --for "$(tmux display-message -p '#{session_id}')" \
  --pane "$TMUX_PANE" --expects-reply --json
xtmux monitor-list --json
```

After package upgrade, reload Pi or start a fresh Pi process and start fresh
Claude sessions so they load the markerless hooks/extensions. Existing SQLite
rows need no conversion. `obs-migrate` remains the non-destructive JSONL/monitor
TSV importer; it never infers a requester or reply from old marker names.

The installer and runtime do not require `XDG_RUNTIME_DIR` for coordination and
do not clean arbitrary runtime paths. Former `xtmux-reply-obligations`,
`xtmux-outbound-expectations`, and `xtmux-auto-monitor` directories are ignored.
Normal OS runtime cleanup may remove them after old processes exit.

---

## 14. Shipped Phase 2 coordination

### 14.1 Reply state machine

1. `message-send` inserts message + receipt atomically. `--bead` implies
   `expects_reply=1` unless explicitly disabled.
2. Recipient `message-ack` updates only `message_receipts`. The obligation stays
   pending.
3. `message-reply --in-reply-to K` verifies the live original recipient session
   and pane, reverses endpoints, inserts one reply, and sets the original
   fulfilment columns in one immediate transaction.
4. Same-key retries are idempotent. Different second replies,
   cross-recipient/pane attempts, endpoint overrides, cancelled targets, and DB
   contention return structured errors with no partial write.
5. The sender may cancel only its own pending message. Reply and cancellation are
   terminal; first commit wins.
6. `safe-send-pointer --reply-to K` invokes the same reply path only after
   successful tmux injection. Dry-run or failed injection never fulfils.

`message-list --expects-reply --json` and `message-status --json` project
`pending`, `fulfilled`, or `cancelled` plus the correlated reply. `obligations
list` is a live sender-pane-owned query over `msg_pending_obligation`; no text,
bead, ack, target, ordering, or marker heuristic clears it.

### 14.2 Wait and wake state machine

`outbound_waits` transitions through `unarmed → armed → terminal-unconsumed →
consumed`, with terminal alternatives `cancelled` and `expired`. Each row owns
requester and target session/pane identities. `monitor_id` is unique when set.

`--wait-for-transition` observes a fresh work cycle before terminalization.
Claude's Stop gate accepts only a wait with matching requester/target identities
and `startedAtMs >= obligation.createdAtMs`; an older same-target wait cannot
cover a newer message. Terminal monitor reconciliation survives restart,
delivers one requester wake, and reports monitors without waits as orphans.
Delivery and `--consume` both require the owning requester session/pane.

### 14.3 Markerless Claude and Pi loops

Claude PostToolUse confirms the durable obligation. Stop blocks once with the
exact native Monitor command when a fresh wait is missing. PostToolUse consumes
a completed wake idempotently. Invalid target metadata blocks for manual
inspection; database failure emits a bounded diagnostic and the Stop loop guard
allows the next Stop while the operator repairs the backend.

Pi derives actions only from complete single JSON command envelopes. The
outgoing-obligation SQL query defaults to 200 rows and the inbox explicitly
passes `--limit 500`. `monitor-list --json` has no CLI limit: it selects full
monitor history, and Pi fails closed after parsing when that array exceeds 500
rows. A successful cycle performs at most 20 ack or wake-consume mutations,
exposes at most 20 validated reply keys, caps the widget at 22 rows / 2000
characters and prompt additions at 1600 characters, and queues one idle
continuation. Budget-deferred work stays in SQLite for later cycles or restart;
over-limit monitor history instead surfaces coordination wake degradation for
manual inspection. Unsafe identifiers are hidden and message summaries are
never promoted into instructions.

### 14.4 Journal evidence

Typed rows are authoritative. The journal records bounded lifecycle evidence,
without message bodies or prompt contents:

- messages: `messages.sent`, `messages.ack`, `messages.reply.linked`,
  `messages.reply.rejected`, `messages.cancelled`,
  `messages.obligation.pruned`;
- waits: `wait.registered`, `wait.monitor.armed`, `wait.terminal`,
  `wait.wake.delivered`, `wait.wake.consumed`, `wait.wake.orphan`,
  `wait.validation_failed`, `wait.cancelled`, `wait.expired`, `wait.pruned`;
- monitor lifecycle remains in the existing `monitor.*`/`monitors.*` events.

### 14.5 Retention and restart

`XTMUX_OBS_REPLY_RETENTION_DAYS` and `XTMUX_OBS_WAIT_RETENTION_DAYS` default to
30. Pending obligations, unacknowledged originals/replies, active waits, and
terminal unconsumed wakes are exempt. Eligible original/reply pairs delete
together; only old consumed/cancelled/expired waits prune. Committed reply,
terminal, delivery, and consumption state is reconstructed directly from SQLite
after process restart; no synthetic marker or TTL participates.
