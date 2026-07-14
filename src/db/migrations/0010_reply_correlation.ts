import type { Migration } from "../schema.ts";

export const migration: Migration = {
  version: 10,
  name: "reply correlation and obligation projections",
  up: `
    CREATE TEMP TABLE messages_receipts_backup AS
      SELECT message_id, recipient_id, read_at_ms, acked_at_ms, acked_by
        FROM message_receipts;
    CREATE TEMP TABLE messages_delivery_backup AS
      SELECT id, related_message_id
        FROM delivery_attempts
       WHERE related_message_id IS NOT NULL;
    CREATE TEMP TABLE messages_turn_backup AS
      SELECT id, parent_message_id
        FROM agent_turns
       WHERE parent_message_id IS NOT NULL;

    CREATE TABLE messages_new (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        message_key            TEXT NOT NULL UNIQUE,
        sender_id              TEXT NOT NULL,
        sender_pane_id         TEXT,
        recipient_id           TEXT NOT NULL,
        target_pane_id         TEXT,
        bead_id                TEXT,
        summary                TEXT NOT NULL,
        payload_json           TEXT,
        expects_reply          INTEGER NOT NULL DEFAULT 0
          CHECK (expects_reply IN (0, 1)),
        created_at_ms          INTEGER NOT NULL,
        reply_to_message_id    INTEGER,
        fulfilled_by_message_id INTEGER,
        fulfilled_at_ms        INTEGER,
        cancelled_at_ms        INTEGER,
        cancel_reason          TEXT,
        CHECK (reply_to_message_id IS NULL OR reply_to_message_id <> id),
        CHECK (
          (fulfilled_by_message_id IS NULL AND fulfilled_at_ms IS NULL)
          OR (fulfilled_by_message_id IS NOT NULL AND fulfilled_at_ms IS NOT NULL)
        ),
        CHECK (cancelled_at_ms IS NULL OR fulfilled_at_ms IS NULL),
        FOREIGN KEY (reply_to_message_id) REFERENCES messages_new(id) ON DELETE RESTRICT,
        FOREIGN KEY (fulfilled_by_message_id) REFERENCES messages_new(id) ON DELETE RESTRICT
    );

    INSERT INTO messages_new (
      id, message_key, sender_id, sender_pane_id, recipient_id, target_pane_id,
      bead_id, summary, payload_json, expects_reply, created_at_ms
    )
    SELECT id, message_key, sender_id, sender_pane_id, recipient_id, target_pane_id,
           bead_id, summary, payload_json, expects_reply, created_at_ms
      FROM messages;

    DROP TABLE messages;
    ALTER TABLE messages_new RENAME TO messages;

    INSERT INTO message_receipts (message_id, recipient_id, read_at_ms, acked_at_ms, acked_by)
      SELECT message_id, recipient_id, read_at_ms, acked_at_ms, acked_by
        FROM messages_receipts_backup;
    UPDATE delivery_attempts
       SET related_message_id = (SELECT related_message_id FROM messages_delivery_backup WHERE id = delivery_attempts.id)
     WHERE id IN (SELECT id FROM messages_delivery_backup);
    UPDATE agent_turns
       SET parent_message_id = (SELECT parent_message_id FROM messages_turn_backup WHERE id = agent_turns.id)
     WHERE id IN (SELECT id FROM messages_turn_backup);
    DROP TABLE messages_receipts_backup;
    DROP TABLE messages_delivery_backup;
    DROP TABLE messages_turn_backup;

    CREATE INDEX msg_recipient_id ON messages(recipient_id, id);
    CREATE INDEX msg_target_pane ON messages(target_pane_id, id);
    CREATE INDEX msg_bead_id ON messages(bead_id, id);
    CREATE INDEX msg_expected_reply ON messages(recipient_id, expects_reply, id);
    CREATE UNIQUE INDEX msg_one_reply_per_request
      ON messages(reply_to_message_id)
      WHERE reply_to_message_id IS NOT NULL;
    CREATE INDEX msg_pending_obligation
      ON messages(sender_id, sender_pane_id, created_at_ms, id)
      WHERE expects_reply = 1
        AND fulfilled_at_ms IS NULL
        AND cancelled_at_ms IS NULL;
    CREATE INDEX msg_reply_target
      ON messages(reply_to_message_id, sender_id, sender_pane_id, id);
    CREATE INDEX msg_fulfilled_retention
      ON messages(fulfilled_at_ms, cancelled_at_ms, id)
      WHERE expects_reply = 1;

  `,
};
