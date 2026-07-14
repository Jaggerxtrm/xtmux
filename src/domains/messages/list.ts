import type { Db } from "../../db/connection.ts";
import type { CorrelatedReply, MessageWithReceipt } from "./types.ts";

export interface ListInput {
  recipientId: string;
  targetPaneId?: string | undefined;
  senderId?: string | undefined;
  sinceMs?: number | undefined;
  unackedOnly?: boolean | undefined;
  expectsReplyOnly?: boolean | undefined;
  limit?: number | undefined;
}

interface MessageListRow extends Omit<MessageWithReceipt, "replyStatus" | "fulfilledAtMs" | "correlatedReply"> {
  correlated_reply_key: string | null;
  correlated_reply_sender_id: string | null;
  correlated_reply_sender_pane_id: string | null;
  correlated_reply_recipient_id: string | null;
  correlated_reply_target_pane_id: string | null;
  correlated_reply_summary: string | null;
  correlated_reply_created_at_ms: number | null;
}

function replyStatus(row: MessageListRow): MessageWithReceipt["reply_status"] {
  if (row.cancelled_at_ms !== null) return "cancelled";
  if (row.expects_reply !== 1) return null;
  return row.fulfilled_at_ms === null ? "pending" : "fulfilled";
}

function correlatedReply(row: MessageListRow): CorrelatedReply | null {
  if (row.correlated_reply_key === null) return null;
  return {
    messageKey: row.correlated_reply_key,
    senderId: row.correlated_reply_sender_id ?? "",
    senderPaneId: row.correlated_reply_sender_pane_id,
    recipientId: row.correlated_reply_recipient_id ?? "",
    targetPaneId: row.correlated_reply_target_pane_id,
    summary: row.correlated_reply_summary ?? "",
    createdAtMs: row.correlated_reply_created_at_ms ?? 0,
  };
}

/** Pure read. Correlated reply projection comes from SQLite, not marker files. */
export function listMessages(db: Db, input: ListInput): MessageWithReceipt[] {
  const clauses: string[] = ["m.recipient_id = ?"];
  const params: (string | number)[] = [input.recipientId];
  if (input.targetPaneId !== undefined) {
    clauses.push("(m.target_pane_id = ? OR m.target_pane_id IS NULL)");
    params.push(input.targetPaneId);
  }
  if (input.senderId !== undefined) {
    clauses.push("m.sender_id = ?");
    params.push(input.senderId);
  }
  if (input.sinceMs !== undefined) {
    clauses.push("m.created_at_ms >= ?");
    params.push(input.sinceMs);
  }
  if (input.unackedOnly) clauses.push("r.acked_at_ms IS NULL");
  if (input.expectsReplyOnly) clauses.push("m.expects_reply = 1");
  const limit = Math.max(1, Math.min(input.limit ?? 200, 5000));
  const rows = db.raw.prepare<MessageListRow, (string | number)[]>(`
    SELECT m.id, m.message_key, m.sender_id, m.sender_pane_id,
           m.recipient_id, m.target_pane_id, m.bead_id,
           m.summary, m.payload_json, m.expects_reply, m.created_at_ms,
           m.reply_to_message_id, m.fulfilled_by_message_id,
           m.fulfilled_at_ms, m.cancelled_at_ms, m.cancel_reason,
           CASE WHEN m.cancelled_at_ms IS NOT NULL THEN 'cancelled'
                WHEN m.expects_reply = 1 AND m.fulfilled_at_ms IS NOT NULL THEN 'fulfilled'
                WHEN m.expects_reply = 1 THEN 'pending' ELSE NULL END AS reply_status,
           r.acked_at_ms, r.acked_by,
           linked.message_key AS fulfilled_by_message_key,
           linked.message_key AS correlated_reply_key,
           linked.sender_id AS correlated_reply_sender_id,
           linked.sender_pane_id AS correlated_reply_sender_pane_id,
           linked.recipient_id AS correlated_reply_recipient_id,
           linked.target_pane_id AS correlated_reply_target_pane_id,
           linked.summary AS correlated_reply_summary,
           linked.created_at_ms AS correlated_reply_created_at_ms
      FROM messages m
      LEFT JOIN message_receipts r
        ON r.message_id = m.id AND r.recipient_id = m.recipient_id
      LEFT JOIN messages linked ON linked.reply_to_message_id = m.id
     WHERE ${clauses.join(" AND ")}
     ORDER BY m.id DESC
     LIMIT ${limit}
  `).all(...params);
  return rows.map((row) => {
    const status = replyStatus(row);
    const projection = correlatedReply(row);
    return {
      ...row,
      reply_status: status,
      replyStatus: status,
      fulfilledAtMs: row.fulfilled_at_ms,
      correlatedReply: projection,
    };
  });
}
