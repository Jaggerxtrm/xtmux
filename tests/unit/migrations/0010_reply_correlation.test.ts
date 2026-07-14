import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../../../src/db/connection.ts";
import { migrate, MIGRATIONS } from "../../../src/db/schema.ts";
import type { Config } from "../../../src/config.ts";

function config(): { cfg: Config; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-m0010-"));
  return {
    cfg: { dbPath: join(dir, "test.db"), mode: "off", busyTimeoutMs: 3000 },
    cleanup: (): void => rmSync(dir, { recursive: true, force: true }),
  };
}

function createPre0010Fixture(db: ReturnType<typeof openDb>): void {
  db.raw.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL,
      checksum TEXT NOT NULL
    );
  `);
  const insertMigration = db.raw.prepare<unknown, [number, string, number, string]>(
    "INSERT INTO schema_migrations (version, name, applied_at_ms, checksum) VALUES (?, ?, ?, ?)",
  );
  for (const migration of MIGRATIONS.filter(({ version }) => version < 10)) {
    db.raw.exec(migration.up);
    insertMigration.run(
      migration.version,
      migration.name,
      migration.version,
      createHash("sha256").update(migration.up).digest("hex").slice(0, 16),
    );
  }
  db.raw.exec(`
    INSERT INTO messages (
      id, message_key, sender_id, sender_pane_id, recipient_id, target_pane_id,
      summary, expects_reply, created_at_ms
    ) VALUES
      (101, 'legacy-pending', '$sender-a', '%pane-a', '$recipient-a', '%target-a', 'old pending', 1, 1001),
      (102, 'legacy-plain', '$sender-b', '%pane-b', '$recipient-b', '%target-b', 'old plain', 0, 1002);
    INSERT INTO message_receipts (message_id, recipient_id, read_at_ms, acked_at_ms, acked_by)
      VALUES
        (101, '$recipient-a', 1010, 1011, '$recipient-a'),
        (102, '$recipient-b', 1020, 1021, '$recipient-b');
    INSERT INTO delivery_attempts (
      kind, target_session_id, related_message_id, attempted_at_ms, succeeded
    ) VALUES
      ('message', '$recipient-a', 101, 1030, 1),
      ('message', '$recipient-b', 102, 1031, 0);
    INSERT INTO handoffs (
      id, source_session_id, target_session_id, target_pane_id, bead_id,
      prompt_file, state, created_at_ms, sent_at_ms, delivery_attempt_id
    ) VALUES
      ('handoff-101', '$sender-a', '$recipient-a', '%target-a', 'bead-101',
       '/tmp/handoff-101.md', 'sent', 1040, 1041, 1);
    INSERT INTO agent_turns (
      id, session_id, pane_id, summary, completed_at_ms, parent_message_id
    ) VALUES
      (201, '$turn-session-a', '%turn-pane-a', 'turn linked pending', 1040, 101),
      (202, '$turn-session-b', '%turn-pane-b', 'turn linked plain', 1041, 102);
  `);
}

describe("migration 0010 reply correlation", () => {
  test("preserves populated message links and defaults correlation columns", () => {
    const { cfg, cleanup } = config();
    const db = openDb(cfg);
    try {
      createPre0010Fixture(db);
      const beforeCounts = {
        messages: db.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM messages").get()?.n,
        receipts: db.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM message_receipts").get()?.n,
        deliveries: db.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM delivery_attempts").get()?.n,
        handoffs: db.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM handoffs").get()?.n,
        turns: db.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM agent_turns").get()?.n,
      };
      const beforeReceipts = db.raw.query<{ message_id: number; recipient_id: string; acked_by: string | null }, []>(
        "SELECT message_id, recipient_id, acked_by FROM message_receipts ORDER BY message_id",
      ).all();
      const beforeDeliveries = db.raw.query<{ id: number; related_message_id: number | null }, []>(
        "SELECT id, related_message_id FROM delivery_attempts ORDER BY id",
      ).all();
      const beforeHandoffs = db.raw.query<{ id: string; delivery_attempt_id: number | null }, []>(
        "SELECT id, delivery_attempt_id FROM handoffs ORDER BY id",
      ).all();
      const beforeTurns = db.raw.query<{ id: number; parent_message_id: number | null }, []>(
        "SELECT id, parent_message_id FROM agent_turns ORDER BY id",
      ).all();

      expect(db.raw.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
      expect(migrate(db).applied).toEqual([10, 11]);
      expect(db.raw.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
      expect(db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect({
        messages: db.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM messages").get()?.n,
        receipts: db.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM message_receipts").get()?.n,
        deliveries: db.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM delivery_attempts").get()?.n,
        handoffs: db.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM handoffs").get()?.n,
        turns: db.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM agent_turns").get()?.n,
      }).toEqual(beforeCounts);
      expect(db.raw.query("SELECT message_id, recipient_id, acked_by FROM message_receipts ORDER BY message_id").all()).toEqual(beforeReceipts);
      expect(db.raw.query("SELECT id, related_message_id FROM delivery_attempts ORDER BY id").all()).toEqual(beforeDeliveries);
      expect(db.raw.query("SELECT id, delivery_attempt_id FROM handoffs ORDER BY id").all()).toEqual(beforeHandoffs);
      expect(db.raw.query("SELECT id, parent_message_id FROM agent_turns ORDER BY id").all()).toEqual(beforeTurns);
      expect(db.raw.query<{ handoff_id: string; message_id: number }, []>(`
        SELECT h.id AS handoff_id, d.related_message_id AS message_id
          FROM handoffs h
          JOIN delivery_attempts d ON d.id = h.delivery_attempt_id
         WHERE h.id = 'handoff-101'
      `).get()).toEqual({ handoff_id: "handoff-101", message_id: 101 });
      expect(db.raw.query<{ turn_id: number; message_id: number }, []>(`
        SELECT t.id AS turn_id, m.id AS message_id
          FROM agent_turns t
          JOIN messages m ON m.id = t.parent_message_id
         WHERE t.id = 201
      `).get()).toEqual({ turn_id: 201, message_id: 101 });

      const columns = db.raw.query<{ name: string }, []>("PRAGMA table_info(messages)").all().map((row) => row.name);
      expect(columns).toEqual(expect.arrayContaining([
        "reply_to_message_id",
        "fulfilled_by_message_id",
        "fulfilled_at_ms",
        "cancelled_at_ms",
        "cancel_reason",
      ]));
      expect(db.raw.query(`
        SELECT message_key, expects_reply, reply_to_message_id,
               fulfilled_by_message_id, fulfilled_at_ms, cancelled_at_ms, cancel_reason
          FROM messages ORDER BY id
      `).all()).toEqual([
        {
          message_key: "legacy-pending",
          expects_reply: 1,
          reply_to_message_id: null,
          fulfilled_by_message_id: null,
          fulfilled_at_ms: null,
          cancelled_at_ms: null,
          cancel_reason: null,
        },
        {
          message_key: "legacy-plain",
          expects_reply: 0,
          reply_to_message_id: null,
          fulfilled_by_message_id: null,
          fulfilled_at_ms: null,
          cancelled_at_ms: null,
          cancel_reason: null,
        },
      ]);
      expect(db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(migrate(db).applied).toEqual([]);
    } finally {
      db.close();
      cleanup();
    }
  });
});
