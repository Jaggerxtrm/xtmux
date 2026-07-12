import type { Migration } from "../schema.ts";

export const migration: Migration = {
  version: 2,
  name: "messages, message_receipts, delivery_attempts",
  up: `
    -- recipient_id is the durable session-id addressing key ($N in tmux) per
    -- docs/observability-redesign.md §3. sender_pane_id / target_pane_id are
    -- optional finer-grained addressing hints; they exist because two panes of
    -- the same tmux session collapse to the same session_id, so pure
    -- session-level addressing loses sender identity when panes talk to each
    -- other. Filtering on target_pane_id keeps message-list scoped to the
    -- actual recipient pane when the caller passed --to <pane|session:w.p>.
    CREATE TABLE IF NOT EXISTS messages (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        message_key        TEXT NOT NULL UNIQUE,
        sender_id          TEXT NOT NULL,
        sender_pane_id     TEXT,
        recipient_id       TEXT NOT NULL,
        target_pane_id     TEXT,
        bead_id            TEXT,
        summary            TEXT NOT NULL,
        payload_json       TEXT,
        created_at_ms      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS msg_recipient_id ON messages(recipient_id, id);
    CREATE INDEX IF NOT EXISTS msg_target_pane  ON messages(target_pane_id, id);
    CREATE INDEX IF NOT EXISTS msg_bead_id      ON messages(bead_id, id);

    CREATE TABLE IF NOT EXISTS message_receipts (
        message_id      INTEGER NOT NULL,
        recipient_id    TEXT NOT NULL,
        read_at_ms      INTEGER,
        acked_at_ms     INTEGER,
        acked_by        TEXT,
        PRIMARY KEY (message_id, recipient_id),
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS rcpt_unacked ON message_receipts(recipient_id, acked_at_ms);

    CREATE TABLE IF NOT EXISTS delivery_attempts (
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
    CREATE INDEX IF NOT EXISTS da_target ON delivery_attempts(target_session_id, id);
    CREATE INDEX IF NOT EXISTS da_kind   ON delivery_attempts(kind, id);
  `,
};
