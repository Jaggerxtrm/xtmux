import type { Db } from "./connection.ts";
import { insertEnvelope } from "./journal.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionConfig {
  messageDays: number;
  replyRetentionDays?: number;
  waitDays: number;
  agentStateDays: number;
  turnDays: number;
  telemetryDays: number;
  auditDays: number;
  deliveryDays: number;
  dbMaxBytes: number | null;
}

const DEFAULTS: RetentionConfig = {
  messageDays: 30,
  replyRetentionDays: 30,
  waitDays: 30,
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
    replyRetentionDays: parseIntEnv("XTMUX_OBS_REPLY_RETENTION_DAYS", DEFAULTS.replyRetentionDays ?? DEFAULTS.messageDays),
    waitDays:        parseIntEnv("XTMUX_OBS_WAIT_RETENTION_DAYS", DEFAULTS.waitDays),
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
  replyMessagesDeleted: number;
  waitsDeleted: number;
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
    replyMessagesDeleted: 0,
    waitsDeleted: 0,
    agentStatesCompacted: 0,
    turnsDeleted: 0,
    commandRunsDeleted: 0,
    auditFindingsDeleted: 0,
    deliveriesDeleted: 0,
    journalPruned: 0,
  };

  // Messages: only terminal, acknowledged rows older than window are eligible.
  // Pending obligations are excluded even when their receipt is acknowledged.
  // Fulfilled replies and originals are deleted together after both retention
  // windows and both receipt policies pass.
  {
    const messageCutoff = t - cfg.messageDays * DAY_MS;
    const replyCutoff = t - (cfg.replyRetentionDays ?? cfg.messageDays) * DAY_MS;
    const eligible = db.raw.prepare<
      { original_id: number; reply_id: number | null },
      [number, number]
    >(
      `SELECT m.id AS original_id, linked.id AS reply_id
         FROM messages m
         LEFT JOIN message_receipts original_receipt
           ON original_receipt.message_id = m.id
          AND original_receipt.recipient_id = m.recipient_id
         LEFT JOIN messages linked ON linked.reply_to_message_id = m.id
         LEFT JOIN message_receipts reply_receipt
           ON reply_receipt.message_id = linked.id
          AND reply_receipt.recipient_id = linked.recipient_id
        WHERE m.reply_to_message_id IS NULL
          AND m.created_at_ms < ?
          AND original_receipt.acked_at_ms IS NOT NULL
          AND NOT (m.expects_reply = 1
                   AND m.fulfilled_at_ms IS NULL
                   AND m.cancelled_at_ms IS NULL)
          AND (linked.id IS NULL OR
               (linked.created_at_ms < ? AND reply_receipt.acked_at_ms IS NOT NULL))`,
    );
    let rows: Array<{ original_id: number; reply_id: number | null }> = [];
    const remove = db.raw.transaction(() => {
      db.raw.exec("PRAGMA defer_foreign_keys = ON");
      rows = eligible.all(messageCutoff, replyCutoff);
      const deleteReply = db.raw.prepare<unknown, [number]>("DELETE FROM messages WHERE id = ?");
      const deleteOriginal = db.raw.prepare<unknown, [number]>("DELETE FROM messages WHERE id = ?");
      for (const row of rows) {
        if (row.reply_id !== null) {
          deleteReply.run(row.reply_id);
          report.replyMessagesDeleted++;
          report.messagesDeleted++;
        }
        deleteOriginal.run(row.original_id);
        report.messagesDeleted++;
      }
    });
    remove.immediate();
    const pairIds = rows
      .filter((row) => row.reply_id !== null)
      .map((row) => ({ original_id: row.original_id, reply_id: row.reply_id }));
    if (pairIds.length > 0) {
      insertEnvelope(db, {
        type: "messages.obligation.pruned",
        domain: "messages",
        payload: { outcome: "pruned", pairs: pairIds, count: pairIds.length },
        createdAtMs: t,
      });
    }
  }

  // Outbound waits: only completed/cancelled/expired rows are terminal cleanup.
  // Armed and undelivered terminal wakes remain durable regardless of age.
  {
    const cutoff = t - cfg.waitDays * DAY_MS;
    const eligible = db.raw.prepare<{ id: string }, [number]>(
      `SELECT id FROM outbound_waits
        WHERE state IN ('consumed', 'cancelled', 'expired')
          AND updated_at_ms < ?
        ORDER BY id`,
    );
    const remove = db.raw.transaction(() => {
      const waitIds = eligible.all(cutoff).map((row) => row.id);
      if (waitIds.length === 0) return;
      const result = db.raw.prepare<unknown, [number]>(
        `DELETE FROM outbound_waits
          WHERE state IN ('consumed', 'cancelled', 'expired')
            AND updated_at_ms < ?`,
      ).run(cutoff);
      report.waitsDeleted = Number((result as { changes?: number }).changes ?? 0);
      insertEnvelope(db, {
        type: "wait.pruned",
        domain: "monitors",
        payload: { outcome: "pruned", wait_ids: waitIds, count: report.waitsDeleted },
        createdAtMs: t,
      });
    });
    remove.immediate();
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
