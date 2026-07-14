import { createHash } from "node:crypto";
import type { Db } from "./connection.ts";
import { DbError } from "./errors.ts";
import { insertEnvelope } from "./journal.ts";
import { migration as m0001 } from "./migrations/0001_bootstrap.ts";
import { migration as m0002 } from "./migrations/0002_messages.ts";
// migration 3 combines Phase 4 monitors + Phase 7 command_runs + Phase 8 audit
// (contributed on xt/ojsx by xtmux:1.2, originally at version 2 there; bumped
// to 3 here because messages already occupies version 2 on xt/hnjk)
import { migration as m0003 } from "./migrations/0003_domains_4_7_8.ts";
import { migration as m0004 } from "./migrations/0004_agents.ts";
import { migration as m0007 } from "./migrations/0007_handoffs.ts";
import { migration as m0008 } from "./migrations/0008_migration_and_shadow.ts";
import { migration as m0009 } from "./migrations/0009_message_reply_expectation.ts";
import { migration as m0010 } from "./migrations/0010_reply_correlation.ts";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
}

export const MIGRATIONS: readonly Migration[] = [m0001, m0002, m0003, m0004, m0007, m0008, m0009, m0010];

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
  // Versions must be strictly increasing but need not be contiguous — versions
  // are reserved across parallel worktrees (Phase 4 owns 3, Phase 5 owns 4,
  // Phase 7 owns 5, …). Gaps close when the reserved worktree merges.
  for (let i = 1; i < sortedMigrations.length; i++) {
    if (sortedMigrations[i]!.version <= sortedMigrations[i - 1]!.version) {
      throw new DbError(
        "XTMUX_DB_MIGRATION_FAILED",
        `migration versions must be strictly increasing; got ${sortedMigrations[i - 1]!.version} then ${sortedMigrations[i]!.version}`,
      );
    }
  }

  const insertRow = db.raw.prepare<
    unknown,
    [number, string, number, string]
  >(
    "INSERT INTO schema_migrations (version, name, applied_at_ms, checksum) VALUES (?, ?, ?, ?)",
  );

  // Read the applied set and write the missing migrations in ONE transaction, and
  // take the write lock up front with BEGIN IMMEDIATE.
  //
  // Several picker invocations can hit a virgin DB at once. Reading
  // schema_migrations outside the transaction let two processes both decide a
  // migration was unapplied; the loser then died on "UNIQUE constraint failed:
  // schema_migrations.version". A *deferred* transaction does not fix that on its
  // own: SQLite will not honour busy_timeout when upgrading a deferred read lock
  // to a write lock (waiting could deadlock), so the loser failed instantly with a
  // raw "database is locked" instead of waiting its turn. IMMEDIATE takes the
  // write lock before reading, so the loser blocks for busy_timeout and then sees
  // the winner's committed rows and skips them.
  const runMigrations = db.raw.transaction(() => {
    const seen = db.raw
      .query<{ version: number; checksum: string }, []>(
        "SELECT version, checksum FROM schema_migrations",
      )
      .all();
    const seenMap = new Map(seen.map((r) => [r.version, r.checksum]));

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
      try {
        db.raw.exec(m.up);
        insertRow.run(m.version, m.name, now(), expected);
      } catch (err) {
        throw new DbError(
          "XTMUX_DB_MIGRATION_FAILED",
          `migration ${m.version} (${m.name}) failed`,
          { cause: err instanceof Error ? err.message : String(err) },
        );
      }
      applied.push(m.version);
    }
  });

  try {
    runMigrations.immediate();
  } catch (err) {
    // DbError is already the documented envelope — do not wrap it a second time.
    if (err instanceof DbError) throw err;
    throw new DbError("XTMUX_DB_MIGRATION_FAILED", "migration failed", {
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  const currentVersion = sortedMigrations[sortedMigrations.length - 1]?.version ?? 0;

  // Envelope written only when we actually applied a migration — reruns are
  // silent so `log tail` isn't polluted by CLI startup envelopes.
  if (currentVersion >= 1 && applied.length > 0) {
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
