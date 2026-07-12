/**
 * DDL for the tables owned by phases 4 / 7 / 8 (PRD §11/§13/§14).
 *
 * Exported as a string so Phase 2's migration framework can apply it as one
 * versioned step, and so the contract tests can stand the tables up in an
 * in-memory DB without the framework. Rationale for every index and CHECK:
 * docs/ts-sqlite-domains-4-7-8.md §4.
 */
export const DDL_DOMAINS_4_7_8 = `
CREATE TABLE IF NOT EXISTS monitors (
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
    CHECK (terminal_status IS NULL OR terminal_status IN
           ('done','timeout','killed','target_gone','process_gone','error')),
    CHECK ((terminal_status IS NULL) = (terminal_at_ms IS NULL))
);
CREATE INDEX IF NOT EXISTS monitors_state_updated ON monitors (state, updated_at_ms);
CREATE INDEX IF NOT EXISTS monitors_pane          ON monitors (pane_id);
CREATE INDEX IF NOT EXISTS monitors_owner_pid     ON monitors (owner_pid);
CREATE INDEX IF NOT EXISTS monitors_active        ON monitors (lease_expires_at_ms)
    WHERE terminal_status IS NULL;

CREATE TABLE IF NOT EXISTS command_runs (
    id                  TEXT PRIMARY KEY,
    tool                TEXT NOT NULL,
    operation           TEXT NOT NULL,
    owner_pid           INTEGER,
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
CREATE INDEX IF NOT EXISTS command_runs_bead       ON command_runs (bead_id, started_at_ms);
CREATE INDEX IF NOT EXISTS command_runs_tool_op    ON command_runs (tool, operation, started_at_ms);
CREATE INDEX IF NOT EXISTS command_runs_incomplete ON command_runs (started_at_ms)
    WHERE finished_at_ms IS NULL;

CREATE TABLE IF NOT EXISTS audit_runs (
    id                  TEXT PRIMARY KEY,
    session_id          TEXT,
    started_at_ms       INTEGER NOT NULL,
    completed_at_ms     INTEGER,
    warning_count       INTEGER,
    cleanup_count       INTEGER
);

CREATE TABLE IF NOT EXISTS audit_findings (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id              TEXT NOT NULL REFERENCES audit_runs(id),
    last_run_id         TEXT NOT NULL REFERENCES audit_runs(id),
    fingerprint         TEXT NOT NULL,
    severity            TEXT NOT NULL,
    kind                TEXT NOT NULL,
    session_id          TEXT,
    session_name        TEXT,
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
CREATE UNIQUE INDEX IF NOT EXISTS audit_findings_fp   ON audit_findings (fingerprint);
CREATE INDEX IF NOT EXISTS        audit_findings_open ON audit_findings (kind, last_seen_ms)
    WHERE resolved_at_ms IS NULL;
`
