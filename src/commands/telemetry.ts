import type { Db } from "../db/connection.ts";
import { finish, reconcileIncomplete, start } from "../domains/telemetry/store.ts";
import { pidAlive } from "../tmux.ts";
import { parseArgs } from "./monitors.ts";

/**
 * CLI surface for correlated command telemetry (xtmux-3xs.7).
 *
 * The picker still *runs* the wrapped command itself — it has to, so stdout,
 * stderr, and exit status pass through untouched (PRD §20). It calls `start`
 * before and `finish` after, and the run id it gets back is what correlates them.
 */
export function telemetryCommand(db: Db, sub: string, argv: string[], now: number): number {
  const a = parseArgs(argv);

  switch (sub) {
    case "start": {
      // everything after `--` is the wrapped argv
      const dash = argv.indexOf("--");
      const wrapped = dash >= 0 ? argv.slice(dash + 1) : [];
      const id = `cr${now}-${process.pid}`;

      start(db, {
        id,
        tool: a["tool"]!,
        argv: wrapped,
        ownerPid: Number(a["pid"] ?? process.pid),
        sessionId: a["session"],
        paneId: a["pane"],
        beadId: a["bead"],
        cwd: a["cwd"],
        repo: a["repo"],
        branchBefore: a["branch"],
        headBefore: a["head"],
        nowMs: now,
      });
      process.stdout.write(id + "\n"); // the picker holds this until finish
      return 0;
    }
    case "finish": {
      finish(db, {
        id: a["id"]!,
        exitCode: Number(a["exit"] ?? 0),
        branchAfter: a["branch"],
        headAfter: a["head"],
        nowMs: now,
      });
      // Opportunistic: somebody has to bury the runs whose wrapper died.
      reconcileIncomplete(db, { pidAlive }, now);
      return 0;
    }
    default:
      process.stderr.write(`unknown telemetry subcommand: ${sub}\n`);
      return 2;
  }
}
