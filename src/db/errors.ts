export type DbErrorCode =
  | "XTMUX_DB_BUSY"
  | "XTMUX_DB_SCHEMA_MISMATCH"
  | "XTMUX_DB_MIGRATION_FAILED"
  | "XTMUX_DB_OPEN_FAILED";

export class DbError extends Error {
  readonly code: DbErrorCode;
  readonly detail: Record<string, unknown>;
  constructor(code: DbErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "DbError";
    this.code = code;
    this.detail = detail;
  }
  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, detail: this.detail };
  }
}

export function isBusyError(err: unknown): boolean {
  if (err instanceof DbError && err.code === "XTMUX_DB_BUSY") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /database is locked|busy|SQLITE_BUSY/i.test(msg);
}

/**
 * A collision on a UNIQUE column — for event_journal.event_key, this is how
 * idempotency is enforced: the second writer of the same keyed event loses, and
 * that is the intended outcome, not a failure.
 */
export function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(msg);
}
