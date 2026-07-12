import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/schema.ts";
import type { Config } from "../../src/config.ts";

function makeCfg(slowQueryMs?: number): { cfg: Config; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-obs-slow-"));
  const cfg: Config = {
    dbPath: join(dir, "test.db"),
    mode: "off",
    busyTimeoutMs: 3000,
    ...(slowQueryMs !== undefined ? { slowQueryMs } : {}),
  };
  return { cfg, cleanup: (): void => rmSync(dir, { recursive: true, force: true }) };
}

function slowQueryCount(db: ReturnType<typeof openDb>): number {
  const row = db.raw
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM event_journal WHERE type = 'db.slow_query'`)
    .get();
  return row?.n ?? 0;
}

describe("slow-query wrapper (xtmux-3xs.14)", () => {
  test("a query over the threshold writes a db.slow_query envelope", () => {
    // Very low threshold so any real query trips it.
    const { cfg, cleanup } = makeCfg(0.001);
    try {
      const boot = openDb(cfg);
      try {
        migrate(boot);
      } finally {
        boot.close();
      }
      const db = openDb(cfg);
      try {
        // Non-trivial query so timing is > 0.001ms — a big cross join fits.
        db.raw
          .query<{ n: number }, []>(
            `WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n < 5000)
             SELECT COUNT(*) AS n FROM t`,
          )
          .get();
        expect(slowQueryCount(db)).toBeGreaterThan(0);
        // Pick the RECURSIVE row specifically — migrate() may have tripped its
        // own inserts (`run`), so we can't rely on LIMIT 1 landing on ours.
        const row = db.raw
          .query<{ payload_json: string }, []>(
            `SELECT payload_json FROM event_journal
              WHERE type = 'db.slow_query' AND payload_json LIKE '%RECURSIVE%' LIMIT 1`,
          )
          .get();
        expect(row).not.toBeNull();
        const payload = JSON.parse(row!.payload_json) as { sql: string; method: string; duration_ms: number };
        expect(payload.method).toBe("get");
        expect(payload.duration_ms).toBeGreaterThan(0);
        expect(payload.sql).toContain("RECURSIVE");
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });

  test("threshold=0 (or unset) disables the wrapper entirely — no slow_query envelopes ever", () => {
    const { cfg, cleanup } = makeCfg(0);
    try {
      const boot = openDb(cfg);
      try {
        migrate(boot);
      } finally {
        boot.close();
      }
      const db = openDb(cfg);
      try {
        db.raw
          .query<{ n: number }, []>(
            `WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n < 5000)
             SELECT COUNT(*) AS n FROM t`,
          )
          .get();
        expect(slowQueryCount(db)).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });

  test("a query under the threshold does NOT write an envelope", () => {
    // High enough that a trivial query stays well below.
    const { cfg, cleanup } = makeCfg(500);
    try {
      const boot = openDb(cfg);
      try {
        migrate(boot);
      } finally {
        boot.close();
      }
      const db = openDb(cfg);
      try {
        db.raw.query<{ x: number }, []>(`SELECT 1 AS x`).get();
        expect(slowQueryCount(db)).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });
});
