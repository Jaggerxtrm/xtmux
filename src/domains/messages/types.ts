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
  created_at_ms: number;
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
}
