import type { Db } from "./db/connection.ts";
import { listPendingObligations } from "./domains/messages/obligations.ts";
import { liveTmuxRequester } from "./cli-messages.ts";

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(arg.slice(2), next);
      i++;
    } else {
      flags.set(arg.slice(2), true);
    }
  }
  return { positional, flags };
}

function error(json: boolean, code: string, message: string, detail: Record<string, unknown> = {}): number {
  if (json) process.stderr.write(JSON.stringify({ code, message, detail }) + "\n");
  else process.stderr.write(message + "\n");
  return 2;
}

export function cliObligationsList(db: Db, argv: string[]): number {
  const { positional, flags } = parseArgs(argv);
  const json = flags.get("json") === true;
  if (positional[0] !== "list") return error(json, "XTMUX_INVALID_ARGUMENT", "usage: obligations list [--pane %N] [--json]");

  const requester = liveTmuxRequester();
  if (!requester.ok) return error(json, requester.code, requester.message, requester.detail);
  const requestedPane = flags.get("pane");
  if (typeof requestedPane === "string" && requestedPane !== requester.paneId) {
    return error(json, "XTMUX_WRONG_PANE", "obligations list: --pane does not match live tmux pane", {
      requestedPane,
    });
  }
  if (requestedPane !== undefined && typeof requestedPane !== "string") {
    return error(json, "XTMUX_INVALID_ARGUMENT", "obligations list: --pane requires a pane id");
  }

  const rows = listPendingObligations(db, {
    senderId: requester.sessionId,
    senderPaneId: requester.paneId,
  });
  process.stdout.write(JSON.stringify(rows) + "\n");
  return 0;
}
