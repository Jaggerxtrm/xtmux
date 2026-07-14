import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
import {
  adopt,
  kill,
  reconcileAll,
  register,
  terminate,
} from "../../src/domains/monitors/store.ts";
import type { TerminalStatus } from "../../src/domains/monitors/terminal.ts";

const TEST_ROOT = mkdtempSync("/tmp/xtmux-outbound-wake-");
const ISOLATED_ENV_KEYS = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "TMPDIR",
  "TMUX_TMPDIR",
] as const;
const previousEnv = new Map<string, string | undefined>(
  ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]),
);
for (const key of ISOLATED_ENV_KEYS) process.env[key] = TEST_ROOT;

afterAll(() => {
  for (const key of ISOLATED_ENV_KEYS) {
    const value = previousEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

function setup(): { db: Db; path: string; closeDb: () => void; cleanup: () => void } {
  const dir = mkdtempSync(join(TEST_ROOT, "case-"));
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

function armMonitorWait(db: Db, monitorId = "monitor-1"): void {
  makeWait(db);
  makeMonitor(db, monitorId);
  armOutboundWait(db, {
    waitId: "wait-1",
    monitorId,
    requesterSessionId: "$requester",
    requesterPaneId: "%requester",
    nowMs: 2000,
  });
}

function expectTerminalUnconsumed(
  db: Db,
  terminalStatus: TerminalStatus,
  nowMs: number,
): void {
  expect(replayOutboundWakes(db, nowMs)).toBe(1);
  expect(getOutboundWait(db, "wait-1", "$requester", "%requester")).toMatchObject({
    state: "terminal-unconsumed",
    terminalStatus,
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

describe("terminal monitor outbound wakes", () => {
  test("killed monitor becomes terminal-unconsumed", () => {
    const { db, cleanup } = setup();
    try {
      armMonitorWait(db);
      const signalled: number[] = [];
      adopt(db, "monitor-1", 4321, 2500);
      expect(kill(db, {
        signal: (pid) => signalled.push(pid),
      }, "monitor-1", 3000)).toBe("killed\tmonitor-1");
      expect(signalled).toEqual([4321]);
      expectTerminalUnconsumed(db, "killed", 3001);
    } finally {
      cleanup();
    }
  });

  test("target-gone monitor becomes terminal-unconsumed", () => {
    const { db, cleanup } = setup();
    try {
      armMonitorWait(db);
      expect(reconcileAll(db, {
        pidAlive: () => true,
        paneAlive: () => false,
      }, 3000)).toEqual([{ id: "monitor-1", status: "target_gone" }]);
      expectTerminalUnconsumed(db, "target_gone", 3001);
    } finally {
      cleanup();
    }
  });

  test("process-gone monitor becomes terminal-unconsumed", () => {
    const { db, cleanup } = setup();
    try {
      armMonitorWait(db);
      adopt(db, "monitor-1", 4321, 2500);
      expect(reconcileAll(db, {
        pidAlive: () => false,
        paneAlive: () => true,
      }, 3000)).toEqual([{ id: "monitor-1", status: "process_gone" }]);
      expectTerminalUnconsumed(db, "process_gone", 3001);
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
      expect(() => registerOutboundWait(db, {
        waitId: "wait-1",
        requesterSessionId: "$requester",
        requesterPaneId: "%requester",
        targetSessionId: "$other",
        targetPaneId: "%target",
        nowMs: 2000,
      })).toThrow(/identity conflict/);
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
      expect(() => armOutboundWait(db, {
        waitId: "wait-1",
        monitorId: "monitor-1",
        requesterSessionId: "$requester",
        requesterPaneId: "%other",
        nowMs: 2003,
      })).toThrow(OutboundWaitOwnershipError);
    } finally {
      cleanup();
    }
  });

  test("concurrent registration and arm preserve one owner and one monitor", async () => {
    const { db, path, cleanup } = setup();
    const left = openDb({ dbPath: path, mode: "off", busyTimeoutMs: 3000 });
    const right = openDb({ dbPath: path, mode: "off", busyTimeoutMs: 3000 });
    try {
      const registrations = await Promise.all([
        Promise.resolve().then(() => registerOutboundWait(db, {
          waitId: "race",
          requesterSessionId: "$requester",
          requesterPaneId: "%requester",
          targetSessionId: "$target",
          targetPaneId: "%target",
          nowMs: 1000,
        })),
        Promise.resolve().then(() => registerOutboundWait(left, {
          waitId: "race",
          requesterSessionId: "$requester",
          requesterPaneId: "%requester",
          targetSessionId: "$target",
          targetPaneId: "%target",
          nowMs: 1001,
        })),
      ]);
      expect(registrations.filter((item) => !item.duplicate)).toHaveLength(1);
      expect(registrations.filter((item) => item.duplicate)).toHaveLength(1);

      makeMonitor(db, "race-monitor");
      const arms = await Promise.all([
        Promise.resolve().then(() => armOutboundWait(db, {
          waitId: "race",
          monitorId: "race-monitor",
          requesterSessionId: "$requester",
          requesterPaneId: "%requester",
          nowMs: 2000,
        })),
        Promise.resolve().then(() => armOutboundWait(right, {
          waitId: "race",
          monitorId: "race-monitor",
          requesterSessionId: "$requester",
          requesterPaneId: "%requester",
          nowMs: 2001,
        })),
      ]);
      expect(arms.filter((item) => !item.duplicate)).toHaveLength(1);
      expect(arms.filter((item) => item.duplicate)).toHaveLength(1);
      expect(getOutboundWait(db, "race", "$requester", "%requester").monitorId).toBe("race-monitor");

      expect(terminalizeOutboundWait(db, "race-monitor", "done", 3000)).toBe(true);
      const deliveries = await Promise.all([
        Promise.resolve().then(() => deliverOutboundWake(db, {
          waitId: "race",
          requesterSessionId: "$requester",
          requesterPaneId: "%requester",
          nowMs: 3001,
        })),
        Promise.resolve().then(() => deliverOutboundWake(left, {
          waitId: "race",
          requesterSessionId: "$requester",
          requesterPaneId: "%requester",
          nowMs: 3002,
        })),
      ]);
      expect(deliveries.filter((item) => item.delivered)).toHaveLength(1);
      expect(deliveries.filter((item) => item.duplicate)).toHaveLength(1);

      const consumptions = await Promise.all([
        Promise.resolve().then(() => consumeOutboundWake(db, {
          waitId: "race",
          requesterSessionId: "$requester",
          requesterPaneId: "%requester",
          nowMs: 3003,
        })),
        Promise.resolve().then(() => consumeOutboundWake(right, {
          waitId: "race",
          requesterSessionId: "$requester",
          requesterPaneId: "%requester",
          nowMs: 3004,
        })),
      ]);
      expect(consumptions.filter((item) => item.consumed)).toHaveLength(1);
      expect(consumptions.filter((item) => item.duplicate)).toHaveLength(1);
    } finally {
      left.close();
      right.close();
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
        requesterSessionId: "$requester",
        requesterPaneId: "%requester",
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
      armOutboundWait(db, {
        waitId: "wait-1",
        monitorId: "monitor-1",
        requesterSessionId: "$requester",
        requesterPaneId: "%requester",
        nowMs: 2000,
      });
      expect(terminalizeOutboundWait(db, "monitor-1", "done", 3000)).toBe(true);
      expect(terminalizeOutboundWait(db, "monitor-1", "done", 3001)).toBe(false);
      const beforeDelivery = consumeOutboundWake(db, {
        waitId: "wait-1",
        requesterSessionId: "$requester",
        requesterPaneId: "%requester",
        nowMs: 3002,
      });
      expect(beforeDelivery).toMatchObject({ consumed: false, duplicate: false });
      expect(deliverOutboundWake(db, {
        waitId: "wait-1",
        requesterSessionId: "$requester",
        requesterPaneId: "%requester",
        nowMs: 3003,
      }).delivered).toBe(true);
      expect(deliverOutboundWake(db, {
        waitId: "wait-1",
        requesterSessionId: "$requester",
        requesterPaneId: "%requester",
        nowMs: 3004,
      }).duplicate).toBe(true);
      expect(() => consumeOutboundWake(db, {
        waitId: "wait-1",
        requesterSessionId: "$other",
        requesterPaneId: "%requester",
        nowMs: 3005,
      })).toThrow(OutboundWaitOwnershipError);
      expect(() => deliverOutboundWake(db, {
        waitId: "wait-1",
        requesterSessionId: "$other",
        requesterPaneId: "%requester",
        nowMs: 3005,
      })).toThrow(OutboundWaitOwnershipError);
      expect(() => deliverOutboundWake(db, {
        waitId: "wait-1",
        requesterSessionId: "$requester",
        requesterPaneId: "%other",
        nowMs: 3005,
      })).toThrow(OutboundWaitOwnershipError);
      expect(consumeOutboundWake(db, {
        waitId: "wait-1",
        requesterSessionId: "$requester",
        requesterPaneId: "%requester",
        nowMs: 3006,
      }).consumed).toBe(true);
      expect(consumeOutboundWake(db, {
        waitId: "wait-1",
        requesterSessionId: "$requester",
        requesterPaneId: "%requester",
        nowMs: 3007,
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
      armOutboundWait(db, {
        waitId: "wait-1",
        monitorId: "monitor-1",
        requesterSessionId: "$requester",
        requesterPaneId: "%requester",
        nowMs: 2000,
      });
      terminate(db, "monitor-1", "timeout", 3000);
      closeDb();

      const reopened = openDb({ dbPath: path, mode: "off", busyTimeoutMs: 3000 });
      try {
        expect(replayOutboundWakes(reopened, 4000)).toBe(1);
        expect(getOutboundWait(reopened, "wait-1", "$requester", "%requester").state)
          .toBe("terminal-unconsumed");
        deliverOutboundWake(reopened, {
          waitId: "wait-1",
          requesterSessionId: "$requester",
          requesterPaneId: "%requester",
          nowMs: 4001,
        });
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
        requesterSessionId: "$requester",
        requesterPaneId: "%requester",
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
