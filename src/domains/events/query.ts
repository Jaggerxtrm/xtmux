import type { Db } from "../../db/connection.ts";
import { insertEnvelope } from "../../db/journal.ts";

export interface JournalRow {
  id: number;
  event_key: string | null;
  type: string;
  domain: string;
  session_id: string | null;
  pane_id: string | null;
  instance_id: string | null;
  bead_id: string | null;
  correlation_id: string | null;
  payload_json: string;
  created_at_ms: number;
}

export interface EmitInput {
  type: string;
  fields: Record<string, string>;
}

/** Compatibility shim for `log emit <type> k=v k=v …` — arbitrary custom events. */
export function emitEvent(db: Db, input: EmitInput, now: () => number = Date.now): number {
  const t = now();
  return insertEnvelope(db, {
    type: input.type,
    domain: "custom",
    sessionId: input.fields["session"] ?? input.fields["session_id"],
    paneId: input.fields["pane"] ?? input.fields["pane_id"],
    beadId: input.fields["bead"] ?? input.fields["bead_id"],
    payload: input.fields,
    createdAtMs: t,
  });
}

export interface QueryInput {
  type?: string | undefined;
  sessionId?: string | undefined;
  paneId?: string | undefined;
  beadId?: string | undefined;
  sinceMs?: number | undefined;
  limit?: number | undefined;
}

export function tail(db: Db, limit = 50): JournalRow[] {
  const stmt = db.raw.prepare<JournalRow, [number]>(
    "SELECT * FROM event_journal ORDER BY id DESC LIMIT ?",
  );
  return stmt.all(Math.max(1, Math.min(limit, 5000)));
}

export function query(db: Db, input: QueryInput): JournalRow[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (input.type !== undefined)      { clauses.push("type = ?");           params.push(input.type); }
  if (input.sessionId !== undefined) { clauses.push("session_id = ?");     params.push(input.sessionId); }
  if (input.paneId !== undefined)    { clauses.push("pane_id = ?");        params.push(input.paneId); }
  if (input.beadId !== undefined)    { clauses.push("bead_id = ?");        params.push(input.beadId); }
  if (input.sinceMs !== undefined)   { clauses.push("created_at_ms >= ?"); params.push(input.sinceMs); }
  const limit = Math.max(1, Math.min(input.limit ?? 200, 5000));
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT * FROM event_journal ${where} ORDER BY id DESC LIMIT ${limit}`;
  const stmt = db.raw.prepare<JournalRow, (string | number)[]>(sql);
  return stmt.all(...params);
}
