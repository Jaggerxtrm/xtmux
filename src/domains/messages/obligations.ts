import type { Db } from "../../db/connection.ts";
import { insertEnvelope } from "../../db/journal.ts";

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

export interface CancelPaneObligationsInput {
  /** The pane whose occupation ended. NEVER optional: see the note below. */
  senderPaneId: string;
  /**
   * Optional extra narrowing. When supplied, only obligations this session also
   * owns are cancelled; a pane whose session id rotated keeps its older rows.
   */
  senderId?: string | undefined;
  reason: string;
  nowMs: number;
}

/**
 * Terminal cleanup for one pane's OUTBOUND reply obligations (K4, xtmux-s96.4).
 *
 * When an agent occupation ends, the reply-required messages it sent can never
 * be discharged *to it*: the requester is gone, so the duty is dead weight that
 * keeps showing up in `obligations list` and keeps arming waits forever.
 *
 * Scoping is deliberately strict, because the failure mode is silent and
 * cross-pane: `sender_pane_id = ?` matches EXACTLY one pane and never NULL, so
 * a message sent by a pane-less caller (a script, a bridge, another host) is
 * left alone, and no other pane's duty can be swept up by the ending pane's
 * cleanup. `expects_reply = 1` keeps FYIs — which carry no duty — untouched,
 * and the `fulfilled_at_ms IS NULL AND cancelled_at_ms IS NULL` predicates make
 * the call idempotent: a second cleanup for the same pane cancels nothing and
 * writes no envelope.
 *
 * @returns the message keys actually cancelled by THIS call.
 */
export function cancelPaneObligations(db: Db, input: CancelPaneObligationsInput): string[] {
  if (!input.senderPaneId) return [];
  const sessionClause = input.senderId === undefined ? "" : " AND m.sender_id = ?";
  const params: string[] = input.senderId === undefined
    ? [input.senderPaneId]
    : [input.senderPaneId, input.senderId];
  const rows = db.raw.prepare<{ id: number; message_key: string; recipient_id: string }, string[]>(`
    SELECT m.id, m.message_key, m.recipient_id
      FROM messages m
     WHERE m.sender_pane_id = ?${sessionClause}
       AND m.expects_reply = 1
       AND m.fulfilled_at_ms IS NULL
       AND m.cancelled_at_ms IS NULL
     ORDER BY m.id
  `).all(...params);
  if (rows.length === 0) return [];

  const update = db.raw.prepare<unknown, [number, string, number]>(
    "UPDATE messages SET cancelled_at_ms = ?, cancel_reason = ? WHERE id = ? AND cancelled_at_ms IS NULL",
  );
  const tx = db.raw.transaction(() => {
    for (const row of rows) {
      update.run(input.nowMs, input.reason, row.id);
      insertEnvelope(db, {
        type: "messages.cancelled",
        domain: "messages",
        paneId: input.senderPaneId,
        sessionId: input.senderId,
        correlationId: row.message_key,
        payload: {
          message_id: row.id,
          outcome: "cancelled",
          reason: input.reason,
          recipient_id: row.recipient_id,
        },
        createdAtMs: input.nowMs,
      });
    }
  });
  tx();
  return rows.map((row) => row.message_key);
}
