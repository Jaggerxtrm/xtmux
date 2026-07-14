import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../../../../src/db/connection.ts";
import { migrate } from "../../../../src/db/schema.ts";
import { insertEnvelope } from "../../../../src/db/journal.ts";
import { journalPage, MAX_PAGE } from "../../../../src/domains/events/page.ts";
import type { JournalPageV1 } from "../../../../src/domains/events/page.ts";
import type { Config } from "../../../../src/config.ts";

function withDb<T>(fn: (db: ReturnType<typeof openDb>) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-page-"));
  const cfg: Config = { dbPath: join(dir, "test.db"), mode: "on", busyTimeoutMs: 3000 };
  const db = openDb(cfg);
  try {
    migrate(db);
    // migrate() journals its own envelope. Clear it so the assertions below count
    // only seeded rows — and note this leaves the next rowid ABOVE 1, which is the
    // realistic shape anyway: after retention, ids do not start at 1.
    db.raw.run("DELETE FROM event_journal");
    return fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seed(db: ReturnType<typeof openDb>, n: number, createdAtMs?: (i: number) => number): void {
  for (let i = 0; i < n; i += 1) {
    insertEnvelope(db, {
      type: "test.seeded",
      domain: "test",
      payload: { i },
      createdAtMs: createdAtMs ? createdAtMs(i) : 1_000 + i,
    });
  }
}

function page(db: ReturnType<typeof openDb>, input: Parameters<typeof journalPage>[1]): JournalPageV1 {
  const result = journalPage(db, input);
  if (!result.ok) throw new Error(`unexpected cursor error: ${result.error.code}`);
  return result.page;
}

describe("journalPage limits", () => {
  // A caller controls this number and the bridge exposes it remotely. An honored
  // --limit 999999 is an unbounded read: the whole journal in one response.
  test("a limit above the cap is clamped to MAX_PAGE, and has_more stays honest", () => {
    withDb((db) => {
      seed(db, MAX_PAGE + 5);
      const p = page(db, { afterId: 0, limit: 999_999 });
      expect(p.items.length).toBe(MAX_PAGE);
      expect(p.has_more).toBe(true);
      // Clamping must not lie about where the caller got to, or the next poll
      // silently skips the rows the clamp withheld.
      expect(p.next_after_id).toBe(p.items[p.items.length - 1]!.journal_id);
    });
  });

  // The dangerous direction: a limit of 0 that is honored returns an empty page
  // forever while has_more=true — the consumer polls at full speed and never
  // advances. A stalled stream is worse than a rejected request.
  test("a limit of zero or below still returns at least one row", () => {
    withDb((db) => {
      seed(db, 3);
      for (const limit of [0, -7]) {
        const p = page(db, { afterId: 0, limit });
        expect(p.items.length).toBeGreaterThanOrEqual(1);
        expect(p.next_after_id).toBeGreaterThan(0);
      }
    });
  });
});

describe("journalPage ordering", () => {
  // The cursor is the committed rowid, never a clock. Two events can share a
  // millisecond and the clock can move backwards (NTP, suspend). This seeds rows
  // whose timestamps run BACKWARDS against their ids: any implementation that
  // sorted or tie-broke on time would hand them back reversed, and a consumer
  // advancing its cursor on the last item would skip everything before it.
  test("rows are ordered by id, not by timestamp, even when timestamps invert", () => {
    withDb((db) => {
      seed(db, 5, (i) => 9_000 - i * 100);
      const p = page(db, { afterId: 0 });
      const ids = p.items.map((it) => it.journal_id);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      const times = p.items.map((it) => it.occurred_at_ms);
      expect(times).toEqual([9_000, 8_900, 8_800, 8_700, 8_600]);
    });
  });

  test("rows sharing one millisecond are still paged exactly once, ascending", () => {
    withDb((db) => {
      seed(db, 6, () => 5_000);
      const seen: number[] = [];
      let cursor = 0;
      for (let guard = 0; guard < 10; guard += 1) {
        const p = page(db, { afterId: cursor, limit: 2 });
        seen.push(...p.items.map((it) => it.journal_id));
        cursor = p.next_after_id;
        if (!p.has_more) break;
      }
      expect(seen.length).toBe(6);
      expect(new Set(seen).size).toBe(6);
      expect(seen).toEqual([...seen].sort((a, b) => a - b));
    });
  });
});
