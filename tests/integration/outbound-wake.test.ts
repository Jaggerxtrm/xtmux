import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.ts";
import { openDb, type Db } from "../../src/db/connection.ts";
import { migration as outboundWakeMigration } from "../../src/db/migrations/0011_outbound_wake_ownership.ts";
import { migrate } from "../../src/db/schema.ts";
import {
  armOutboundWait,
  cancelOutboundWait,
  consumeOutboundWake,
  deliverOutboundWake,
  getOutboundWait,
  listOutboundWaits,
  registerOutboundWait,
  replayOutboundWakes,
  terminalizeOutboundWait,
  OutboundWaitOwnershipError,
  OutboundWaitTargetMismatchError,
} from "../../src/domains/monitors/outbound-wake.ts";
import { register, terminate } from "../../src/domains/monitors/store.ts";

function setup(): { db: Db; path: string; closeDb: () => void; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-outbound-wake-"));
  const path = join(dir, "test.db");
  const cfg: Config = { dbPath: path, mode: "off", busyTimeoutMs: 3000 };
  const db = openDb(cfg);
  migrate(db);
  db.raw.exec(outboundWakeMigration.up);
  let closed = false;
  const closeDb = (): void => {
    if (closed) return;
    db.close();
    closed = true;
  };
  return {
    db,
    path,
    closeDb,
    cleanup: (): void => {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeWait(db: Db, waitId = "wait-1"): void {
  registerOutboundWait(db, {
    waitId,
    requesterSessionId: "$requester",
    requesterPaneId: "%requester",
    targetSessionId: "$target",
    targetPaneId: "%target",
    nowMs: 1000,
  });
}

function makeMonitor(db: Db, monitorId = "monitor-1"): void {
  register(db, {
    id: monitorId,
    target: "$target",
    sessionId: "$target",
    paneId: "%target",
    state: "working",
    intervalMs: 30_000,
    nowMs: 1000,
  });
}

describe("outbound wake migration", () => {
  test("creates requester-owned state table and idempotent indexes", () => {
    const { db, cleanup } = setup();
    try {
      const table = db.raw
        .query<{ name: string }, [string]>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get("outbound_waits");
      expect(table?.name).toBe("outbound_waits");
      db.raw.exec(outboundWakeMigration.up);
      const indexes = db.raw
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name LIKE 'ow_%'",
        )
        .get();
      expect(indexes?.n).toBe(5);
    } finally {
      cleanup();
    }
  });
});

describe("outbound wake lifecycle", () => {
  test("register and arm are idempotent, target-linked, and pane isolated", () => {
    const { db, cleanup } = setup();
    try {
      makeWait(db);
      makeMonitor(db);
      expect(registerOutboundWait(db, {
        waitId: "wait-1",
        requesterSessionId: "$requester",
        requesterPaneId: "%requester",
        targetSessionId: "$target",
        targetPaneId: "%target",
        nowMs: 2000,
      }).duplicate).toBe(true);
      const first = armOutboundWait(db, {
        waitId: "wait-1",
        monitorId: "monitor-1",
        requesterSessionId: "$requester",
        requesterPaneId: "%requester",
        nowMs: 2000,
      });
      const second = armOutboundWait(db, {
        waitId: "wait-1",
        monitorId: "monitor-1",
        requesterSessionId: "$requester",
        requesterPaneId: "%requester",
        nowMs: 2001,
      });
      expect(first.wait.state).toBe("armed");
      expect(second.duplicate).toBe(true);
      expect(second.wait.monitorId).toBe("monitor-1");
      expect(listOutboundWaits(db, "$requester", "%requester")).toHaveLength(1);
      expect(listOutboundWaits(db, "$requester", "%other")).toHaveLength(0);

      expect(() => armOutboundWait(db, {
        waitId: "wait-1",
        monitorId: "monitor-1",
        requesterSessionId: "$other",
        requesterPaneId: "%requester",
        nowMs: 2002,
      })).toThrow(OutboundWaitOwnershipError);
    } finally {
      cleanup();
    }
  });

  test("rejects monitor target mismatch without linking wait", () => {
    const { db, cleanup } = setup();
    try {
      makeWait(db);
      register(db, {
        id: "wrong-monitor",
        target: "$other",
        sessionId: "$other",
        paneId: "%other",
        state: "working",
        intervalMs: 30_000,
        nowMs: 1000,
      });
      expect(() => armOutboundWait(db, {
        waitId: "wait-1",
        monitorId: "wrong-monitor",
        nowMs: 2000,
      })).toThrow(OutboundWaitTargetMismatchError);
      expect(getOutboundWait(db, "wait-1", "$requester", "%requester").state).toBe("unarmed");
    } finally {
      cleanup();
    }
  });

  test("terminal delivery and consumption are one-time, with requester isolation", () => {
    const { db, cleanup } = setup();
    try {
      makeWait(db);
      makeMonitor(db);
      armOutboundWait(db, { waitId: "wait-1", monitorId: "monitor-1", nowMs: 2000 });
      expect(terminalizeOutboundWait(db, "monitor-1", "done", 3000)).toBe(true);
      expect(terminalizeOutboundWait(db, "monitor-1", "done", 3001)).toBe(false);
      expect(deliverOutboundWake(db, "wait-1", 3002).delivered).toBe(true);
      expect(deliverOutboundWake(db, "wait-1", 3003).duplicate).toBe(true);
      expect(() => consumeOutboundWake(db, {
        waitId: "wait-1",
        requesterSessionId: "$other",
        requesterPaneId: "%requester",
        nowMs: 3004,
      })).toThrow(OutboundWaitOwnershipError);
      expect(consumeOutboundWake(db, {
        waitId: "wait-1",
        requesterSessionId: "$requester",
        requesterPaneId: "%requester",
        nowMs: 3005,
      }).consumed).toBe(true);
      expect(consumeOutboundWake(db, {
        waitId: "wait-1",
        requesterSessionId: "$requester",
        requesterPaneId: "%requester",
        nowMs: 3006,
      }).duplicate).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("replays terminal monitor state after database restart", () => {
    const { db, path, closeDb, cleanup } = setup();
    try {
      makeWait(db);
      makeMonitor(db);
      armOutboundWait(db, { waitId: "wait-1", monitorId: "monitor-1", nowMs: 2000 });
      terminate(db, "monitor-1", "timeout", 3000);
      closeDb();

      const reopened = openDb({ dbPath: path, mode: "off", busyTimeoutMs: 3000 });
      try {
        expect(replayOutboundWakes(reopened, 4000)).toBe(1);
        expect(getOutboundWait(reopened, "wait-1", "$requester", "%requester").state)
          .toBe("terminal-unconsumed");
        deliverOutboundWake(reopened, "wait-1", 4001);
        expect(consumeOutboundWake(reopened, {
          waitId: "wait-1",
          requesterSessionId: "$requester",
          requesterPaneId: "%requester",
          nowMs: 4002,
        }).consumed).toBe(true);
      } finally {
        reopened.close();
      }
    } finally {
      cleanup();
    }
  });

  test("expiry is terminal before arm and cancellation is owner-scoped", () => {
    const { db, cleanup } = setup();
    try {
      registerOutboundWait(db, {
        waitId: "expiring",
        requesterSessionId: "$requester",
        requesterPaneId: "%requester",
        targetSessionId: "$target",
        targetPaneId: "%target",
        expiresAtMs: 2000,
        nowMs: 1000,
      });
      expect(armOutboundWait(db, {
        waitId: "expiring",
        monitorId: "missing-monitor",
        nowMs: 2000,
      }).wait.state).toBe("expired");
      makeWait(db, "cancelled");
      expect(() => cancelOutboundWait(db, {
        waitId: "cancelled",
        requesterSessionId: "$other",
        requesterPaneId: "%requester",
        nowMs: 2000,
      })).toThrow(OutboundWaitOwnershipError);
    } finally {
      cleanup();
    }
  });

  test("cancel is absorbing and journal payload excludes body-like fields", () => {
    const { db, cleanup } = setup();
    try {
      makeWait(db);
      cancelOutboundWait(db, {
        waitId: "wait-1",
        requesterSessionId: "$requester",
        requesterPaneId: "%requester",
        reasonCode: "caller_cancelled",
        nowMs: 2000,
      });
      const again = cancelOutboundWait(db, {
        waitId: "wait-1",
        requesterSessionId: "$requester",
        requesterPaneId: "%requester",
        nowMs: 2001,
      });
      expect(again.duplicate).toBe(true);
      const events = db.raw
        .query<{ payload_json: string }, []>(
          "SELECT payload_json FROM event_journal WHERE type = 'wait.cancelled'",
        )
        .all();
      expect(events).toHaveLength(1);
      expect(events[0]?.payload_json).not.toContain("summary");
      expect(events[0]?.payload_json).not.toContain("payload");
    } finally {
      cleanup();
    }
  });
});
