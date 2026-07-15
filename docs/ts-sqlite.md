## SCOPE

This epic replaced xtmux’s flat JSONL observability and message-routing implementation with a typed, indexed SQLite runtime. Sections 1–26 preserve the original PRD; §27 records the shipped Phase 2 coordination contract and overrides earlier future-tense descriptions.

The work was broader than optimizing `message-list`. It separated four concerns formerly mixed inside `events.jsonl`, tmux options, temporary TSV files, and shell control flow:

```text
durable operational state
durable message delivery
historical/audit events
live tmux and picker UI projections
```

The shipped architecture is **Rung C: SQLite-backed runtime and observability**, implemented primarily in Bun/TypeScript, while preserving the existing shell picker as the stable tmux and fzf integration layer.

Rung A and Rung B remain useful only as compatibility or benchmark baselines. They are not acceptable end states for this epic.

---

## 1. ARCHITECTURAL DECISION

Implement an SQLite-backed runtime with typed domain tables and indexed queries.

SQLite becomes authoritative for:

* durable messages and acknowledgement state;
* agent instance lifecycle;
* agent state-transition history;
* completed agent turns;
* monitor registrations, leases, heartbeats, and terminal outcomes;
* handoff lifecycle;
* delivery attempts;
* correlated git, bd, and GitHub command telemetry;
* audit runs and durable findings;
* generic/custom event journaling;
* schema and legacy-data migrations.

The implementation must not reproduce the current `events.jsonl` design as one generic hot SQL table.

Use typed operational tables for frequently queried domains, plus an append-only `event_journal` for compatibility, custom events, drilldown, and audit.

```text
typed domain tables = runtime and query authority
event_journal        = historical envelope and compatibility surface
tmux options         = live UI projections
tmux server          = live topology authority
```

---

## 2. CHANNELS DESIGN AUDIT

Before implementation, read the canonical Channels design family in this order:

1. `~/dev/xtrm/docs/channels/channels.md`
2. `channels-upgrade.md`
3. `channels-forensic-attention-proposal.md`
4. the specialists runtime implementation backed by `observability.db`

The Channels specification is normative where the concepts overlap. It already establishes several invariants this epic should reuse:

* durable SQLite storage rather than a global JSONL transport;
* stable participant or recipient identity;
* monotonic database IDs for ordering;
* pure reads separated from acknowledgement mutations;
* acknowledgement only after successful processing;
* typed messages rather than prose-only records;
* pointer and summary payloads rather than raw large blobs;
* streams as durable truth;
* projections as reconstructible caches;
* transport mechanics separated from semantic or forensic events.

The canonical Channels storage uses indexed SQLite message and subscription tables, with a monotonic autoincrement message ID as the delivery cursor.

The Channels runtime explicitly separates pure observation from effectful acknowledgement and advances delivery state only after successful processing.

The Channels design also treats the stream as truth and projections as recomputable caches.

xtmux must reuse those invariants and vocabulary without importing the full Channels subsystem.

### Channels features intentionally not inherited

This epic does not add:

* specialist judges;
* channel topologies;
* consensus or quorum;
* capability negotiation;
* specialist subscription expressions;
* evidence grants;
* work-graph derivation;
* node supervision;
* self-activation;
* freeform multi-agent routing;
* cross-container channels;
* cross-machine synchronization.

xtmux remains a simpler local session-routing and observability runtime based on tmux session and pane identities.

---

## 3. IMPLEMENTATION LANGUAGE AND RUNTIME BOUNDARY

The durable V2 runtime should be implemented in **Bun/TypeScript**.

This is not a complete rewrite of the picker.

### Shell remains responsible for

* the stable `bin/tmux-session-picker` executable;
* tmux and fzf interaction;
* session and pane discovery;
* `capture-pane`;
* ANSI rendering;
* switch, jump, rename, interrupt, approve, and kill actions;
* live topology queries;
* the legacy V1 implementation while V2 is disabled.

### Bun/TypeScript becomes responsible for

* SQLite connections and configuration;
* schema creation and versioned migrations;
* transactional domain mutations;
* message and receipt queries;
* runtime-object state machines;
* retention and reconciliation;
* legacy migration;
* contract testing;
* benchmark generation;
* structured errors;
* compatibility formatting for delegated CLI commands.

Suggested layout:

```text
package.json
bun.lock
tsconfig.json

src/
  cli.ts
  config.ts
  output-contracts.ts

  db/
    connection.ts
    schema.ts
    health.ts
    retention.ts
    migrations/

  domains/
    events/
    messages/
    agents/
    monitors/
    handoffs/
    deliveries/
    telemetry/
    audit/

  migration/
    legacy-jsonl.ts
    legacy-monitor-tsv.ts
    legacy-agent-state-log.ts

  benchmarks/
    messages.ts
    concurrent-runtime.ts

tests/
  contracts/
  integration/
  fixtures/

bin/
  tmux-session-picker

extensions/
  pi-agent-state.ts
```

`bin/tmux-session-picker` remains the public entry point and delegates durable-runtime commands to the Bun implementation under `XTMUX_OBS_V2=shadow` or `1`.

The command names, stdout formats, stderr formats, and exit semantics remain compatible unless a documented V2-only option is explicitly used.

No mandatory daemon or broker is introduced. Each invocation opens the database, verifies the schema, performs a bounded operation, and closes.

Prefer Bun’s runtime-native SQLite support over spawning the `sqlite3` CLI.

---

## 4. TARGET DATABASE DOMAINS

The target database is:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/xtmux/observability.db
```

Minimum domain model:

```text
event_journal
messages
message_receipts
delivery_attempts
agent_instances
agent_state_transitions
agent_turns
monitors
handoffs
command_runs
audit_runs
audit_findings
migration_runs
schema_migrations
```

Additional supporting indexes and lookup tables are allowed when justified by query plans or invariants.

---

## 5. GENERIC EVENT JOURNAL

Keep a generic append-only journal for:

* `log emit`;
* arbitrary custom event types;
* compatibility output for `log tail` and `log query`;
* mutation audit envelopes;
* unsupported or future event kinds;
* migration provenance;
* runtime failures and rejection facts.

Suggested conceptual shape:

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
```

Required indexes:

```text
(type, id)
(session_id, id)
(pane_id, id)
(bead_id, id)
(correlation_id)
(domain, id)
```

The journal is not the primary read path for messages, monitors, agent state, telemetry, handoffs, or audit findings.

Typed-table mutation and journal-envelope insertion should occur in the same transaction when both are required.

The current `log_event` function writes all event kinds into the same file, while `log query` scans and filters that file by type, pane, session, bead, and timestamp.

---

## 6. MESSAGES AND RECEIPTS

Migrate:

```text
message.sent
message.ack
message.failed
```

into typed message and receipt tables.

Suggested conceptual model:

```sql
CREATE TABLE messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    message_key     TEXT NOT NULL UNIQUE,
    sender_id       TEXT NOT NULL,
    recipient_id    TEXT NOT NULL,
    bead_id         TEXT,
    summary         TEXT NOT NULL,
    payload_json    TEXT,
    created_at_ms   INTEGER NOT NULL
);

CREATE TABLE message_receipts (
    message_id      INTEGER NOT NULL,
    recipient_id    TEXT NOT NULL,
    read_at_ms      INTEGER,
    acked_at_ms     INTEGER,
    acked_by        TEXT,
    PRIMARY KEY (message_id, recipient_id),
    FOREIGN KEY (message_id)
      REFERENCES messages(id)
      ON DELETE CASCADE
);
```

Required invariants:

* recipient identity is normalized to tmux `#{session_id}` where available;
* message and receipt creation occur in one transaction;
* `message-list` is a pure read;
* `message-ack` is the only acknowledgement mutation;
* ack is idempotent;
* an acknowledgement cannot exist without its message;
* ordinary retention never removes an unacknowledged message;
* message insertion succeeds independently from tmux projection updates;
* message query complexity depends on recipient queue size and result limit, not total observability volume.

The shipped implementation inserts messages and receipts atomically in SQLite, then mutates `@agent_unread_count` and `@agent_unread_since` only as best-effort projections. `message-ack` updates receipt state only; explicit correlation in §27 owns reply fulfilment.

### Unread tmux options

Retain:

```text
@agent_unread_count
@agent_unread_since
```

as live UI projections.

They are not authoritative.

Add reconciliation that recalculates the unread projection from SQLite when:

* the picker opens or refreshes;
* a message mutation detects projection failure;
* an explicit repair command is run;
* a shadow comparison reports divergence.

---

## 7. DELIVERY ATTEMPTS

Separate durable message insertion from best-effort pane or tmux delivery.

Create a domain for:

```text
tmux send-keys
tmux display-message
unread projection writes
Claude second-Enter injection
approve/interrupt/message picker actions
handoff pointer injection
```

Suggested conceptual shape:

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
    details_json        TEXT
);
```

The current `safe-send-pointer` directly performs `tmux send-keys` and then records the operation as `message.sent`. This conflates durable channel messages with pane injection.

In V2:

```text
message.sent           = durable message inserted in SQLite
delivery.attempted     = best-effort external projection or pane injection
```

They must not share the same semantic event type.

---

## 8. AGENT INSTANCES

Create a durable record for each agent activation.

Suggested conceptual model:

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
```

An instance represents one agent activation, not merely a pane. Panes may be reused.

Natural instance-open sources include:

```text
agent.role.launched
Pi session_start
Claude SessionStart
first valid agent.state when no instance exists
```

Natural terminal sources include:

```text
session_shutdown
state=off
pane disappearance reconciliation
explicit kill or stop
```

The launcher already emits agent metadata such as `XTMUX_AGENT_*`, pane options, and `agent.role.launched`. The database should preserve that lifecycle without replacing the tmux options used by the live picker.

---

## 9. AGENT STATE TRANSITIONS

Migrate:

```text
agent.state
```

into a typed state-transition table.

Suggested conceptual shape:

```sql
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
    created_at_ms       INTEGER NOT NULL
);
```

Update `agent_instances.last_state` and `last_transition_ms` transactionally.

Retain the pane-scoped options:

```text
@agent_state
@agent_bead
@agent_task
@agent_prompt_file
@agent_parent_session
@agent_last_transition
```

as the hot live UI contract.

The current state script already writes those options and appends an `agent.state` record containing pane, session, state, hook event, bead, task, prompt file, and parent.

Do not store every repeated Pi event. Preserve the current debounce semantics: only meaningful state transitions or bounded same-state refreshes should reach durable storage.

---

## 10. AGENT TURNS

Migrate:

```text
agent.turn.done
```

into a typed completed-turn table.

Suggested conceptual shape:

```sql
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
    UNIQUE(instance_id, turn_index)
);
```

When a completed turn also sends a parent notification:

1. insert the turn;
2. insert the parent message and receipt;
3. link `agent_turns.parent_message_id`;
4. commit;
5. update tmux projections best-effort.

The Pi extension currently records `agent.turn.done` with pane, stable session ID, session name, bead, parent, and compact last-message text, then separately sends a message to the parent.

V2 must correlate those operations.

---

## 11. MONITOR RUNTIME

The complete monitor registry is stored in SQLite. Legacy temporary TSV files are importer inputs only.

Monitor state includes:

```text
monitor id
pid
target
pane
observed state
start time
timeout
poll interval
last update
terminal event
```

The runtime updates monitor heartbeat/current state in place and persists terminal status. `monitor-list` reconciles SQLite rows against live tmux/process probes; it does not scan or rewrite a runtime TSV registry.

Suggested conceptual model:

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
    terminal_detail     TEXT
);
```

Migrate:

```text
monitor.started
monitor.done
monitor.timeout
monitor.killed
```

into state transitions on the monitor row plus journal envelopes.

Add explicit terminal statuses:

```text
done
timeout
killed
target_gone
process_gone
error
```

Do not append one historical event for every poll tick. Update heartbeat and current-state columns instead.

---

## 12. HANDOFF LIFECYCLE

Migrate:

```text
handoff.created
handoff.sent
```

and the associated prompt-pointer lifecycle into a typed table.

Suggested conceptual model:

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
    delivery_attempt_id   INTEGER
);
```

States:

```text
created
sent
delivery_failed
accepted
completed
cancelled
```

The current handoff flow creates a prompt file, records `handoff.created`, writes agent metadata to the target pane, records `handoff.sent`, and then invokes `safe-send-pointer`.

Store:

* pointer path;
* content hash;
* short summary;
* bead;
* source and target identities;
* lifecycle state.

Do not store the complete prompt-file contents in SQLite.

Add reconciliation for:

```text
created but never sent
sent to dead pane
prompt file missing before send
handoff without bead
completed turn without handoff completion
```

---

## 13. CORRELATED COMMAND TELEMETRY

Replace uncorrelated start/end event pairs with one typed command-run record.

Current telemetry logs:

```text
telemetry.command.started
git.command
git.commit
git.push
git.merge
bd.command
bd.create
bd.claim
bd.update
bd.close
bd.remember
git.pr.create
git.pr.merge
gh.command
```

with fields including pane, session, bead, cwd, repo, branch, head, argv, and exit code.

Suggested conceptual model:

```sql
CREATE TABLE command_runs (
    id                  TEXT PRIMARY KEY,
    tool                TEXT NOT NULL,
    operation           TEXT NOT NULL,
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
    terminal_status     TEXT
);
```

The wrapper should:

1. insert a started command run;
2. execute the real command;
3. update the same row with result metadata;
4. write relevant journal envelopes.

This enables detection of:

```text
started runs without completion
failure rates
command duration
last commit or push by bead
PR create without later merge
failed bead close operations
```

---

## 14. AUDIT RUNS AND FINDINGS

Migrate:

```text
audit.run
```

and persist the actual audit findings currently emitted only to stdout.

The current audit derives findings such as:

```text
missing-path
stale-specialist
dirty-worktree
shared-worktree
working-do-not-kill
naming-convention
agent-pane-without-bead
```

but only the fact that the audit ran is persisted.

Suggested conceptual model:

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
    run_id              TEXT NOT NULL,
    fingerprint         TEXT NOT NULL,
    severity            TEXT NOT NULL,
    kind                TEXT NOT NULL,
    session_id          TEXT,
    pane_id             TEXT,
    repo                TEXT,
    path                TEXT,
    detail_json         TEXT,
    first_seen_ms       INTEGER NOT NULL,
    last_seen_ms        INTEGER NOT NULL,
    resolved_at_ms      INTEGER
);
```

Use stable finding fingerprints so repeated audits update `last_seen_ms` instead of producing unbounded duplicate facts.

A finding absent from a later complete audit may be marked resolved.

Do not persist every dashboard snapshot. Persist only durable findings and audit-run metadata.

---

## 15. LIVE STATE THAT REMAINS OUTSIDE SQLITE

SQLite must not replace tmux as the live source for:

* session existence;
* pane existence;
* pane geometry;
* current command;
* pane capture;
* attachment state;
* live session/window topology.

Do not persist:

* full `capture-pane` history;
* fzf filter state;
* picker list mode;
* short-lived git cache entries;
* complete prompt-file contents;
* terminal rendering output;
* every monitor polling observation;
* full stdout/stderr from git, bd, or gh;
* arbitrary pane geometry snapshots.

The picker currently reads explicit `@agent_state` live and deliberately excludes it from the persistent git cache.

That live-state behavior should remain.

---

## 16. STORAGE AND TRANSACTION INVARIANTS

When V2 is authoritative:

1. SQLite is the durable operational source of truth.
2. Every multi-table mutation uses an explicit transaction.
3. Message and receipt creation are atomic.
4. Turn and parent-message correlation are atomic.
5. Typed-table and journal writes are atomic when both are required.
6. Reads do not mutate acknowledgement state.
7. Unacknowledged messages are not silently expired.
8. tmux projection failure does not fail the durable mutation.
9. Runtime-object state transitions are validated.
10. Schema migrations are versioned and idempotent.
11. Every command uses bounded database lock waits.
12. Busy failures return a distinct actionable error.
13. No shell or TypeScript loop performs one database process or query per result row.
14. Prepared statements are reused within one invocation.
15. Foreign keys are enabled.
16. Tests use isolated temporary databases.

Recommended defaults:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 3000;
PRAGMA foreign_keys = ON;
```

Any deviation requires benchmark or reliability evidence in `docs/observability-redesign.md`.

---

## 17. RETENTION AND DATABASE SIZE MANAGEMENT

The V1 JSONL backend continues using size-triggered file rotation.

The V2 SQLite backend uses size-triggered retention and compaction.

Introduce:

```text
XTMUX_OBS_DB_MAX_BYTES
XTMUX_OBS_MESSAGE_RETENTION_DAYS
XTMUX_OBS_AGENT_STATE_RETENTION_DAYS
XTMUX_OBS_TURN_RETENTION_DAYS
XTMUX_OBS_TELEMETRY_RETENTION_DAYS
XTMUX_OBS_AUDIT_RETENTION_DAYS
XTMUX_OBS_DELIVERY_RETENTION_DAYS
```

Required retention behavior:

* unacknowledged messages are never deleted by ordinary retention;
* acknowledged messages may be deleted after their retention window;
* active agent instances are not deleted;
* active monitors are not deleted;
* incomplete handoffs are not deleted;
* incomplete command runs are not deleted;
* unresolved audit findings remain available;
* agent-state history may be compacted while preserving the latest state per instance;
* domain retention executes independently;
* cleanup runs transactionally;
* WAL checkpointing may follow cleanup;
* automatic `VACUUM` does not run on every threshold crossing.

Any future unacknowledged-message expiration must be explicit, auditable, and terminal. Silent expiration is forbidden.

---

## 18. FEATURE-FLAG AND ROLLOUT MODES

Support three modes.

### `XTMUX_OBS_V2=0` or unset

* legacy JSONL and TSV implementation only;
* no SQLite writes;
* existing file layout;
* existing rotation;
* existing stdout;
* existing stderr;
* existing exit codes.

### `XTMUX_OBS_V2=shadow`

* V1 remains authoritative;
* durable mutations are mirrored to SQLite;
* CLI reads still return V1 results;
* V2 results are compared diagnostically;
* divergences are recorded without changing command output.

Compare:

```text
recipient normalization
message ordering
message IDs
acknowledgement state
unread counts
monitor state
agent latest state
turn correlation
telemetry result
audit findings
```

### `XTMUX_OBS_V2=1`

* SQLite is authoritative;
* tmux options are best-effort projections;
* V1 output formatting remains compatible;
* legacy writes may remain only as an explicitly temporary mirror.

Dual-write must have a documented retirement condition.

---

## 19. LEGACY MIGRATION

Provide non-destructive migration commands:

```bash
tmux-session-picker obs-migrate --dry-run
tmux-session-picker obs-migrate --apply
tmux-session-picker obs-migrate --status
```

Migration sources:

```text
events.jsonl
events.jsonl.1 ... events.jsonl.N
legacy monitor TSV directory
optional agent-state audit log
```

The importer must:

* preserve all source files;
* be idempotent;
* use deterministic legacy identities;
* avoid duplicate imports;
* normalize session and pane identities where possible;
* import typed domains;
* retain unknown event kinds in `event_journal`;
* link acknowledgements to messages;
* explicitly report orphan acknowledgements;
* explicitly report malformed records;
* report unsupported or ambiguous records;
* record source path, size, modification time, and hash;
* record counts by domain;
* record migration completion status.

Minimum migration report:

```text
files scanned
records scanned
journal events imported
messages imported
receipts linked
orphan acknowledgements
agent instances reconstructed
agent transitions imported
turns imported
monitors imported
handoffs imported
command runs correlated
audit runs imported
duplicate records skipped
malformed records
unsupported event types
```

Do not silently discard malformed or orphaned records.

Where historical start/end correlation is ambiguous, preserve both records in the journal and report the unresolved correlation instead of inventing one.

---

## 20. OUTPUT COMPATIBILITY

Create golden output fixtures for:

```text
message-send
message-list
message-list --unacked
message-ack
monitor-agent
monitor-list
monitor-kill
handoff
safe-send-pointer
telemetry
audit
log tail
log query
```

With V2 disabled, output must be byte-identical to the pre-epic implementation, including stdout, stderr, and exit status.

With V2 enabled, output remains compatible unless the command exposes a documented V2-only field or mode.

Structured internal data must not leak into existing human-readable output accidentally.

---

## 21. PERFORMANCE VALIDATION

Benchmark full command latency, including:

```text
runtime startup
database open
schema verification
query execution
formatting
process exit
```

Do not benchmark raw SQL alone.

Required corpora:

```text
Corpus A
100k messages distributed across 100 recipients.

Corpus B
100k total records:
5k messages
95k agent-state, telemetry, monitor, audit, delivery, and turn records.

Corpus C
1M total records:
one hot recipient with 10k messages
1k unacknowledged messages.

Corpus D
concurrent workload:
Pi state transitions
monitor heartbeat
message send/list/ack
telemetry command completion
dashboard or audit reader.
```

Measure:

```text
message-list --for X
message-list --for X --unacked
message-send
message-ack
monitor-list
latest agent state
recent completed turns
audit unresolved findings
log query by type
log query by bead
concurrent read/write behavior
cold and warm cache
p50, p95, p99, maximum
```

Acceptance:

* `message-list --for X` under 100 ms p99 on the 100k-message corpus;
* unrelated event volume does not materially change recipient-query latency;
* no per-row process spawning;
* monitor, state, and telemetry writes do not starve message routing;
* process startup does not invalidate the latency target;
* database-busy behavior is bounded;
* no lost or duplicated mutation under tested concurrency.

---

## 22. CONTRACT TESTS

Test both V1 and V2.

Required message tests:

```text
send
list
recipient normalization
unacked filtering
idempotent ack
unknown message
ack by wrong recipient
concurrent send
projection failure
retention preservation
migration orphan handling
```

Required agent tests:

```text
instance open
state transition
same-state debounce
pane reuse creates new instance
turn completion
parent-message correlation
shutdown/off terminal behavior
missing pane reconciliation
```

Required monitor tests:

```text
register
heartbeat
done
timeout
kill
owner process gone
target pane gone
lease expiry
restart reconciliation
```

Required handoff tests:

```text
created
sent
delivery failure
missing prompt file
dead target
accepted/completed correlation
idempotent migration
```

Required telemetry tests:

```text
start/completion correlation
nonzero exit
process interruption
before/after git metadata
incomplete-run reconciliation
```

Required audit tests:

```text
run creation
finding fingerprint
repeat observation
resolution
partial audit failure
```

Required feature-mode tests:

```text
V1 byte identity
shadow dual-write
shadow divergence detection
V2 authoritative reads
migration rerun
schema upgrade rerun
```

---

## 23. DELIVERABLES

1. `docs/observability-redesign.md` containing:

   * architecture choice;
   * Channels audit;
   * inherited invariants;
   * intentionally excluded Channels features;
   * runtime/domain ownership;
   * schema;
   * identity model;
   * transactions;
   * retention;
   * feature modes;
   * migration;
   * compatibility;
   * performance results.

2. Bun/TypeScript runtime skeleton.

3. SQLite adapter and schema migration framework.

4. Generic event journal.

5. Messages and receipts.

6. Delivery-attempt tracking and unread reconciliation.

7. Agent instances, transitions, and turns.

8. Monitor registry and leases.

9. Handoff lifecycle.

10. Correlated command telemetry.

11. Audit runs and findings.

12. Legacy migration tool.

13. Shadow-mode semantic comparison.

14. Contract test suites.

15. Reproducible benchmark harness and committed results.

16. Updated:

    * `README.md`;
    * `docs/agent-state-hooks.md`;
    * observability documentation;
    * migration and recovery documentation.

---

## 24. IMPLEMENTATION SEQUENCE

Execute in this order:

```text
Phase 1
Channels audit, architecture brief, schema, identity and output contracts.

Phase 2
Bun/TypeScript project skeleton, SQLite adapter, health checks,
schema migrations and concurrency tests.

Phase 3
event_journal plus messages, receipts, delivery attempts and unread reconciliation.

Phase 4
monitor registry, leases, heartbeat and terminal-state migration.

Phase 5
agent instances, state transitions, completed turns and parent-message correlation.

Phase 6
handoffs and prompt-pointer lifecycle.

Phase 7
correlated command telemetry.

Phase 8
audit runs, finding persistence and resolution.

Phase 9
legacy JSONL/TSV migration and shadow-mode comparison.

Phase 10
retention, compaction, final benchmarks, documentation and V2 cutover.
```

Do not begin broad shell-to-TypeScript UI migration as part of this epic.

Do not make V2 authoritative before:

* message correctness passes;
* concurrency tests pass;
* migration is idempotent;
* shadow comparison is clean;
* benchmark targets pass;
* recovery and rollback are documented.

---

## 25. NON-GOALS

* No broker.
* No mandatory daemon.
* No full pub/sub system.
* No cross-machine synchronization.
* No replacement for Beads or Dolt.
* No full specialists Channels implementation.
* No judge, topology, quorum, or self-activation.
* No replacement of tmux as live topology authority.
* No storage of raw pane transcripts.
* No storage of complete prompt-file bodies.
* No indefinite dual-write.
* No full picker rewrite.
* No generic single-table observability design.
* No assumption that the `sqlite3` CLI exists.
* No change to the operator-facing meaning of:

  * `@agent_state`;
  * `@agent_bead`;
  * `@agent_task`;
  * `@agent_prompt_file`;
  * `@agent_parent_session`;
  * `@agent_last_transition`.

---

## 26. SUCCESS

The epic is complete when:

* message reads scale with recipient queue size, not global history;
* acknowledgement semantics are transactionally correct and retention-safe;
* unrelated observability domains no longer compete with message routing;
* monitors no longer depend on temporary TSV registry files;
* agent activations, state changes, and turns are durably correlated;
* handoffs have queryable lifecycle state;
* direct pane delivery is distinguished from durable messaging;
* command telemetry has correlated start and completion records;
* audit findings persist and can be resolved over time;
* tmux options remain responsive live projections;
* V1 remains byte-compatible when disabled;
* shadow mode demonstrates semantic parity;
* legacy data migrates non-destructively and idempotently;
* V2 meets the full-command p99 performance target;
* no mandatory daemon or broker has been introduced.

---

## 27. SHIPPED PHASE 2 COORDINATION CONTRACT

SQLite is the sole steady-state authority for reply obligations, correlated
replies, outbound waits, monitor linkage, terminal wakes, and wake consumption.
The former Pi/Claude runtime marker directories are not read, written, expired,
or migrated by the coordination loops.

### 27.1 Message correlation

Migration 0010 rebuilds `messages` with `expects_reply`,
`reply_to_message_id`, `fulfilled_by_message_id`, `fulfilled_at_ms`,
`cancelled_at_ms`, and `cancel_reason`. It adds:

* unique `msg_one_reply_per_request` for one fulfilling reply;
* partial `msg_pending_obligation` keyed by sender session/pane and creation;
* `msg_reply_target` for correlation reads;
* `msg_fulfilled_retention` for terminal cleanup.

`message-send --bead` defaults to an expected reply; explicit false is FYI-only.
`message-ack` is receipt-only. `message-reply --in-reply-to <messageKey>`
requires the live original recipient pane, derives reversed endpoints, and
inserts reply + fulfilment atomically. Same-key retry is idempotent; a different
second reply, wrong session/pane, endpoint override, cancellation race, or busy
database returns a structured error without partial mutation. Owner cancellation
is terminal. `safe-send-pointer --reply-to` calls the reply path only after a
successful injection.

### 27.2 Requester-owned waits

Migration 0011 adds `outbound_waits` with requester/target session and pane IDs,
optional related message and monitor IDs, states `unarmed`, `armed`,
`terminal-unconsumed`, `consumed`, `cancelled`, and `expired`, terminal/wake
timestamps, and expiry. Its indexes enforce one wait per monitor and bound
requester-pending, target-active, wake-delivery, and retention queries.

A target does not identify its requester. Arm, wake delivery, and consumption
validate both requester columns. `--wait-for-transition` requires a target to
enter working state and leave it; Claude additionally requires a covering wait
whose start is no earlier than the obligation. Terminal rows and one-time wakes
replay after restart. Monitors with no linked wait are retained as orphans and
cannot wake a requester.

### 27.3 Markerless consumers and bounds

Claude PostToolUse verifies the SQLite obligation; Stop supplies the exact native
Monitor wait when a fresh requester-owned wait is missing; PostToolUse consumes
a completed wake idempotently. Database/shape failures produce bounded
operator-facing diagnostics and no marker fallback.

Pi accepts only complete single coordination JSON envelopes. Each cycle reads at
most 500 rows, performs at most 20 ack/wake mutations, publishes at most 20
validated reply keys, caps its widget at 22 rows / 2000 characters and prompt
addition at 1600 characters, and queues one continuation while idle. Remaining
work stays durable for later cycles or restart. Unsafe metadata is hidden and
message summaries are never promoted into instructions.

### 27.4 Retention and telemetry

`XTMUX_OBS_REPLY_RETENTION_DAYS` and `XTMUX_OBS_WAIT_RETENTION_DAYS` default to
30. Pending obligations, unacknowledged original/reply rows, active waits, and
terminal unconsumed wakes are preserved. Eligible reply/original pairs delete
together; only old consumed/cancelled/expired waits prune.

Typed rows are authority; bounded journal evidence includes
`messages.reply.linked`, `messages.reply.rejected`,
`messages.obligation.pruned`, `wait.registered`, `wait.monitor.armed`,
`wait.terminal`, `wait.wake.delivered`, `wait.wake.consumed`,
`wait.wake.orphan`, `wait.validation_failed`, `wait.cancelled`, `wait.expired`,
and `wait.pruned`. Message and prompt bodies are excluded.

### 27.5 Upgrade/operator boundary

Schema migrations apply automatically on database open. Upgrade the npm package,
reload/start fresh Pi, and start fresh Claude sessions. Existing SQLite message
and wait rows remain authoritative. `obs-migrate` continues to import legacy
JSONL/monitor TSV data only; it does not infer requester or reply state from
marker names. Coordination works with `XDG_RUNTIME_DIR` unset. Troubleshoot with
`xtmux-obs health`, `obligations list --json`, pane-scoped `message-list --expects-reply
--json`, and `monitor-list --json`, not runtime-directory inspection.
