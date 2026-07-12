import type { Db } from "../../db/connection.ts";
import { insertEnvelope } from "../../db/journal.ts";
import type { MessageRow } from "./types.ts";

export type AckStatus =
  | "acked"
  | "already-acked"
  | "wrong-recipient"
  | "unknown-message";

export interface AckInput {
  messageId: number;
  ackedBy: string;
}

export interface AckResult {
  status: AckStatus;
  ackedAtMs?: number | undefined;
}

/**
 * Idempotent ack. Only the recipient of the message may ack it; another
 * `--by` gets `wrong-recipient` (no mutation). Repeat acks by the correct
 * recipient return `already-acked` without touching timestamps.
 */
export function ackMessage(
  db: Db,
  input: AckInput,
  now: () => number = Date.now,
): AckResult {
  const findMsg = db.raw.prepare<Pick<MessageRow, "id" | "recipient_id" | "bead_id">, [number]>(
    "SELECT id, recipient_id, bead_id FROM messages WHERE id = ?",
  );
  const findReceipt = db.raw.prepare<
    { acked_at_ms: number | null; acked_by: string | null },
    [number, string]
  >(
    "SELECT acked_at_ms, acked_by FROM message_receipts WHERE message_id = ? AND recipient_id = ?",
  );
  const updateReceipt = db.raw.prepare<
    unknown,
    [number, string, number, string]
  >(
    `UPDATE message_receipts
       SET acked_at_ms = ?, acked_by = ?
     WHERE message_id = ? AND recipient_id = ?`,
  );

  let status: AckStatus = "unknown-message";
  let ackedAtMs: number | undefined;

  const tx = db.raw.transaction(() => {
    const msg = findMsg.get(input.messageId);
    if (!msg) {
      status = "unknown-message";
      return;
    }
    if (msg.recipient_id !== input.ackedBy) {
      status = "wrong-recipient";
      return;
    }
    const receipt = findReceipt.get(input.messageId, msg.recipient_id);
    if (receipt?.acked_at_ms) {
      status = "already-acked";
      ackedAtMs = receipt.acked_at_ms;
      return;
    }
    const t = now();
    updateReceipt.run(t, input.ackedBy, input.messageId, msg.recipient_id);
    ackedAtMs = t;
    status = "acked";
    insertEnvelope(db, {
      type: "messages.ack",
      domain: "messages",
      sessionId: msg.recipient_id,
      beadId: msg.bead_id ?? undefined,
      correlationId: `msg:${input.messageId}`,
      payload: { message_id: input.messageId, acked_by: input.ackedBy },
      createdAtMs: t,
    });
  });
  tx();
  const result: AckResult = { status };
  if (ackedAtMs !== undefined) result.ackedAtMs = ackedAtMs;
  return result;
}
