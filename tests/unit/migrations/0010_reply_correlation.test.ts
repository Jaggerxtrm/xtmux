import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../../../src/db/connection.ts";
import { migrate } from "../../../src/db/schema.ts";
import type { Config } from "../../../src/config.ts";

function config(): { cfg: Config; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-m0010-"));
  return {
    cfg: { dbPath: join(dir, "test.db"), mode: "off", busyTimeoutMs: 3000 },
    cleanup: (): void => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("migration 0010 reply correlation", () => {
  test("rebuilds messages, preserves rows, constraints, indexes, and rerun", () => {
    const { cfg, cleanup } = config();
    try {
      const db = openDb(cfg);
      migrate(db);
      db.raw.exec("INSERT INTO messages (message_key, sender_id, recipient_id, summary, created_at_ms) VALUES ('legacy', '$s', '$r', 'old', 1)");
      const first = migrate(db);
      expect(first.applied).toEqual([]);
      expect(db.raw.query("SELECT message_key FROM messages").get()).toEqual({ message_key: "legacy" });
      const columns = db.raw.query<{ name: string }, []>("PRAGMA table_info(messages)").all().map((row) => row.name);
      expect(columns).toContain("reply_to_message_id");
      expect(columns).toContain("fulfilled_by_message_id");
      expect(columns).toContain("fulfilled_at_ms");
      expect(columns).toContain("cancelled_at_ms");
      expect(db.raw.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'msg_pending_obligation'").get()?.name).toBe("msg_pending_obligation");
      expect(db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
      db.close();
    } finally {
      cleanup();
    }
  });
});
