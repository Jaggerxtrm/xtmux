import type { Db } from "../../db/connection.ts";
import { insertEnvelope } from "../../db/journal.ts";
import type { AgentInstanceRow, EndReason } from "./types.ts";

export interface OpenInstanceInput {
  instanceId: string;
  sessionId: string;
  sessionName?: string | undefined;
  paneId: string;
  runtime?: string | undefined;
  role?: string | undefined;
  beadId?: string | undefined;
  task?: string | undefined;
  promptFile?: string | undefined;
  parentSessionId?: string | undefined;
  sourceEvent: string;
}

/**
 * Idempotent on instance_id. Returns { created: true, instanceId } on first
 * open, { created: false } if a row already exists (e.g. duplicate launcher
 * event).
 */
export function openInstance(
  db: Db,
  input: OpenInstanceInput,
  now: () => number = Date.now,
): { created: boolean; instanceId: string } {
  const existing = db.raw
    .query<{ instance_id: string }, [string]>(
      "SELECT instance_id FROM agent_instances WHERE instance_id = ?",
    )
    .get(input.instanceId);
  if (existing) return { created: false, instanceId: input.instanceId };

  const insert = db.raw.prepare<
    unknown,
    [
      string, string, string | null, string, string | null, string | null,
      string | null, string | null, string | null, string | null, number,
    ]
  >(
    `INSERT INTO agent_instances
       (instance_id, session_id, session_name, pane_id, runtime, role,
        bead_id, task, prompt_file, parent_session_id, started_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const startedAtMs = now();
  const tx = db.raw.transaction(() => {
    insert.run(
      input.instanceId,
      input.sessionId,
      input.sessionName ?? null,
      input.paneId,
      input.runtime ?? null,
      input.role ?? null,
      input.beadId ?? null,
      input.task ?? null,
      input.promptFile ?? null,
      input.parentSessionId ?? null,
      startedAtMs,
    );
    insertEnvelope(db, {
      type: "agents.instance.open",
      domain: "agents",
      sessionId: input.sessionId,
      paneId: input.paneId,
      instanceId: input.instanceId,
      beadId: input.beadId,
      correlationId: input.instanceId,
      payload: {
        source_event: input.sourceEvent,
        role: input.role,
        runtime: input.runtime,
        parent_session_id: input.parentSessionId,
        task: input.task,
      },
      createdAtMs: startedAtMs,
    });
  });
  tx();
  return { created: true, instanceId: input.instanceId };
}

export interface CloseInstanceInput {
  instanceId: string;
  reason: EndReason;
}

export function closeInstance(
  db: Db,
  input: CloseInstanceInput,
  now: () => number = Date.now,
): boolean {
  const existing = db.raw
    .query<{ ended_at_ms: number | null; session_id: string; pane_id: string }, [string]>(
      "SELECT ended_at_ms, session_id, pane_id FROM agent_instances WHERE instance_id = ?",
    )
    .get(input.instanceId);
  if (!existing) return false;
  if (existing.ended_at_ms !== null) return false; // already closed

  const endedAtMs = now();
  const tx = db.raw.transaction(() => {
    db.raw
      .prepare<unknown, [number, string, string]>(
        "UPDATE agent_instances SET ended_at_ms = ?, end_reason = ? WHERE instance_id = ?",
      )
      .run(endedAtMs, input.reason, input.instanceId);
    insertEnvelope(db, {
      type: `agents.instance.end.${input.reason}`,
      domain: "agents",
      sessionId: existing.session_id,
      paneId: existing.pane_id,
      instanceId: input.instanceId,
      correlationId: input.instanceId,
      payload: { end_reason: input.reason },
      createdAtMs: endedAtMs,
    });
  });
  tx();
  return true;
}

/**
 * Find the active (ended_at_ms IS NULL) instance for a pane, if any. Used by
 * transition() to attribute state changes to the right instance and by
 * reconcile() to end instances whose panes vanished.
 */
export function findActiveInstanceForPane(db: Db, paneId: string): AgentInstanceRow | null {
  const row = db.raw
    .query<AgentInstanceRow, [string]>(
      "SELECT * FROM agent_instances WHERE pane_id = ? AND ended_at_ms IS NULL ORDER BY started_at_ms DESC LIMIT 1",
    )
    .get(paneId);
  return row ?? null;
}
