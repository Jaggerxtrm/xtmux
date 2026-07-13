import type { Db } from "../db/connection.ts";
import {
  adopt,
  heartbeat,
  kill,
  list,
  listResults,
  MonitorNotFoundError,
  register,
  terminate,
} from "../domains/monitors/store.ts";
import { IllegalTransitionError, type TerminalStatus } from "../domains/monitors/terminal.ts";
import { liveProbes } from "../tmux.ts";

/**
 * CLI surface for the monitor registry (xtmux-3xs.4).
 *
 * bin/tmux-session-picker delegates here under XTMUX_OBS_V2=shadow|1. Durations
 * cross the boundary in SECONDS, because that is V1's unit on both stdin and
 * stdout; milliseconds exist only inside the DB.
 */

const sToMs = (s: string | undefined, dflt = 0): number => (Number(s ?? dflt) || 0) * 1000;

export interface Args {
  [k: string]: string | undefined;
}

/** --key value / --key=value */
export function parseArgs(argv: readonly string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else out[a.slice(2)] = argv[++i];
  }
  return out;
}

export function monitorCommand(db: Db, sub: string, argv: string[], now: number): number {
  const a = parseArgs(argv);

  switch (sub) {
    case "register": {
      const id = a["id"]!;
      register(db, {
        id,
        target: a["target"] ?? "",
        paneId: a["pane"] ?? "",
        sessionId: a["session"],
        state: a["state"] ?? "",
        timeoutMs: sToMs(a["timeout"]) || undefined,
        intervalMs: sToMs(a["interval"], 30),
        nowMs: now,
      });
      return 0;
    }
    case "adopt": {
      adopt(db, a["id"]!, Number(a["pid"]), now);
      return 0;
    }
    case "heartbeat": {
      heartbeat(db, a["id"]!, a["state"] ?? "", now);
      return 0;
    }
    case "terminate": {
      terminate(db, a["id"]!, a["status"] as TerminalStatus, now, a["detail"]);
      return 0;
    }
    case "list": {
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(listResults(db, liveProbes, now)) + "\n");
      } else {
        for (const line of list(db, liveProbes, now)) process.stdout.write(line + "\n");
      }
      return 0;
    }
    case "kill": {
      const id = a["id"] ?? argv.find((arg) => !arg.startsWith("--")) ?? "";
      const json = argv.includes("--json");
      try {
        kill(db, liveProbes, id, now);
        process.stdout.write(json ? `${JSON.stringify({ monitorId: id, status: "killed" })}\n` : `killed\t${id}\n`);
        return 0;
      } catch (err) {
        if (err instanceof MonitorNotFoundError) {
          if (json) process.stderr.write(JSON.stringify({ code: "XTMUX_MONITOR_NOT_FOUND", message: err.message, detail: { monitorId: id } }) + "\n");
          else process.stderr.write(`monitor-kill: not found: ${id}\n`);
          return 1;
        }
        if (json && err instanceof IllegalTransitionError) {
          process.stderr.write(JSON.stringify({ code: "XTMUX_MONITOR_TERMINAL", message: err.message, detail: { monitorId: id, terminalStatus: err.from } }) + "\n");
          return 4;
        }
        throw err;
      }
    }
    default:
      process.stderr.write(`unknown monitor subcommand: ${sub}\n`);
      return 2;
  }
}
