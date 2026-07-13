import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../config.ts";
import { DbError } from "./errors.ts";

export interface Db {
  readonly raw: Database;
  close(): void;
}

export function openDb(cfg: Config): Db {
  try {
    mkdirSync(dirname(cfg.dbPath), { recursive: true });
  } catch (err) {
    throw new DbError("XTMUX_DB_OPEN_FAILED", `mkdir failed for ${cfg.dbPath}`, {
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  let raw: Database;
  try {
    raw = new Database(cfg.dbPath, { create: true });
  } catch (err) {
    throw new DbError("XTMUX_DB_OPEN_FAILED", `open failed: ${cfg.dbPath}`, {
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  // busy_timeout FIRST, and it is not a style preference. `journal_mode = WAL`
  // takes an exclusive lock, so on a virgin DB that several processes open at
  // once it is the one pragma that genuinely contends. Setting busy_timeout
  // after it meant the WAL switch ran with SQLite's default timeout of 0 and
  // failed instantly with a raw "database is locked" — as a bare SQLiteError,
  // since these pragmas were outside the try/catch that wraps the open above.
  try {
    raw.exec(`PRAGMA busy_timeout = ${cfg.busyTimeoutMs};`);
    raw.exec("PRAGMA journal_mode = WAL;");
    raw.exec("PRAGMA synchronous = NORMAL;");
    raw.exec("PRAGMA foreign_keys = ON;");
  } catch (err) {
    throw new DbError("XTMUX_DB_OPEN_FAILED", `pragma setup failed: ${cfg.dbPath}`, {
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  const threshold = cfg.slowQueryMs ?? 0;
  if (threshold > 0) installSlowQueryWrapper(raw, threshold);
  return {
    raw,
    close(): void {
      // xtmux-3xs.15: SQLite's own guidance is to run `PRAGMA optimize` before
      // closing so the query planner's stats don't drift as data grows.
      // Best-effort; XTMUX_OBS_SKIP_PRAGMA_OPTIMIZE=1 opts out for benchmark
      // comparability.
      if (process.env["XTMUX_OBS_SKIP_PRAGMA_OPTIMIZE"] !== "1") {
        try { raw.exec("PRAGMA optimize;"); } catch { /* best-effort */ }
      }
      raw.close();
    },
  };
}

// installSlowQueryWrapper — proxy Database.prepare so every statement's
// .all/.get/.run is timed. On exceeding `threshold` ms, insert a db.slow_query
// envelope into event_journal directly (bypassing journal.ts::insertEnvelope
// to avoid reentrant prepare calls). xtmux-3xs.14. Zero cost when threshold=0
// (openDb doesn't call this).
function installSlowQueryWrapper(raw: Database, threshold: number): void {
  // Statement built with the UNWRAPPED prepare (so it stays out of the timing
  // hot path and cannot recurse on itself). Prepared lazily on first slow query
  // — openDb may run before migrate() has created event_journal, so we cannot
  // eagerly prepare in the constructor path.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originalPrepare = (raw.prepare as any).bind(raw) as (sql: string) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let envelopeStmt: any = null;
  let reentry = false;
  const record = (sql: string, method: string, ms: number): void => {
    if (reentry) return;
    reentry = true;
    try {
      if (envelopeStmt === null) {
        envelopeStmt = originalPrepare(
          `INSERT INTO event_journal
             (event_key, type, domain, session_id, pane_id, instance_id, bead_id,
              correlation_id, payload_json, created_at_ms)
           VALUES (NULL, ?, 'db', NULL, NULL, NULL, NULL, NULL, ?, ?)
           RETURNING id`,
        );
      }
      envelopeStmt.get(
        "db.slow_query",
        JSON.stringify({ sql, method, duration_ms: Math.round(ms * 100) / 100 }),
        Date.now(),
      );
    } catch {
      // Best-effort — never let observability break the wrapped call. Also
      // covers the pre-migrate window: if event_journal doesn't exist yet the
      // envelope insert throws and we swallow it; envelopeStmt stays null so
      // we retry after migrate() lands.
      envelopeStmt = null;
    } finally {
      reentry = false;
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (raw as any).prepare = function (sql: string): unknown {
    const stmt = originalPrepare(sql);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrap = (fn: (...a: any[]) => any, name: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (...args: any[]): unknown => {
        const t0 = performance.now();
        try {
          return fn(...args);
        } finally {
          const dt = performance.now() - t0;
          if (dt > threshold) record(sql, name, dt);
        }
      };
    };
    if (typeof stmt.all === "function") stmt.all = wrap(stmt.all.bind(stmt), "all");
    if (typeof stmt.get === "function") stmt.get = wrap(stmt.get.bind(stmt), "get");
    if (typeof stmt.run === "function") stmt.run = wrap(stmt.run.bind(stmt), "run");
    return stmt;
  };
}
