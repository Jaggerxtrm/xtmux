# xtmux Observability Redesign — SQLite-backed runtime

Epic: **xtmux-3xs** (supersedes xtmux-ihu).
PRD: [`docs/ts-sqlite.md`](./ts-sqlite.md) — normative for scope, non-goals, phase sequence.
This document is the Phase 1 deliverable: architecture decision + Channels audit + schema + identity + output contracts + retention + feature modes + migration + compatibility + benchmark plan.

Anything not stated here inherits the PRD by reference. Anything in conflict — the PRD wins until this doc is amended and reviewed.

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
- V2-only machine queries avoid formatted-message scans: `message-status <message_key>` returns sender, recipient, bead, summary, and durable ack state; `unread-count --for <recipient>` returns recipient-scoped count plus oldest unacked timestamp. Both emit one JSON row and reject V1 mode rather than inventing receipt data.
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
