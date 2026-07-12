# Domains 4 / 7 / 8 — monitors, command telemetry, audit

Staging doc for the design contracts of `xtmux-3xs.4`, `.7`, `.8`. Folds into
`docs/observability-redesign.md` once Phase 1 creates that file (Phase 1 owns
it; keeping the draft separate avoids a merge conflict on a shared doc).

Derived from PRD `docs/ts-sqlite.md` §11/§13/§14 plus a behavioural capture of
the V1 implementation (`tests/fixtures/golden/v1/`, regenerate with
`capture.sh`, verify with `capture.sh --check`).

---

## 1. Monitors (Phase 4)

### 1.1 Lifecycle vs observed state

Two orthogonal columns, routinely conflated in V1:

- `state` — the *observed agent state* of the target pane (`working`, `running`,
  `idle`, `done`, …). Changes on every poll. Not a lifecycle.
- `terminal_status` — the *monitor's own lifecycle*. `NULL` while the monitor is
  active; set exactly once, then absorbing.

### 1.2 Terminal-status taxonomy

| status | trigger | who writes it |
|---|---|---|
| `done` | target left the working set (`agent_state_is_working` false) | `monitor-run` poll loop |
| `timeout` | `now - started_at_ms >= timeout_ms` while still working | `monitor-run` poll loop |
| `killed` | operator ran `monitor-kill <id>` | `monitor-kill` |
| `target_gone` | `pane_id` no longer resolves in tmux | poll loop or `monitor-list` reconcile |
| `process_gone` | owner PID absent, or lease expired with no fresh heartbeat | `monitor-list` reconcile |
| `error` | poll loop raised an unexpected failure | `monitor-run` |

State machine: `active (terminal_status IS NULL) → <one terminal status>`.
Terminal is absorbing — a second transition, or a heartbeat against a terminal
row, is an illegal transition and must be rejected with a structured error
(`src/domains/monitors/terminal.ts`), not silently ignored.

### 1.3 V1 TSV → `monitors` mapping (feeds Phase 9 import)

V1 record: one `/tmp/tmux-picker-state-$UID/monitors/<id>.tsv` per monitor,
fields `type, id, pid, target, pane, state, start, timeout, interval, updated`.

| TSV field | column | conversion |
|---|---|---|
| `id` | `id` | verbatim (`m<epoch>-<pane digits>-<pid>`) |
| `pid` | `owner_pid` | integer; the literal `starting` sentinel → `NULL` |
| `target` | `target` | verbatim (operator-supplied target string) |
| `pane` | `pane_id` | verbatim (`%N`) |
| — | `session_id` | **new**: resolve `#{session_id}` from `pane_id` at register time |
| — | `instance_id` | **new**: agent instance owning the pane (Phase 5), nullable |
| `state` | `state` | verbatim observed state |
| `start` | `started_at_ms` | seconds × 1000 |
| `updated` | `updated_at_ms`, `heartbeat_at_ms` | seconds × 1000 (V1 has one field for both) |
| `timeout` | `timeout_ms` | seconds × 1000; V1's `0` (= no timeout) → `NULL` |
| `interval` | `interval_ms` | seconds × 1000 |
| — | `lease_expires_at_ms` | **new**: `heartbeat_at_ms + max(3 × interval_ms, 30_000)` |
| — | `terminal_status`, `terminal_at_ms`, `terminal_detail` | **new**; imported rows are active (TSV rows only exist while alive), so `NULL` |

Historical `monitor.started` / `monitor.done` / `monitor.timeout` /
`monitor.killed` journal events reconstruct terminal history for monitors whose
TSV file is already gone (Phase 9 wires the import; V1 deletes the TSV on exit,
so the journal is the only record of any completed monitor).

### 1.4 Lease rule

`lease_expires_at_ms = heartbeat_at_ms + max(3 × interval_ms, 30_000)`.

Three missed poll ticks, floored at 30 s so short intervals do not produce a
lease that expires inside normal scheduling jitter. Reconciliation (on
`monitor-list`) marks rows past their lease with no fresh heartbeat as
`process_gone` — this is the crash-mid-poll case, where V1 leaves an orphan TSV
until someone happens to run `monitor-list` with a dead PID.

### 1.5 V1 behaviours the V2 path must preserve

- `monitor-agent` prints the registration row **before** the background poller
  has a PID (`pid` column = `starting`), then rewrites it. Stdout must keep the
  same 10-column TSV shape.
- `monitor-list` sorts by `start`, then `id` (`sort -t $'\t' -k6,6 -k2,2`).
- `monitor-kill` on an unknown id: `monitor-kill: not found: <id>` on stderr,
  exit 1.
- V1 `monitor-list` **mutates on read** (re-observes the pane and rewrites every
  TSV). V2 keeps the re-observation but writes heartbeat columns in place — no
  historical row per tick, no `/tmp` write at all under `XTMUX_OBS_V2=1`.

---

## 2. Command telemetry (Phase 7)

### 2.1 tool / operation taxonomy

`command_runs.tool` ∈ `{git, bd, gh}`. `operation` is the V1 event name minus
the tool prefix, so the journal envelope `type` stays byte-identical:

| tool | argv shape | `operation` | journal `type` |
|---|---|---|---|
| git | `commit …` | `commit` | `git.commit` |
| git | `push …` | `push` | `git.push` |
| git | `merge …` | `merge` | `git.merge` |
| git | anything else | `command` | `git.command` |
| bd | `create …` | `create` | `bd.create` |
| bd | `close …` | `close` | `bd.close` |
| bd | `remember …` | `remember` | `bd.remember` |
| bd | `update … --claim` | `claim` | `bd.claim` |
| bd | `update …` (no `--claim`) | `update` | `bd.update` |
| bd | anything else | `command` | `bd.command` |
| gh | `pr create …` | `pr.create` | `git.pr.create` |
| gh | `pr merge …` | `pr.merge` | `git.pr.merge` |
| gh | anything else | `command` | `gh.command` |

`terminal_status` ∈ `{success, failed, interrupted}`: `success` when
`exit_code = 0`, `failed` when non-zero, `interrupted` when the wrapper died
before writing a result (`finished_at_ms IS NULL` at reconciliation).

### 2.2 Insert-then-update

One row per invocation. `INSERT` with `started_at_ms` + `branch_before` /
`head_before`, run the real command, `UPDATE` the same row with
`finished_at_ms`, `exit_code`, `terminal_status`, `branch_after` / `head_after`.
Both writes emit a journal envelope sharing `command_runs.id` as
`correlation_id`. V1 emits `telemetry.command.started` then the per-event type —
the same two envelopes, now correlated.

Git before/after metadata is captured only for `tool=git|gh` (V1 does the same:
the `bd` branch skips `git_repo_root` / `git_current_branch` / `git_head_hash`).

### 2.3 Interrupted-run reconciliation

A row with `finished_at_ms IS NULL` is either in flight or orphaned. Rule:

1. **PID check (authoritative).** `owner_pid` absent → `interrupted`.
2. **Age threshold (fallback**, when the PID may have been recycled or the row
   came from another host**).** `started_at_ms` older than **15 minutes** →
   `interrupted`.

15 min is above the p99 of any wrapped command in this repo's history (the slow
tail is `gh pr create` and `bd close`, both seconds) while staying short enough
that an incomplete-run query is useful during a session.

Reconciliation runs opportunistically on the next telemetry invocation and on
`monitor-list` — no daemon.

> **Contract deviation (needs 1.1 sign-off):** PRD §13's `command_runs` DDL has
> no PID column, which leaves only the age threshold and makes `interrupted`
> detection a guess. Proposal: add `owner_pid INTEGER`. Same shape as
> `monitors.owner_pid`, and it makes rule 1 exact.

### 2.4 Sample queries (Phase 7 OUTPUT)

```sql
-- PR created but never merged
SELECT c.bead_id, c.argv, c.started_at_ms FROM command_runs c
WHERE c.operation = 'pr.create' AND c.terminal_status = 'success'
  AND NOT EXISTS (SELECT 1 FROM command_runs m
                  WHERE m.operation = 'pr.merge' AND m.repo = c.repo
                    AND m.started_at_ms > c.started_at_ms);

-- failed bead-close rate
SELECT terminal_status, COUNT(*) FROM command_runs
WHERE tool = 'bd' AND operation = 'close' GROUP BY terminal_status;

-- incomplete runs (candidates for reconciliation)
SELECT id, tool, operation, started_at_ms FROM command_runs
WHERE finished_at_ms IS NULL AND started_at_ms < :now_ms - 900000;

-- last push per bead
SELECT bead_id, MAX(finished_at_ms) FROM command_runs
WHERE operation = 'push' AND terminal_status = 'success' GROUP BY bead_id;
```

---

## 3. Audit (Phase 8)

### 3.1 Closed enums

`severity` ∈ `{warning, cleanup}` — exactly V1's two output classes, so stdout
stays byte-identical.

`kind` ∈ `{missing-path, stale-specialist, dirty-worktree, shared-worktree,
working-do-not-kill, naming-convention, agent-pane-without-bead}`.

| kind | severity | V1 trigger |
|---|---|---|
| `missing-path` | cleanup | session cwd no longer exists on disk |
| `stale-specialist` | cleanup | `sp-*` session whose state is `done` or empty |
| `dirty-worktree` | warning | session's repo has uncommitted changes |
| `shared-worktree` | warning | worktree used by more than one live session |
| `working-do-not-kill` | warning | pane state is in the working set |
| `naming-convention` | warning | session named `tmp-*`, `test-*`, `*-tmp`, `*-test`, or containing a space |
| `agent-pane-without-bead` | warning | pane advertises `@agent_state` but no `@agent_bead` |

### 3.2 Fingerprint recipe

```
fingerprint = sha256( "v1" ␟ kind ␟ k1=v1 ␟ k2=v2 … )[:32]      # ␟ = 0x1F
```

Keys sorted, values raw (no normalization beyond trimming). Pure function of
its inputs — no PID, no timestamp, no random — so it is stable across process
restarts, which is exactly what the `last_seen_ms`-advances-not-duplicates
requirement needs.

Identity tuple per kind — deliberately **excludes** the volatile part of the
finding (the dirty *count*, the observed *state*), because a finding that says
"this worktree is dirty" is the same finding whether 3 or 30 files changed. The
volatile part lives in `detail_json` and is overwritten on each observation.

| kind | identity keys | in `detail_json` only |
|---|---|---|
| `missing-path` | `session_name`, `path` | — |
| `stale-specialist` | `session_name` | `state` |
| `dirty-worktree` | `session_name`, `path` | `dirty_count`, `repo` |
| `shared-worktree` | `session_name`, `path` | `repo`, `peers` |
| `working-do-not-kill` | `session_name` | `state` |
| `naming-convention` | `session_name` | — |
| `agent-pane-without-bead` | `session_name`, `pane_index` | `state`, `cmd`, `pane_id` |

`pane_index` (`window:pane`), not `pane_id` — tmux recycles `%N` on restart, so
a `pane_id`-keyed fingerprint would create a fresh finding every tmux restart.

> **Contract deviation (needs 1.1 sign-off):** PRD §14's `audit_findings` DDL
> carries `session_id` but not `session_name`. `session_id` (`$N`) is a
> per-instance handle: recreate the session, get a new one, and every finding
> re-fingerprints as new. Fingerprints key on the *name* (which is what the
> operator's naming convention makes durable). Proposal: add `session_name
> TEXT`; keep `session_id` as the live-instance pointer.

### 3.3 Observation and resolution

Each observation is one upsert. `run_id` pins the run that first saw the finding;
`last_run_id` tracks the most recent one, and that is what resolution keys on —
`run_id` cannot serve, because a finding seen in ten consecutive runs still
carries the *first* run's id.

```sql
INSERT INTO audit_findings (run_id, last_run_id, fingerprint, severity, kind,
                            session_id, session_name, pane_id, repo, path,
                            detail_json, first_seen_ms, last_seen_ms)
VALUES (:run_id, :run_id, :fp, :severity, :kind, :sid, :sname, :pane, :repo, :path,
        :detail, :now_ms, :now_ms)
ON CONFLICT (fingerprint) DO UPDATE SET
    last_run_id    = :run_id,
    last_seen_ms   = :now_ms,
    resolved_at_ms = NULL,        -- it came back; same finding, not a new row
    detail_json    = :detail,     -- volatile part (dirty count, state) is overwritten
    session_id     = :sid,        -- live-instance pointer follows the current session
    pane_id        = :pane;
```

Resolution then runs once, after a **complete** audit:

```sql
UPDATE audit_findings SET resolved_at_ms = :run_completed_ms
WHERE resolved_at_ms IS NULL AND last_run_id <> :run_id;
```

Gated on completeness: `audit_runs.completed_at_ms` is written only after the
audit walks the whole dashboard without error. A partial audit (crash mid-run)
leaves it `NULL` and must never drive resolution — otherwise a crash halfway
through the session list mass-resolves every finding it simply did not reach.
This is why the resolution `UPDATE` lives in the same transaction as the
`completed_at_ms` write, and nowhere else.

### 3.4 V1 behaviours the V2 path must preserve

- Emission order follows the `dashboard expanded` walk, which is tmux
  enumeration order — **not** stable across runs. The golden fixture sorts
  before comparing; V2 must not "fix" the order, since that would change stdout.
- The header line `audit\tread-only\twarnings-and-cleanup-candidates` is emitted
  once, from the `dashboard` row.
- Findings go to stdout as TSV, one per line. Persistence is additive: stdout
  stays byte-identical under both flag modes.

---

## 4. DDL for the schema freeze (Phase 2 input)

Drop-in for `src/db/schema.ts` / the first migration. PRD §11/§13/§14 verbatim,
plus the indexes each phase's contract requires and the two deviations in §5.
`*_at_ms` are epoch milliseconds throughout.

```sql
CREATE TABLE IF NOT EXISTS monitors (
    id                  TEXT PRIMARY KEY,
    owner_pid           INTEGER,
    target              TEXT NOT NULL,
    session_id          TEXT,
    pane_id             TEXT NOT NULL,
    instance_id         TEXT,
    state               TEXT NOT NULL,          -- observed pane state, not lifecycle
    started_at_ms       INTEGER NOT NULL,
    updated_at_ms       INTEGER NOT NULL,
    heartbeat_at_ms     INTEGER,
    lease_expires_at_ms INTEGER,
    timeout_ms          INTEGER,                -- NULL = no timeout (V1 encodes this as 0)
    interval_ms         INTEGER NOT NULL,
    terminal_status     TEXT,                   -- NULL while active; absorbing once set
    terminal_at_ms      INTEGER,
    terminal_detail     TEXT,
    CHECK (terminal_status IS NULL OR terminal_status IN
           ('done','timeout','killed','target_gone','process_gone','error')),
    CHECK ((terminal_status IS NULL) = (terminal_at_ms IS NULL))
);
CREATE INDEX IF NOT EXISTS monitors_state_updated ON monitors (state, updated_at_ms);
CREATE INDEX IF NOT EXISTS monitors_pane          ON monitors (pane_id);
CREATE INDEX IF NOT EXISTS monitors_owner_pid     ON monitors (owner_pid);
-- reconciliation and monitor-list both scan "still active", so index it directly
CREATE INDEX IF NOT EXISTS monitors_active        ON monitors (lease_expires_at_ms)
    WHERE terminal_status IS NULL;

CREATE TABLE IF NOT EXISTS command_runs (
    id                  TEXT PRIMARY KEY,
    tool                TEXT NOT NULL,
    operation           TEXT NOT NULL,
    owner_pid           INTEGER,                -- DEVIATION, see §5.1
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
    CHECK (terminal_status IS NULL OR terminal_status IN ('success','failed','interrupted'))
);
CREATE INDEX IF NOT EXISTS command_runs_bead      ON command_runs (bead_id, started_at_ms);
CREATE INDEX IF NOT EXISTS command_runs_tool_op   ON command_runs (tool, operation, started_at_ms);
-- the incomplete-run query is the hot one for reconciliation
CREATE INDEX IF NOT EXISTS command_runs_incomplete ON command_runs (started_at_ms)
    WHERE finished_at_ms IS NULL;

CREATE TABLE IF NOT EXISTS audit_runs (
    id                  TEXT PRIMARY KEY,
    session_id          TEXT,
    started_at_ms       INTEGER NOT NULL,
    completed_at_ms     INTEGER,                -- NULL = partial; must NOT drive resolution
    warning_count       INTEGER,
    cleanup_count       INTEGER
);

CREATE TABLE IF NOT EXISTS audit_findings (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id              TEXT NOT NULL REFERENCES audit_runs(id),   -- run that FIRST saw it
    last_run_id         TEXT NOT NULL REFERENCES audit_runs(id),   -- run that saw it MOST RECENTLY
    fingerprint         TEXT NOT NULL,
    severity            TEXT NOT NULL,
    kind                TEXT NOT NULL,
    session_id          TEXT,                   -- live-instance pointer ($N), NOT identity
    session_name        TEXT,                   -- DEVIATION, see §5.2; this is the identity
    pane_id             TEXT,
    repo                TEXT,
    path                TEXT,
    detail_json         TEXT,
    first_seen_ms       INTEGER NOT NULL,
    last_seen_ms        INTEGER NOT NULL,
    resolved_at_ms      INTEGER,
    CHECK (severity IN ('warning','cleanup')),
    CHECK (kind IN ('missing-path','stale-specialist','dirty-worktree','shared-worktree',
                    'working-do-not-kill','naming-convention','agent-pane-without-bead'))
);
-- the dedup rule *is* this constraint: one row per fingerprint, forever. A repeat
-- observation UPDATEs last_seen_ms + last_run_id; it never inserts.
CREATE UNIQUE INDEX IF NOT EXISTS audit_findings_fp ON audit_findings (fingerprint);
CREATE INDEX IF NOT EXISTS audit_findings_open ON audit_findings (kind, last_seen_ms)
    WHERE resolved_at_ms IS NULL;
```

Note the partial indexes and `CHECK` constraints — they need `foreign_keys=ON`
and a SQLite new enough for partial indexes (3.8+; Bun's bundled SQLite is far
past that). The `(terminal_status IS NULL) = (terminal_at_ms IS NULL)` check is
what makes "terminal is absorbing" a schema invariant rather than a convention.

---

## 5. Open questions for Phase 1/2 (1.1)

1. `command_runs.owner_pid` — see §2.3.
2. `audit_findings.session_name` — see §3.2.
3. Journal envelope helper: which module exports the `event_journal` writer that
   domains 4/7/8 call (`src/domains/events/`)? Phases 4/7/8 all need
   `writeEnvelope({domain, event, correlation_id, …})` and should not each roll
   their own.
