import type { Db } from "../../db/connection.ts";

export interface UnreadStats {
  recipientId: string;
  unreadCount: number;
  oldestUnackedAtMs: number | null;
}

/**
 * Recompute unread stats for a recipient from SQLite (authoritative). Caller
 * writes the result into tmux options @agent_unread_count / @agent_unread_since
 * best-effort — projection failure does NOT roll back this read.
 */
export function computeUnread(db: Db, recipientId: string): UnreadStats {
  const stmt = db.raw.prepare<
    { unread_count: number; oldest_at: number | null },
    [string]
  >(
    `SELECT COUNT(*) AS unread_count,
            MIN(m.created_at_ms) AS oldest_at
       FROM messages m
       LEFT JOIN message_receipts r
         ON r.message_id = m.id AND r.recipient_id = m.recipient_id
      WHERE m.recipient_id = ? AND (r.acked_at_ms IS NULL)`,
  );
  const row = stmt.get(recipientId);
  return {
    recipientId,
    unreadCount: row?.unread_count ?? 0,
    oldestUnackedAtMs: row?.oldest_at ?? null,
  };
}
