import type { Db } from "../../db/connection.ts";
import type { MessageWithReceipt } from "./types.ts";

export interface ListInput {
  recipientId: string;
  targetPaneId?: string | undefined;
  senderId?: string | undefined;
  sinceMs?: number | undefined;
  unackedOnly?: boolean | undefined;
  limit?: number | undefined;
}

/**
 * Pure read. Never mutates receipts.
 * O(recipient queue size × limit), not O(all events).
 */
export function listMessages(db: Db, input: ListInput): MessageWithReceipt[] {
  const clauses: string[] = ["m.recipient_id = ?"];
  const params: (string | number)[] = [input.recipientId];
  if (input.targetPaneId !== undefined) {
    // caller passed pane-level addressing: match rows targeting this pane OR
    // rows with no pane (session-scoped) so pure session broadcasts still land.
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
  if (input.unackedOnly) {
    clauses.push("(r.acked_at_ms IS NULL)");
  }
  const limit = Math.max(1, Math.min(input.limit ?? 200, 5000));

  const sql = `
    SELECT m.id, m.message_key, m.sender_id, m.sender_pane_id,
           m.recipient_id, m.target_pane_id, m.bead_id,
           m.summary, m.payload_json, m.created_at_ms,
           r.acked_at_ms, r.acked_by
      FROM messages m
      LEFT JOIN message_receipts r
        ON r.message_id = m.id AND r.recipient_id = m.recipient_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY m.id DESC
     LIMIT ${limit}
  `;
  const stmt = db.raw.prepare<MessageWithReceipt, (string | number)[]>(sql);
  return stmt.all(...params);
}
