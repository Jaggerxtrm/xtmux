import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/schema.ts";
import { sendMessage } from "../../src/domains/messages/send.ts";
import { listMessages } from "../../src/domains/messages/list.ts";
import { ackMessage } from "../../src/domains/messages/ack.ts";
import { computeUnread } from "../../src/domains/messages/reconcile-unread.ts";
import { recordDelivery } from "../../src/domains/deliveries/attempt.ts";
import type { Config } from "../../src/config.ts";
import type { Db } from "../../src/db/connection.ts";

function setup(): { db: Db; cleanup: () => void; now: { t: number } } {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-msg-"));
  const cfg: Config = { dbPath: join(dir, "test.db"), mode: "off", busyTimeoutMs: 3000 };
  const db = openDb(cfg);
  migrate(db);
  return {
    db,
    now: { t: 1_000 },
    cleanup: (): void => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("messages: send + list + ack", () => {
  test("send inserts message + receipt in one transaction; list returns it", () => {
    const { db, cleanup, now } = setup();
    try {
      const r = sendMessage(
        db,
        {
          messageKey: "k1",
          senderId: "$sender",
          recipientId: "$recipient",
          summary: "hello",
        },
        () => ++now.t,
      );
      expect(r.duplicate).toBe(false);
      expect(r.messageId).toBeGreaterThan(0);

      const rows = listMessages(db, { recipientId: "$recipient" });
      expect(rows.length).toBe(1);
      expect(rows[0]!.summary).toBe("hello");
      expect(rows[0]!.acked_at_ms).toBeNull();

      // envelope written
      const envelopes = db.raw
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM event_journal WHERE type = 'messages.sent'",
        )
        .get();
      expect(envelopes?.n).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("resend with same message_key is idempotent (no duplicate row)", () => {
    const { db, cleanup, now } = setup();
    try {
      const a = sendMessage(
        db,
        { messageKey: "same", senderId: "$s", recipientId: "$r", summary: "x" },
        () => ++now.t,
      );
      const b = sendMessage(
        db,
        { messageKey: "same", senderId: "$s", recipientId: "$r", summary: "x" },
        () => ++now.t,
      );
      expect(a.messageId).toBe(b.messageId);
      expect(b.duplicate).toBe(true);
      const rows = listMessages(db, { recipientId: "$r" });
      expect(rows.length).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("list --unacked filters acked receipts", () => {
    const { db, cleanup, now } = setup();
    try {
      const { messageId: m1 } = sendMessage(
        db,
        { messageKey: "a", senderId: "$s", recipientId: "$r", summary: "one" },
        () => ++now.t,
      );
      sendMessage(
        db,
        { messageKey: "b", senderId: "$s", recipientId: "$r", summary: "two" },
        () => ++now.t,
      );
      ackMessage(db, { messageId: m1, ackedBy: "$r" }, () => ++now.t);

      const all = listMessages(db, { recipientId: "$r" });
      expect(all.length).toBe(2);
      const unacked = listMessages(db, { recipientId: "$r", unackedOnly: true });
      expect(unacked.length).toBe(1);
      expect(unacked[0]!.message_key).toBe("b");
    } finally {
      cleanup();
    }
  });

  test("ack is idempotent + rejects wrong recipient + rejects unknown", () => {
    const { db, cleanup, now } = setup();
    try {
      const { messageId } = sendMessage(
        db,
        { messageKey: "k", senderId: "$s", recipientId: "$r", summary: "x" },
        () => ++now.t,
      );
      const first = ackMessage(db, { messageId, ackedBy: "$r" }, () => ++now.t);
      expect(first.status).toBe("acked");
      const firstAt = first.ackedAtMs!;

      const second = ackMessage(db, { messageId, ackedBy: "$r" }, () => ++now.t);
      expect(second.status).toBe("already-acked");
      expect(second.ackedAtMs).toBe(firstAt); // timestamp unchanged on re-ack

      const wrong = ackMessage(db, { messageId, ackedBy: "$other" }, () => ++now.t);
      expect(wrong.status).toBe("wrong-recipient");

      const unknown = ackMessage(db, { messageId: 99999, ackedBy: "$r" }, () => ++now.t);
      expect(unknown.status).toBe("unknown-message");

      // envelope written exactly once for the successful ack
      const acks = db.raw
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM event_journal WHERE type = 'messages.ack'",
        )
        .get();
      expect(acks?.n).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("delete of message cascades to receipts (FK ON DELETE CASCADE)", () => {
    const { db, cleanup, now } = setup();
    try {
      const { messageId } = sendMessage(
        db,
        { messageKey: "k", senderId: "$s", recipientId: "$r", summary: "x" },
        () => ++now.t,
      );
      db.raw.exec(`DELETE FROM messages WHERE id = ${messageId}`);
      const rcpt = db.raw
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM message_receipts")
        .get();
      expect(rcpt?.n).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("unread reconciliation", () => {
  test("computeUnread returns count + oldest unacked timestamp; zero after ack", () => {
    const { db, cleanup, now } = setup();
    try {
      const { messageId: m1 } = sendMessage(
        db,
        { messageKey: "a", senderId: "$s", recipientId: "$r", summary: "1" },
        () => ++now.t,
      );
      sendMessage(
        db,
        { messageKey: "b", senderId: "$s", recipientId: "$r", summary: "2" },
        () => ++now.t,
      );

      const before = computeUnread(db, "$r");
      expect(before.unreadCount).toBe(2);
      expect(before.oldestUnackedAtMs).not.toBeNull();

      ackMessage(db, { messageId: m1, ackedBy: "$r" }, () => ++now.t);
      const mid = computeUnread(db, "$r");
      expect(mid.unreadCount).toBe(1);

      // Ack the second one
      const { messageId: m2 } = sendMessage(
        db,
        { messageKey: "c", senderId: "$s", recipientId: "$r", summary: "3" },
        () => ++now.t,
      );
      ackMessage(db, { messageId: m2, ackedBy: "$r" }, () => ++now.t);
      // still 1 remaining (the "b" message)
      const after = computeUnread(db, "$r");
      expect(after.unreadCount).toBe(1);
    } finally {
      cleanup();
    }
  });
});

describe("pane-level addressing (same-session ambiguity fix)", () => {
  test("target_pane_id disambiguates two panes of the same session", () => {
    const { db, cleanup, now } = setup();
    try {
      // xtmux:1.1 -> xtmux:1.2 scenario: both panes are of session $1732 so the
      // durable recipient_id collapses to $1732 for both. target_pane_id keeps
      // them distinguishable at message-list time.
      sendMessage(
        db,
        {
          messageKey: "to-pane-a",
          senderId: "$1732",
          senderPaneId: "%1930",
          recipientId: "$1732",
          targetPaneId: "%1930",
          summary: "for pane A",
        },
        () => ++now.t,
      );
      sendMessage(
        db,
        {
          messageKey: "to-pane-b",
          senderId: "$1732",
          senderPaneId: "%1930",
          recipientId: "$1732",
          targetPaneId: "%1931",
          summary: "for pane B",
        },
        () => ++now.t,
      );
      sendMessage(
        db,
        {
          messageKey: "session-wide",
          senderId: "$1732",
          recipientId: "$1732",
          summary: "for anyone in the session",
        },
        () => ++now.t,
      );

      // pane B sees its own directed messages + the session-wide one; NOT pane A's
      const forB = listMessages(db, { recipientId: "$1732", targetPaneId: "%1931" });
      expect(forB.length).toBe(2);
      const summariesForB = forB.map((r) => r.summary).sort();
      expect(summariesForB).toEqual(["for anyone in the session", "for pane B"]);

      // pure session listing (no --pane) still sees all three
      const forSession = listMessages(db, { recipientId: "$1732" });
      expect(forSession.length).toBe(3);
    } finally {
      cleanup();
    }
  });
});

describe("delivery attempts", () => {
  test("recordDelivery writes typed row + envelope; success + fail both recorded", () => {
    const { db, cleanup, now } = setup();
    try {
      const okId = recordDelivery(
        db,
        {
          kind: "pane_pointer",
          targetSessionId: "$1",
          targetPaneId: "%9",
          payloadSummary: "hello",
          succeeded: true,
        },
        () => ++now.t,
      );
      expect(okId).toBeGreaterThan(0);

      const failId = recordDelivery(
        db,
        {
          kind: "handoff_pointer",
          targetSessionId: "$1",
          targetPaneId: "%10",
          succeeded: false,
          failureCode: "target_gone",
        },
        () => ++now.t,
      );
      expect(failId).toBeGreaterThan(0);

      const rows = db.raw
        .query<{ n: number; kinds: string }, []>(
          `SELECT COUNT(*) AS n,
                  GROUP_CONCAT(kind || ':' || succeeded, ',') AS kinds
             FROM delivery_attempts`,
        )
        .get();
      expect(rows?.n).toBe(2);

      const okEnv = db.raw
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM event_journal WHERE type = 'deliveries.pane_pointer.ok'",
        )
        .get();
      expect(okEnv?.n).toBe(1);
      const failEnv = db.raw
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM event_journal WHERE type = 'deliveries.handoff_pointer.fail'",
        )
        .get();
      expect(failEnv?.n).toBe(1);
    } finally {
      cleanup();
    }
  });
});

describe("concurrent send", () => {
  test("100 concurrent sends produce 100 distinct rows via unique message_key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xtmux-msg-conc-"));
    const cfg: Config = { dbPath: join(dir, "test.db"), mode: "off", busyTimeoutMs: 3000 };
    try {
      const bootstrap = openDb(cfg);
      migrate(bootstrap);
      bootstrap.close();

      const errors: string[] = [];
      await Promise.all(
        Array.from({ length: 100 }, async (_, i) => {
          const db = openDb(cfg);
          try {
            sendMessage(
              db,
              {
                messageKey: `conc-${i}`,
                senderId: "$s",
                recipientId: "$r",
                summary: `m${i}`,
              },
            );
          } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err));
          } finally {
            db.close();
          }
        }),
      );
      expect(errors).toEqual([]);

      const check = openDb(cfg);
      const total = check.raw
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM messages")
        .get();
      expect(total?.n).toBe(100);
      const distinct = check.raw
        .query<{ n: number }, []>("SELECT COUNT(DISTINCT message_key) AS n FROM messages")
        .get();
      expect(distinct?.n).toBe(100);
      const rcpt = check.raw
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM message_receipts")
        .get();
      expect(rcpt?.n).toBe(100);
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
