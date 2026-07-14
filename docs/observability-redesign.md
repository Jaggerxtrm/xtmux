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
- No mandatory daemon or broker. Each invocation opens the DB, verifies schema, runs a bounded op, closes.

Database path: `${XDG_STATE_HOME:-$HOME/.local/state}/xtmux/observability.db`.

---

## 2. Channels audit — inherited and excluded

_Source: `~/dev/xtrm/docs/channels/` (canonical, upgrade, forensic-attention proposal), plus the specialists runtime implementation backed by `observability.db`._

### Inherited invariants (borrowed vocabulary + structural rules)

Sources: `channels.md` §5.1–5.5, §5.7, §10.5, §11; `channels-upgrade.md` §5, §8, §10, §18; `channels-forensic-attention-proposal.md` §A1–A4. Materialization reference: `~/dev/specialists/src/specialist/observability-sqlite.ts` L212–294 (`specialist_forensic_events`, WAL pragmas, cursor tables).

| # | Invariant | Why | xtmux analog |
|---|---|---|---|
| A1 | **One SQLite writer per DB, WAL mode.** | Removes race between concurrent writers that today only avoids collisions by tmux-single-process luck. | `tmux-session-picker` is the only writer of `events.jsonl` today → becomes only writer of `observability.db`. |
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
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    message_key        TEXT NOT NULL UNIQUE,
    sender_id          TEXT NOT NULL,
    sender_pane_id     TEXT,                            -- fine-grained addressing (see below)
    recipient_id       TEXT NOT NULL,
    target_pane_id     TEXT,                            -- fine-grained addressing (see below)
    bead_id            TEXT,
    summary            TEXT NOT NULL,
    payload_json       TEXT,
    created_at_ms      INTEGER NOT NULL
);
CREATE INDEX msg_recipient_id ON messages(recipient_id, id);
CREATE INDEX msg_target_pane  ON messages(target_pane_id, id);
CREATE INDEX msg_bead_id      ON messages(bead_id, id);

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
- `message-list` is a pure read; `message-ack` is the sole ack mutation; ack is idempotent.
- V2-only machine queries avoid formatted-message scans: `message-status <message_key>` returns sender, recipient, bead, summary, `expectsReply`, and durable ack state; `unread-count --for <recipient> [--pane %N]` returns recipient/pane-scoped count plus oldest unacked timestamp. `message-list --unacked --expects-reply --json` is the bounded structured inbox used by Pi reply obligations.
- `message-send --expects-reply[=true|false]` stores sender intent. V2 defaults it to true when `--bead` is present; explicit false is the FYI opt-out. Pi converts discovered expected/unacked rows into durable local obligations before acknowledging receipt, so ack never fulfills the reply obligation and restart scans do not recreate fulfilled work.
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

### 4.7 `handoffs` (PRD §12)

```sql
CREATE TABLE handoffs (
    id                    TEXT PRIMARY KEY,
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

Prompt-file body is NEVER stored — only path + hash + short summary.

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
- `XTMUX_OBS_AGENT_STATE_RETENTION_DAYS`
- `XTMUX_OBS_TURN_RETENTION_DAYS`
- `XTMUX_OBS_TELEMETRY_RETENTION_DAYS`
- `XTMUX_OBS_AUDIT_RETENTION_DAYS`
- `XTMUX_OBS_DELIVERY_RETENTION_DAYS`

Preservation rules:

- Unacked messages: never deleted by ordinary retention. Any explicit-terminal expiration path (future) requires its own auditable proposal.
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
| unset / `0` | authoritative | not invoked | V1 |
| `shadow` | authoritative | mirrored writes; divergences recorded to `shadow_divergences`; stdout unchanged | V1 |
| `1` | not invoked (or explicit temporary mirror w/ documented retirement condition) | authoritative | V2 |

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

## 13. Cutover + rollback (Phase 10)

**Current status: DONE (xtmux-3xs.31).** `obs_v2_mode()` in
`bin/tmux-session-picker` and `parseMode` in `src/config.ts` both default to
`on` when `XTMUX_OBS_V2` is unset. Explicit `XTMUX_OBS_V2=0` opts back to V1.
The "production traffic sample" gate was retired: single-user tool, sample is
the operator.

Shadow-mode surface (xtmux-3xs.12):

- Writes (`message-send`, `message-ack`, `log-emit`) shadow-tee into SQLite via
  `obs_call` after V1 writes JSONL. Best-effort; failures are silent.
- Reads (`message-list`, `monitor-list`) capture V1 output, invoke V2, byte-diff,
  and record any divergence via `obs_call shadow-record` → `shadow_divergences`.
- `xtmux-obs shadow-summary` rolls up divergence counts per (domain, command).
- Deferred to a follow-up: `log-query` shadow-read (V1 body needs the same
  extract-to-helper refactor pattern used for message-list), and `audit` shadow
  content-diff (the walk isn't a stable input across two invocations, so live
  V1-vs-V2 comparison produces noise — `--stable` orders it, but a fixture-driven
  harness would be needed to compare content meaningfully).

Cutover done (xtmux-3xs.31). All gates met: message correctness ✅,
concurrency ✅, migration idempotent ✅, shadow-mode wiring correct ✅,
benchmark targets pass ✅ (p99=93 ms via compiled binary, §11.1),
rollback procedure documented ✅ (below), timestamp column byte-parity ✅
(xtmux-3xs.27), V1/V2 differential oracle ✅ (xtmux-3xs.19).

Rollback procedure (from XTMUX_OBS_V2=1 default):

1. Revert the picker default flip (single-line change on `obs_v2_mode`).
2. `unset XTMUX_OBS_V2` in operator shell profiles.
3. Optional: `rm ${XDG_STATE_HOME:-$HOME/.local/state}/xtmux/observability.db*`
   to start fresh on next V2 attempt. Legacy `events.jsonl` files are
   untouched by any V2 code path so V1 keeps working with existing state.

Data preserved through rollback:

- `events.jsonl` and rotated files never modified by V2 (importer reads only)
- Legacy monitor TSV directory never modified by V2
- tmux options (`@agent_state`, `@agent_unread_count`, ...) reflect the
  currently authoritative source without needing manual reset

Retention envs (all currently unset → defaults apply per `src/db/retention.ts`
loadRetentionConfig()):

- `XTMUX_OBS_MESSAGE_RETENTION_DAYS` (default 30, unacked exempt)
- `XTMUX_OBS_AGENT_STATE_RETENTION_DAYS` (default 14, compaction preserves latest per instance)
- `XTMUX_OBS_TURN_RETENTION_DAYS` (default 60)
- `XTMUX_OBS_TELEMETRY_RETENTION_DAYS` (default 30, incomplete runs preserved)
- `XTMUX_OBS_AUDIT_RETENTION_DAYS` (default 90, unresolved findings preserved)
- `XTMUX_OBS_DELIVERY_RETENTION_DAYS` (default 7)
- `XTMUX_OBS_DB_MAX_BYTES` (default null — no automatic prune of event_journal)

---

## 14. Open questions escalated

<!-- To fill during Phase 1 close. -->

None yet.

---

## 15. Current V1 codepath scope map (Phase 1 audit)

_Extracted from `bin/tmux-session-picker` (2656 lines, bash) and `extensions/pi-agent-state.ts` (185 lines, TS). Feeds the SCOPE of Phases 3–8._

Event log path: `${XDG_STATE_HOME:-$HOME/.local/state}/xtmux/events.jsonl`, defined at `event_log_file` L575; rotation L642; universal writer `log_event` L659; universal escape `json_escape` L584.

| Command | Function(s) | Line range | Writes (files + tmux options) | Events emitted |
|---|---|---|---|---|
| `message-send` | `message_send`; dispatch | 740–803; 2444 | `events.jsonl`; `@agent_unread_count` (incr) + `@agent_unread_since` (epoch) on target session | `message.failed` (L771 resolve fail), `message.sent` (L789) |
| `message-list` (+ `--unacked`) | `message_list` | 839–921 | tmp ack index file (deleted) | — |
| `message-ack` | `message_ack`; dispatch | 804–833; 2454 | `events.jsonl`; `@agent_unread_count` decrement, `@agent_unread_since` unset on zero | `message.ack` (L818) |
| `safe-send-pointer` | `safe_send_pointer`; dispatch | 1958–2100; 2409 | `tmux send-keys` to target; `events.jsonl` | `message.sent` (L2016) **← conflates durable + delivery, PRD §7 fix** |
| `monitor-agent` (+ `monitor_run`) | `monitor_agent`, `monitor_run`; dispatch | 1772–1822; 2389 | `${TMPDIR}/tmux-picker-state-<uid>/monitors/<id>.tsv` (per-tick rewrite); `events.jsonl` | `monitor.started` (L1819), `monitor.done` (L1782), `monitor.timeout` (L1788) |
| `monitor-list` | `monitor_list`; dispatch | 1823–1842; 2399 | — | — |
| `monitor-kill` | `monitor_kill`; dispatch | 1843–1854; 2404 | kill pid; remove `<id>.tsv`; `events.jsonl` | `monitor.killed` (L1851) |
| `handoff --target …` | `handoff`; dispatch | 1861…; 2429 | prompt file `${TMPDIR:-/tmp}/xtmux-handoff-<safe>.txt`; `@agent_bead`, `@agent_prompt_file`, `@agent_parent_session`, `@agent_task` on target pane; `tmux send-keys` on confirm; `events.jsonl` | `handoff.created` (L1913), `handoff.sent` (L1923) |
| `telemetry <git\|bd\|gh>` | `telemetry_run`; dispatch | 922–1107; 2459 | tool-specific side effects; `events.jsonl`; **on completion writes `@agent_state @agent_bead @agent_task @agent_parent_session` on running pane (L1081)** — preserve or explicitly retire in Phase 7 | `telemetry.command.started` (git L943, bd L964, gh L981) + per-subcommand variants (`telemetry.git.*`, `telemetry.bd.*`, `telemetry.gh.*`) |
| `audit` | `audit`; dispatch | 1154–~1300; 2424 | prints TSV | `audit.run` (L1156) |
| `log emit\|tail\|query` | `log_cli`, `log_cli_emit`, `log_cli_tail`, `log_cli_query`; dispatch | 680–730; 2439 | `events.jsonl` | passthrough (whatever type the caller supplies) |

### `extensions/pi-agent-state.ts` publish path

- **The extension does not directly write `@agent_state` or `agent.state`.** It calls `XTMUX_AGENT_STATE_SCRIPT` (default `~/.tmux/scripts/agent-state.sh`) via `setState(state)` at L86–99. That external script writes tmux pane opts `@agent_state` + `@agent_last_transition` (agent-state.sh L110–111), reflects `XTMUX_AGENT_{BEAD,TASK,PROMPT_FILE,PARENT_SESSION}` env onto matching `@agent_*` pane opts (L94–97), and emits the `agent.state` JSONL record (L55–69). Debounced by `XTMUX_PI_STATE_DEBOUNCE_MS` (5s default).
- **Pi lifecycle → state mapping** (extension listens; does not emit these names):
  - `session_start` → `setState("idle")` (L151)
  - `before_agent_start` / `agent_start` / `tool_execution_start` / `turn_start` → `setState("running")`
  - `agent_end` → `setState("done")` then `publishTurnDone(event)` (L177)
  - `session_shutdown` → `setState(reason === "quit" ? "off" : "idle")` (L182)
- **`publishTurnDone` L109–149** reads `#{pane_id}` / `#{session_id}` / `#S` / `@agent_bead` / `@agent_parent_session`, then:
  1. spawns `picker log emit agent.turn.done …` (writes `events.jsonl` via `log_event`)
  2. if `parent && text`: spawns `picker message-send --from <sid|pane> --to <parent> --bead <bead> --text "turn done: <text>"` → `message.sent` + `@agent_unread_*` bump on parent session

### `agent.role.launched`

Not emitted by the picker or the pi extension. External launcher owns it (PRD §8 notes "launcher already emits agent metadata"). Phase 5 must locate the launcher (`XTMUX_AGENT_*` env producer) and wire instance-open there.

### Current event-type inventory (from these files)

`message.sent`, `message.failed`, `message.ack`, `monitor.started`, `monitor.done`, `monitor.timeout`, `monitor.killed`, `handoff.created`, `handoff.sent`, `telemetry.command.started` (+ per-subcommand `telemetry.git.*` / `telemetry.bd.*` / `telemetry.gh.*` variants), `audit.run`, `agent.state` (from agent-state.sh), `agent.turn.done` (from pi extension via `log_cli_emit`), plus any caller-defined type through `log emit`.

### Scope callouts feeding downstream phases

- **Phase 3**: `safe_send_pointer` currently emits `message.sent` — this is the conflation PRD §7 requires splitting into `delivery.attempted (kind=pane_pointer)` + optional durable message.
- **Phase 3**: `message_list` grep-of-rotated-files ack index is the current O(N) hotspot. Move to `message_receipts` LEFT JOIN.
- **Phase 4**: `monitor_run` per-tick rewrite of `<id>.tsv` becomes an in-place update of `monitors.updated_at_ms` + `heartbeat_at_ms`. Zero `/tmp` writes on V2.
- **Phase 5**: Scope must include **`~/.tmux/scripts/agent-state.sh`** (not just the pi extension). It is the real writer of both the pane options and `agent.state` events. The Bun runtime must be reachable from that script under V2 (either shell → picker delegation or a direct `bun` invocation with a stable interface).
- **Phase 5**: locate the external `agent.role.launched` emitter and wire it to `agent_instances` open.
- **Phase 6**: handoff pointer flow ends in `safe_send_pointer` which today emits `message.sent`. Phase 6 depends on Phase 3 in part because handoff's delivery layer must land as `delivery.attempted (kind=handoff_pointer)` alongside its `handoffs` row.
- **Phase 7**: `telemetry_run` currently writes agent pane options on completion (L1081). Decide during Phase 7 whether this cross-domain projection stays (backwards-compat) or moves to Phase 5's agent-state ownership.
- **Phase 8**: `audit` prints TSV to stdout only; Phase 8 persists rows and keeps stdout format byte-identical when V2 disabled.

---

## 16. Golden fixture harness

Base directory: `tests/fixtures/golden/v1/`. Each command produces three files:

- `<label>.stdout`
- `<label>.stderr`
- `<label>.exit`

Normalization: shared `tests/fixtures/golden/v1/normalize.sed` filters volatile tokens (timestamps, PIDs, hashes, tmp paths, pane / session ids, epoch seconds, 40-hex SHAs) before diff. Comparators run `sed -f normalize.sed` on both sides before comparing.

Phase 1/2 captured (this session, in worktree `xtmux-xt-claude-hnjk`):

- **Isolated (byte-identity oracle):** `message-list-empty`, `message-list-unacked-empty`, `monitor-list-empty`, `log-tail-empty`, `log-query-empty` — reproducible via `scripts/capture-v1-fixtures.sh` inside a scratch `XDG_STATE_HOME` + `TMPDIR` so no /tmp monitor rows or ambient events pollute the capture. Drift check: `scripts/capture-v1-fixtures.sh --check`.
- **Live (documentary):** `log-tail-live`, `log-query-live`, `audit-live` — snapshots of a real dev-machine state; NOT a byte-identity oracle. Serve as reference for downstream phase authors.

Phase 1 captured (concurrent, in worktree `xtmux-xt-claude-ojsx`): `normalize.sed` + monitor/telemetry/audit-focused fixtures — merged at Phase 1 close.

Remaining fixtures (owner phase in parens): `message-send` (3), `message-ack` (3), `monitor-agent` (4), `monitor-kill` (4), `handoff` (6), `safe-send-pointer` (3/6), `telemetry` (7).

---

## 17. Reply-obligation and outbound-wake state machines (xtmux-3ua)

**Decision.** SQLite is sole source of truth for reply obligations, correlated
replies, outbound waits, monitor linkage, terminal wakes, and wake consumption.
The three runtime marker directories are compatibility inputs only during one
bounded migration. No steady-state writer, reader, deleter, hook, extension, or
CLI path reads a marker directory. A restart derives all pending state by SQL;
Pi and Claude reloads do not recreate fulfilled work from process memory.

**Identity rule.** Reply authority uses stable session identity (`session_id`)
plus optional pane identity (`pane_id`). A monitor target alone never identifies
its requester. `message-ack` remains receipt-only. Only an explicit reply carrying
`reply_to_message_key` can fulfil an obligation; target, bead, text, send order,
or safe-send-pointer output never clears one.

### 17.1 Phase-1 audit: current marker ownership

This table records current behavior, not target behavior. Every current-state
claim in this subsection has a file:line citation.

| Directory | Writer path | Reader path | Deleter path | TTL / override | Duplicate write meaning | Stale file meaning |
|---|---|---|---|---|---|---|
| `xtmux-reply-obligations` | Pi creates directory and atomically writes `reply-to-<sender>[-for-<pane>]_pending` from `recordObligation`; inbound discovery calls it after `message-list`, and ack result handling calls it again. [`extensions/pi-inbox-reply.ts:140-154`, `extensions/pi-inbox-reply.ts:204-224`] | `readObligations` scans matching names, `listObligations` projects them, render/widget and `before_agent_start` consume them. [`extensions/pi-inbox-reply.ts:106-138`, `extensions/pi-inbox-reply.ts:250-320`] | `clearObligation` removes sender/pane path after any parsed message-send or safe-send-pointer result; reads also remove expired, invalid, or malformed files. [`extensions/pi-inbox-reply.ts:118-123`, `extensions/pi-inbox-reply.ts:326-335`] | `XTMUX_REPLY_OBLIGATION_TTL_MS`, default 3,600,000 ms; expiry uses marker mtime. [`extensions/pi-inbox-reply.ts:47-58`, `extensions/pi-inbox-reply.ts:110-116`] | Same sender/pane path is replaced by atomic temp-write/rename; it refreshes a snapshot and does not prove a second inbound message or fulfilment. [`extensions/pi-inbox-reply.ts:140-154`] | File older than TTL is deleted and obligation disappears even when SQLite message remains expected and unfulfilled. [`extensions/pi-inbox-reply.ts:110-123`] |
| `xtmux-outbound-expectations` | Pi writes JSON `{target, monitorId, paneId, createdAtMs}` after auto-monitor arm, using an atomic temp-write/rename. [`extensions/pi-inbox-reply.ts:74-82`, `extensions/pi-auto-monitor.ts:98-100`] | Pi reads names for its own pane, then compares stored monitor IDs with `monitor-list --json` to find a monitor no longer active. [`extensions/pi-inbox-reply.ts:84-103`, `extensions/pi-inbox-reply.ts:232-245`] | Reader removes malformed, invalid, or over-8-hour files; completed files are removed after monitor-list comparison. [`extensions/pi-inbox-reply.ts:84-103`, `extensions/pi-inbox-reply.ts:245-247`] | Hard-coded 28,800,000 ms (8 h); no environment override in reader. Auto-monitor timeout/interval defaults are separate `8h`/`60s` settings. [`extensions/pi-inbox-reply.ts:84-95`, `extensions/pi-auto-monitor.ts:17-22`, `extensions/pi-auto-monitor.ts:28-31`] | Same target/pane filename is replaced, so duplicate arm records latest monitor ID; it is not an idempotent database transition and can overwrite a prior wait. [`extensions/pi-inbox-reply.ts:74-82`] | Expired, corrupt, or no-longer-listed monitor file is removed; a live SQLite monitor may therefore lose requester wake context. [`extensions/pi-inbox-reply.ts:84-103`, `extensions/pi-inbox-reply.ts:232-247`] |
| `xtmux-auto-monitor` | Claude PostToolUse hook touches `<sanitized-target>_pending` after successful send/pointer recognition; it may touch even when another monitor is active. [`.xtrm/hooks/auto-monitor-on-send.mjs:20-50`, `.xtrm/hooks/auto-monitor-on-send.mjs:152-167`] | Claude Stop drain hook scans every `_pending` file; Pi does not read this directory. [`.xtrm/hooks/auto-monitor-drain-stop.mjs:18-55`, `.xtrm/hooks/auto-monitor-drain-stop.mjs:81-98`] | Claude PostToolUse consumed hook removes target marker after a wait-agent command; drain-stop prunes old markers; its reason also tells users to `rm -f` manually. [`.xtrm/hooks/auto-monitor-consumed.mjs:10-12`, `.xtrm/hooks/auto-monitor-consumed.mjs:36-45`, `.xtrm/hooks/auto-monitor-drain-stop.mjs:41-51`, `.xtrm/hooks/auto-monitor-drain-stop.mjs:73-76`] | `XTMUX_AUTO_MONITOR_TTL_MS`, default 3,600,000 ms; `XTMUX_AUTO_MONITOR_DRAIN_DISABLE=1` bypasses gate and `XTMUX_AUTO_MONITOR_DISABLE=1` bypasses sender hook. [`.xtrm/hooks/auto-monitor-drain-stop.mjs:16-21`, `.xtrm/hooks/auto-monitor-drain-stop.mjs:81-83`, `.xtrm/hooks/auto-monitor-on-send.mjs:23-26`, `.xtrm/hooks/auto-monitor-on-send.mjs:142-143`] | Touching same target updates mtime; it means another send observed, not a distinct requester/target wait. An existing monitor does not suppress touch. [`.xtrm/hooks/auto-monitor-on-send.mjs:124-132`, `.xtrm/hooks/auto-monitor-on-send.mjs:160-165`] | Old marker is pruned before Stop, so a forgotten monitor-arm gate silently stops blocking after TTL; foreign target identity cannot be distinguished from same-name target. [`.xtrm/hooks/auto-monitor-drain-stop.mjs:31-55`] |

The repository's `.claude/settings.json` currently registers SessionStart,
PreToolUse, PostToolUse, and Stop hooks but no `xtmux-auto-monitor` triple;
those hook files therefore require explicit packaging/registration during the
cutover. [`.claude/settings.json:1-164`]

The current SQLite runtime already has durable messages, receipts, and monitor
rows. `messages` stores sender/recipient/pane hints and `expects_reply`, while
receipts store read/ack state; receipts are not a fulfilment relation.
[`src/db/migrations/0002_messages.ts:14-39`, `src/db/migrations/0009_message_reply_expectation.ts:7-12`]
`sendMessage` inserts message and receipt atomically, deduplicates by
`message_key`, and journals `messages.sent`; it has no reply link.
[`src/domains/messages/send.ts:21-28`, `src/domains/messages/send.ts:62-101`]
`ackMessage` validates recipient and updates only receipt columns, with
idempotent `already-acked`; it has no fulfilment side effect.
[`src/domains/messages/ack.ts:21-25`, `src/domains/messages/ack.ts:52-80`]
The CLI defaults `expectsReply` to true when `--bead` is present, and the picker
passes that option through. [`src/cli-messages.ts:107-132`, `bin/tmux-session-picker:961-1032`]
Current list JSON projects message and receipt fields only, while current
monitor rows contain target/session/pane and terminal status but no requester or
wake-consumption columns. [`src/cli-messages.ts:160-192`, `src/domains/monitors/store.ts:328-355`, `src/db/migrations/0003_domains_4_7_8.ts:18-43`]

### 17.2 Relational design and SQL migration sketch

Migration 0010, `reply_links_and_outbound_waits`, extends `messages` and adds
one table where existing rows cannot express requester-owned waits. Existing
migration registration is ordered and checksummed by `schema.ts`; this sketch
belongs after 0009 and must be registered there, not run by this ADR.
[`src/db/schema.ts:43-60`, `src/db/schema.ts:90-115`]

#### Reply obligation: extend `messages`

A separate obligation table is unnecessary: an obligation is a projection of one
message with `expects_reply=1`, no cancellation, and no correlated reply. The
message row is already its durable key and retention unit. A self-FK reply link
and fulfilment columns preserve the relation without duplicating identity.

```sql
ALTER TABLE messages ADD COLUMN reply_to_message_id INTEGER
  REFERENCES messages(id) ON DELETE RESTRICT;
ALTER TABLE messages ADD COLUMN fulfilled_by_message_id INTEGER
  REFERENCES messages(id) ON DELETE RESTRICT;
ALTER TABLE messages ADD COLUMN fulfilled_at_ms INTEGER;
ALTER TABLE messages ADD COLUMN cancelled_at_ms INTEGER;
ALTER TABLE messages ADD COLUMN cancel_reason TEXT;

ALTER TABLE messages ADD CONSTRAINT messages_reply_shape CHECK (
  reply_to_message_id IS NULL OR reply_to_message_id <> id
);
ALTER TABLE messages ADD CONSTRAINT messages_fulfilment_shape CHECK (
  (fulfilled_by_message_id IS NULL AND fulfilled_at_ms IS NULL)
  OR (fulfilled_by_message_id IS NOT NULL AND fulfilled_at_ms IS NOT NULL)
);
ALTER TABLE messages ADD CONSTRAINT messages_terminal_obligation CHECK (
  cancelled_at_ms IS NULL OR fulfilled_at_ms IS NULL
);

CREATE UNIQUE INDEX msg_one_reply_per_request
  ON messages(reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;
CREATE INDEX msg_pending_obligation
  ON messages(sender_id, sender_pane_id, created_at_ms, id)
  WHERE expects_reply = 1
    AND fulfilled_at_ms IS NULL
    AND cancelled_at_ms IS NULL;
CREATE INDEX msg_reply_target
  ON messages(reply_to_message_id, sender_id, sender_pane_id, id);
CREATE INDEX msg_fulfilled_retention
  ON messages(fulfilled_at_ms, cancelled_at_ms, id)
  WHERE expects_reply = 1;
```

The implementation must use a migration-safe table rebuild if deployed SQLite
cannot add named table constraints with `ALTER TABLE`; this is a sketch, not a
claim that shown statements are exact migration syntax. Existing unique
`message_key` remains send idempotency key.

#### Outbound wait: add `outbound_waits`

A new table is necessary. `monitors` describes target lifecycle and is shared by
callers; it has no requester, originating wait, or one-time wake receipt. Adding
requester columns directly to `monitors` would allow multiple waits to claim one
monitor and would lose wait history when duplicate arms race.

```sql
CREATE TABLE outbound_waits (
    id                    TEXT PRIMARY KEY,
    requester_session_id  TEXT NOT NULL,
    requester_pane_id     TEXT NOT NULL,
    target_session_id     TEXT NOT NULL,
    target_pane_id        TEXT NOT NULL,
    related_message_id    INTEGER,
    monitor_id            TEXT,
    state                 TEXT NOT NULL,
    terminal_status       TEXT,
    terminal_at_ms        INTEGER,
    wake_delivered_at_ms  INTEGER,
    wake_consumed_at_ms   INTEGER,
    created_at_ms         INTEGER NOT NULL,
    updated_at_ms         INTEGER NOT NULL,
    expires_at_ms         INTEGER,
    CHECK (state IN ('registered','armed','terminal','consumed','cancelled','expired')),
    CHECK (terminal_status IS NULL OR terminal_status IN
           ('done','timeout','killed','target_gone','process_gone','error')),
    CHECK ((state IN ('terminal','consumed') AND terminal_status IS NOT NULL)
           OR state NOT IN ('terminal','consumed')),
    CHECK (wake_consumed_at_ms IS NULL OR wake_delivered_at_ms IS NOT NULL),
    FOREIGN KEY (related_message_id) REFERENCES messages(id) ON DELETE SET NULL,
    FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX ow_monitor_once ON outbound_waits(monitor_id)
  WHERE monitor_id IS NOT NULL;
CREATE INDEX ow_requester_pending
  ON outbound_waits(requester_session_id, requester_pane_id, state, updated_at_ms)
  WHERE state IN ('registered','armed','terminal');
CREATE INDEX ow_target_active
  ON outbound_waits(target_session_id, target_pane_id, state, updated_at_ms)
  WHERE state IN ('registered','armed');
CREATE INDEX ow_wake_delivery
  ON outbound_waits(requester_session_id, requester_pane_id, wake_delivered_at_ms, id)
  WHERE state = 'terminal' AND wake_consumed_at_ms IS NULL;
CREATE INDEX ow_retention ON outbound_waits(updated_at_ms, state);
```

Every requester query includes both requester columns:

```sql
SELECT id, target_session_id, target_pane_id, monitor_id, state,
       terminal_status, terminal_at_ms, wake_delivered_at_ms,
       wake_consumed_at_ms, created_at_ms, updated_at_ms
  FROM outbound_waits
 WHERE requester_session_id = :session_id
   AND requester_pane_id = :pane_id
   AND state IN ('registered','armed','terminal')
 ORDER BY created_at_ms, id;
```

Registration, arm, terminal transition, wake delivery, and consumption each run
in an immediate transaction and emit one journal envelope. Arm uses
`UPDATE ... WHERE state='registered' AND monitor_id IS NULL`; zero rows means
`duplicate-arm`, not a second monitor. Terminal monitor reconciliation joins
`outbound_waits.monitor_id = monitors.id`; it never scans a marker directory.
A monitor with no wait is retained as an orphan monitor and cannot deliver a
wake. Wake delivery is idempotent by wait ID; consumption is
`UPDATE ... WHERE state='terminal' AND wake_consumed_at_ms IS NULL`, so exactly
one caller receives `consumed:true`.

### 17.3 Reply-obligation state machine

States are derived, not copied: `pending` means expected, neither cancelled nor
fulfilled; `fulfilled` means both fulfilment columns are set; `cancelled` means
`cancelled_at_ms` is set. A reply row is a normal message with
`reply_to_message_id`; explicit reply validates original row, reversed session
and pane identities, and one-reply uniqueness before inserting. No text or bead
matching is permitted.

| Transition case | Guard and input | SQLite transition | Concrete API result | Journal outcome |
|---|---|---|---|---|
| Send with implicit expectation | `message-send` has `--bead`, no explicit false, valid identities | Insert `expects_reply=1` message and receipt; fulfilment NULL | `duplicate:false`, `expectsReply:true`, key/id returned | `messages.sent` with IDs, panes, intent; no body |
| Send without expectation | Explicit false or no bead and no true flag | Insert `expects_reply=0`; no pending projection | JSON returns `expectsReply:false`; reply-to rejected | `messages.sent` with false intent |
| Ack before reply | Recipient calls unchanged `message-ack` | Update only receipt ack columns; obligation stays pending | `status:acked`; obligation still listed | `messages.ack`; no fulfilment event |
| Correlated reply | `message-reply --in-reply-to K` from original recipient to original sender | Insert reply FK and atomically set original fulfilment columns | `fulfilled:true`, `duplicate:false`, both keys returned | `messages.reply.linked` with IDs/identities |
| Reply before late ack | Valid reply while original receipt is unacked | Fulfil original; receipt remains unacked | Reply succeeds; later ack independently returns acked/already-acked | Link event, then receipt event only |
| Duplicate ack | Correct recipient repeats ack | No row change; first timestamp/by preserved | `status:already-acked`, original fulfilment unchanged | No second mutation event |
| Duplicate reply | Same reply key retries, or same original already has reply | Same key returns existing reply; another key hits unique correlation conflict | Same-key `duplicate:true`; different-key `XTMUX_REPLY_ALREADY_LINKED`, no partial write | `messages.reply.duplicate` or `messages.reply.rejected` |
| Invalid correlation | Missing key, unknown key, self-link, non-expecting original, or reply cycle | Transaction rolls back; no message, receipt, or fulfilment update | `XTMUX_REPLY_INVALID_CORRELATION`, exit 4 | `messages.reply.rejected` with reason code and IDs only |
| Cross-recipient reply | Sender is not original recipient, or destination is not original sender | Transaction rolls back; original remains pending | `XTMUX_REPLY_WRONG_PARTICIPANT`, exit 4 | Rejected event with expected/actual session and pane IDs |
| Cross-pane reply | Original has target pane and reply sender pane differs, or explicit destination pane differs | Transaction rolls back; original remains pending | `XTMUX_REPLY_WRONG_PANE`, exit 4 | Rejected event with pane IDs, no body |
| Cancellation | Owner sends `message-cancel --message-key K` before fulfilment | Set `cancelled_at_ms/reason` only when pending; never clear receipt | `cancelled:true`; later reply rejected as cancelled | `messages.obligation.cancelled` |
| Cancellation race with reply | Reply and cancel race in separate writers | First committed terminal transition wins; second sees fulfilled/cancelled and rolls back | One success; other `XTMUX_REPLY_TERMINAL` | Exactly one terminal event; loser rejection records outcome |
| Retention prune | Fulfilled/cancelled original, required receipt state complete, age past message TTL | Delete reply and original in one transaction only after journal/import cutoff; pending rows excluded | `retention` reports deleted pair; no obligation appears | `messages.obligation.pruned` with IDs/count, no body |
| Restart/reload | Process exits after any committed transition | SQL projection recomputes pending/fulfilled/cancelled; no marker read | Same state before and after restart | No synthetic transition event |

`message-list` must expose correlation without requiring extension file access.
Its pane-scoped SQL is executable directly against SQLite:

```sql
SELECT m.message_key, m.sender_id, m.sender_pane_id,
       m.recipient_id, m.target_pane_id, m.bead_id, m.summary,
       m.created_at_ms, m.expects_reply,
       r.acked_at_ms, r.acked_by,
       m.fulfilled_at_ms, linked.message_key AS fulfilled_by_message_key,
       linked.message_key AS correlated_reply_key,
       linked.sender_id AS correlated_reply_sender_id,
       linked.sender_pane_id AS correlated_reply_sender_pane_id,
       linked.recipient_id AS correlated_reply_recipient_id,
       linked.target_pane_id AS correlated_reply_target_pane_id,
       linked.summary AS correlated_reply_summary,
       linked.created_at_ms AS correlated_reply_created_at_ms
  FROM messages AS m
  LEFT JOIN message_receipts AS r
    ON r.message_id = m.id AND r.recipient_id = m.recipient_id
  LEFT JOIN messages AS linked
    ON linked.reply_to_message_id = m.id
 WHERE m.recipient_id = :session_id
   AND (m.target_pane_id = :pane_id OR m.target_pane_id IS NULL)
 ORDER BY m.id DESC
 LIMIT :limit;
```

The correlated projection is `null` or:

```json
{"messageKey":"reply-key","senderId":"$target","senderPaneId":"%target-pane","recipientId":"$requester","targetPaneId":"%requester-pane","summary":"short reply","createdAtMs":1730000000000}
```

### 17.4 Outbound-wait state machine

A wait is owned by `(requester_session_id, requester_pane_id)` and targets
`(target_session_id, target_pane_id)`. `monitor_id` is a nullable linkage until
arm. Terminal state is absorbing for monitor observation; wake delivery and
consumption are separate idempotent facts.

| Transition case | Guard and input | SQLite transition | Concrete API result | Journal outcome |
|---|---|---|---|---|
| Requester registers wait | Valid requester and target session/pane, unique wait ID | Insert `outbound_waits(state='registered', monitor_id=NULL)` | `waitId`, `state:registered`, requester/target IDs | `wait.registered` |
| Monitor arm | Registered wait and monitor belongs to same target pane | Insert monitor, set wait `armed` and `monitor_id` in one transaction | `monitorId`, `waitId`, `state:armed` | `wait.monitor.armed` and `monitor.started` |
| Terminal wake delivered | Linked monitor reaches done/timeout/killed/etc | Set wait `terminal`, terminal fields, `wake_delivered_at_ms` once | `delivered:true`, terminal status, `consumed:false` | `wait.terminal`, then `wait.wake.delivered` |
| Wake consumed | Requester owns wait and terminal wake is unconsumed | Set `state='consumed'`, `wake_consumed_at_ms` once | `consumed:true`; second call false/already-consumed | `wait.wake.consumed` once |
| Replay after restart | Same requester queries terminal unconsumed wait after process restart | Read existing terminal row; do not re-arm or redeliver | `replayed:true`, same wait/monitor/status; consumption still one-time | `wait.wake.replayed`; no new arm |
| Duplicate arm | Same wait already armed or terminal | Conditional update affects zero rows; existing monitor returned | `duplicate:true`, existing `monitorId`; no second monitor | `wait.monitor.duplicate` |
| Orphan monitor | Monitor terminalizes with no matching `outbound_waits` row | Preserve monitor terminal history; create no wait or wake | `monitor-list` marks `orphan:true` or internal report; no requester wake | `wait.monitor.orphan` |
| Cross-session isolation | Caller session/pane differs from requester columns | No update and no wake delivery/consumption | `XTMUX_WAIT_NOT_OWNER`, exit 4 | `wait.validation_failed` with expected/actual IDs |
| Cross-pane isolation | Same session but wrong requester pane | No update; target pane is not enough authority | `XTMUX_WAIT_NOT_OWNER`, exit 4 | Validation event with pane IDs |
| Invalid monitor linkage | Arm target pane/session differs from wait target | Transaction rolls back monitor link | `XTMUX_WAIT_TARGET_MISMATCH`, exit 4 | `wait.validation_failed` |
| Cancellation/timeout | Owner cancels, or expiry applies before arm | Set `cancelled`/`expired`; terminal monitor cannot deliver wake | `state:cancelled` or `state:expired`; `consumed:false` | `wait.cancelled` or `wait.expired` |
| Restart during arm | Process dies before commit | No half-row is visible; retry registers/arms idempotently | Existing committed state returned, otherwise safe retry | No phantom event |
| Retention prune | Consumed/cancelled/expired wait older than wait TTL | Delete wait only after terminal facts are journaled; active/registered/armed preserved | Retention report counts row; no future wake | `wait.pruned` |

### 17.5 CLI and JSON contracts

JSON is one object per mutation and one array for list commands. All IDs are
canonical database/session/pane IDs. Human TSV remains compatibility output;
these shapes define new machine behavior.

**`message-send`** (current implicit default retained):

```json
{"messageKey":"m-1","messageId":41,"duplicate":false,"senderId":"$requester","senderPaneId":"%1","recipientId":"$target","targetPaneId":"%2","beadId":"xtmux-3ua.2","expectsReply":true,"createdAtMs":1730000000000}
```

`--bead` implies `expectsReply:true`; `--expects-reply=false` is explicit opt
out. Duplicate same key returns same row and `duplicate:true`; conflicting
payload or correlation is a validation error, never overwrite.

**`message-list --for $requester --pane %1 --expects-reply --json`** returns:

```json
[{"messageKey":"m-1","senderId":"$target","senderPaneId":"%2","recipientId":"$requester","targetPaneId":"%1","beadId":"xtmux-3ua.2","summary":"work","createdAtMs":1730000000000,"expectsReply":true,"acked":true,"ackedAtMs":1730000000100,"ackedBy":"$requester","replyStatus":"pending","fulfilledAtMs":null,"fulfilledByMessageKey":null,"correlatedReply":null}]
```

For fulfilled messages `replyStatus` is `fulfilled`, timestamps are non-null,
and `correlatedReply` has the exact reply projection above. For cancelled rows
it is `cancelled`. `--unacked` filters receipt ack only and never means
unfulfilled.

**`message-reply --in-reply-to m-1 --text T --json`** is explicit fulfilment:

```json
{"messageKey":"reply-m-1-1","messageId":42,"duplicate":false,"replyToMessageKey":"m-1","fulfilledMessageKey":"m-1","fulfilled":true,"senderId":"$requester","senderPaneId":"%1","recipientId":"$target","targetPaneId":"%2","createdAtMs":1730000000200}
```

The operation derives reversed endpoints from `m-1`; caller-provided endpoint
or pane overrides are rejected. Optional `--message-key` controls idempotence.
`message-cancel --message-key m-1 --json` returns
`{"messageKey":"m-1","cancelled":true,"cancelledAtMs":1730000000300}`.

**`message-ack`** remains receipt-only and unchanged:

```json
{"messageKey":"m-1","status":"acked","acked":true,"ackedAtMs":1730000000100,"ackedBy":"$requester"}
```

Repeat returns `status:"already-acked"`; wrong recipient returns structured
error and performs no fulfilment or receipt mutation.

**`wait-agent`** registers/reads one requester-owned wait and returns:

```json
{"waitId":"w-1","target":"$target","requesterSessionId":"$requester","requesterPaneId":"%1","targetSessionId":"$target","targetPaneId":"%2","state":"terminal","monitorId":"mon-1","terminalStatus":"done","wakeDelivered":true,"wakeConsumed":false,"replayed":false,"startedAtMs":1730000000000,"completedAtMs":1730000000400,"timeoutMs":1800000,"intervalMs":30000}
```

`wait-agent --consume` sets one-time consumption and returns
`wakeConsumed:true`; a non-owner gets `XTMUX_WAIT_NOT_OWNER`.

**`monitor-agent`** registers or idempotently arms a wait and returns:

```json
{"monitorId":"mon-1","waitId":"w-1","target":"$target","requesterSessionId":"$requester","requesterPaneId":"%1","sessionId":"$target","paneId":"%2","state":"working","startedAtMs":1730000000000,"timeoutMs":1800000,"intervalMs":30000,"terminalStatus":null,"wakeDelivered":false}
```

A direct monitor with no wait is legal for compatibility, but it cannot produce a
requester wake and is reported orphaned when terminal.

**`monitor-list --json`** returns array rows including current lifecycle and
wait ownership:

```json
[{"monitorId":"mon-1","waitId":"w-1","target":"$target","requesterSessionId":"$requester","requesterPaneId":"%1","sessionId":"$target","paneId":"%2","state":"done","startedAtMs":1730000000000,"updatedAtMs":1730000000400,"timeoutMs":1800000,"intervalMs":30000,"terminalStatus":"done","terminalAtMs":1730000000400,"wakeDelivered":true,"wakeConsumed":false,"orphan":false}]
```

Every extension and hook consumes these fields through JSON; none opens a runtime
file. `extensions/coordination-json.ts` must recognize explicit reply and wait
results rather than treating any target-bearing send as fulfilment.
[`extensions/coordination-json.ts:1-47`]

### 17.6 Legacy migration and marker deletion

Migration runs once under `obs-migrate --apply`, records deterministic
`event_key` and source path/line, and deletes only validated recognized files
after commit. Existing migration rules already require idempotence and report
malformed source locations rather than silently dropping them.
[`docs/observability-redesign.md:660-685`]

| Directory | Plan | Validation and corrupt/foreign-file safety |
|---|---|---|
| `xtmux-reply-obligations` | **Import once then delete.** Parse marker JSON, find `message_key`, verify expected recipient/pane and current pending SQL projection. No new obligation row is inserted; import records provenance and SQL remains authority. | Recognized malformed JSON, missing message, wrong recipient, or fulfilled/cancelled message is journaled as `legacy.marker.discarded` with reason and then quarantined/deleted only after a durable report. Unrecognized filename or foreign pane/name is not deleted; move to a migration quarantine directory outside runtime reads. |
| `xtmux-outbound-expectations` | **Import once then delete when representable.** Validate target, requester pane, monitor ID, and matching live SQLite monitor/wait; attach existing wait to monitor if safe, otherwise do not invent requester identity. | Corrupt JSON, unknown monitor, target mismatch, or duplicate monitor is recorded with source hash and safely discarded after report. Foreign filename stays quarantined. Never infer requester session from target or process environment. |
| `xtmux-auto-monitor` | **Safe-discard unrepresentable markers; import matched waits once.** Target-only marker cannot establish requester identity. If an exact registered wait and target pane match, mark/import its gate and delete marker; otherwise discard as legacy evidence, not as a new wait. | Malformed, foreign, or ambiguous target is hashed and journaled, then quarantined before deletion. No manual `rm` path remains after cutover. A marker never causes a monitor to be created without a durable requester wait. |

Migration order is: stop new marker writers, snapshot directory manifests,
validate/import in one bounded pass, commit journal provenance, rename recognized
files to quarantine, verify SQL projections, then remove quarantine after the
configured grace period. A crash before deletion reruns by deterministic
`event_key`; a crash after deletion leaves committed SQL or a journaled discard.
No migration path reads arbitrary file contents after the manifest hash and no
foreign file is interpreted as a marker.

### 17.7 Retention and restart rules

Defaults follow §6: messages 30 days, delivery 7 days. Add
`XTMUX_OBS_REPLY_RETENTION_DAYS` (default 30) and
`XTMUX_OBS_WAIT_RETENTION_DAYS` (default 30); invalid or negative values fail
configuration rather than becoming zero. Pruning is transactional and reports
counts.

- Pending obligations (`expects_reply=1`, no fulfilment/cancellation) are never
  pruned, regardless of age or database size pressure.
- An original message with no receipt ack is never pruned. A correlated reply is
  retained with its original until both are eligible; deleting only the reply
  would not resurrect the obligation, but deleting the pair is the only allowed
  terminal cleanup.
- Fulfilled and cancelled originals retain terminal columns through the reply
  retention window. Prune removes reply plus original in one transaction only
  after terminal age, receipt policy, and migration-import cutoff pass.
- Active `outbound_waits` in `registered` or `armed` state are never pruned.
  Terminal undelivered waits are preserved until consumed or explicit expiry;
  consumed/cancelled/expired waits are prunable after wait TTL.
- Active monitors (`terminal_status IS NULL`) and monitors linked to incomplete
  waits are never pruned. Terminal monitor history may prune only after its wait
  terminal/wake facts are retained or journaled.
- A cancellation is absorbing. A late reply cannot clear cancellation, and a
  prune cannot remove cancellation before the terminal retention cutoff.
- After restart, pending/fulfilled/cancelled obligations and pending/terminal/
  consumed waits are SQL queries. No mtime, process-local `Set`, hook bypass, or
  stale monitor-list absence changes state.

### 17.8 Journal event contract

All events use `event_journal` envelope fields `type`, `domain`,
`session_id`, `pane_id`, `correlation_id`, `payload_json`, and `created_at_ms`;
`event_key` is deterministic for idempotent import or one mutation. Existing
journal storage and redaction rules remain normative. [`docs/observability-redesign.md:791-801`]
Required event payloads are:

| Event name | Required fields | Redaction rule |
|---|---|---|
| `messages.sent` | message ID/key, sender/recipient session IDs, sender/target pane IDs, expects-reply, bead ID if present | IDs and bounded bead ID allowed; summary/body excluded |
| `messages.ack` | message ID/key, recipient session/pane, acked-by, outcome | IDs allowed; no message body |
| `messages.reply.linked` | original and reply IDs/keys, reversed session/pane IDs, correlation outcome, timestamp | IDs/outcome allowed; summary and payload bodies excluded |
| `messages.reply.duplicate` | original key, existing reply key, attempted key, requester/recipient IDs | IDs and duplicate outcome only |
| `messages.reply.rejected` | attempted key, original key if parsed, reason code, expected/actual session/pane IDs | IDs/reason allowed; secrets, full body, raw args excluded |
| `messages.obligation.cancelled` | message key/id, owner session/pane, reason code, timestamp | Reason must be enum/bounded text; no body |
| `messages.obligation.pruned` | original/reply IDs or count, retention cutoff, outcome | IDs/count/cutoff allowed; no bodies |
| `wait.registered` | wait ID, requester/target session and pane IDs, related message ID, expiry | IDs/status allowed; no payload |
| `wait.monitor.armed` | wait ID, monitor ID, requester/target identities, duplicate flag | IDs/status only |
| `wait.monitor.duplicate` | wait ID, existing monitor ID, requester identity, outcome | IDs/status only |
| `monitor.started` | monitor ID, target/session/pane, state, timeout/interval | IDs and bounded state allowed |
| `monitor.state` | monitor ID, session/pane, from/to state | IDs and enum states only |
| `monitor.done`, `monitor.timeout`, `monitor.killed`, `monitor.target_gone`, `monitor.process_gone`, `monitor.error` | monitor ID, target session/pane, terminal status/time, bounded detail code | IDs/status/detail code only; no pane output body |
| `wait.terminal` | wait/monitor IDs, terminal status/time, target/requester identities | IDs/status/detail code; no pane output body |
| `wait.wake.delivered` | wait/monitor IDs, requester session/pane, delivery timestamp, duplicate flag | IDs/status only |
| `wait.wake.consumed` | wait ID, requester session/pane, consumer process/session, timestamp | IDs/status only |
| `wait.wake.replayed` | wait/monitor IDs, requester identity, terminal status, restart marker | IDs/status only |
| `wait.wake.orphan` | monitor ID, target session/pane, no-wait reason | IDs/status only |
| `wait.validation_failed` | operation, wait/monitor ID if known, expected/actual identities, reason code | IDs/reason only; no raw command/body |
| `legacy.marker.imported` | source directory/name/hash, source line if applicable, imported wait/message key, outcome | Path basename/hash/IDs allowed; file contents excluded |
| `legacy.marker.discarded` | source directory/name/hash, reason code, quarantine status | Hash/basename/reason only; secrets and contents excluded |
| `wait.cancelled` / `wait.expired` | wait ID, requester identity, reason, timestamp | IDs and bounded reason only |
| `wait.pruned` | wait IDs/count, cutoff, terminal state | IDs/count/cutoff only |

No event stores secrets, credentials, full message summaries, payload JSON,
prompt-file bodies, raw hook stdin, full command argv, stdout, or stderr. Hashes
are preferred for forensic linkage. Validation failures are journaled after
sanitizing input and never echo attacker-controlled text into the event.

### 17.9 Epic implementation map

| Child | ADR sections implemented, tested, or documented |
|---|---|
| `xtmux-3ua.2` | §17.2 reply DDL; §17.3 all reply transitions; §17.5 message contracts; §17.7 retention; §17.8 message events |
| `xtmux-3ua.3` | §17.2 `outbound_waits`; §17.4 wait transitions; §17.5 wait/monitor JSON; §17.7 wait retention |
| `xtmux-3ua.4` | §17.3 projection; §17.5 exact CLI contracts and error outcomes |
| `xtmux-3ua.5` | §17.3/§17.4 transition tables; §17.7 restart/concurrency/retention invariants; §17.8 journal assertions |
| `xtmux-3ua.6` | §17.1 Pi marker audit; §17.4 wake consumption; §17.5 extension JSON boundary; §17.7 restart behavior |
| `xtmux-3ua.7` | §17.1 Claude marker audit; §17.4 monitor arm/terminal wake; §17.6 marker deletion and no-marker cutover |
| `xtmux-3ua.8` | §17.6 all three legacy migration plans, quarantine, idempotence, and artifact cutover |
| `xtmux-3ua.9` | §17.3/§17.4 semantics; §17.5 CLI shapes; §17.6 upgrade behavior and §17.8 troubleshooting evidence |
| `xtmux-3ua.10` | §17.3 explicit reply/no heuristic rule; §17.4 requester-owned wake; §17.5 operator-facing contracts |
| `xtmux-3ua.11` | §17.4 restart and one-time wake; §17.5 packed Pi/Claude contracts; §17.6 cleanup verification |
| `xtmux-3ua.12` | §17.1 citations; §17.2 FKs/indexes; §17.3/§17.4 adversarial transitions; §17.6 corrupt-file safety; §17.8 redaction |

### 17.10 Open questions and ADR risks for adversarial review

1. **Reply pane strictness.** §17.3 “Cross-pane reply” row rejects a reply when
   the original target pane is gone or the runtime can only recover session ID.
   Should pane identity degrade to session identity after pane teardown, or must
   it reject forever? Attack row: cross-pane reply and restart projection.
2. **One reply versus multiple valid replies.** `msg_one_reply_per_request`
   makes correlation one-to-one. If a recipient legitimately needs a correction
   or streamed completion, this schema rejects second reply rather than modelling
   versions. Attack row: duplicate reply and correlated reply; decide whether a
   future reply sequence is required before migration 0010.
3. **Wake delivery crash window.** Delivery is recorded before extension/Claude
   notification. A process can crash after `wake_delivered_at_ms` and before
   user-visible notification; replay returns the recorded wake, but delivery
   semantics need an adversarial proof that no caller treats “delivered” as
   “consumed.” Attack row: terminal wake delivered, wake consumed, replay after
   restart.
4. **Legacy target-only markers.** `xtmux-auto-monitor` stores only a sanitized
   target filename and no requester identity [`.xtrm/hooks/auto-monitor-on-send.mjs:36-38`].
   Importing it risks cross-session wake; discarding it risks losing a genuine
   active gate. Attack row: legacy migration and orphan monitor; require fixture
   evidence for both outcomes.
5. **Terminal retention and late writers.** Pruning fulfilled originals plus
   replies depends on import cutoff and event-journal retention. A delayed old
   client could submit a correlated reply after prune and receive unknown-key
   rejection. Attack row: retention prune and late reply; verify this is explicit,
   observable failure rather than silent new obligation.
