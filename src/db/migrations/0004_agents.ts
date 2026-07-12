import type { Migration } from "../schema.ts";

// Reserve migration 3 for Phase 4 (monitors, owned by xtmux:1.2 / xt/ojsx).
// Migration 4 lands Phase 5 agents domain. See docs/observability-redesign.md §4.5.
export const migration: Migration = {
  version: 4,
  name: "agent_instances, agent_state_transitions, agent_turns",
  up: `
    CREATE TABLE IF NOT EXISTS agent_instances (
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
    CREATE INDEX IF NOT EXISTS ai_session_id ON agent_instances(session_id, started_at_ms);
    CREATE INDEX IF NOT EXISTS ai_pane_id    ON agent_instances(pane_id, started_at_ms);
    CREATE INDEX IF NOT EXISTS ai_bead_id    ON agent_instances(bead_id);
    -- partial index on active instances for the reconciliation scan
    CREATE INDEX IF NOT EXISTS ai_active     ON agent_instances(pane_id) WHERE ended_at_ms IS NULL;

    CREATE TABLE IF NOT EXISTS agent_state_transitions (
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
    CREATE INDEX IF NOT EXISTS ast_instance ON agent_state_transitions(instance_id, id);
    CREATE INDEX IF NOT EXISTS ast_pane     ON agent_state_transitions(pane_id, id);
    CREATE INDEX IF NOT EXISTS ast_session  ON agent_state_transitions(session_id, id);

    CREATE TABLE IF NOT EXISTS agent_turns (
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
    CREATE INDEX IF NOT EXISTS at_session ON agent_turns(session_id, id);
    CREATE INDEX IF NOT EXISTS at_bead    ON agent_turns(bead_id, id);
  `,
};
