import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/connection.ts";
import type { Db } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/schema.ts";
import { runMigration } from "../../src/migration/runner.ts";
import type { Config } from "../../src/config.ts";

function setup(): { db: Db; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-mig-"));
  const cfg: Config = { dbPath: join(dir, "test.db"), mode: "off", busyTimeoutMs: 3000 };
  const db = openDb(cfg);
  migrate(db);
  return {
    db,
    dir,
    cleanup: (): void => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function writeJsonl(path: string, events: object[]): void {
  const text = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(path, text);
}

describe("legacy JSONL migration", () => {
  test("dry-run counts records without writing typed tables", () => {
    const { db, dir, cleanup } = setup();
    try {
      const src = join(dir, "events.jsonl");
      writeJsonl(src, [
        { ts_epoch: 100, type: "message.sent", id: "m1", from: "$a", to: "$b", bead: "b", text: "hi" },
        { ts_epoch: 101, type: "message.ack", id: "m1", by: "$b" },
      ]);
      const r = runMigration(db, { apply: false, sources: [src] });
      expect(r.mode).toBe("dry-run");
      expect(r.counts.recordsScanned).toBe(2);
      const msgs = db.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM messages").get();
      expect(msgs?.n).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("apply imports messages + acks + agent state + turns + unknown types", () => {
    const { db, dir, cleanup } = setup();
    try {
      const src = join(dir, "events.jsonl");
      writeJsonl(src, [
        { ts_epoch: 100, type: "message.sent", id: "m1", from: "$a", to: "$b", bead: "xtmux-3xs", text: "hi" },
        { ts_epoch: 101, type: "message.ack", id: "m1", by: "$b" },
        { ts_epoch: 102, type: "agent.role.launched", instance_id: "inst-1", session: "$b", pane: "%9", role: "claude", runtime: "claude-code" },
        { ts_epoch: 103, type: "agent.state", pane: "%9", session: "$b", state: "running", bead: "xtmux-3xs" },
        { ts_epoch: 104, type: "agent.state", pane: "%9", session: "$b", state: "done", bead: "xtmux-3xs" },
        { ts_epoch: 105, type: "agent.turn.done", pane: "%9", session: "$b", bead: "xtmux-3xs", last_message: "did it" },
        { ts_epoch: 106, type: "custom.thing", k: "v" },
      ]);
      const r = runMigration(db, { apply: true, sources: [src] });
      expect(r.counts.messagesImported).toBe(1);
      expect(r.counts.receiptsLinked).toBe(1);
      expect(r.counts.agentInstancesReconstructed).toBe(1);
      expect(r.counts.agentTransitionsImported).toBe(2);
      expect(r.counts.turnsImported).toBe(1);
      expect(r.counts.unsupportedTypes).toBe(1);
      expect(r.counts.malformedRecords).toBe(0);

      // migration_runs row exists
      const runs = db.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM migration_runs").get();
      expect(runs?.n).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("rerun is idempotent (zero new rows on second apply)", () => {
    const { db, dir, cleanup } = setup();
    try {
      const src = join(dir, "events.jsonl");
      writeJsonl(src, [
        { ts_epoch: 100, type: "message.sent", id: "m1", from: "$a", to: "$b", bead: "b", text: "hi" },
        { ts_epoch: 200, type: "custom.thing", k: "v" },
      ]);
      const first = runMigration(db, { apply: true, sources: [src] });
      expect(first.counts.messagesImported).toBe(1);

      const before = db.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM event_journal").get();

      const second = runMigration(db, { apply: true, sources: [src] });
      // message re-send returns duplicate (message_key exists); custom event
      // hits UNIQUE(event_key) → counted as duplicatesSkipped.
      expect(second.counts.messagesImported).toBe(0);
      expect(second.counts.duplicatesSkipped).toBeGreaterThan(0);

      const after = db.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM event_journal").get();
      expect(after?.n).toBe(before?.n);
    } finally {
      cleanup();
    }
  });

  test("orphan ack (no matching message.sent) is reported not dropped", () => {
    const { db, dir, cleanup } = setup();
    try {
      const src = join(dir, "events.jsonl");
      writeJsonl(src, [
        { ts_epoch: 100, type: "message.ack", id: "orphan-1", by: "$b" },
      ]);
      const r = runMigration(db, { apply: true, sources: [src] });
      expect(r.counts.orphanAcks).toBe(1);
      expect(r.counts.receiptsLinked).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("malformed line reported with count, not silently dropped", () => {
    const { db, dir, cleanup } = setup();
    try {
      const src = join(dir, "events.jsonl");
      writeFileSync(
        src,
        '{"ts_epoch":100,"type":"message.sent","id":"m1","from":"$a","to":"$b","text":"ok"}\n' +
          "this is not json\n" +
          '{"ts_epoch":101,"type":"custom","k":"v"}\n',
      );
      const r = runMigration(db, { apply: true, sources: [src] });
      expect(r.counts.malformedRecords).toBe(1);
      expect(r.counts.recordsScanned).toBe(3);
    } finally {
      cleanup();
    }
  });

  test("rotated files ordered oldest-first + processed together", () => {
    const { db, dir, cleanup } = setup();
    try {
      const primary = join(dir, "events.jsonl");
      const rotated = join(dir, "events.jsonl.1");
      writeJsonl(rotated, [
        { ts_epoch: 50, type: "message.sent", id: "old", from: "$a", to: "$b", text: "1" },
      ]);
      writeJsonl(primary, [
        { ts_epoch: 100, type: "message.sent", id: "new", from: "$a", to: "$b", text: "2" },
      ]);
      const r = runMigration(db, { apply: true, sources: [primary, rotated] });
      expect(r.counts.messagesImported).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("manifest captures path + size + mtime + sha256", () => {
    const { db, dir, cleanup } = setup();
    try {
      const src = join(dir, "events.jsonl");
      writeJsonl(src, [{ ts_epoch: 100, type: "custom", k: "v" }]);
      const r = runMigration(db, { apply: true, sources: [src] });
      expect(r.sources.length).toBe(1);
      expect(r.sources[0]!.path).toBe(src);
      expect(r.sources[0]!.sha256.length).toBe(64);
      expect(r.sources[0]!.sizeBytes).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });
});
