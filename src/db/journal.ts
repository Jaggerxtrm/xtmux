import type { Db } from "./connection.ts";

export interface Envelope {
  eventKey?: string | undefined;
  type: string;
  domain: string;
  sessionId?: string | undefined;
  paneId?: string | undefined;
  instanceId?: string | undefined;
  beadId?: string | undefined;
  correlationId?: string | undefined;
  payload: Record<string, unknown>;
  createdAtMs: number;
}

export function insertEnvelope(db: Db, env: Envelope): number {
  const stmt = db.raw.prepare<
    { id: number },
    [
      string | null,
      string,
      string,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      string,
      number,
    ]
  >(
    `INSERT INTO event_journal
       (event_key, type, domain, session_id, pane_id, instance_id, bead_id, correlation_id, payload_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  );
  const row = stmt.get(
    env.eventKey ?? null,
    env.type,
    env.domain,
    env.sessionId ?? null,
    env.paneId ?? null,
    env.instanceId ?? null,
    env.beadId ?? null,
    env.correlationId ?? null,
    JSON.stringify(env.payload),
    env.createdAtMs,
  );
  return row?.id ?? 0;
}
