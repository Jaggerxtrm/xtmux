import type { Migration } from "../schema.ts";

export const migration: Migration = {
  version: 10,
  name: "reply correlation and obligation projections",
  up: `
    DROP INDEX IF EXISTS msg_recipient_id;
    DROP INDEX IF EXISTS msg_target_pane;
    DROP INDEX IF EXISTS msg_bead_id;
    DROP INDEX IF EXISTS msg_expected_reply;
    DROP INDEX IF EXISTS rcpt_unacked;
    DROP INDEX IF EXISTS da_target;
    DROP INDEX IF EXISTS da_kind;
    DROP INDEX IF EXISTS at_session;
    DROP INDEX IF EXISTS at_bead;
    DROP INDEX IF EXISTS ho_target;
    DROP INDEX IF EXISTS ho_bead;
    DROP INDEX IF EXISTS ho_open;

    ALTER TABLE messages RENAME TO messages_old;
    CREATE TABLE messages (
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
        FOREIGN KEY (reply_to_message_id) REFERENCES messages(id) ON DELETE RESTRICT,
        FOREIGN KEY (fulfilled_by_message_id) REFERENCES messages(id) ON DELETE RESTRICT
    );
    INSERT INTO messages (
      id, message_key, sender_id, sender_pane_id, recipient_id, target_pane_id,
      bead_id, summary, payload_json, expects_reply, created_at_ms
    )
    SELECT id, message_key, sender_id, sender_pane_id, recipient_id, target_pane_id,
           bead_id, summary, payload_json, expects_reply, created_at_ms
      FROM messages_old;

    ALTER TABLE message_receipts RENAME TO message_receipts_old;
    CREATE TABLE message_receipts (
        message_id      INTEGER NOT NULL,
        recipient_id    TEXT NOT NULL,
        read_at_ms      INTEGER,
        acked_at_ms     INTEGER,
        acked_by        TEXT,
        PRIMARY KEY (message_id, recipient_id),
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );
    INSERT INTO message_receipts (message_id, recipient_id, read_at_ms, acked_at_ms, acked_by)
      SELECT message_id, recipient_id, read_at_ms, acked_at_ms, acked_by
        FROM message_receipts_old;
    DROP TABLE message_receipts_old;

    ALTER TABLE delivery_attempts RENAME TO delivery_attempts_old;
    ALTER TABLE handoffs RENAME TO handoffs_old;
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
        details_json        TEXT,
        FOREIGN KEY (related_message_id) REFERENCES messages(id) ON DELETE SET NULL
    );
    INSERT INTO delivery_attempts (
      id, kind, source_session_id, target_session_id, target_pane_id,
      related_message_id, related_handoff_id, payload_summary, attempted_at_ms,
      succeeded, failure_code, details_json
    )
    SELECT id, kind, source_session_id, target_session_id, target_pane_id,
           related_message_id, related_handoff_id, payload_summary, attempted_at_ms,
           succeeded, failure_code, details_json
      FROM delivery_attempts_old;
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
        delivery_attempt_id   INTEGER,
        CHECK (state IN ('created','sent','delivery_failed','accepted','completed','cancelled')),
        FOREIGN KEY (source_instance_id)  REFERENCES agent_instances(instance_id),
        FOREIGN KEY (delivery_attempt_id) REFERENCES delivery_attempts(id) ON DELETE SET NULL
    );
    INSERT INTO handoffs (
      id, source_instance_id, source_session_id, target_session_id, target_pane_id,
      bead_id, parent_session_id, prompt_file, prompt_file_hash, summary, state,
      created_at_ms, sent_at_ms, accepted_at_ms, completed_at_ms, failure_code,
      delivery_attempt_id
    )
    SELECT id, source_instance_id, source_session_id, target_session_id, target_pane_id,
           bead_id, parent_session_id, prompt_file, prompt_file_hash, summary, state,
           created_at_ms, sent_at_ms, accepted_at_ms, completed_at_ms, failure_code,
           delivery_attempt_id
      FROM handoffs_old;
    DROP TABLE handoffs_old;
    DROP TABLE delivery_attempts_old;

    ALTER TABLE agent_turns RENAME TO agent_turns_old;
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
        UNIQUE(instance_id, turn_index),
        FOREIGN KEY (instance_id)       REFERENCES agent_instances(instance_id),
        FOREIGN KEY (parent_message_id) REFERENCES messages(id) ON DELETE SET NULL
    );
    INSERT INTO agent_turns (
      id, instance_id, session_id, pane_id, bead_id, parent_session_id,
      turn_index, summary, completed_at_ms, parent_message_id
    )
    SELECT id, instance_id, session_id, pane_id, bead_id, parent_session_id,
           turn_index, summary, completed_at_ms, parent_message_id
      FROM agent_turns_old;
    DROP TABLE agent_turns_old;
    DROP TABLE messages_old;

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
    CREATE INDEX rcpt_unacked ON message_receipts(recipient_id, acked_at_ms);
    CREATE INDEX da_target ON delivery_attempts(target_session_id, id);
    CREATE INDEX da_kind ON delivery_attempts(kind, id);
    CREATE INDEX at_session ON agent_turns(session_id, id);
    CREATE INDEX at_bead ON agent_turns(bead_id, id);
    CREATE INDEX ho_target ON handoffs(target_session_id, id);
    CREATE INDEX ho_bead ON handoffs(bead_id);
    CREATE INDEX ho_open ON handoffs(state, created_at_ms)
      WHERE state IN ('created','sent','accepted');
  `,
};
