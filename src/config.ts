import { homedir } from "node:os";
import { join } from "node:path";

export type ObsMode = "off" | "shadow" | "on";

export interface Config {
  dbPath: string;
  mode: ObsMode;
  busyTimeoutMs: number;
  // Slow-query threshold in ms. 0 or unset disables the wrapper entirely
  // (xtmux-3xs.14). Any prepare().all/get/run call slower than this writes
  // a db.slow_query envelope to event_journal.
  slowQueryMs?: number;
}

const XDG_STATE = process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state");

function parseMode(raw: string | undefined): ObsMode {
  if (raw === undefined || raw === "" || raw === "0") return "off";
  if (raw === "shadow") return "shadow";
  if (raw === "1") return "on";
  throw new Error(`XTMUX_OBS_V2 must be one of 0|shadow|1 (got ${JSON.stringify(raw)})`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    dbPath: env["XTMUX_OBS_DB_PATH"] ?? join(XDG_STATE, "xtmux", "observability.db"),
    mode: parseMode(env["XTMUX_OBS_V2"]),
    busyTimeoutMs: Number(env["XTMUX_OBS_BUSY_TIMEOUT_MS"] ?? 3000),
    slowQueryMs: Number(env["XTMUX_OBS_SLOW_QUERY_MS"] ?? 25),
  };
}
