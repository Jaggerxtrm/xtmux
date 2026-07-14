import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../../../../src/db/connection.ts";
import { migrate } from "../../../../src/db/schema.ts";
import { sendMessage } from "../../../../src/domains/messages/send.ts";
import { replyMessage } from "../../../../src/domains/messages/reply.ts";
import { ackMessage } from "../../../../src/domains/messages/ack.ts";
import { messageStatus } from "../../../../src/domains/messages/status.ts";
import { listPendingObligations } from "../../../../src/domains/messages/obligations.ts";
import { MessageError, type MessageErrorCode } from "../../../../src/domains/messages/errors.ts";
import type { Config } from "../../../../src/config.ts";

function setup(): { db: ReturnType<typeof openDb>; cleanup: () => void; now: () => number } {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-reply-"));
  const db = openDb({ dbPath: join(dir, "test.db"), mode: "off", busyTimeoutMs: 3000 } satisfies Config);
  migrate(db);
  let time = 1_000;
  return { db, cleanup: (): void => { db.close(); rmSync(dir, { recursive: true, force: true }); }, now: (): number => ++time };
}

function expectCode(action: () => unknown, code: MessageErrorCode): void {
  try {
    action();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(MessageError);
    expect((error as MessageError).code).toBe(code);
  }
}

describe("message reply lifecycle", () => {
  test("ack is receipt-only; correlated reply is sole fulfilment transition", () => {
    const { db, cleanup, now } = setup();
    try {
      const original = sendMessage(db, {
        messageKey: "request-1", senderId: "$requester", senderPaneId: "%1",
        recipientId: "$target", targetPaneId: "%2", summary: "private body", expectsReply: true,
      }, now);
      ackMessage(db, { messageId: original.messageId, ackedBy: "$target" }, now);
      expect(listPendingObligations(db, { senderId: "$requester", senderPaneId: "%1" })).toHaveLength(1);
      const reply = replyMessage(db, {
        messageKey: "reply-1", replyToMessageKey: "request-1", senderId: "$target", senderPaneId: "%2",
        summary: "reply body", payloadJson: JSON.stringify({ secret: "not journaled" }),
      }, now);
      expect(reply.fulfilled).toBe(true);
      expect(messageStatus(db, "request-1")?.replyStatus).toBe("fulfilled");
      expect(listPendingObligations(db, { senderId: "$requester", senderPaneId: "%1" })).toHaveLength(0);
      ackMessage(db, { messageId: original.messageId, ackedBy: "$target" }, now);
      expect(messageStatus(db, "request-1")?.replyStatus).toBe("fulfilled");
      const journal = db.raw.query<{ payload_json: string }, []>("SELECT payload_json FROM event_journal").all();
      expect(journal.every((row) => !row.payload_json.includes("private body") && !row.payload_json.includes("reply body"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("same reply key is idempotent; conflicting key and terminal targets fail structurally", () => {
    const { db, cleanup, now } = setup();
    try {
      sendMessage(db, { messageKey: "request-1", senderId: "$s", recipientId: "$r", summary: "work", expectsReply: true }, now);
      const first = replyMessage(db, { messageKey: "reply-1", replyToMessageKey: "request-1", senderId: "$r", summary: "done" }, now);
      const duplicate = replyMessage(db, { messageKey: "reply-1", replyToMessageKey: "request-1", senderId: "$r", summary: "done" }, now);
      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.messageId).toBe(first.messageId);
      expectCode(() => replyMessage(db, { messageKey: "reply-2", replyToMessageKey: "request-1", senderId: "$r", summary: "again" }, now), "XTMUX_ALREADY_FULFILLED");
      expectCode(() => sendMessage(db, { messageKey: "reply-1", senderId: "$r", recipientId: "$s", summary: "different", replyToMessageId: first.messageId }, now), "XTMUX_MESSAGE_KEY_CONFLICT");
    } finally {
      cleanup();
    }
  });

  test("wrong participant, pane, missing target, self-reference, and endpoint override refuse", () => {
    const { db, cleanup, now } = setup();
    try {
      sendMessage(db, { messageKey: "request-1", senderId: "$s", senderPaneId: "%s", recipientId: "$r", targetPaneId: "%r", summary: "work", expectsReply: true }, now);
      expectCode(() => replyMessage(db, { messageKey: "bad-1", replyToMessageKey: "request-1", senderId: "$other", senderPaneId: "%r", summary: "x" }, now), "XTMUX_WRONG_RECIPIENT");
      expectCode(() => replyMessage(db, { messageKey: "bad-2", replyToMessageKey: "request-1", senderId: "$r", senderPaneId: "%other", summary: "x" }, now), "XTMUX_WRONG_PANE");
      expectCode(() => replyMessage(db, { messageKey: "bad-3", replyToMessageKey: "missing", senderId: "$r", summary: "x" }, now), "XTMUX_INVALID_CORRELATION");
      expectCode(() => replyMessage(db, { messageKey: "request-1", replyToMessageKey: "request-1", senderId: "$r", senderPaneId: "%r", summary: "x" }, now), "XTMUX_MESSAGE_KEY_CONFLICT");
      expectCode(() => replyMessage(db, { messageKey: "bad-4", replyToMessageKey: "request-1", senderId: "$r", senderPaneId: "%r", recipientId: "$s", summary: "x" }, now), "XTMUX_ENDPOINT_OVERRIDE");
      const rejected = db.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM event_journal WHERE type = 'messages.reply.rejected'").get();
      expect(rejected?.n).toBe(5);
    } finally {
      cleanup();
    }
  });
});
