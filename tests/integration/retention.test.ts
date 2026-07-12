import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/connection.ts";
import type { Db } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/schema.ts";
import { sendMessage } from "../../src/domains/messages/send.ts";
import { ackMessage } from "../../src/domains/messages/ack.ts";
import { applyRetention, loadRetentionConfig } from "../../src/db/retention.ts";
import type { Config } from "../../src/config.ts";

function setup(): { db: Db; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-ret-"));
  const cfg: Config = { dbPath: join(dir, "test.db"), mode: "off", busyTimeoutMs: 3000 };
  const db = openDb(cfg);
  migrate(db);
  return {
    db,
    cleanup: (): void => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("retention preservation rules (PRD §17)", () => {
  test("unacked messages never deleted, even beyond retention window", () => {
    const { db, cleanup } = setup();
    try {
      const NOW = 1_000_000_000_000;
      const OLD = NOW - 90 * DAY_MS;
      // one old unacked, one old acked
      const oldUnacked = sendMessage(
        db,
        { messageKey: "old-unacked", senderId: "$s", recipientId: "$r", summary: "keep me" },
        () => OLD,
      );
      const oldAcked = sendMessage(
        db,
        { messageKey: "old-acked", senderId: "$s", recipientId: "$r", summary: "dispose me" },
        () => OLD,
      );
      ackMessage(db, { messageId: oldAcked.messageId, ackedBy: "$r" }, () => OLD + 1);

      const cfg = { ...loadRetentionConfig(), messageDays: 30 };
      applyRetention(db, cfg, () => NOW);

      const remaining = db.raw
        .query<{ id: number; message_key: string }, []>(
          "SELECT id, message_key FROM messages ORDER BY id",
        )
        .all();
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.message_key).toBe("old-unacked");
      expect(remaining[0]!.id).toBe(oldUnacked.messageId);
    } finally {
      cleanup();
    }
  });

  test("active agent instances preserved; state history compacted to latest per instance", () => {
    const { db, cleanup } = setup();
    try {
      const NOW = 1_000_000_000_000;
      const OLD = NOW - 90 * DAY_MS;
      db.raw.exec(
        `INSERT INTO agent_instances (instance_id, session_id, pane_id, started_at_ms)
         VALUES ('active', '$1', '%1', ${OLD})`,
      );
      db.raw.exec(
        `INSERT INTO agent_state_transitions (instance_id, pane_id, state, created_at_ms) VALUES
           ('active', '%1', 'running', ${OLD}),
           ('active', '%1', 'done',    ${OLD + 1}),
           ('active', '%1', 'off',     ${OLD + 2})`,
      );

      const cfg = { ...loadRetentionConfig(), agentStateDays: 30 };
      const r = applyRetention(db, cfg, () => NOW);
      expect(r.agentStatesCompacted).toBe(2); // 3 -> latest only

      const remaining = db.raw
        .query<{ state: string }, []>("SELECT state FROM agent_state_transitions").all();
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.state).toBe("off");

      const inst = db.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM agent_instances").get();
      expect(inst?.n).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("incomplete command_runs preserved even past retention", () => {
    const { db, cleanup } = setup();
    try {
      const NOW = 1_000_000_000_000;
      const OLD = NOW - 60 * DAY_MS;
      db.raw.exec(
        `INSERT INTO command_runs (id, tool, operation, started_at_ms) VALUES
           ('done-old', 'git', 'commit', ${OLD}),
           ('run-old',  'git', 'push',   ${OLD})`,
      );
      db.raw.exec(
        `UPDATE command_runs SET finished_at_ms = ${OLD + 100}, terminal_status = 'success'
          WHERE id = 'done-old'`,
      );

      const cfg = { ...loadRetentionConfig(), telemetryDays: 30 };
      const r = applyRetention(db, cfg, () => NOW);
      expect(r.commandRunsDeleted).toBe(1);
      const remaining = db.raw.query<{ id: string }, []>("SELECT id FROM command_runs").all();
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.id).toBe("run-old");
    } finally {
      cleanup();
    }
  });

  test("unresolved audit findings preserved past window", () => {
    const { db, cleanup } = setup();
    try {
      const NOW = 1_000_000_000_000;
      const OLD = NOW - 200 * DAY_MS;
      db.raw.exec(
        `INSERT INTO audit_runs (id, started_at_ms) VALUES ('run-1', ${OLD})`,
      );
      db.raw.exec(
        `INSERT INTO audit_findings
           (run_id, last_run_id, fingerprint, severity, kind, first_seen_ms, last_seen_ms, resolved_at_ms) VALUES
           ('run-1', 'run-1', 'fp-unresolved', 'warning', 'dirty-worktree', ${OLD}, ${OLD}, NULL),
           ('run-1', 'run-1', 'fp-resolved',   'cleanup', 'missing-path',   ${OLD}, ${OLD}, ${OLD + 1})`,
      );
      const cfg = { ...loadRetentionConfig(), auditDays: 30 };
      applyRetention(db, cfg, () => NOW);
      const remaining = db.raw
        .query<{ fingerprint: string }, []>("SELECT fingerprint FROM audit_findings")
        .all();
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.fingerprint).toBe("fp-unresolved");
    } finally {
      cleanup();
    }
  });

  test("retention envelope emitted", () => {
    const { db, cleanup } = setup();
    try {
      const cfg = loadRetentionConfig();
      applyRetention(db, cfg);
      const env = db.raw
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM event_journal WHERE type = 'db.retention.apply'",
        )
        .get();
      expect(env?.n).toBe(1);
    } finally {
      cleanup();
    }
  });
});
