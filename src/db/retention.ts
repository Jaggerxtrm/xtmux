import type { Db } from "./connection.ts";
import { insertEnvelope } from "./journal.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionConfig {
  messageDays: number;
  agentStateDays: number;
  turnDays: number;
  telemetryDays: number;
  auditDays: number;
  deliveryDays: number;
  dbMaxBytes: number | null;
}

const DEFAULTS: RetentionConfig = {
  messageDays: 30,
  agentStateDays: 14,
  turnDays: 60,
  telemetryDays: 30,
  auditDays: 90,
  deliveryDays: 7,
  dbMaxBytes: null,
};

function parseIntEnv(name: string, dflt: number): number {
  const v = process.env[name];
  if (!v) return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

function parseNullableIntEnv(name: string, dflt: number | null): number | null {
  const v = process.env[name];
  if (!v) return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

export function loadRetentionConfig(): RetentionConfig {
  return {
    messageDays:     parseIntEnv("XTMUX_OBS_MESSAGE_RETENTION_DAYS", DEFAULTS.messageDays),
    agentStateDays:  parseIntEnv("XTMUX_OBS_AGENT_STATE_RETENTION_DAYS", DEFAULTS.agentStateDays),
    turnDays:        parseIntEnv("XTMUX_OBS_TURN_RETENTION_DAYS", DEFAULTS.turnDays),
    telemetryDays:   parseIntEnv("XTMUX_OBS_TELEMETRY_RETENTION_DAYS", DEFAULTS.telemetryDays),
    auditDays:       parseIntEnv("XTMUX_OBS_AUDIT_RETENTION_DAYS", DEFAULTS.auditDays),
    deliveryDays:    parseIntEnv("XTMUX_OBS_DELIVERY_RETENTION_DAYS", DEFAULTS.deliveryDays),
    dbMaxBytes:      parseNullableIntEnv("XTMUX_OBS_DB_MAX_BYTES", DEFAULTS.dbMaxBytes),
  };
}

export interface RetentionReport {
  messagesDeleted: number;
  agentStatesCompacted: number;
  turnsDeleted: number;
  commandRunsDeleted: number;
  auditFindingsDeleted: number;
  deliveriesDeleted: number;
  journalPruned: number;
}

/**
 * Per-domain retention. Preservation rules per PRD §17 / design doc §6:
 * - unacked messages never deleted
 * - active agent instances / monitors / handoffs / incomplete command_runs / unresolved findings preserved
 * - agent-state history may be compacted preserving latest per instance
 */
export function applyRetention(
  db: Db,
  cfg: RetentionConfig = loadRetentionConfig(),
  now: () => number = Date.now,
): RetentionReport {
  const t = now();
  const report: RetentionReport = {
    messagesDeleted: 0,
    agentStatesCompacted: 0,
    turnsDeleted: 0,
    commandRunsDeleted: 0,
    auditFindingsDeleted: 0,
    deliveriesDeleted: 0,
    journalPruned: 0,
  };

  // Messages: only delete if acked AND older than window. Unacked always preserved.
  {
    const cutoff = t - cfg.messageDays * DAY_MS;
    const r = db.raw
      .prepare<unknown, [number]>(
        `DELETE FROM messages
           WHERE id IN (
             SELECT m.id
               FROM messages m
               LEFT JOIN message_receipts r
                 ON r.message_id = m.id AND r.recipient_id = m.recipient_id
              WHERE m.created_at_ms < ? AND r.acked_at_ms IS NOT NULL
           )`,
      )
      .run(cutoff);
    report.messagesDeleted = Number((r as { changes?: number }).changes ?? 0);
  }

  // Agent state: compact by preserving only the latest transition per instance
  // once older than window. Instances themselves stay untouched.
  {
    const cutoff = t - cfg.agentStateDays * DAY_MS;
    const r = db.raw
      .prepare<unknown, [number]>(
        `DELETE FROM agent_state_transitions
           WHERE created_at_ms < ?
             AND id NOT IN (
               SELECT MAX(id) FROM agent_state_transitions GROUP BY instance_id
             )`,
      )
      .run(cutoff);
    report.agentStatesCompacted = Number((r as { changes?: number }).changes ?? 0);
  }

  // Turns: delete old turns; do NOT touch active agent instances.
  {
    const cutoff = t - cfg.turnDays * DAY_MS;
    const r = db.raw
      .prepare<unknown, [number]>("DELETE FROM agent_turns WHERE completed_at_ms < ?")
      .run(cutoff);
    report.turnsDeleted = Number((r as { changes?: number }).changes ?? 0);
  }

  // Command runs: only completed runs deleted. Incomplete preserved.
  {
    const cutoff = t - cfg.telemetryDays * DAY_MS;
    const r = db.raw
      .prepare<unknown, [number]>(
        "DELETE FROM command_runs WHERE finished_at_ms IS NOT NULL AND finished_at_ms < ?",
      )
      .run(cutoff);
    report.commandRunsDeleted = Number((r as { changes?: number }).changes ?? 0);
  }

  // Audit findings: only resolved findings older than window. Unresolved preserved.
  {
    const cutoff = t - cfg.auditDays * DAY_MS;
    const r = db.raw
      .prepare<unknown, [number]>(
        "DELETE FROM audit_findings WHERE resolved_at_ms IS NOT NULL AND resolved_at_ms < ?",
      )
      .run(cutoff);
    report.auditFindingsDeleted = Number((r as { changes?: number }).changes ?? 0);
  }

  // Delivery attempts: delete old — never tied to durability guarantees.
  {
    const cutoff = t - cfg.deliveryDays * DAY_MS;
    const r = db.raw
      .prepare<unknown, [number]>("DELETE FROM delivery_attempts WHERE attempted_at_ms < ?")
      .run(cutoff);
    report.deliveriesDeleted = Number((r as { changes?: number }).changes ?? 0);
  }

  // Journal: prune old entries when size cap set. Typed tables above are the
  // authoritative record; journal is envelope history.
  if (cfg.dbMaxBytes !== null) {
    const cutoff = t - Math.min(cfg.messageDays, cfg.auditDays) * DAY_MS;
    const r = db.raw
      .prepare<unknown, [number]>("DELETE FROM event_journal WHERE created_at_ms < ?")
      .run(cutoff);
    report.journalPruned = Number((r as { changes?: number }).changes ?? 0);
  }

  insertEnvelope(db, {
    type: "db.retention.apply",
    domain: "db",
    payload: { ...report, config: cfg },
    createdAtMs: t,
  });

  return report;
}
