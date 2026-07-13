#!/usr/bin/env bun
import { loadConfig } from "./config.ts";
import { openDb } from "./db/connection.ts";
import { migrate } from "./db/schema.ts";
import { checkHealth } from "./db/health.ts";
import { DbError } from "./db/errors.ts";
import { cliMessageAck, cliMessageList, cliMessageSend, cliMessageStatus, cliUnreadCount } from "./cli-messages.ts";
import { cliLogEmit, cliLogTail, cliLogQuery } from "./cli-log.ts";
import { recordDelivery } from "./domains/deliveries/attempt.ts";
import type { DeliveryKind } from "./domains/deliveries/attempt.ts";
import { runMigration } from "./migration/runner.ts";
import { recordDivergence, summarizeDivergences, type DiffKind } from "./db/shadow.ts";
import { applyRetention } from "./db/retention.ts";
import { monitorCommand } from "./commands/monitors.ts";
import { telemetryCommand } from "./commands/telemetry.ts";
import { auditCommand } from "./commands/audit.ts";
import { listObligations } from "../extensions/pi-inbox-reply.ts";

function usage(): string {
  return `usage: xtmux-obs <command>
commands:
  health                     print JSON health report and exit 0 if ok else 2
  migrate                    apply pending schema migrations
  version [--json]           print schema version

  message-send --to <sid> --from <sid> [--to-pane %N] [--from-pane %N] --text T [--bead ID] [--expects-reply true|false] [--message-key K] [--json]
  message-list --for <sid> [--pane %N] [--from <sid>] [--since <ms>] [--unacked] [--expects-reply] [--json] [--limit N]
  message-ack <message_id> --by <sid> [--json]
  message-status <message_key>        print JSON receipt state (V2 only)
  unread-count --for <sid> [--pane %N] print JSON unread summary; --pane scopes to that pane (xtmux-3xs.28)
  obligations list [--pane %N] [--json] print active reply obligations; JSON mode requires a pane
  log-tail [N] [--json]             print NDJSON or one JSON event array
  log-query [filters] [--json]      query NDJSON or one JSON event array

  monitor register|adopt|heartbeat|terminate|list|kill   monitor registry; list/kill accept --json (3xs.4)
  telemetry start|finish                                 correlated command runs (3xs.7)
  audit ingest [--partial]                               persist audit findings from stdin (3xs.8)

  obs-migrate --dry-run|--apply|--status  legacy JSONL importer + report
  retention                                apply per-domain retention; prints RetentionReport
  shadow-summary                          shadow-mode divergence rollup
  shadow-record --domain X --command Y --diff-kind Z [--v1-snippet S --v2-snippet S]
                                          record a shadow divergence (picker-internal)
`;
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[2] ?? "";
  const cfg = loadConfig();
  const now = Date.now();
  try {
    switch (cmd) {
      case "monitor":
      case "telemetry":
      case "audit": {
        const db = openDb(cfg);
        try {
          // Same as the message-* path: migrate on every invocation. These are
          // picker hot-path commands, but a no-op migrate() on a current schema
          // is lost in process-startup noise, and skipping it meant a fresh
          // XDG_STATE_HOME hit "no such table: monitors" instead of an empty list.
          migrate(db);
          const sub = argv[3] ?? "";
          const rest = argv.slice(4);
          if (cmd === "monitor") return monitorCommand(db, sub, rest, now);
          if (cmd === "telemetry") return telemetryCommand(db, sub, rest, now);
          return await auditCommand(db, sub, rest, now);
        } finally {
          db.close();
        }
      }
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
          process.stdout.write(argv.slice(3).includes("--json") ? JSON.stringify({ schemaVersion: report.schemaVersion }) + "\n" : String(report.schemaVersion) + "\n");
          return 0;
        } finally {
          db.close();
        }
      }
      case "obligations": {
        const json = argv.slice(4).includes("--json");
        if (argv[3] !== "list") {
          process.stderr.write(json ? JSON.stringify({ code: "XTMUX_INVALID_ARGUMENT", message: "usage: xtmux-obs obligations list [--pane %N] [--json]", detail: {} }) + "\n" : "usage: xtmux-obs obligations list [--pane %N]\n");
          return 2;
        }
        const paneFlag = argv.indexOf("--pane", 4);
        const paneId = paneFlag >= 0 ? argv[paneFlag + 1] ?? "" : process.env.TMUX ? process.env.TMUX_PANE ?? "" : "";
        if (json && !paneId) {
          process.stderr.write(JSON.stringify({ code: "XTMUX_PANE_REQUIRED", message: "obligations list --json requires --pane or a tmux pane context", detail: {} }) + "\n");
          return 2;
        }
        process.stdout.write(JSON.stringify(listObligations(paneId)) + "\n");
        return paneId ? 0 : 2;
      }
      case "obs-migrate": {
        const db = openDb(cfg);
        try {
          migrate(db);
          const rest = argv.slice(3);
          const apply = rest.includes("--apply");
          const status = rest.includes("--status");
          if (status) {
            const rows = db.raw
              .query<
                {
                  id: string;
                  mode: string;
                  completed_at_ms: number | null;
                  counts_json: string | null;
                },
                []
              >(
                "SELECT id, mode, completed_at_ms, counts_json FROM migration_runs ORDER BY started_at_ms DESC LIMIT 10",
              )
              .all();
            process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
            return 0;
          }
          const report = runMigration(db, { apply });
          process.stdout.write(JSON.stringify(report, null, 2) + "\n");
          return 0;
        } finally {
          db.close();
        }
      }
      case "shadow-summary": {
        const db = openDb(cfg);
        try {
          migrate(db);
          const rows = summarizeDivergences(db);
          process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
          return 0;
        } finally {
          db.close();
        }
      }
      case "retention": {
        // Apply per-domain retention. Preservation rules baked into the SQL
        // (unacked messages / active instances / incomplete runs / unresolved
        // findings never touched). Config comes from env — see docs §6.
        const db = openDb(cfg);
        try {
          migrate(db);
          const report = applyRetention(db);
          process.stdout.write(JSON.stringify(report, null, 2) + "\n");
          return 0;
        } finally {
          db.close();
        }
      }
      case "shadow-record": {
        // Best-effort divergence write from the picker's shadow-tee. Never fails
        // the wrapped V1 command — parse errors and DB errors both return 0.
        const args = argv.slice(3);
        const get = (flag: string): string | undefined => {
          const idx = args.indexOf(flag);
          if (idx < 0) return undefined;
          return args[idx + 1];
        };
        const domain = get("--domain");
        const command = get("--command");
        const diffKind = get("--diff-kind") as DiffKind | undefined;
        if (!domain || !command || !diffKind) return 0;
        const db = openDb(cfg);
        try {
          recordDivergence(db, {
            domain,
            command,
            diffKind,
            v1Snippet: get("--v1-snippet"),
            v2Snippet: get("--v2-snippet"),
          });
        } catch {
          // swallow — shadow writes must not cascade
        } finally {
          db.close();
        }
        return 0;
      }
      case "message-send":
      case "message-list":
      case "message-ack":
      case "message-status":
      case "unread-count":
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
            case "message-status":   return cliMessageStatus(db, rest);
            case "unread-count":     return cliUnreadCount(db, rest);
            case "log-emit":         return cliLogEmit(db, rest);
            case "log-tail":         return cliLogTail(db, rest);
            case "log-query":        return cliLogQuery(db, rest);
            case "delivery-record":  return cliDeliveryRecord(db, rest);
          }
        } finally {
          db.close();
        }
      }
      // eslint-disable-next-line no-fallthrough
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

process.exit(await main(process.argv));
