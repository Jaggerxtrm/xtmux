#!/usr/bin/env bun
import { loadConfig } from "./config.ts";
import { openDb } from "./db/connection.ts";
import { migrate } from "./db/schema.ts";
import { checkHealth } from "./db/health.ts";
import { DbError } from "./db/errors.ts";
import { monitorCommand } from "./commands/monitors.ts";
import { telemetryCommand } from "./commands/telemetry.ts";
import { auditCommand } from "./commands/audit.ts";

function usage(): string {
  return `usage: xtmux-obs <command>
commands:
  health            print JSON health report and exit 0 if ok else 2
  migrate           apply pending schema migrations
  version           print schema version

  monitor register|adopt|heartbeat|terminate|list|kill   monitor registry (3xs.4)
  telemetry start|finish                                 correlated command runs (3xs.7)
  audit ingest [--partial]                               persist audit findings from stdin (3xs.8)
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
        // Domain commands assume the schema is current: the picker calls them on
        // the hot path and cannot afford a migrate() per invocation, so `migrate`
        // is an explicit install/upgrade step.
        const db = openDb(cfg);
        try {
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
          process.stdout.write(String(report.schemaVersion) + "\n");
          return 0;
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

process.exit(await main(process.argv));
