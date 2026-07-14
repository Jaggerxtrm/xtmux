import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../../../../src/db/connection.ts";
import { migrate } from "../../../../src/db/schema.ts";
import { sendMessage } from "../../../../src/domains/messages/send.ts";
import { replyMessage } from "../../../../src/domains/messages/reply.ts";
import { ackMessage } from "../../../../src/domains/messages/ack.ts";
import { listPendingObligations } from "../../../../src/domains/messages/obligations.ts";
import { applyRetention, loadRetentionConfig } from "../../../../src/db/retention.ts";
import type { Config } from "../../../../src/config.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function setup(): { db: ReturnType<typeof openDb>; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-obligation-"));
  const db = openDb({ dbPath: join(dir, "test.db"), mode: "off", busyTimeoutMs: 3000 } satisfies Config);
  migrate(db);
  return { db, cleanup: (): void => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe("pending obligations and reply retention", () => {
  test("pane query is indexed and retention keeps pending but removes eligible pair", () => {
    const { db, cleanup } = setup();
    try {
      const now = 1_000_000_000_000;
      const old = now - 90 * DAY_MS;
      const pending = sendMessage(db, { messageKey: "pending", senderId: "$owner", senderPaneId: "%1", recipientId: "$worker", targetPaneId: "%2", summary: "pending", expectsReply: true }, () => old);
      ackMessage(db, { messageId: pending.messageId, ackedBy: "$worker" }, () => old + 1);
      const fulfilled = sendMessage(db, { messageKey: "fulfilled", senderId: "$owner", senderPaneId: "%1", recipientId: "$worker", targetPaneId: "%2", summary: "fulfilled", expectsReply: true }, () => old);
      ackMessage(db, { messageId: fulfilled.messageId, ackedBy: "$worker" }, () => old + 1);
      const reply = replyMessage(db, { messageKey: "reply", replyToMessageKey: "fulfilled", senderId: "$worker", senderPaneId: "%2", summary: "done" }, () => old + 2);
      ackMessage(db, { messageId: reply.messageId, ackedBy: "$owner" }, () => old + 3);

      const pendingRows = listPendingObligations(db, { senderId: "$owner", senderPaneId: "%1" });
      expect(pendingRows.map((row) => row.messageKey)).toEqual(["pending"]);
      const plan = db.raw.query<{ detail: string }, []>("EXPLAIN QUERY PLAN SELECT id FROM messages WHERE sender_id = '$owner' AND sender_pane_id = '%1' AND expects_reply = 1 AND fulfilled_at_ms IS NULL AND cancelled_at_ms IS NULL").all();
      expect(plan.some((row) => row.detail.includes("msg_pending_obligation"))).toBe(true);

      const report = applyRetention(db, { ...loadRetentionConfig(), messageDays: 30, replyRetentionDays: 30 }, () => now);
      expect(report.messagesDeleted).toBe(2);
      expect(db.raw.query<{ message_key: string }, []>("SELECT message_key FROM messages").all()).toEqual([{ message_key: "pending" }]);
    } finally {
      cleanup();
    }
  });
});
