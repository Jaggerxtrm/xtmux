import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Db } from "../../db/connection.ts";
import { insertEnvelope } from "../../db/journal.ts";
import { recordDelivery } from "../deliveries/attempt.ts";

export type HandoffState =
  | "created"
  | "sent"
  | "delivery_failed"
  | "accepted"
  | "completed"
  | "cancelled";

export interface CreateInput {
  id: string;
  sourceInstanceId?: string | undefined;
  sourceSessionId?: string | undefined;
  targetSessionId?: string | undefined;
  targetPaneId: string;
  beadId: string;
  parentSessionId?: string | undefined;
  promptFile: string;
  summary?: string | undefined;
}

function hashFile(path: string): string | null {
  try {
    const buf = readFileSync(path);
    return createHash("sha256").update(buf).digest("hex").slice(0, 32);
  } catch {
    return null;
  }
}

export function createHandoff(
  db: Db,
  input: CreateInput,
  now: () => number = Date.now,
): { id: string; hash: string | null } {
  if (!input.beadId) throw new Error("handoff: bead is required");
  const hash = hashFile(input.promptFile);
  const createdAtMs = now();
  const tx = db.raw.transaction(() => {
    db.raw
      .prepare<
        unknown,
        [
          string, string | null, string | null, string | null, string,
          string, string | null, string, string | null, string | null,
          string, number,
        ]
      >(
        `INSERT INTO handoffs
           (id, source_instance_id, source_session_id, target_session_id, target_pane_id,
            bead_id, parent_session_id, prompt_file, prompt_file_hash, summary,
            state, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.sourceInstanceId ?? null,
        input.sourceSessionId ?? null,
        input.targetSessionId ?? null,
        input.targetPaneId,
        input.beadId,
        input.parentSessionId ?? null,
        input.promptFile,
        hash,
        input.summary ?? null,
        "created",
        createdAtMs,
      );
    insertEnvelope(db, {
      type: "handoffs.created",
      domain: "handoffs",
      sessionId: input.targetSessionId,
      paneId: input.targetPaneId,
      beadId: input.beadId,
      correlationId: `ho:${input.id}`,
      payload: {
        handoff_id: input.id,
        prompt_file: input.promptFile,
        prompt_file_hash: hash,
        source_session_id: input.sourceSessionId,
      },
      createdAtMs,
    });
  });
  tx();
  return { id: input.id, hash };
}

export interface SendInput {
  id: string;
  succeeded: boolean;
  failureCode?: string | undefined;
  payloadSummary?: string | undefined;
}

/**
 * Transition created -> sent (or created -> delivery_failed on failure).
 * Records a delivery_attempts row with kind=handoff_pointer + links it.
 */
export function markSent(
  db: Db,
  input: SendInput,
  now: () => number = Date.now,
): { newState: HandoffState; deliveryId: number } {
  let newState: HandoffState = "delivery_failed";
  let deliveryId = 0;
  const tx = db.raw.transaction(() => {
    const cur = db.raw
      .query<{
        state: string;
        target_session_id: string | null;
        target_pane_id: string;
        source_session_id: string | null;
        bead_id: string;
      }, [string]>(
        `SELECT state, target_session_id, target_pane_id, source_session_id, bead_id
           FROM handoffs WHERE id = ?`,
      )
      .get(input.id);
    if (!cur) throw new Error(`handoff not found: ${input.id}`);
    if (cur.state !== "created") throw new Error(`handoff ${input.id} not in state=created (was ${cur.state})`);

    deliveryId = recordDelivery(
      db,
      {
        kind: "handoff_pointer",
        sourceSessionId: cur.source_session_id ?? undefined,
        targetSessionId: cur.target_session_id ?? undefined,
        targetPaneId: cur.target_pane_id,
        relatedHandoffId: input.id,
        payloadSummary: input.payloadSummary,
        succeeded: input.succeeded,
        failureCode: input.failureCode,
      },
      now,
    );

    newState = input.succeeded ? "sent" : "delivery_failed";
    const t = now();
    db.raw
      .prepare<unknown, [string, number, string | null, number, string]>(
        `UPDATE handoffs
            SET state = ?, sent_at_ms = ?, failure_code = ?, delivery_attempt_id = ?
          WHERE id = ?`,
      )
      .run(newState, t, input.failureCode ?? null, deliveryId, input.id);

    insertEnvelope(db, {
      type: `handoffs.${newState}`,
      domain: "handoffs",
      sessionId: cur.target_session_id ?? undefined,
      paneId: cur.target_pane_id,
      beadId: cur.bead_id,
      correlationId: `ho:${input.id}`,
      payload: {
        handoff_id: input.id,
        delivery_attempt_id: deliveryId,
        succeeded: input.succeeded,
        failure_code: input.failureCode,
      },
      createdAtMs: t,
    });
  });
  tx();
  return { newState, deliveryId };
}

export interface StateTransitionInput {
  id: string;
  toState: "accepted" | "completed" | "cancelled";
}

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  created:         ["cancelled"],
  sent:            ["accepted", "completed", "cancelled"],
  delivery_failed: ["cancelled"],
  accepted:        ["completed", "cancelled"],
};

export function transitionHandoff(
  db: Db,
  input: StateTransitionInput,
  now: () => number = Date.now,
): boolean {
  let ok = false;
  const tx = db.raw.transaction(() => {
    const cur = db.raw
      .query<{ state: string; target_session_id: string | null; target_pane_id: string; bead_id: string }, [string]>(
        "SELECT state, target_session_id, target_pane_id, bead_id FROM handoffs WHERE id = ?",
      )
      .get(input.id);
    if (!cur) return;
    const allowed = ALLOWED_TRANSITIONS[cur.state] ?? [];
    if (!allowed.includes(input.toState)) {
      throw new Error(`handoff ${input.id}: illegal transition ${cur.state} -> ${input.toState}`);
    }
    const t = now();
    const col =
      input.toState === "accepted"
        ? "accepted_at_ms"
        : input.toState === "completed"
          ? "completed_at_ms"
          : null;
    if (col) {
      db.raw
        .prepare<unknown, [string, number, string]>(
          `UPDATE handoffs SET state = ?, ${col} = ? WHERE id = ?`,
        )
        .run(input.toState, t, input.id);
    } else {
      db.raw
        .prepare<unknown, [string, string]>(
          "UPDATE handoffs SET state = ? WHERE id = ?",
        )
        .run(input.toState, input.id);
    }
    insertEnvelope(db, {
      type: `handoffs.${input.toState}`,
      domain: "handoffs",
      sessionId: cur.target_session_id ?? undefined,
      paneId: cur.target_pane_id,
      beadId: cur.bead_id,
      correlationId: `ho:${input.id}`,
      payload: { handoff_id: input.id },
      createdAtMs: t,
    });
    ok = true;
  });
  tx();
  return ok;
}
