export interface CorrelatedReply {
  messageKey: string;
  senderId: string;
  senderPaneId: string | null;
  recipientId: string;
  targetPaneId: string | null;
  summary: string;
  createdAtMs: number;
}

export type ReplyStatus = "pending" | "fulfilled" | "cancelled" | null;

export interface MessageRow {
  id: number;
  message_key: string;
  sender_id: string;
  sender_pane_id: string | null;
  recipient_id: string;
  target_pane_id: string | null;
  bead_id: string | null;
  summary: string;
  payload_json: string | null;
  expects_reply: number;
  created_at_ms: number;
  reply_to_message_id: number | null;
  fulfilled_by_message_id: number | null;
  fulfilled_at_ms: number | null;
  cancelled_at_ms: number | null;
  cancel_reason: string | null;
}

export interface ReceiptRow {
  message_id: number;
  recipient_id: string;
  read_at_ms: number | null;
  acked_at_ms: number | null;
  acked_by: string | null;
}

export interface MessageWithReceipt extends MessageRow {
  acked_at_ms: number | null;
  acked_by: string | null;
  reply_status: ReplyStatus;
  fulfilled_by_message_key: string | null;
  correlated_reply_key: string | null;
  correlated_reply_sender_id: string | null;
  correlated_reply_sender_pane_id: string | null;
  correlated_reply_recipient_id: string | null;
  correlated_reply_target_pane_id: string | null;
  correlated_reply_summary: string | null;
  correlated_reply_created_at_ms: number | null;
  replyStatus: ReplyStatus;
  fulfilledAtMs: number | null;
  correlatedReply: CorrelatedReply | null;
}
