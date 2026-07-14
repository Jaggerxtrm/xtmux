import type { Db } from "../../db/connection.ts";

export interface PendingObligationInput {
  senderId: string;
  senderPaneId?: string | undefined;
  limit?: number | undefined;
}

export interface PendingObligation {
  messageKey: string;
  messageId: number;
  senderId: string;
  senderPaneId: string | null;
  recipientId: string;
  targetPaneId: string | null;
  summary: string;
  createdAtMs: number;
  acked: boolean;
  ackedAtMs: number | null;
  replyStatus: "pending";
}

interface PendingRow {
  message_key: string;
  id: number;
  sender_id: string;
  sender_pane_id: string | null;
  recipient_id: string;
  target_pane_id: string | null;
  summary: string;
  created_at_ms: number;
  acked_at_ms: number | null;
}

/**
 * Query pending reply obligations from SQLite. WHERE predicates mirror
 * msg_pending_obligation partial index; no marker directory or full scan.
 */
export function listPendingObligations(db: Db, input: PendingObligationInput): PendingObligation[] {
  const limit = Math.max(1, Math.min(input.limit ?? 200, 5000));
  const paneClause = input.senderPaneId === undefined
    ? "m.sender_pane_id IS NULL"
    : "m.sender_pane_id = ?";
  const params: (string | number)[] = input.senderPaneId === undefined
    ? [input.senderId]
    : [input.senderId, input.senderPaneId];
  const rows = db.raw.prepare<PendingRow, (string | number)[]>(`
    SELECT m.message_key, m.id, m.sender_id, m.sender_pane_id,
           m.recipient_id, m.target_pane_id, m.summary, m.created_at_ms,
           r.acked_at_ms
      FROM messages m
      LEFT JOIN message_receipts r
        ON r.message_id = m.id AND r.recipient_id = m.recipient_id
     WHERE m.sender_id = ?
       AND ${paneClause}
       AND m.expects_reply = 1
       AND m.fulfilled_at_ms IS NULL
       AND m.cancelled_at_ms IS NULL
     ORDER BY m.created_at_ms, m.id
     LIMIT ${limit}
  `).all(...params);
  return rows.map((row) => ({
    messageKey: row.message_key,
    messageId: row.id,
    senderId: row.sender_id,
    senderPaneId: row.sender_pane_id,
    recipientId: row.recipient_id,
    targetPaneId: row.target_pane_id,
    summary: row.summary,
    createdAtMs: row.created_at_ms,
    acked: row.acked_at_ms !== null,
    ackedAtMs: row.acked_at_ms,
    replyStatus: "pending" as const,
  }));
}

export const pendingObligations = listPendingObligations;
export const queryPendingObligations = listPendingObligations;
