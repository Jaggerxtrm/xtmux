import type { Migration } from "../schema.ts";

/** Reserved for xtmux-3ua.3; register in schema.ts after reply migration 0010 lands. */
export const migration: Migration = {
  version: 11,
  name: "outbound wake ownership",
  up: `
    CREATE TABLE IF NOT EXISTS outbound_waits (
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
        CHECK (state IN ('unarmed','armed','terminal-unconsumed','consumed','cancelled','expired')),
        CHECK (terminal_status IS NULL OR terminal_status IN
               ('done','timeout','killed','target_gone','process_gone','error')),
        CHECK ((state IN ('terminal-unconsumed','consumed') AND terminal_status IS NOT NULL)
               OR state NOT IN ('terminal-unconsumed','consumed')),
        CHECK (wake_consumed_at_ms IS NULL OR wake_delivered_at_ms IS NOT NULL),
        FOREIGN KEY (related_message_id) REFERENCES messages(id) ON DELETE SET NULL,
        FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ow_monitor_once ON outbound_waits(monitor_id)
      WHERE monitor_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ow_requester_pending
      ON outbound_waits(requester_session_id, requester_pane_id, state, updated_at_ms)
      WHERE state IN ('unarmed','armed','terminal-unconsumed');
    CREATE INDEX IF NOT EXISTS ow_target_active
      ON outbound_waits(target_session_id, target_pane_id, state, updated_at_ms)
      WHERE state IN ('unarmed','armed');
    CREATE INDEX IF NOT EXISTS ow_wake_delivery
      ON outbound_waits(requester_session_id, requester_pane_id, wake_delivered_at_ms, id)
      WHERE state = 'terminal-unconsumed' AND wake_consumed_at_ms IS NULL;
    CREATE INDEX IF NOT EXISTS ow_retention ON outbound_waits(updated_at_ms, state);
  `,
};
