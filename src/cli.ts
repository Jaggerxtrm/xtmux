#!/usr/bin/env bun
import { loadConfig } from "./config.ts";
import { openDb } from "./db/connection.ts";
import { migrate } from "./db/schema.ts";
import { checkHealth } from "./db/health.ts";
import { DbError } from "./db/errors.ts";
import { cliMessageAck, cliMessageList, cliMessageSend } from "./cli-messages.ts";
import { cliLogEmit, cliLogTail, cliLogQuery } from "./cli-log.ts";
import { recordDelivery } from "./domains/deliveries/attempt.ts";
import type { DeliveryKind } from "./domains/deliveries/attempt.ts";

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
      case "message-ack":
      case "log-emit":
      case "log-tail":
      case "log-query":
      case "delivery-record": {
        const db = openDb(cfg);
        try {
          migrate(db);
          const rest = argv.slice(3);
          switch (cmd) {
            case "message-send":     return cliMessageSend(db, rest);
            case "message-list":     return cliMessageList(db, rest);
            case "message-ack":      return cliMessageAck(db, rest);
            case "log-emit":         return cliLogEmit(db, rest);
            case "log-tail":         return cliLogTail(db, rest);
            case "log-query":        return cliLogQuery(db, rest);
            case "delivery-record":  return cliDeliveryRecord(db, rest);
          }
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

/**
 * Minimal delivery-recording CLI so the picker can log delivery attempts
 * (safe-send-pointer, second-Enter injection) without embedding a Bun call
 * per side effect. Flags mirror recordDelivery() input.
 */
function cliDeliveryRecord(db: import("./db/connection.ts").Db, argv: string[]): number {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(a.slice(2), next);
        i++;
      } else {
        flags.set(a.slice(2), "true");
      }
    }
  }
  const kind = flags.get("kind") as DeliveryKind | undefined;
  if (!kind) {
    process.stderr.write("delivery-record: --kind required\n");
    return 2;
  }
  const succeeded = flags.get("succeeded") !== "false";
  recordDelivery(db, {
    kind,
    sourceSessionId: flags.get("source-session") ?? undefined,
    targetSessionId: flags.get("target-session") ?? undefined,
    targetPaneId: flags.get("target-pane") ?? undefined,
    relatedMessageId: flags.get("related-message-id")
      ? Number(flags.get("related-message-id"))
      : undefined,
    relatedHandoffId: flags.get("related-handoff-id"),
    payloadSummary: flags.get("summary"),
    succeeded,
    failureCode: flags.get("failure-code"),
  });
  return 0;
}

process.exit(main(process.argv));
