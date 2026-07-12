import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/connection.ts";
import type { Db } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/schema.ts";
import { closeInstance, findActiveInstanceForPane, openInstance } from "../../src/domains/agents/instance.ts";
import { recordTransition } from "../../src/domains/agents/transition.ts";
import { completeTurn } from "../../src/domains/agents/turn.ts";
import { listMessages } from "../../src/domains/messages/list.ts";
import type { Config } from "../../src/config.ts";

function setup(): { db: Db; cleanup: () => void; now: { t: number } } {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-agents-"));
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

describe("agent instances", () => {
  test("openInstance is idempotent on instance_id", () => {
    const { db, cleanup, now } = setup();
    try {
      const a = openInstance(
        db,
        {
          instanceId: "inst-1",
          sessionId: "$1",
          paneId: "%9",
          role: "claude",
          runtime: "claude-code",
          sourceEvent: "agent.role.launched",
        },
        () => ++now.t,
      );
      expect(a.created).toBe(true);
      const b = openInstance(
        db,
        {
          instanceId: "inst-1",
          sessionId: "$1",
          paneId: "%9",
          sourceEvent: "agent.role.launched",
        },
        () => ++now.t,
      );
      expect(b.created).toBe(false);

      const rows = db.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM agent_instances").get();
      expect(rows?.n).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("pane reuse creates a new instance after close", () => {
    const { db, cleanup, now } = setup();
    try {
      openInstance(
        db,
        { instanceId: "A", sessionId: "$1", paneId: "%9", sourceEvent: "agent.role.launched" },
        () => ++now.t,
      );
      closeInstance(db, { instanceId: "A", reason: "session_shutdown" }, () => ++now.t);
      openInstance(
        db,
        { instanceId: "B", sessionId: "$1", paneId: "%9", sourceEvent: "agent.role.launched" },
        () => ++now.t,
      );
      const active = findActiveInstanceForPane(db, "%9");
      expect(active?.instance_id).toBe("B");
      const total = db.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM agent_instances").get();
      expect(total?.n).toBe(2);
    } finally {
      cleanup();
    }
  });
});

describe("agent state transitions", () => {
  test("transition updates last_state on instance atomically", () => {
    const { db, cleanup, now } = setup();
    try {
      openInstance(
        db,
        { instanceId: "inst", sessionId: "$1", paneId: "%9", sourceEvent: "launch" },
        () => ++now.t,
      );
      const r = recordTransition(
        db,
        { paneId: "%9", sessionId: "$1", state: "running", instanceId: "inst" },
        () => ++now.t,
      );
      expect(r.debounced).toBe(false);
      expect(r.instanceId).toBe("inst");
      const inst = db.raw
        .query<{ last_state: string | null }, [string]>(
          "SELECT last_state FROM agent_instances WHERE instance_id = ?",
        )
        .get("inst");
      expect(inst?.last_state).toBe("running");
    } finally {
      cleanup();
    }
  });

  test("same-state debounce skips duplicate rows", () => {
    const { db, cleanup, now } = setup();
    try {
      openInstance(db, { instanceId: "i", sessionId: "$1", paneId: "%9", sourceEvent: "l" }, () => ++now.t);
      const first = recordTransition(db, { paneId: "%9", sessionId: "$1", state: "running", instanceId: "i" }, () => ++now.t);
      const second = recordTransition(db, { paneId: "%9", sessionId: "$1", state: "running", instanceId: "i" }, () => ++now.t);
      const third = recordTransition(db, { paneId: "%9", sessionId: "$1", state: "running", instanceId: "i", sourceEvent: "forced" }, () => ++now.t);
      expect(first.debounced).toBe(false);
      expect(second.debounced).toBe(true);
      expect(third.debounced).toBe(false); // source_event forces a row
      const rows = db.raw
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM agent_state_transitions WHERE instance_id = ?",
        )
        .get("i");
      expect(rows?.n).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("state=off closes the active instance", () => {
    const { db, cleanup, now } = setup();
    try {
      openInstance(db, { instanceId: "i", sessionId: "$1", paneId: "%9", sourceEvent: "l" }, () => ++now.t);
      const r = recordTransition(db, { paneId: "%9", sessionId: "$1", state: "off", instanceId: "i" }, () => ++now.t);
      expect(r.endedInstance).toBe(true);
      const inst = db.raw
        .query<{ end_reason: string | null }, [string]>(
          "SELECT end_reason FROM agent_instances WHERE instance_id = ?",
        )
        .get("i");
      expect(inst?.end_reason).toBe("state_off");
    } finally {
      cleanup();
    }
  });
});

describe("agent turns", () => {
  test("turn + parent message + link happen in one transaction", () => {
    const { db, cleanup, now } = setup();
    try {
      openInstance(
        db,
        {
          instanceId: "i",
          sessionId: "$child",
          paneId: "%c",
          parentSessionId: "$parent",
          sourceEvent: "l",
        },
        () => ++now.t,
      );
      const r = completeTurn(
        db,
        {
          paneId: "%c",
          sessionId: "$child",
          parentSessionId: "$parent",
          summary: "did the thing",
          parentMessageText: "turn done: did the thing",
          beadId: "xtmux-3xs.5",
          instanceId: "i",
        },
        () => ++now.t,
      );
      expect(r.turnId).toBeGreaterThan(0);
      expect(r.parentMessageId).not.toBeNull();

      const turn = db.raw
        .query<{ parent_message_id: number | null }, [number]>(
          "SELECT parent_message_id FROM agent_turns WHERE id = ?",
        )
        .get(r.turnId);
      expect(turn?.parent_message_id).toBe(r.parentMessageId);

      // Parent sees the message
      const forParent = listMessages(db, { recipientId: "$parent" });
      expect(forParent.length).toBe(1);
      expect(forParent[0]!.summary).toBe("turn done: did the thing");
    } finally {
      cleanup();
    }
  });

  test("turn without parent still records the turn row", () => {
    const { db, cleanup, now } = setup();
    try {
      openInstance(db, { instanceId: "i", sessionId: "$1", paneId: "%9", sourceEvent: "l" }, () => ++now.t);
      const r = completeTurn(
        db,
        {
          paneId: "%9",
          sessionId: "$1",
          summary: "silent turn",
          instanceId: "i",
        },
        () => ++now.t,
      );
      expect(r.turnId).toBeGreaterThan(0);
      expect(r.parentMessageId).toBeNull();
    } finally {
      cleanup();
    }
  });
});
