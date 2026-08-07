// K4-xtmux agent recovery and terminal cleanup (xtmux-s96.4), at the domain
// level. The Codex column in tests/contracts/eval-01-codex-matrix.test.ts
// proves the same behaviours end to end through the installed hooks; these
// tests pin the store contracts directly, including the scoping guards whose
// failure mode is silent and cross-pane.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../src/config.ts";
import { openDb, type Db } from "../../src/db/connection.ts";
import { migration as outboundWakeMigration } from "../../src/db/migrations/0011_outbound_wake_ownership.ts";
import { migrate } from "../../src/db/schema.ts";
import { closeInstance, openInstance } from "../../src/domains/agents/instance.ts";
import { reconcileAgentInstances } from "../../src/domains/agents/recovery.ts";
import { cancelPaneObligations, listPendingObligations } from "../../src/domains/messages/obligations.ts";
import { sendMessage } from "../../src/domains/messages/send.ts";
import { armOutboundWait, registerOutboundWait } from "../../src/domains/monitors/outbound-wake.ts";
import { cancelMonitorsOwnedByPane, reconcileAll, register } from "../../src/domains/monitors/store.ts";

const TEST_ROOT = mkdtempSync("/tmp/xtmux-agent-recovery-");
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

function setup(): { db: Db; cleanup: () => void } {
  const dir = mkdtempSync(join(TEST_ROOT, "case-"));
  const cfg: Config = { dbPath: join(dir, "test.db"), mode: "off", busyTimeoutMs: 3000 };
  const db = openDb(cfg);
  migrate(db);
  db.raw.exec(outboundWakeMigration.up);
  return {
    db,
    cleanup: (): void => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function open(db: Db, instanceId: string, paneId: string, sessionId = "$1", t = 1_000): void {
  openInstance(db, { instanceId, sessionId, paneId, sourceEvent: "test" }, () => t);
}

function ask(db: Db, key: string, senderPaneId: string | undefined, senderId = "$1"): void {
  sendMessage(db, {
    messageKey: key,
    senderId,
    senderPaneId,
    recipientId: "$peer",
    targetPaneId: "%peer",
    summary: key,
    expectsReply: true,
  }, () => 2_000);
}

const allAlive = { pidAlive: () => true, paneAlive: () => true };

describe("agent instance reconciliation", () => {
  test("an instance whose pane vanished is closed as pane_gone; a live one is untouched", () => {
    const { db, cleanup } = setup();
    try {
      open(db, "dead", "%1");
      open(db, "live", "%2");
      const closed = reconcileAgentInstances(db, { paneAlive: (pane) => pane !== "%1" }, 5_000);
      expect(closed.map((row) => row.instanceId)).toEqual(["dead"]);

      const rows = db.raw.query<{ instance_id: string; ended_at_ms: number | null; end_reason: string | null }, []>(
        "SELECT instance_id, ended_at_ms, end_reason FROM agent_instances ORDER BY instance_id",
      ).all();
      expect(rows).toEqual([
        { instance_id: "dead", ended_at_ms: 5_000, end_reason: "pane_gone" },
        { instance_id: "live", ended_at_ms: null, end_reason: null },
      ]);

      // Idempotent: a second pass closes nothing and writes no second envelope.
      expect(reconcileAgentInstances(db, { paneAlive: (pane) => pane !== "%1" }, 6_000)).toEqual([]);
      const events = db.raw.query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM event_journal WHERE type = 'agents.instance.end.pane_gone'",
      ).get();
      expect(events?.n).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("a pane probe is spawned once per distinct pane, not once per instance", () => {
    const { db, cleanup } = setup();
    try {
      open(db, "a", "%1", "$1", 1_000);
      // Two open rows on one pane: only possible from an old database written
      // before openInstance superseded, which is exactly what this repairs.
      db.raw.exec("INSERT INTO agent_instances (instance_id, session_id, pane_id, started_at_ms) VALUES ('b', '$1', '%1', 1001)");
      const probed: string[] = [];
      reconcileAgentInstances(db, {
        paneAlive: (pane) => { probed.push(pane); return false; },
      }, 5_000);
      expect(probed).toEqual(["%1"]);
      const open2 = db.raw.query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM agent_instances WHERE ended_at_ms IS NULL",
      ).get();
      expect(open2?.n).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("reconcileAll ends nothing when the tmux server itself is unreachable", () => {
    const { db, cleanup } = setup();
    try {
      open(db, "live", "%1");
      reconcileAll(db, { pidAlive: () => true, paneAlive: () => false, serverAlive: () => false }, 5_000);
      const row = db.raw.query<{ ended_at_ms: number | null }, []>(
        "SELECT ended_at_ms FROM agent_instances",
      ).get();
      expect(row?.ended_at_ms).toBeNull();

      // Same probe answer, but the server IS up: now the pane really is gone.
      reconcileAll(db, { pidAlive: () => true, paneAlive: () => false, serverAlive: () => true }, 6_000);
      expect(db.raw.query<{ ended_at_ms: number | null }, []>(
        "SELECT ended_at_ms FROM agent_instances",
      ).get()?.ended_at_ms).toBe(6_000);
    } finally {
      cleanup();
    }
  });

  test("a new occupation supersedes an instance the previous agent never closed", () => {
    const { db, cleanup } = setup();
    try {
      open(db, "first", "%1", "$1", 1_000);
      open(db, "second", "%1", "$2", 2_000);
      const rows = db.raw.query<{ instance_id: string; ended_at_ms: number | null; end_reason: string | null }, []>(
        "SELECT instance_id, ended_at_ms, end_reason FROM agent_instances ORDER BY started_at_ms",
      ).all();
      expect(rows[0]).toEqual({ instance_id: "first", ended_at_ms: 2_000, end_reason: "superseded" });
      expect(rows[1]?.ended_at_ms).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("supersession is per pane: a concurrent occupation of another pane survives", () => {
    const { db, cleanup } = setup();
    try {
      open(db, "other-pane", "%2", "$1", 1_000);
      open(db, "first", "%1", "$1", 1_000);
      open(db, "second", "%1", "$2", 2_000);
      expect(db.raw.query<{ ended_at_ms: number | null }, [string]>(
        "SELECT ended_at_ms FROM agent_instances WHERE instance_id = ?",
      ).get("other-pane")?.ended_at_ms).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("re-opening the SAME instance id is still idempotent and supersedes nothing", () => {
    const { db, cleanup } = setup();
    try {
      open(db, "same", "%1", "$1", 1_000);
      const again = openInstance(db, { instanceId: "same", sessionId: "$1", paneId: "%1", sourceEvent: "dup" }, () => 2_000);
      expect(again.created).toBe(false);
      expect(db.raw.query<{ ended_at_ms: number | null }, []>(
        "SELECT ended_at_ms FROM agent_instances",
      ).get()?.ended_at_ms).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("terminal cleanup", () => {
  test("closing an instance cancels only that pane's own reply obligations", () => {
    const { db, cleanup } = setup();
    try {
      open(db, "inst", "%1");
      ask(db, "mine", "%1");
      ask(db, "other-pane", "%9");
      ask(db, "no-pane", undefined);
      sendMessage(db, {
        messageKey: "fyi", senderId: "$1", senderPaneId: "%1", recipientId: "$peer",
        summary: "fyi", expectsReply: false,
      }, () => 2_000);

      closeInstance(db, { instanceId: "inst", reason: "state_off" }, () => 3_000);

      const rows = db.raw.query<{ message_key: string; cancelled_at_ms: number | null; cancel_reason: string | null }, []>(
        "SELECT message_key, cancelled_at_ms, cancel_reason FROM messages ORDER BY message_key",
      ).all();
      const byKey = Object.fromEntries(rows.map((row) => [row.message_key, row]));
      expect(byKey["mine"]).toEqual({ message_key: "mine", cancelled_at_ms: 3_000, cancel_reason: "instance_state_off" });
      // A different pane's duty, a pane-less sender's duty, and an FYI are all
      // out of scope. The pane-less case matters: `sender_pane_id IS NULL` must
      // never match a pane predicate, or a bridge/script send would be swept up
      // by whichever pane happened to end first.
      expect(byKey["other-pane"]?.cancelled_at_ms).toBeNull();
      expect(byKey["no-pane"]?.cancelled_at_ms).toBeNull();
      expect(byKey["fyi"]?.cancelled_at_ms).toBeNull();
      expect(listPendingObligations(db, { senderId: "$1", senderPaneId: "%1" })).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("cancelPaneObligations is idempotent and narrows by session when asked", () => {
    const { db, cleanup } = setup();
    try {
      ask(db, "sess-1", "%1", "$1");
      ask(db, "sess-2", "%1", "$2");
      const first = cancelPaneObligations(db, { senderPaneId: "%1", senderId: "$1", reason: "test", nowMs: 3_000 });
      expect(first).toEqual(["sess-1"]);
      expect(cancelPaneObligations(db, { senderPaneId: "%1", senderId: "$1", reason: "test", nowMs: 4_000 })).toEqual([]);
      // Without --senderId the whole pane is in scope, whatever its session id
      // rotated to.
      expect(cancelPaneObligations(db, { senderPaneId: "%1", reason: "test", nowMs: 5_000 })).toEqual(["sess-2"]);
      expect(db.raw.query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM event_journal WHERE type = 'messages.cancelled'",
      ).get()?.n).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("a pane's own monitors are cancelled; a monitor TARGETING it is not", () => {
    const { db, cleanup } = setup();
    try {
      // The ending pane %1 watches %peer.
      register(db, { id: "mine", target: "$peer", sessionId: "$peer", paneId: "%peer", state: "working", intervalMs: 30_000, nowMs: 1_000 });
      registerOutboundWait(db, {
        waitId: "w-mine", requesterSessionId: "$1", requesterPaneId: "%1",
        targetSessionId: "$peer", targetPaneId: "%peer", nowMs: 1_000,
      });
      armOutboundWait(db, { waitId: "w-mine", monitorId: "mine", requesterSessionId: "$1", requesterPaneId: "%1", nowMs: 1_100 });

      // Someone else watches the ending pane %1. That monitor belongs to THEM.
      register(db, { id: "theirs", target: "$1", sessionId: "$1", paneId: "%1", state: "working", intervalMs: 30_000, nowMs: 1_000 });
      registerOutboundWait(db, {
        waitId: "w-theirs", requesterSessionId: "$peer", requesterPaneId: "%peer",
        targetSessionId: "$1", targetPaneId: "%1", nowMs: 1_000,
      });
      armOutboundWait(db, { waitId: "w-theirs", monitorId: "theirs", requesterSessionId: "$peer", requesterPaneId: "%peer", nowMs: 1_100 });

      const result = cancelMonitorsOwnedByPane(db, "%1", 3_000);
      expect(result).toEqual({ waits: ["w-mine"], monitors: ["mine"] });

      const monitors = Object.fromEntries(db.raw.query<{ id: string; terminal_status: string | null }, []>(
        "SELECT id, terminal_status FROM monitors",
      ).all().map((row) => [row.id, row.terminal_status]));
      expect(monitors["mine"]).toBe("killed");
      expect(monitors["theirs"]).toBeNull();
      const waits = Object.fromEntries(db.raw.query<{ id: string; state: string }, []>(
        "SELECT id, state FROM outbound_waits",
      ).all().map((row) => [row.id, row.state]));
      expect(waits["w-mine"]).toBe("cancelled");
      expect(waits["w-theirs"]).toBe("armed");

      // Idempotent.
      expect(cancelMonitorsOwnedByPane(db, "%1", 4_000)).toEqual({ waits: [], monitors: [] });
    } finally {
      cleanup();
    }
  });

  test("reconcileAll cancels a dead owner's monitors without tripping the absorbing-terminal rule", () => {
    const { db, cleanup } = setup();
    try {
      open(db, "inst", "%1");
      register(db, { id: "mine", target: "$peer", sessionId: "$peer", paneId: "%peer", state: "working", intervalMs: 30_000, nowMs: 1_000 });
      registerOutboundWait(db, {
        waitId: "w", requesterSessionId: "$1", requesterPaneId: "%1",
        targetSessionId: "$peer", targetPaneId: "%peer", nowMs: 1_000,
      });
      armOutboundWait(db, { waitId: "w", monitorId: "mine", requesterSessionId: "$1", requesterPaneId: "%1", nowMs: 1_100 });

      // Both the owner pane AND the target pane are gone, so the reconciliation
      // pass has two independent verdicts available for the same monitor row.
      // Cancelling it as the dead owner's must not leave the target_gone branch
      // re-terminating a row that is already terminal.
      expect(() => reconcileAll(db, { pidAlive: () => true, paneAlive: () => false, serverAlive: () => true }, 5_000)).not.toThrow();
      expect(db.raw.query<{ terminal_status: string | null }, []>(
        "SELECT terminal_status FROM monitors",
      ).get()?.terminal_status).toBe("killed");
    } finally {
      cleanup();
    }
  });

  test("reconcileAll with everything alive is unchanged", () => {
    const { db, cleanup } = setup();
    try {
      open(db, "inst", "%1");
      register(db, { id: "m", target: "$peer", sessionId: "$peer", paneId: "%peer", state: "working", intervalMs: 30_000, nowMs: 1_000 });
      expect(reconcileAll(db, allAlive, 2_000)).toEqual([]);
      expect(db.raw.query<{ ended_at_ms: number | null }, []>(
        "SELECT ended_at_ms FROM agent_instances",
      ).get()?.ended_at_ms).toBeNull();
    } finally {
      cleanup();
    }
  });
});
