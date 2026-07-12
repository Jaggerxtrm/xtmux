import type { Db } from "../../db/connection.ts";
import { insertEnvelope } from "../../db/journal.ts";

export interface SendInput {
  messageKey: string;
  senderId: string;
  senderPaneId?: string | undefined;
  recipientId: string;
  targetPaneId?: string | undefined;
  beadId?: string | undefined;
  summary: string;
  payloadJson?: string | undefined;
}

export interface SendResult {
  messageId: number;
  duplicate: boolean;
}

/**
 * Insert a durable message + its receipt in a single transaction.
 * Idempotent on `message_key`: a re-send with the same key returns the
 * existing row without touching timestamps.
 * Recipient normalization is the caller's responsibility (must be a stable
 * `#{session_id}` per docs/observability-redesign.md §3).
 */
export function sendMessage(db: Db, input: SendInput, now: () => number = Date.now): SendResult {
  const findByKey = db.raw.prepare<{ id: number }, [string]>(
    "SELECT id FROM messages WHERE message_key = ?",
  );
  const insertMessage = db.raw.prepare<
    { id: number },
    [
      string,
      string,
      string | null,
      string,
      string | null,
      string | null,
      string,
      string | null,
      number,
    ]
  >(
    `INSERT INTO messages
       (message_key, sender_id, sender_pane_id, recipient_id, target_pane_id,
        bead_id, summary, payload_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  );
  const insertReceipt = db.raw.prepare<
    unknown,
    [number, string]
  >(
    "INSERT INTO message_receipts (message_id, recipient_id) VALUES (?, ?)",
  );

  let messageId = 0;
  let duplicate = false;
  const tx = db.raw.transaction(() => {
    const existing = findByKey.get(input.messageKey);
    if (existing) {
      messageId = existing.id;
      duplicate = true;
      return;
    }
    const createdAtMs = now();
    const row = insertMessage.get(
      input.messageKey,
      input.senderId,
      input.senderPaneId ?? null,
      input.recipientId,
      input.targetPaneId ?? null,
      input.beadId ?? null,
      input.summary,
      input.payloadJson ?? null,
      createdAtMs,
    );
    messageId = row?.id ?? 0;
    insertReceipt.run(messageId, input.recipientId);
    insertEnvelope(db, {
      eventKey: `messages.sent:${input.messageKey}`,
      type: "messages.sent",
      domain: "messages",
      sessionId: input.recipientId,
      paneId: input.targetPaneId,
      beadId: input.beadId,
      correlationId: input.messageKey,
      payload: {
        message_id: messageId,
        sender_id: input.senderId,
        sender_pane_id: input.senderPaneId,
        recipient_id: input.recipientId,
        target_pane_id: input.targetPaneId,
        summary: input.summary,
      },
      createdAtMs,
    });
  });
  tx();
  return { messageId, duplicate };
}
