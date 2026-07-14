import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../../src/db/connection.ts";
import { applyRetention, loadRetentionConfig } from "../../src/db/retention.ts";
import { migrate } from "../../src/db/schema.ts";
import { ackMessage } from "../../src/domains/messages/ack.ts";
import { MessageError } from "../../src/domains/messages/errors.ts";
import { listPendingObligations } from "../../src/domains/messages/obligations.ts";
import { replyMessage } from "../../src/domains/messages/reply.ts";
import { sendMessage } from "../../src/domains/messages/send.ts";
import {
  armOutboundWait,
  consumeOutboundWake,
  deliverOutboundWake,
  getOutboundWait,
  OutboundWaitOwnershipError,
  registerOutboundWait,
  replayOutboundWakes,
  terminalizeOutboundWait,
} from "../../src/domains/monitors/outbound-wake.ts";
import { register, terminate } from "../../src/domains/monitors/store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function setup(): { db: Db; dbPath: string; close: () => void; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "xtmux-coordination-state-"));
  const dbPath = join(root, "observability.db");
  const db = openDb({ dbPath, mode: "on", busyTimeoutMs: 3000 });
  let closed = false;
  return {
    db,
    dbPath,
    close: () => {
      if (closed) return;
      db.close();
      closed = true;
    },
    cleanup: () => {
      if (!closed) db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function request(db: Db, key: string, nowMs: number) {
  return sendMessage(db, {
    messageKey: key,
    senderId: "$owner",
    senderPaneId: "%owner",
    recipientId: "$worker",
    targetPaneId: "%worker",
    summary: `secret-${key}`,
    payloadJson: JSON.stringify({ token: `token-${key}` }),
    expectsReply: true,
  }, () => nowMs);
}

function monitor(db: Db, id: string, nowMs: number): void {
  register(db, {
    id,
    target: "$target",
    sessionId: "$target",
    paneId: "%target",
    state: "working",
    intervalMs: 1000,
    nowMs,
  });
}

function wait(db: Db, id: string, requesterSessionId: string, requesterPaneId: string, monitorId: string, nowMs: number): void {
  registerOutboundWait(db, {
    waitId: id,
    requesterSessionId,
    requesterPaneId,
    targetSessionId: "$target",
    targetPaneId: "%target",
    nowMs,
  });
  monitor(db, monitorId, nowMs);
  armOutboundWait(db, {
    waitId: id,
    monitorId,
    requesterSessionId,
    requesterPaneId,
    nowMs: nowMs + 1,
  });
}

describe("SQLite coordination state machines", () => {
  test("fresh migration, reopen, and retention preserve pending work and prune terminal pairs", () => {
    const ctx = setup();
    try {
      const first = migrate(ctx.db, () => 1000);
      expect(first.applied).toEqual(expect.arrayContaining([10, 11]));
      expect(ctx.db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(ctx.db.raw.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('messages', 'outbound_waits') ORDER BY name").all()).toEqual([
        { name: "messages" },
        { name: "outbound_waits" },
      ]);

      const now = 1_000_000_000_000;
      const old = now - 90 * DAY_MS;
      const pending = request(ctx.db, "retention-pending", old);
      ackMessage(ctx.db, { messageId: pending.messageId, ackedBy: "$worker" }, () => old + 1);
      const terminal = request(ctx.db, "retention-terminal", old);
      ackMessage(ctx.db, { messageId: terminal.messageId, ackedBy: "$worker" }, () => old + 1);
      const reply = replyMessage(ctx.db, {
        messageKey: "retention-reply",
        replyToMessageKey: "retention-terminal",
        senderId: "$worker",
        senderPaneId: "%worker",
        summary: "secret-terminal-reply",
        payloadJson: JSON.stringify({ token: "retention-secret" }),
      }, () => old + 2);
      ackMessage(ctx.db, { messageId: reply.messageId, ackedBy: "$owner" }, () => old + 3);

      const report = applyRetention(ctx.db, {
        ...loadRetentionConfig(),
        messageDays: 30,
        replyRetentionDays: 30,
      }, () => now);
      expect(report).toMatchObject({ messagesDeleted: 2, replyMessagesDeleted: 1 });
      expect(listPendingObligations(ctx.db, { senderId: "$owner", senderPaneId: "%owner" }).map((row) => row.messageKey)).toEqual(["retention-pending"]);
      const pruned = ctx.db.raw.query<{ payload_json: string }, []>("SELECT payload_json FROM event_journal WHERE type = 'messages.obligation.pruned'").get();
      expect(JSON.parse(pruned?.payload_json ?? "{}")).toEqual({
        outcome: "pruned",
        pairs: [{ original_id: terminal.messageId, reply_id: reply.messageId }],
        count: 1,
      });
      expect(pruned?.payload_json).not.toContain("secret");

      ctx.close();
      const reopened = openDb({ dbPath: ctx.dbPath, mode: "on", busyTimeoutMs: 3000 });
      try {
        const again = migrate(reopened, () => now + 1);
        expect(again.applied).toEqual([]);
        expect(again.skipped).toEqual(first.applied);
        expect(listPendingObligations(reopened, { senderId: "$owner", senderPaneId: "%owner" }).map((row) => row.messageKey)).toEqual(["retention-pending"]);
      } finally {
        reopened.close();
      }
    } finally {
      ctx.cleanup();
    }
  });

  test("ack/reply order, duplicates, direction, and pane/session guards are deterministic", () => {
    const ctx = setup();
    try {
      migrate(ctx.db);
      const ackFirst = request(ctx.db, "ack-first", 1000);
      expect(ackMessage(ctx.db, { messageId: ackFirst.messageId, ackedBy: "$worker" }, () => 1100).status).toBe("acked");
      expect(listPendingObligations(ctx.db, { senderId: "$owner", senderPaneId: "%owner" }).map((row) => row.messageKey)).toEqual(["ack-first"]);
      const ackFirstReply = replyMessage(ctx.db, {
        messageKey: "ack-first-reply",
        replyToMessageKey: "ack-first",
        senderId: "$worker",
        senderPaneId: "%worker",
        summary: "secret-ack-first-reply",
      }, () => 1200);
      expect(ackMessage(ctx.db, { messageId: ackFirst.messageId, ackedBy: "$worker" }, () => 1300)).toMatchObject({ status: "already-acked", ackedAtMs: 1100 });
      expect(replyMessage(ctx.db, {
        messageKey: "ack-first-reply",
        replyToMessageKey: "ack-first",
        senderId: "$worker",
        senderPaneId: "%worker",
        summary: "secret-ack-first-reply",
      }, () => 1400)).toMatchObject({ duplicate: true, messageId: ackFirstReply.messageId });

      const replyFirst = request(ctx.db, "reply-first", 2000);
      replyMessage(ctx.db, {
        messageKey: "reply-first-reply",
        replyToMessageKey: "reply-first",
        senderId: "$worker",
        senderPaneId: "%worker",
        summary: "secret-reply-first",
      }, () => 2100);
      expect(ackMessage(ctx.db, { messageId: replyFirst.messageId, ackedBy: "$worker" }, () => 2200).status).toBe("acked");

      const guarded = request(ctx.db, "guarded", 3000);
      const invalid = [
        () => replyMessage(ctx.db, { messageKey: "wrong-session", replyToMessageKey: "guarded", senderId: "$other", senderPaneId: "%worker", summary: "x" }),
        () => replyMessage(ctx.db, { messageKey: "wrong-pane", replyToMessageKey: "guarded", senderId: "$worker", senderPaneId: "%other", summary: "x" }),
        () => replyMessage(ctx.db, { messageKey: "wrong-direction", replyToMessageKey: "guarded", senderId: "$worker", senderPaneId: "%worker", recipientId: "$owner", summary: "x" }),
        () => replyMessage(ctx.db, { messageKey: "missing-key", replyToMessageKey: "missing", senderId: "$worker", senderPaneId: "%worker", summary: "x" }),
      ];
      expect(invalid.map((action) => {
        try {
          action();
          return "accepted";
        } catch (error) {
          return error instanceof MessageError ? error.code : "unexpected";
        }
      })).toEqual(["XTMUX_WRONG_RECIPIENT", "XTMUX_WRONG_PANE", "XTMUX_ENDPOINT_OVERRIDE", "XTMUX_INVALID_CORRELATION"]);
      expect(ctx.db.raw.query("SELECT fulfilled_at_ms FROM messages WHERE id = ?").get(guarded.messageId)).toEqual({ fulfilled_at_ms: null });

      const linked = ctx.db.raw.query<{ correlation_id: string; session_id: string; pane_id: string; payload_json: string }, []>(
        "SELECT correlation_id, session_id, pane_id, payload_json FROM event_journal WHERE type = 'messages.reply.linked' ORDER BY id",
      ).all();
      expect(linked).toHaveLength(2);
      expect(linked.map((row) => JSON.parse(row.payload_json))).toEqual([
        { message_id: ackFirstReply.messageId, reply_to_message_id: ackFirst.messageId, fulfilled_at_ms: 1200, outcome: "fulfilled" },
        expect.objectContaining({ reply_to_message_id: replyFirst.messageId, outcome: "fulfilled" }),
      ]);
      expect(linked[0]).toMatchObject({ correlation_id: "ack-first-reply", session_id: "$owner", pane_id: "%owner" });
      expect(linked.every((row) => !row.payload_json.includes("secret") && !row.payload_json.includes("token"))).toBe(true);
    } finally {
      ctx.cleanup();
    }
  });

  test("arm, terminal replay, delivery, and consume stay isolated between two requesters", () => {
    const ctx = setup();
    try {
      migrate(ctx.db);
      wait(ctx.db, "wait-a", "$requester-a", "%a", "monitor-a", 1000);
      wait(ctx.db, "wait-b", "$requester-b", "%b", "monitor-b", 1100);
      expect(terminalizeOutboundWait(ctx.db, "monitor-a", "done", 2000)).toBe(true);
      terminate(ctx.db, "monitor-b", "timeout", 2100);
      ctx.close();

      const reopened = openDb({ dbPath: ctx.dbPath, mode: "on", busyTimeoutMs: 3000 });
      try {
        expect(replayOutboundWakes(reopened, 2200)).toBe(1);
        expect(getOutboundWait(reopened, "wait-a", "$requester-a", "%a")).toMatchObject({ state: "terminal-unconsumed", terminalStatus: "done" });
        expect(getOutboundWait(reopened, "wait-b", "$requester-b", "%b")).toMatchObject({ state: "terminal-unconsumed", terminalStatus: "timeout" });
        expect(() => deliverOutboundWake(reopened, { waitId: "wait-b", requesterSessionId: "$requester-a", requesterPaneId: "%a", nowMs: 2300 })).toThrow(OutboundWaitOwnershipError);
        expect(deliverOutboundWake(reopened, { waitId: "wait-a", requesterSessionId: "$requester-a", requesterPaneId: "%a", nowMs: 2301 })).toMatchObject({ delivered: true, duplicate: false });
        expect(consumeOutboundWake(reopened, { waitId: "wait-a", requesterSessionId: "$requester-a", requesterPaneId: "%a", nowMs: 2302 })).toMatchObject({ consumed: true, duplicate: false });
        expect(consumeOutboundWake(reopened, { waitId: "wait-a", requesterSessionId: "$requester-a", requesterPaneId: "%a", nowMs: 2303 })).toMatchObject({ consumed: false, duplicate: true });
        expect(deliverOutboundWake(reopened, { waitId: "wait-b", requesterSessionId: "$requester-b", requesterPaneId: "%b", nowMs: 2304 })).toMatchObject({ delivered: true });

        const events = reopened.raw.query<{ type: string; correlation_id: string; payload_json: string }, []>(
          "SELECT type, correlation_id, payload_json FROM event_journal WHERE correlation_id IN ('wait:wait-a', 'wait:wait-b') ORDER BY id",
        ).all();
        expect(events.length).toBeGreaterThanOrEqual(9);
        for (const event of events) {
          const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
          expect(payload.wait_id).toBe(event.correlation_id.slice(5));
          expect(payload).toHaveProperty("outcome");
          expect(event.payload_json).not.toMatch(/secret|token|summary|payload/i);
        }
      } finally {
        reopened.close();
      }
    } finally {
      ctx.cleanup();
    }
  });
});
