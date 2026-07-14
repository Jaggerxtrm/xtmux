import type { Migration } from "../schema.ts";

export const migration: Migration = {
  version: 12,
  name: "handoff idempotency and monitor ownership",
  up: `
    ALTER TABLE handoffs ADD COLUMN handoff_key TEXT;
    ALTER TABLE handoffs ADD COLUMN monitor_id TEXT REFERENCES monitors(id);
    UPDATE handoffs SET handoff_key = id WHERE handoff_key IS NULL;
    CREATE UNIQUE INDEX ho_key ON handoffs(handoff_key);
    CREATE INDEX ho_monitor ON handoffs(monitor_id);
  `,
};
