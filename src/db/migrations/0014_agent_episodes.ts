import type { Migration } from "../schema.ts";

// xtmux-gdk: durable response episodes. One episode = one user prompt plus all
// Claude continuations caused before control genuinely returns to the operator
// (Stop-hook block follow-ups, which fire Stop again with stop_hook_active).
// agent_turns rows are candidates inside an episode; the viewer renders the
// episode (primary + substantive follow-ups, short acknowledgements collapsed)
// and never treats the latest row as the response.
export const migration: Migration = {
  version: 14,
  name: "agent_episodes + agent_turns.episode_id",
  up: `
    CREATE TABLE IF NOT EXISTS agent_episodes (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id         TEXT,
        session_id          TEXT NOT NULL,
        pane_id             TEXT NOT NULL,
        bead_id             TEXT,
        parent_session_id   TEXT,
        source_cursor       INTEGER,
        opened_at_ms        INTEGER NOT NULL,
        closed_at_ms        INTEGER,
        FOREIGN KEY (instance_id) REFERENCES agent_instances(instance_id)
    );
    CREATE INDEX IF NOT EXISTS ae_pane      ON agent_episodes(pane_id, id);
    -- the open-episode lookup for turn attach is the hot path
    CREATE INDEX IF NOT EXISTS ae_pane_open ON agent_episodes(pane_id) WHERE closed_at_ms IS NULL;

    ALTER TABLE agent_turns ADD COLUMN episode_id INTEGER;
    CREATE INDEX IF NOT EXISTS at_episode   ON agent_turns(episode_id, id);
  `,
};
