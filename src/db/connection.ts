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
  raw.exec("PRAGMA journal_mode = WAL;");
  raw.exec("PRAGMA synchronous = NORMAL;");
  raw.exec(`PRAGMA busy_timeout = ${cfg.busyTimeoutMs};`);
  raw.exec("PRAGMA foreign_keys = ON;");
  return {
    raw,
    close(): void {
      raw.close();
    },
  };
}
