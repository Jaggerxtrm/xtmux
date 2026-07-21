import type { Db } from "../../db/connection.ts";
import { replyProjection, type MessageListRow } from "./list.ts";
import type { MessageWithReplyState } from "./types.ts";

const MESSAGE_SELECT = `
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
`;

/** Pure read: resolve a message key first, then a numeric SQLite message id. */
export function getMessage(db: Db, keyOrId: string): MessageWithReplyState | null {
  if (!keyOrId) return null;
  const byKey = db.raw.prepare<MessageListRow, [string]>(
    `${MESSAGE_SELECT} WHERE m.message_key = ? LIMIT 1`,
  ).get(keyOrId);
  if (byKey) return replyProjection(byKey);

  if (!/^\d+$/.test(keyOrId)) return null;
  const byId = db.raw.prepare<MessageListRow, [number]>(
    `${MESSAGE_SELECT} WHERE m.id = ? LIMIT 1`,
  ).get(Number(keyOrId));
  return byId ? replyProjection(byId) : null;
}
