import { spawnSync } from "node:child_process";
import type { Db } from "./db/connection.ts";
import { listPendingObligations } from "./domains/messages/obligations.ts";

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
    } else flags.set(arg.slice(2), true);
  }
  return { positional, flags };
}

function tmuxValue(target: string, format: string): string | undefined {
  if (!process.env.TMUX) return undefined;
  const result = spawnSync("tmux", ["display-message", "-p", "-t", target, format], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const value = String(result.stdout ?? "").trim();
  return value || undefined;
}

function error(json: boolean, code: string, message: string, detail: Record<string, unknown> = {}): number {
  if (json) process.stderr.write(JSON.stringify({ code, error_code: code, message, detail }) + "\n");
  else process.stderr.write(message + "\n");
  return 2;
}

export function cliObligationsList(db: Db, argv: string[]): number {
  const { flags } = parseArgs(argv);
  const json = flags.get("json") === true;
  const paneFlag = flags.get("pane");
  const paneId = typeof paneFlag === "string" ? paneFlag : process.env.TMUX_PANE ?? "";
  if (!paneId && json) return error(true, "XTMUX_PANE_REQUIRED", "obligations list --json requires --pane or a tmux pane context");
  if (!paneId) {
    process.stderr.write("obligations list: --pane or tmux pane context required\n");
    return 2;
  }
  const senderId = tmuxValue(paneId, "#{session_id}") ?? process.env.XTMUX_SESSION_ID
    ?? db.raw.query<{ sender_id: string }, [string]>(
      "SELECT sender_id FROM messages WHERE sender_pane_id = ? AND expects_reply = 1 ORDER BY id DESC LIMIT 1",
    ).get(paneId)?.sender_id
    ?? paneId;
  const rows = listPendingObligations(db, { senderId, senderPaneId: paneId });
  process.stdout.write(JSON.stringify(rows) + "\n");
  return 0;
}
