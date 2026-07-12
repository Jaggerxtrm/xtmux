import { createHash } from "node:crypto";
import type { Db } from "./connection.ts";
import { DbError } from "./errors.ts";
import { insertEnvelope } from "./journal.ts";
import { migration as m0001 } from "./migrations/0001_bootstrap.ts";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
}

export const MIGRATIONS: readonly Migration[] = [m0001];

const SCHEMA_MIGRATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
      version         INTEGER PRIMARY KEY,
      name            TEXT NOT NULL,
      applied_at_ms   INTEGER NOT NULL,
      checksum        TEXT NOT NULL
  );
`;

function checksum(up: string): string {
  return createHash("sha256").update(up).digest("hex").slice(0, 16);
}

export interface MigrationResult {
  applied: number[];
  skipped: number[];
  currentVersion: number;
}

export function migrate(db: Db, now: () => number = Date.now): MigrationResult {
  const startedAtMs = now();
  db.raw.exec(SCHEMA_MIGRATIONS_DDL);

  const applied: number[] = [];
  const skipped: number[] = [];

  const sortedMigrations = [...MIGRATIONS].sort((a, b) => a.version - b.version);
  for (let i = 0; i < sortedMigrations.length; i++) {
    if (sortedMigrations[i]!.version !== i + 1) {
      throw new DbError(
        "XTMUX_DB_MIGRATION_FAILED",
        `migration versions must be contiguous starting at 1; got ${sortedMigrations[i]!.version} at index ${i}`,
      );
    }
  }

  const seen = db.raw
    .query<{ version: number; checksum: string }, []>(
      "SELECT version, checksum FROM schema_migrations",
    )
    .all();
  const seenMap = new Map(seen.map((r) => [r.version, r.checksum]));

  const insertRow = db.raw.prepare<
    unknown,
    [number, string, number, string]
  >(
    "INSERT INTO schema_migrations (version, name, applied_at_ms, checksum) VALUES (?, ?, ?, ?)",
  );

  for (const m of sortedMigrations) {
    const cur = seenMap.get(m.version);
    const expected = checksum(m.up);
    if (cur !== undefined) {
      if (cur !== expected) {
        throw new DbError(
          "XTMUX_DB_SCHEMA_MISMATCH",
          `migration ${m.version} (${m.name}) already applied with different checksum`,
          { expected, actual: cur },
        );
      }
      skipped.push(m.version);
      continue;
    }
    const tx = db.raw.transaction(() => {
      db.raw.exec(m.up);
      insertRow.run(m.version, m.name, now(), expected);
    });
    try {
      tx();
    } catch (err) {
      throw new DbError(
        "XTMUX_DB_MIGRATION_FAILED",
        `migration ${m.version} (${m.name}) failed`,
        { cause: err instanceof Error ? err.message : String(err) },
      );
    }
    applied.push(m.version);
  }

  const currentVersion = sortedMigrations[sortedMigrations.length - 1]?.version ?? 0;

  // Envelope written only after event_journal exists (created by migration 1).
  // On a fresh DB this is safe: migration 1 runs before we get here.
  if (currentVersion >= 1) {
    const finishedAtMs = now();
    insertEnvelope(db, {
      type: "db.migration.apply",
      domain: "db",
      payload: {
        applied,
        skipped,
        currentVersion,
        outcome: "success",
        duration_ms: finishedAtMs - startedAtMs,
      },
      createdAtMs: finishedAtMs,
    });
  }

  return { applied, skipped, currentVersion };
}

export function currentSchemaVersion(db: Db): number {
  db.raw.exec(SCHEMA_MIGRATIONS_DDL);
  const row = db.raw
    .query<{ v: number | null }, []>("SELECT MAX(version) AS v FROM schema_migrations")
    .get();
  return row?.v ?? 0;
}
