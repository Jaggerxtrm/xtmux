import type { Db } from "../../db/connection.ts";

export interface MessageStatus {
  messageKey: string;
  senderId: string;
  recipientId: string;
  beadId: string | null;
  summary: string;
  expectsReply: boolean;
  acked: boolean;
  ackedAtMs: number | null;
  ackedBy: string | null;
}

export function messageStatus(db: Db, messageKey: string): MessageStatus | null {
  const row = db.raw
    .query<{
      message_key: string;
      sender_id: string;
      recipient_id: string;
      bead_id: string | null;
      summary: string;
      expects_reply: number;
      acked_at_ms: number | null;
      acked_by: string | null;
    }, [string]>(
      `SELECT m.message_key, m.sender_id, m.recipient_id, m.bead_id, m.summary,
              m.expects_reply, r.acked_at_ms, r.acked_by
         FROM messages m
         LEFT JOIN message_receipts r ON r.message_id = m.id AND r.recipient_id = m.recipient_id
        WHERE m.message_key = ?`,
    )
    .get(messageKey);
  if (!row) return null;
  return {
    messageKey: row.message_key,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    beadId: row.bead_id,
    summary: row.summary,
    expectsReply: row.expects_reply === 1,
    acked: row.acked_at_ms !== null,
    ackedAtMs: row.acked_at_ms,
    ackedBy: row.acked_by,
  };
}
