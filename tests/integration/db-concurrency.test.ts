import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/schema.ts";
import type { Config } from "../../src/config.ts";

function makeCfg(): { cfg: Config; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-obs-conc-"));
  const cfg: Config = { dbPath: join(dir, "test.db"), mode: "off", busyTimeoutMs: 3000 };
  return { cfg, cleanup: (): void => rmSync(dir, { recursive: true, force: true }) };
}

describe("db concurrency", () => {
  test("N concurrent writers × K inserts each: no lost or duplicated rows", async () => {
    const { cfg, cleanup } = makeCfg();
    const N = 8;
    const K = 100;
    try {
      const bootstrap = openDb(cfg);
      migrate(bootstrap);
      bootstrap.close();

      const errors: Array<{ writer: number; msg: string }> = [];
      const workers = Array.from({ length: N }, async (_, writer) => {
        const db = openDb(cfg);
        try {
          const stmt = db.raw.prepare<
            unknown,
            [string, string, string, string, number]
          >(
            `INSERT INTO event_journal (event_key, type, domain, payload_json, created_at_ms)
             VALUES (?, ?, ?, ?, ?)`,
          );
          for (let i = 0; i < K; i++) {
            try {
              stmt.run(`w${writer}-${i}`, "concurrency.test", "test", "{}", Date.now());
            } catch (err) {
              errors.push({ writer, msg: err instanceof Error ? err.message : String(err) });
            }
          }
        } finally {
          db.close();
        }
      });
      await Promise.all(workers);
      expect(errors).toEqual([]);

      const check = openDb(cfg);
      const total = check.raw
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM event_journal WHERE type = 'concurrency.test'",
        )
        .get();
      expect(total?.n).toBe(N * K);
      const distinct = check.raw
        .query<{ n: number }, []>(
          "SELECT COUNT(DISTINCT event_key) AS n FROM event_journal WHERE type = 'concurrency.test'",
        )
        .get();
      expect(distinct?.n).toBe(N * K);
      check.close();
    } finally {
      cleanup();
    }
  }, 30_000);

  test("busy failure surfaces a distinct actionable error class shape", async () => {
    const { cfg, cleanup } = makeCfg();
    try {
      const a = openDb(cfg);
      migrate(a);

      const b = openDb({ ...cfg, busyTimeoutMs: 100 });

      const held = a.raw.transaction(() => {
        a.raw.exec(
          `INSERT INTO event_journal (event_key, type, domain, payload_json, created_at_ms)
           VALUES ('hold-1', 't', 'd', '{}', 1)`,
        );
        try {
          b.raw.exec(
            `INSERT INTO event_journal (event_key, type, domain, payload_json, created_at_ms)
             VALUES ('hold-2', 't', 'd', '{}', 2)`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          expect(msg).toMatch(/busy|locked/i);
          return;
        }
        expect.unreachable("second writer should have observed BUSY/LOCKED");
      });
      held();

      a.close();
      b.close();
    } finally {
      cleanup();
    }
  });
});
