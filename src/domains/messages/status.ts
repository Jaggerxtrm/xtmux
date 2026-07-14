import type { Db } from "../../db/connection.ts";
import type { CorrelatedReply, ReplyStatus } from "./types.ts";

export interface MessageStatus {
  messageKey: string;
  senderId: string;
  senderPaneId: string | null;
  recipientId: string;
  targetPaneId: string | null;
  beadId: string | null;
  summary: string;
  expectsReply: boolean;
  acked: boolean;
  ackedAtMs: number | null;
  ackedBy: string | null;
  replyStatus: ReplyStatus;
  fulfilledAtMs: number | null;
  fulfilledByMessageKey: string | null;
  correlatedReply: CorrelatedReply | null;
}

export function messageStatus(db: Db, messageKey: string): MessageStatus | null {
  const row = db.raw.query<{
    message_key: string;
    sender_id: string;
    sender_pane_id: string | null;
    recipient_id: string;
    target_pane_id: string | null;
    bead_id: string | null;
    summary: string;
    expects_reply: number;
    acked_at_ms: number | null;
    acked_by: string | null;
    fulfilled_at_ms: number | null;
    cancelled_at_ms: number | null;
    fulfilled_by_message_key: string | null;
    correlated_reply_key: string | null;
    correlated_reply_sender_id: string | null;
    correlated_reply_sender_pane_id: string | null;
    correlated_reply_recipient_id: string | null;
    correlated_reply_target_pane_id: string | null;
    correlated_reply_summary: string | null;
    correlated_reply_created_at_ms: number | null;
  }, [string]>(
    `SELECT m.message_key, m.sender_id, m.sender_pane_id,
            m.recipient_id, m.target_pane_id, m.bead_id, m.summary,
            m.expects_reply, r.acked_at_ms, r.acked_by,
            m.fulfilled_at_ms, m.cancelled_at_ms,
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
      WHERE m.message_key = ?`,
  ).get(messageKey);
  if (!row) return null;
  const replyStatus: ReplyStatus = row.cancelled_at_ms !== null
    ? "cancelled"
    : row.expects_reply !== 1
      ? null
      : row.fulfilled_at_ms === null ? "pending" : "fulfilled";
  const correlatedReply = row.correlated_reply_key === null ? null : {
    messageKey: row.correlated_reply_key,
    senderId: row.correlated_reply_sender_id ?? "",
    senderPaneId: row.correlated_reply_sender_pane_id,
    recipientId: row.correlated_reply_recipient_id ?? "",
    targetPaneId: row.correlated_reply_target_pane_id,
    summary: row.correlated_reply_summary ?? "",
    createdAtMs: row.correlated_reply_created_at_ms ?? 0,
  } satisfies CorrelatedReply;
  return {
    messageKey: row.message_key,
    senderId: row.sender_id,
    senderPaneId: row.sender_pane_id,
    recipientId: row.recipient_id,
    targetPaneId: row.target_pane_id,
    beadId: row.bead_id,
    summary: row.summary,
    expectsReply: row.expects_reply === 1,
    acked: row.acked_at_ms !== null,
    ackedAtMs: row.acked_at_ms,
    ackedBy: row.acked_by,
    replyStatus,
    fulfilledAtMs: row.fulfilled_at_ms,
    fulfilledByMessageKey: row.fulfilled_by_message_key,
    correlatedReply,
  };
}
