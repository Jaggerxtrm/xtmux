import type { Migration } from "../schema.ts";

/**
 * Tables owned by phases 4 (monitors), 7 (command telemetry), 8 (audit).
 * PRD §11/§13/§14. Rationale for every index and CHECK:
 * docs/ts-sqlite-domains-4-7-8.md §4.
 *
 * Three columns are not in the PRD's suggested DDL:
 *   - command_runs.owner_pid       — without it, `interrupted` is an age-threshold guess
 *   - audit_findings.session_name  — tmux session_id ($N) is per-instance, so
 *                                    fingerprinting on it re-mints every finding
 *                                    whenever a session is recreated
 *   - audit_findings.last_run_id   — with one row per fingerprint, run_id stays pinned
 *                                    to the FIRST run that saw a finding, so resolution
 *                                    keyed on run_id would match nothing, ever
 */
const up = `
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
  CREATE INDEX IF NOT EXISTS mon_state_updated ON monitors(state, updated_at_ms);
  CREATE INDEX IF NOT EXISTS mon_pane          ON monitors(pane_id);
  CREATE INDEX IF NOT EXISTS mon_owner_pid     ON monitors(owner_pid);
  CREATE INDEX IF NOT EXISTS mon_active        ON monitors(lease_expires_at_ms)
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
  CREATE INDEX IF NOT EXISTS cr_bead       ON command_runs(bead_id, started_at_ms);
  CREATE INDEX IF NOT EXISTS cr_tool_op    ON command_runs(tool, operation, started_at_ms);
  CREATE INDEX IF NOT EXISTS cr_incomplete ON command_runs(started_at_ms)
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
  CREATE UNIQUE INDEX IF NOT EXISTS af_fingerprint ON audit_findings(fingerprint);
  CREATE INDEX IF NOT EXISTS        af_open        ON audit_findings(kind, last_seen_ms)
      WHERE resolved_at_ms IS NULL;
`;

export const migration: Migration = {
  version: 3,
  name: "domains 4/7/8: monitors, command_runs, audit_runs, audit_findings",
  up,
};
