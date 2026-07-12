import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/connection.ts";
import { migrate, currentSchemaVersion, MIGRATIONS } from "../../src/db/schema.ts";
import type { Config } from "../../src/config.ts";

function makeCfg(): { cfg: Config; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-obs-test-"));
  const cfg: Config = { dbPath: join(dir, "test.db"), mode: "off", busyTimeoutMs: 3000 };
  return { cfg, cleanup: (): void => rmSync(dir, { recursive: true, force: true }) };
}

describe("schema migrations", () => {
  test("first run applies all migrations; rerun is a no-op", () => {
    const { cfg, cleanup } = makeCfg();
    try {
      const db = openDb(cfg);
      const first = migrate(db);
      expect(first.applied).toEqual(MIGRATIONS.map((m) => m.version));
      expect(first.skipped).toEqual([]);
      expect(first.currentVersion).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);

      const second = migrate(db);
      expect(second.applied).toEqual([]);
      expect(second.skipped).toEqual(MIGRATIONS.map((m) => m.version));
      expect(second.currentVersion).toBe(first.currentVersion);
      expect(currentSchemaVersion(db)).toBe(first.currentVersion);
      db.close();
    } finally {
      cleanup();
    }
  });

  test("event_journal table exists after migration and enforces unique event_key", () => {
    const { cfg, cleanup } = makeCfg();
    try {
      const db = openDb(cfg);
      migrate(db);
      db.raw.exec(
        `INSERT INTO event_journal (event_key, type, domain, payload_json, created_at_ms)
         VALUES ('k1', 't', 'd', '{}', 1)`,
      );
      expect(() =>
        db.raw.exec(
          `INSERT INTO event_journal (event_key, type, domain, payload_json, created_at_ms)
           VALUES ('k1', 't', 'd', '{}', 2)`,
        ),
      ).toThrow();
      db.close();
    } finally {
      cleanup();
    }
  });

  test("pragmas are set", () => {
    const { cfg, cleanup } = makeCfg();
    try {
      const db = openDb(cfg);
      migrate(db);
      const jm = db.raw.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
      expect(jm?.journal_mode.toLowerCase()).toBe("wal");
      const fk = db.raw.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
      expect(fk?.foreign_keys).toBe(1);
      db.close();
    } finally {
      cleanup();
    }
  });
});
