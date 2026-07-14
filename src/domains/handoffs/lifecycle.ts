import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Db } from "../../db/connection.ts";
import { insertEnvelope } from "../../db/journal.ts";
import { recordDelivery } from "../deliveries/attempt.ts";
import { registerWithinTransaction, type RegisterInput } from "../monitors/store.ts";

export type HandoffState =
  | "created"
  | "sent"
  | "delivery_failed"
  | "accepted"
  | "completed"
  | "cancelled";

export interface CreateInput {
  id: string;
  handoffKey?: string | undefined;
  sourceInstanceId?: string | undefined;
  sourceSessionId?: string | undefined;
  targetSessionId?: string | undefined;
  targetPaneId: string;
  beadId: string;
  parentSessionId?: string | undefined;
  promptFile: string;
  summary?: string | undefined;
}

/**
 * A retry reused an idempotency key for a delegation that is not the same one.
 * Distinct from a plain duplicate (which is the whole point of the key) and from a
 * storage error: this is the caller's mistake, and it is caught rather than
 * absorbed because absorbing it produces a durable record that lies.
 */
export class HandoffKeyConflictError extends Error {
  readonly code = "XTMUX_HANDOFF_KEY_CONFLICT";
  constructor(readonly handoffKey: string, readonly conflicts: string[]) {
    super(`handoff ${handoffKey}: key already describes a different delegation — ${conflicts.join(", ")}`);
    this.name = "HandoffKeyConflictError";
  }
}

function hashFile(path: string): string | null {
  try {
    const buf = readFileSync(path);
    return createHash("sha256").update(buf).digest("hex").slice(0, 32);
  } catch {
    return null;
  }
}

function insertHandoffWithinTransaction(
  db: Db,
  input: CreateInput,
  now: () => number,
): { id: string; hash: string | null; duplicate: boolean } {
  if (!input.beadId) throw new Error("handoff: bead is required");
  const key = input.handoffKey ?? input.id;
  const hash = hashFile(input.promptFile);
  const createdAtMs = now();
  const result = db.raw
    .prepare<unknown, [string, string, string | null, string | null, string | null, string, string, string | null, string, string | null, string | null, string, number]>(
      `INSERT INTO handoffs
         (id, handoff_key, source_instance_id, source_session_id, target_session_id, target_pane_id,
          bead_id, parent_session_id, prompt_file, prompt_file_hash, summary, state, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(handoff_key) DO NOTHING`
    )
    .run(
      input.id,
      key,
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
    ) as { changes?: number };
  const duplicate = Number(result.changes ?? 0) === 0;
  const existing = db.raw
    .query<{ id: string; prompt_file_hash: string | null; target_pane_id: string; bead_id: string; prompt_file: string }, [string]>(
      "SELECT id, prompt_file_hash, target_pane_id, bead_id, prompt_file FROM handoffs WHERE handoff_key = ?",
    )
    .get(key);
  if (!existing) throw new Error(`handoff ${key}: insert was not committed`);
  // An idempotency key promises "this is the SAME delegation, sent again". A retry
  // that changed the target, the bead, or the prompt file is a DIFFERENT
  // delegation wearing a used key: DO NOTHING would keep the old row, the picker
  // would still inject the new pointer, and the attempt would be recorded against
  // a handoff that describes something else entirely — a durable record that lies
  // about what was delivered. Refuse instead; the caller wants a new key.
  if (duplicate) {
    const conflicts: string[] = [];
    if (existing.target_pane_id !== input.targetPaneId) conflicts.push(`target_pane_id (${existing.target_pane_id} -> ${input.targetPaneId})`);
    if (existing.bead_id !== input.beadId) conflicts.push(`bead_id (${existing.bead_id} -> ${input.beadId})`);
    if (existing.prompt_file !== input.promptFile) conflicts.push(`prompt_file (${existing.prompt_file} -> ${input.promptFile})`);
    // The file may have been REWRITTEN under the same path. Same key + same path +
    // different bytes is still a different delegation.
    if (hash !== null && existing.prompt_file_hash !== null && hash !== existing.prompt_file_hash) {
      conflicts.push("prompt_file contents changed");
    }
    if (conflicts.length > 0) {
      throw new HandoffKeyConflictError(key, conflicts);
    }
  }
  if (!duplicate) {
    insertEnvelope(db, {
      type: "handoffs.created",
      domain: "handoffs",
      sessionId: input.targetSessionId,
      paneId: input.targetPaneId,
      beadId: input.beadId,
      correlationId: `ho:${key}`,
      payload: {
        handoff_id: input.id,
        handoff_key: key,
        prompt_file: input.promptFile,
        prompt_file_hash: hash,
        source_session_id: input.sourceSessionId,
      },
      createdAtMs,
    });
  }
  return { id: existing.id, hash: existing.prompt_file_hash, duplicate };
}

export function createHandoff(
  db: Db,
  input: CreateInput,
  now: () => number = Date.now,
): { id: string; hash: string | null; duplicate: boolean } {
  let result: { id: string; hash: string | null; duplicate: boolean } | undefined;
  const tx = db.raw.transaction(() => { result = insertHandoffWithinTransaction(db, input, now); });
  tx();
  if (!result) throw new Error(`handoff ${input.id}: transaction returned no result`);
  return result;
}

export interface HandoffMonitorInput {
  monitorId: string;
  target: string;
  paneId: string;
  sessionId?: string | undefined;
  instanceId?: string | undefined;
  state: string;
  timeoutMs?: number | undefined;
  intervalMs: number;
}

export interface CreateHandoffWithMonitorResult {
  handoff: { id: string; hash: string | null; duplicate: boolean };
  monitorId: string | null;
  monitorDuplicate: boolean;
}

export function createHandoffWithMonitor(
  db: Db,
  input: CreateInput,
  monitor: HandoffMonitorInput | undefined,
  now: () => number = Date.now,
): CreateHandoffWithMonitorResult {
  let result: CreateHandoffWithMonitorResult | undefined;
  const tx = db.raw.transaction(() => {
    const handoff = insertHandoffWithinTransaction(db, input, now);
    if (!monitor) {
      result = { handoff, monitorId: null, monitorDuplicate: false };
      return;
    }
    const linked = db.raw
      .query<{ monitor_id: string | null }, [string]>(
        "SELECT monitor_id FROM handoffs WHERE handoff_key = ?",
      )
      .get(input.handoffKey ?? input.id);
    if (linked?.monitor_id !== null && linked?.monitor_id !== undefined) {
      if (linked.monitor_id !== monitor.monitorId) {
        throw new Error(`handoff ${input.handoffKey ?? input.id}: monitor identity conflict`);
      }
      result = { handoff, monitorId: monitor.monitorId, monitorDuplicate: true };
      return;
    }
    const existing = db.raw
      .query<{ id: string }, [string]>(
        "SELECT id FROM monitors WHERE id = ?",
      )
      .get(monitor.monitorId);
    if (!existing) {
      const registration: RegisterInput = { id: monitor.monitorId, ...monitor, nowMs: now() };
      registerWithinTransaction(db, registration);
      db.raw.prepare<unknown, [string, string]>(
        "UPDATE handoffs SET monitor_id = ? WHERE handoff_key = ?",
      ).run(monitor.monitorId, input.handoffKey ?? input.id);
    } else {
      throw new Error(`monitor ${monitor.monitorId}: already belongs to another handoff`);
    }
    result = { handoff, monitorId: monitor.monitorId, monitorDuplicate: false };
  });
  tx();
  if (!result) throw new Error(`handoff ${input.id}: transaction returned no result`);
  return result;
}

export interface SendInput {
  id: string;
  succeeded: boolean;
  failureCode?: string | undefined;
  payloadSummary?: string | undefined;
}

/**
 * Records one append-only delivery_attempts row for every pointer injection.
 * Replays are allowed for created, sent, and delivery_failed handoffs.
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
    if (!["created", "sent", "delivery_failed"].includes(cur.state)) {
      throw new Error(`handoff ${input.id} not retryable (was ${cur.state})`);
    }

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
