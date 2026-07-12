import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/connection.ts";
import type { Db } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/schema.ts";
import { createHandoff, markSent, transitionHandoff } from "../../src/domains/handoffs/lifecycle.ts";
import type { Config } from "../../src/config.ts";

function setup(): { db: Db; dir: string; cleanup: () => void; now: { t: number } } {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-ho-"));
  const cfg: Config = { dbPath: join(dir, "test.db"), mode: "off", busyTimeoutMs: 3000 };
  const db = openDb(cfg);
  migrate(db);
  return {
    db,
    dir,
    now: { t: 1_000 },
    cleanup: (): void => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("handoffs", () => {
  test("create + send + accept + complete lifecycle", () => {
    const { db, dir, cleanup, now } = setup();
    try {
      const promptFile = join(dir, "prompt.md");
      writeFileSync(promptFile, "# do the thing\n");
      const c = createHandoff(
        db,
        {
          id: "ho-1",
          sourceSessionId: "$1",
          targetSessionId: "$2",
          targetPaneId: "%9",
          beadId: "xtmux-3xs.6",
          promptFile,
          summary: "do the thing",
        },
        () => ++now.t,
      );
      expect(c.hash).not.toBeNull();

      const s = markSent(db, { id: "ho-1", succeeded: true }, () => ++now.t);
      expect(s.newState).toBe("sent");
      expect(s.deliveryId).toBeGreaterThan(0);

      const a = transitionHandoff(db, { id: "ho-1", toState: "accepted" }, () => ++now.t);
      expect(a).toBe(true);
      const co = transitionHandoff(db, { id: "ho-1", toState: "completed" }, () => ++now.t);
      expect(co).toBe(true);

      const row = db.raw
        .query<{ state: string; delivery_attempt_id: number | null }, [string]>(
          "SELECT state, delivery_attempt_id FROM handoffs WHERE id = ?",
        )
        .get("ho-1");
      expect(row?.state).toBe("completed");
      expect(row?.delivery_attempt_id).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  test("delivery failure transitions to delivery_failed with failure_code", () => {
    const { db, dir, cleanup, now } = setup();
    try {
      const promptFile = join(dir, "prompt.md");
      writeFileSync(promptFile, "x");
      createHandoff(
        db,
        { id: "ho-2", targetPaneId: "%9", beadId: "b", promptFile },
        () => ++now.t,
      );
      const s = markSent(
        db,
        { id: "ho-2", succeeded: false, failureCode: "target_gone" },
        () => ++now.t,
      );
      expect(s.newState).toBe("delivery_failed");
      const row = db.raw
        .query<{ state: string; failure_code: string | null }, [string]>(
          "SELECT state, failure_code FROM handoffs WHERE id = ?",
        )
        .get("ho-2");
      expect(row?.state).toBe("delivery_failed");
      expect(row?.failure_code).toBe("target_gone");
    } finally {
      cleanup();
    }
  });

  test("missing prompt file → hash is null; caller can decide", () => {
    const { db, dir, cleanup, now } = setup();
    try {
      const c = createHandoff(
        db,
        {
          id: "ho-3",
          targetPaneId: "%9",
          beadId: "b",
          promptFile: join(dir, "does-not-exist.md"),
        },
        () => ++now.t,
      );
      expect(c.hash).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("handoff without bead is rejected", () => {
    const { db, dir, cleanup, now } = setup();
    try {
      const promptFile = join(dir, "prompt.md");
      writeFileSync(promptFile, "x");
      expect(() =>
        createHandoff(
          db,
          { id: "ho-x", targetPaneId: "%9", beadId: "", promptFile },
          () => ++now.t,
        ),
      ).toThrow();
    } finally {
      cleanup();
    }
  });

  test("illegal transition rejected (e.g. created -> completed skips sent)", () => {
    const { db, dir, cleanup, now } = setup();
    try {
      const promptFile = join(dir, "prompt.md");
      writeFileSync(promptFile, "x");
      createHandoff(db, { id: "ho-y", targetPaneId: "%9", beadId: "b", promptFile }, () => ++now.t);
      expect(() =>
        transitionHandoff(db, { id: "ho-y", toState: "completed" }, () => ++now.t),
      ).toThrow();
    } finally {
      cleanup();
    }
  });
});
