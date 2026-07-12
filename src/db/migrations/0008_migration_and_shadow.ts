import type { Migration } from "../schema.ts";

// Phase 9 tables: migration_runs (importer report) + shadow_divergences
// (V1-vs-V2 comparison staging). See docs/observability-redesign.md §4.10, §4.11.
export const migration: Migration = {
  version: 8,
  name: "migration_runs, shadow_divergences",
  up: `
    CREATE TABLE IF NOT EXISTS migration_runs (
        id                  TEXT PRIMARY KEY,
        started_at_ms       INTEGER NOT NULL,
        completed_at_ms     INTEGER,
        mode                TEXT NOT NULL,
        source_manifest     TEXT NOT NULL,
        counts_json         TEXT,
        orphan_acks         INTEGER,
        malformed_records   INTEGER,
        unsupported_types   INTEGER,
        duplicates_skipped  INTEGER,
        CHECK (mode IN ('dry-run', 'apply'))
    );

    CREATE TABLE IF NOT EXISTS shadow_divergences (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        domain              TEXT NOT NULL,
        command             TEXT NOT NULL,
        diff_kind           TEXT NOT NULL,
        v1_snippet          TEXT,
        v2_snippet          TEXT,
        detail_json         TEXT,
        detected_at_ms      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sd_domain ON shadow_divergences(domain, detected_at_ms);
  `,
};
