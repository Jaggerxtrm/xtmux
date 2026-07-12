import type { Migration } from "../schema.ts";

// Version 5 reserved for Phase 7 command_runs (xt/ojsx).
// Version 6 reserved for Phase 8 audit (xt/ojsx).
// Version 7 lands Phase 6 handoffs (this worktree).
// See docs/observability-redesign.md §4.7.
export const migration: Migration = {
  version: 7,
  name: "handoffs",
  up: `
    CREATE TABLE IF NOT EXISTS handoffs (
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
        CHECK (state IN ('created','sent','delivery_failed','accepted','completed','cancelled')),
        FOREIGN KEY (source_instance_id)  REFERENCES agent_instances(instance_id),
        FOREIGN KEY (delivery_attempt_id) REFERENCES delivery_attempts(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS ho_target ON handoffs(target_session_id, id);
    CREATE INDEX IF NOT EXISTS ho_bead   ON handoffs(bead_id);
    -- reconciliation: unfinished handoffs
    CREATE INDEX IF NOT EXISTS ho_open   ON handoffs(state, created_at_ms)
      WHERE state IN ('created','sent','accepted');
  `,
};
