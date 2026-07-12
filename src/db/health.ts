import type { Db } from "./connection.ts";
import { MIGRATIONS, currentSchemaVersion } from "./schema.ts";

export interface HealthReport {
  ok: boolean;
  dbPath: string;
  schemaVersion: number;
  expectedSchemaVersion: number;
  pragmas: {
    journalMode: string;
    synchronous: number;
    busyTimeoutMs: number;
    foreignKeys: number;
  };
  problems: string[];
}

interface PragmaJournalRow { journal_mode: string; }
interface PragmaIntRow { [k: string]: number; }

function pragmaString(db: Db, name: string): string {
  const row = db.raw.query<PragmaJournalRow, []>(`PRAGMA ${name}`).get();
  return row?.journal_mode ?? "";
}
function pragmaInt(db: Db, name: string): number {
  const row = db.raw.query<PragmaIntRow, []>(`PRAGMA ${name}`).get() as Record<string, number> | null;
  if (!row) return -1;
  const values = Object.values(row);
  return values[0] ?? -1;
}

export function checkHealth(db: Db, dbPath: string): HealthReport {
  const schemaVersion = currentSchemaVersion(db);
  const expected = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
  const journalMode = pragmaString(db, "journal_mode");
  const synchronous = pragmaInt(db, "synchronous");
  const busyTimeoutMs = pragmaInt(db, "busy_timeout");
  const foreignKeys = pragmaInt(db, "foreign_keys");

  const problems: string[] = [];
  if (journalMode.toLowerCase() !== "wal") problems.push(`journal_mode=${journalMode}, expected wal`);
  if (foreignKeys !== 1) problems.push(`foreign_keys=${foreignKeys}, expected 1`);
  if (busyTimeoutMs <= 0) problems.push(`busy_timeout=${busyTimeoutMs}, expected > 0`);
  if (schemaVersion !== expected) problems.push(`schema_version=${schemaVersion}, expected ${expected}`);

  return {
    ok: problems.length === 0,
    dbPath,
    schemaVersion,
    expectedSchemaVersion: expected,
    pragmas: { journalMode, synchronous, busyTimeoutMs, foreignKeys },
    problems,
  };
}
