#!/usr/bin/env bun
import { loadConfig } from "./config.ts";
import { openDb } from "./db/connection.ts";
import { migrate } from "./db/schema.ts";
import { checkHealth } from "./db/health.ts";
import { DbError } from "./db/errors.ts";
import { cliMessageAck, cliMessageList, cliMessageSend } from "./cli-messages.ts";

function usage(): string {
  return `usage: xtmux-obs <command>
commands:
  health                     print JSON health report and exit 0 if ok else 2
  migrate                    apply pending schema migrations
  version                    print schema version
  message-send --to <sid> --from <sid> [--to-pane %N] [--from-pane %N] --text T [--bead ID] [--message-key K]
  message-list --for <sid> [--pane %N] [--from <sid>] [--since <ms>] [--unacked] [--limit N]
  message-ack <message_id> --by <sid>
`;
}

function main(argv: string[]): number {
  const cmd = argv[2] ?? "";
  const cfg = loadConfig();
  try {
    switch (cmd) {
      case "health": {
        const db = openDb(cfg);
        try {
          const report = checkHealth(db, cfg.dbPath);
          process.stdout.write(JSON.stringify(report) + "\n");
          return report.ok ? 0 : 2;
        } finally {
          db.close();
        }
      }
      case "migrate": {
        const db = openDb(cfg);
        try {
          const result = migrate(db);
          process.stdout.write(JSON.stringify(result) + "\n");
          return 0;
        } finally {
          db.close();
        }
      }
      case "version": {
        const db = openDb(cfg);
        try {
          const report = checkHealth(db, cfg.dbPath);
          process.stdout.write(String(report.schemaVersion) + "\n");
          return 0;
        } finally {
          db.close();
        }
      }
      case "message-send":
      case "message-list":
      case "message-ack": {
        const db = openDb(cfg);
        try {
          migrate(db);
          const rest = argv.slice(3);
          if (cmd === "message-send") return cliMessageSend(db, rest);
          if (cmd === "message-list") return cliMessageList(db, rest);
          return cliMessageAck(db, rest);
        } finally {
          db.close();
        }
      }
      case "":
      case "help":
      case "--help":
        process.stdout.write(usage());
        return cmd === "" ? 2 : 0;
      default:
        process.stderr.write(`unknown command: ${cmd}\n${usage()}`);
        return 2;
    }
  } catch (err) {
    if (err instanceof DbError) {
      process.stderr.write(JSON.stringify(err.toJSON()) + "\n");
      return 3;
    }
    process.stderr.write(String(err instanceof Error ? err.stack ?? err.message : err) + "\n");
    return 1;
  }
}

process.exit(main(process.argv));
