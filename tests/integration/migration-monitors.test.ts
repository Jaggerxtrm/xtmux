import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/schema.ts";
import { importLegacyMonitorTsv } from "../../src/migration/legacy-monitor-tsv.ts";
import type { Config } from "../../src/config.ts";

function makeCfg(): { cfg: Config; cleanup: () => void; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-obs-monimport-"));
  const cfg: Config = { dbPath: join(dir, "test.db"), mode: "off", busyTimeoutMs: 3000 };
  return { cfg, cleanup: (): void => rmSync(dir, { recursive: true, force: true }), dir };
}

function seedTsv(
  monitorsDir: string,
  id: string,
  fields: {
    pid: number;
    target: string;
    pane: string;
    state: string;
    startSecs: number;
    timeoutSecs: number;
    intervalSecs: number;
    updatedSecs: number;
    fileMtimeMs?: number;
  },
): string {
  const line = [
    "monitor",
    id,
    fields.pid,
    fields.target,
    fields.pane,
    fields.state,
    fields.startSecs,
    fields.timeoutSecs,
    fields.intervalSecs,
    fields.updatedSecs,
  ].join("\t");
  const path = join(monitorsDir, `${id}.tsv`);
  writeFileSync(path, line + "\n");
  if (fields.fileMtimeMs !== undefined) {
    const t = new Date(fields.fileMtimeMs);
    utimesSync(path, t, t);
  }
  return path;
}

describe("legacy monitor TSV importer (xtmux-3xs.13)", () => {
  test("N .tsv files → N monitors rows; rerun → zero new rows", () => {
    const { cfg, cleanup, dir } = makeCfg();
    try {
      const boot = openDb(cfg);
      migrate(boot);
      boot.close();

      const monitorsDir = join(dir, "monitors");
      mkdirSync(monitorsDir, { recursive: true });
      const now = 2_000_000_000_000;
      seedTsv(monitorsDir, "m-done", {
        pid: 12345, target: "a", pane: "%1", state: "done",
        startSecs: 1_900_000_000, timeoutSecs: 1800, intervalSecs: 60, updatedSecs: 1_900_000_120,
      });
      seedTsv(monitorsDir, "m-timeout", {
        pid: 12346, target: "b", pane: "%2", state: "running",
        startSecs: 1_900_000_000, timeoutSecs: 100, intervalSecs: 60, updatedSecs: 1_900_000_050,
      });
      seedTsv(monitorsDir, "m-gone", {
        pid: 99999, target: "c", pane: "%3", state: "running",
        startSecs: 1_900_000_000, timeoutSecs: 0, intervalSecs: 60, updatedSecs: 1_900_000_050,
      });

      const db = openDb(cfg);
      try {
        const first = importLegacyMonitorTsv(db, {
          apply: true,
          sources: [
            join(monitorsDir, "m-done.tsv"),
            join(monitorsDir, "m-timeout.tsv"),
            join(monitorsDir, "m-gone.tsv"),
          ],
          now: () => now,
        });
        expect(first.filesScanned).toBe(3);
        expect(first.monitorsInserted).toBe(3);
        expect(first.duplicatesSkipped).toBe(0);
        expect(first.byTerminalStatus["done"]).toBe(1);
        expect(first.byTerminalStatus["timeout"]).toBe(1);
        expect(first.byTerminalStatus["process_gone"]).toBe(1);

        // Rerun is a no-op.
        const second = importLegacyMonitorTsv(db, {
          apply: true,
          sources: [
            join(monitorsDir, "m-done.tsv"),
            join(monitorsDir, "m-timeout.tsv"),
            join(monitorsDir, "m-gone.tsv"),
          ],
          now: () => now,
        });
        expect(second.monitorsInserted).toBe(0);
        expect(second.duplicatesSkipped).toBe(3);

        // Row-level check: terminal_status carries.
        const row = db.raw
          .query<{ terminal_status: string; target: string }, [string]>(
            `SELECT terminal_status, target FROM monitors WHERE id = ?`,
          )
          .get("m-done");
        expect(row?.terminal_status).toBe("done");
        expect(row?.target).toBe("a");
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });

  test("dry-run does not insert; malformed file skipped, not thrown", () => {
    const { cfg, cleanup, dir } = makeCfg();
    try {
      const boot = openDb(cfg);
      migrate(boot);
      boot.close();

      const monitorsDir = join(dir, "monitors");
      mkdirSync(monitorsDir, { recursive: true });
      writeFileSync(join(monitorsDir, "bogus.tsv"), "this\tis\tnot\ta\tmonitor\n");
      seedTsv(monitorsDir, "m-ok", {
        pid: 1, target: "a", pane: "%1", state: "done",
        startSecs: 1, timeoutSecs: 60, intervalSecs: 60, updatedSecs: 2,
      });

      const db = openDb(cfg);
      try {
        const dry = importLegacyMonitorTsv(db, {
          apply: false,
          sources: [join(monitorsDir, "m-ok.tsv"), join(monitorsDir, "bogus.tsv")],
        });
        expect(dry.filesScanned).toBe(2);
        expect(dry.monitorsInserted).toBe(0);

        const applied = importLegacyMonitorTsv(db, {
          apply: true,
          sources: [join(monitorsDir, "m-ok.tsv"), join(monitorsDir, "bogus.tsv")],
        });
        expect(applied.monitorsInserted).toBe(1);
        expect(applied.malformedRecords).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });
});
