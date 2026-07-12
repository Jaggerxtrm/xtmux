import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Db } from "../db/connection.ts";
import { insertEnvelope } from "../db/journal.ts";
import { sendMessage } from "../domains/messages/send.ts";
import { ackMessage } from "../domains/messages/ack.ts";
import { openInstance } from "../domains/agents/instance.ts";
import { recordTransition } from "../domains/agents/transition.ts";
import { completeTurn } from "../domains/agents/turn.ts";

export interface ImportCounts {
  filesScanned: number;
  recordsScanned: number;
  journalEventsImported: number;
  messagesImported: number;
  receiptsLinked: number;
  orphanAcks: number;
  agentInstancesReconstructed: number;
  agentTransitionsImported: number;
  turnsImported: number;
  monitorsImported: number;
  handoffsImported: number;
  commandRunsCorrelated: number;
  auditRunsImported: number;
  duplicatesSkipped: number;
  malformedRecords: number;
  unsupportedTypes: number;
  deliveriesImported: number;
}

export interface ImportOptions {
  apply: boolean;              // false = dry-run
  sources: string[];           // absolute paths to events.jsonl and rotated files
  now?: () => number;
}

interface JsonlEvent {
  ts?: string;
  ts_epoch?: number;
  type?: string;
  [k: string]: unknown;
}

const EMPTY_COUNTS: ImportCounts = {
  filesScanned: 0,
  recordsScanned: 0,
  journalEventsImported: 0,
  messagesImported: 0,
  receiptsLinked: 0,
  orphanAcks: 0,
  agentInstancesReconstructed: 0,
  agentTransitionsImported: 0,
  turnsImported: 0,
  monitorsImported: 0,
  handoffsImported: 0,
  commandRunsCorrelated: 0,
  auditRunsImported: 0,
  duplicatesSkipped: 0,
  malformedRecords: 0,
  unsupportedTypes: 0,
  deliveriesImported: 0,
};

function eventKey(sourcePath: string, lineNumber: number, payload: string): string {
  return createHash("sha256")
    .update(`${sourcePath}:${lineNumber}:${payload}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Deterministic non-destructive JSONL importer. Rerun-safe via
 * event_journal.event_key (unique constraint) and the message_key / instance_id
 * columns on typed writers. Malformed lines and unsupported types are reported
 * but never silently dropped — they go to the counters and end up in the
 * migration_runs summary.
 */
export function importLegacyJsonl(db: Db, options: ImportOptions): ImportCounts {
  const counts: ImportCounts = { ...EMPTY_COUNTS };
  const now = options.now ?? (() => Date.now());

  for (const path of options.sources) {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue; // absent rotated files are fine
    }
    if (!stat.isFile()) continue;
    counts.filesScanned++;

    const text = readFileSync(path, "utf8");
    const lines = text.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.trim()) continue;
      counts.recordsScanned++;

      let ev: JsonlEvent;
      try {
        ev = JSON.parse(line) as JsonlEvent;
      } catch {
        counts.malformedRecords++;
        continue;
      }
      if (typeof ev.type !== "string") {
        counts.malformedRecords++;
        continue;
      }
      if (!options.apply) continue; // dry-run just counts

      const key = eventKey(path, i + 1, line);
      const createdAtMs = typeof ev.ts_epoch === "number" ? ev.ts_epoch * 1000 : now();

      try {
        importOne(db, ev, key, createdAtMs, counts);
      } catch (err) {
        if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
          counts.duplicatesSkipped++;
        } else {
          counts.malformedRecords++;
        }
      }
    }
  }
  return counts;
}

function s(ev: JsonlEvent, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = ev[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function importOne(
  db: Db,
  ev: JsonlEvent,
  key: string,
  createdAtMs: number,
  counts: ImportCounts,
): void {
  switch (ev.type) {
    case "message.sent": {
      const messageKey = s(ev, "id", "message_key") ?? key;
      const sender = s(ev, "from", "sender_id") ?? "unknown";
      const recipient = s(ev, "to", "recipient_id") ?? "unknown";
      const bead = s(ev, "bead", "bead_id");
      const summary = s(ev, "text", "summary") ?? "";
      const r = sendMessage(
        db,
        {
          messageKey,
          senderId: sender,
          recipientId: recipient,
          beadId: bead,
          summary,
        },
        () => createdAtMs,
      );
      if (!r.duplicate) counts.messagesImported++;
      else counts.duplicatesSkipped++;
      return;
    }
    case "message.ack": {
      const messageKey = s(ev, "id", "message_key");
      const by = s(ev, "by", "acked_by") ?? "unknown";
      if (!messageKey) {
        counts.orphanAcks++;
        return;
      }
      const msg = db.raw
        .query<{ id: number }, [string]>(
          "SELECT id FROM messages WHERE message_key = ?",
        )
        .get(messageKey);
      if (!msg) {
        counts.orphanAcks++;
        return;
      }
      const r = ackMessage(db, { messageId: msg.id, ackedBy: by }, () => createdAtMs);
      if (r.status === "acked" || r.status === "already-acked") {
        counts.receiptsLinked++;
      }
      return;
    }
    case "message.failed": {
      // Not durable — record as a journal envelope for forensic replay.
      insertEnvelope(db, {
        eventKey: key,
        type: "runtime.message_rejected",
        domain: "messages",
        payload: ev as Record<string, unknown>,
        createdAtMs,
      });
      counts.journalEventsImported++;
      return;
    }
    case "agent.state": {
      const pane = s(ev, "pane", "pane_id");
      if (!pane) {
        counts.malformedRecords++;
        return;
      }
      recordTransition(
        db,
        {
          paneId: pane,
          sessionId: s(ev, "session", "session_id"),
          state: s(ev, "state") ?? "",
          sourceEvent: s(ev, "hook_event", "source_event") ?? "legacy-import",
          beadId: s(ev, "bead", "bead_id"),
          task: s(ev, "task"),
          promptFile: s(ev, "prompt_file"),
          parentSessionId: s(ev, "parent", "parent_session"),
        },
        () => createdAtMs,
      );
      counts.agentTransitionsImported++;
      return;
    }
    case "agent.turn.done": {
      const pane = s(ev, "pane", "pane_id");
      const session = s(ev, "session", "session_id");
      if (!pane || !session) {
        counts.malformedRecords++;
        return;
      }
      completeTurn(
        db,
        {
          paneId: pane,
          sessionId: session,
          sessionName: s(ev, "session_name"),
          beadId: s(ev, "bead", "bead_id"),
          parentSessionId: s(ev, "parent", "parent_session"),
          summary: s(ev, "last_message", "summary"),
        },
        () => createdAtMs,
      );
      counts.turnsImported++;
      return;
    }
    case "agent.role.launched": {
      const pane = s(ev, "pane", "pane_id");
      const session = s(ev, "session", "session_id");
      const instanceId = s(ev, "instance_id", "instance") ?? key;
      if (!pane || !session) {
        counts.malformedRecords++;
        return;
      }
      const r = openInstance(
        db,
        {
          instanceId,
          sessionId: session,
          sessionName: s(ev, "session_name"),
          paneId: pane,
          runtime: s(ev, "runtime"),
          role: s(ev, "role"),
          beadId: s(ev, "bead", "bead_id"),
          task: s(ev, "task"),
          promptFile: s(ev, "prompt_file"),
          parentSessionId: s(ev, "parent", "parent_session"),
          sourceEvent: "agent.role.launched",
        },
        () => createdAtMs,
      );
      if (r.created) counts.agentInstancesReconstructed++;
      else counts.duplicatesSkipped++;
      return;
    }
    case "monitor.started":
    case "monitor.done":
    case "monitor.timeout":
    case "monitor.killed": {
      // Full monitor lifecycle reconstruction from JSONL history is deferred;
      // record as journal envelopes so history is preserved. Live monitor rows
      // come from the runtime; TSV importer (future) rebuilds row snapshots.
      insertEnvelope(db, {
        eventKey: key,
        type: ev.type.replace(".", "s.").replace("monitors.", "monitors."), // monitor.done -> monitors.done
        domain: "monitors",
        payload: ev as Record<string, unknown>,
        createdAtMs,
      });
      counts.journalEventsImported++;
      counts.monitorsImported++;
      return;
    }
    case "handoff.created":
    case "handoff.sent": {
      insertEnvelope(db, {
        eventKey: key,
        type: `handoffs.${ev.type.split(".")[1]}`,
        domain: "handoffs",
        payload: ev as Record<string, unknown>,
        createdAtMs,
      });
      counts.journalEventsImported++;
      counts.handoffsImported++;
      return;
    }
    case "telemetry.command.started": {
      insertEnvelope(db, {
        eventKey: key,
        type: "telemetry.command.started",
        domain: "telemetry",
        payload: ev as Record<string, unknown>,
        createdAtMs,
      });
      counts.journalEventsImported++;
      counts.commandRunsCorrelated++;
      return;
    }
    case "audit.run": {
      insertEnvelope(db, {
        eventKey: key,
        type: "audit.run",
        domain: "audit",
        payload: ev as Record<string, unknown>,
        createdAtMs,
      });
      counts.journalEventsImported++;
      counts.auditRunsImported++;
      return;
    }
    default: {
      // Unknown type: preserve in journal (§5) with type intact.
      const t = ev.type ?? "unknown";
      if (t.startsWith("telemetry.")) {
        insertEnvelope(db, {
          eventKey: key,
          type: t,
          domain: "telemetry",
          payload: ev as Record<string, unknown>,
          createdAtMs,
        });
        counts.journalEventsImported++;
        counts.commandRunsCorrelated++;
        return;
      }
      if (t.startsWith("deliveries.") || t === "delivery.attempted") {
        insertEnvelope(db, {
          eventKey: key,
          type: t,
          domain: "deliveries",
          payload: ev as Record<string, unknown>,
          createdAtMs,
        });
        counts.journalEventsImported++;
        counts.deliveriesImported++;
        return;
      }
      insertEnvelope(db, {
        eventKey: key,
        type: t,
        domain: "custom",
        payload: ev as Record<string, unknown>,
        createdAtMs,
      });
      counts.journalEventsImported++;
      counts.unsupportedTypes++;
      return;
    }
  }
}

export interface SourceManifest {
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
}

export function manifestSources(sources: string[]): SourceManifest[] {
  const out: SourceManifest[] = [];
  for (const path of sources) {
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
      out.push({
        path,
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
        sha256: hash,
      });
    } catch {
      // absent files skipped
    }
  }
  return out;
}
