import type { Migration } from "../schema.ts";

export const migration: Migration = {
  version: 9,
  name: "message reply expectation",
  up: `
    ALTER TABLE messages
      ADD COLUMN expects_reply INTEGER NOT NULL DEFAULT 0
      CHECK (expects_reply IN (0, 1));
    CREATE INDEX msg_expected_reply
      ON messages(recipient_id, expects_reply, id);
  `,
};
