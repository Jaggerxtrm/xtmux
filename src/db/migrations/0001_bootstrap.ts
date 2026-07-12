import type { Migration } from "../schema.ts";

export const migration: Migration = {
  version: 1,
  name: "bootstrap: schema_migrations + event_journal skeleton",
  up: `
    CREATE TABLE IF NOT EXISTS event_journal (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key       TEXT UNIQUE,
        type            TEXT NOT NULL,
        domain          TEXT NOT NULL,
        session_id      TEXT,
        pane_id         TEXT,
        instance_id     TEXT,
        bead_id         TEXT,
        correlation_id  TEXT,
        payload_json    TEXT NOT NULL,
        created_at_ms   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ev_type_id     ON event_journal(type, id);
    CREATE INDEX IF NOT EXISTS ev_session_id  ON event_journal(session_id, id);
    CREATE INDEX IF NOT EXISTS ev_pane_id     ON event_journal(pane_id, id);
    CREATE INDEX IF NOT EXISTS ev_bead_id     ON event_journal(bead_id, id);
    CREATE INDEX IF NOT EXISTS ev_correlation ON event_journal(correlation_id);
    CREATE INDEX IF NOT EXISTS ev_domain_id   ON event_journal(domain, id);
  `,
};
