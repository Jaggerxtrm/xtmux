import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.ts";
import { openDb } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/schema.ts";
import { deliverOutboundWake, registerOutboundWait, replayOutboundWakes } from "../../src/domains/monitors/outbound-wake.ts";
import { register, terminate } from "../../src/domains/monitors/store.ts";
import { replyMessage } from "../../src/domains/messages/reply.ts";
import { sendMessage } from "../../src/domains/messages/send.ts";
import { reconcileLegacyMarkers } from "../../src/migration/legacy-markers.ts";

const NOW = 2_000_000_000_000;

function marker(runtime: string, kind: string, name: string, value: unknown): string {
  const dir = join(runtime, kind);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  const path = join(dir, name);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  chmodSync(path, 0o600);
  utimesSync(path, new Date(NOW - 1_000), new Date(NOW - 1_000));
  return path;
}

describe("legacy coordination marker reconciliation", () => {
  test("imports representable state once and safely handles hostile fixtures", () => {
    const root = mkdtempSync(join(tmpdir(), "xtmux-legacy-markers-"));
    const runtime = join(root, "runtime");
    const quarantine = join(root, "state", "quarantine");
    const cfg: Config = { dbPath: join(root, "state", "observability.db"), mode: "on", busyTimeoutMs: 3000 };
    const db = openDb(cfg);
    try {
      migrate(db, () => NOW);
      sendMessage(db, {
        messageKey: "pending-valid", senderId: "$sender", senderPaneId: "%sender",
        recipientId: "$recipient", targetPaneId: "%recipient", beadId: "xtmux-3ua.8",
        summary: "secret summary must never enter migration evidence", expectsReply: true,
      }, () => NOW - 1_000);
      sendMessage(db, {
        messageKey: "pending-wrong-pane", senderId: "$sender", senderPaneId: "%sender",
        recipientId: "$recipient", targetPaneId: "%other", beadId: "xtmux-3ua.8",
        summary: "wrong pane", expectsReply: true,
      }, () => NOW - 1_000);
      sendMessage(db, {
        messageKey: "pending-fulfilled", senderId: "$sender", senderPaneId: "%sender",
        recipientId: "$recipient", targetPaneId: "%recipient", beadId: "xtmux-3ua.8",
        summary: "fulfilled", expectsReply: true,
      }, () => NOW - 1_000);
      replyMessage(db, {
        messageKey: "reply-fulfilled", replyToMessageKey: "pending-fulfilled",
        senderId: "$recipient", senderPaneId: "%recipient", summary: "done",
      }, () => NOW - 500);

      register(db, {
        id: "mon-active", target: "$target", sessionId: "$target", paneId: "%target",
        state: "working", intervalMs: 60_000, timeoutMs: 28_800_000, nowMs: NOW - 2_000,
      });
      registerOutboundWait(db, {
        waitId: "wait-active", requesterSessionId: "$requester", requesterPaneId: "%requester",
        targetSessionId: "$target", targetPaneId: "%target", nowMs: NOW - 2_000,
      });

      marker(runtime, "xtmux-reply-obligations", "reply-to-$sender-for-%recipient_pending", {
        senderId: "$sender", messageKey: "pending-valid", beadId: "xtmux-3ua.8",
        summary: "secret summary must never enter migration evidence", acceptedAtMs: NOW - 1_000, paneId: "%recipient",
      });
      marker(runtime, "xtmux-reply-obligations", "reply-to-$sender-for-%recipient-missing_pending", {
        senderId: "$sender", messageKey: "missing", beadId: "xtmux-3ua.8", summary: "x",
        acceptedAtMs: NOW - 1_000, paneId: "%recipient-missing",
      });
      marker(runtime, "xtmux-reply-obligations", "reply-to-$sender-for-%recipient-wrong_pending", {
        senderId: "$sender", messageKey: "pending-wrong-pane", beadId: "xtmux-3ua.8", summary: "x",
        acceptedAtMs: NOW - 1_000, paneId: "%recipient-wrong",
      });
      marker(runtime, "xtmux-reply-obligations", "reply-to-$sender-for-%recipient-fulfilled_pending", {
        senderId: "$sender", messageKey: "pending-fulfilled", beadId: "xtmux-3ua.8", summary: "x",
        acceptedAtMs: NOW - 1_000, paneId: "%recipient-fulfilled",
      });
      const stale = marker(runtime, "xtmux-reply-obligations", "reply-to-$stale-for-%stale_pending", {
        senderId: "$stale", messageKey: "stale", beadId: "xtmux-3ua.8", summary: "x",
        acceptedAtMs: NOW - 7_200_000, paneId: "%stale",
      });
      utimesSync(stale, new Date(NOW - 7_200_000), new Date(NOW - 7_200_000));
      marker(runtime, "xtmux-reply-obligations", "reply-to-$corrupt-for-%corrupt_pending", "{not-json");
      const symlink = join(runtime, "xtmux-reply-obligations", "reply-to-$linked-for-%linked_pending");
      symlinkSync("/etc/passwd", symlink);
      marker(runtime, "xtmux-reply-obligations", "foreign-notes.txt", "do not delete foreign data");

      marker(runtime, "xtmux-outbound-expectations", "wait-for-$target-from-%requester_pending", {
        target: "$target", monitorId: "mon-active", paneId: "%requester", createdAtMs: NOW - 1_000,
      });
      marker(runtime, "xtmux-auto-monitor", "$target_pending", "");

      const first = reconcileLegacyMarkers(db, { apply: true, runtimeDir: runtime, quarantineDir: quarantine, now: () => NOW });
      expect(first).toMatchObject({ scanned: 10, imported: 3, discarded: 5, quarantined: 2, cleanupFailures: 0 });
      expect(first.byReason).toMatchObject({
        pending_message: 1, active_monitor_attached: 1, matched_wait: 1,
        missing_message: 1, pane_mismatch: 1, already_fulfilled: 1, stale: 1,
        malformed_json: 1, symlink: 1, foreign_filename: 1,
      });
      expect(readdirSync(runtime)).toEqual([]);
      expect(readdirSync(quarantine, { recursive: true }).length).toBeGreaterThanOrEqual(3);

      const wait = db.raw.query<{ monitor_id: string; state: string }, [string]>(
        "SELECT monitor_id, state FROM outbound_waits WHERE id = ?",
      ).get("wait-active");
      expect(wait).toEqual({ monitor_id: "mon-active", state: "armed" });
      terminate(db, "mon-active", "done", NOW + 1_000);
      expect(replayOutboundWakes(db, NOW + 1_001)).toBe(1);
      const wake = deliverOutboundWake(db, {
        waitId: "wait-active", requesterSessionId: "$requester", requesterPaneId: "%requester", nowMs: NOW + 1_002,
      });
      expect(wake).toMatchObject({ delivered: true, wait: { state: "terminal-unconsumed", wakeDelivered: true } });

      const events = db.raw.query<{ event_key: string; type: string; payload_json: string }, []>(
        "SELECT event_key, type, payload_json FROM event_journal WHERE type LIKE 'legacy.marker.%' ORDER BY id",
      ).all();
      expect(events).toHaveLength(10);
      expect(new Set(events.map((event) => event.event_key)).size).toBe(10);
      expect(events.every((event) => {
        const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
        return typeof payload.path_class === "string" && typeof payload.reason === "string" && typeof payload.outcome === "string";
      })).toBe(true);
      expect(events.map((event) => event.payload_json).join("\n")).not.toContain("secret summary");
      expect(events.map((event) => event.payload_json).join("\n")).not.toContain(root);
      expect(events.map((event) => event.payload_json).join("\n")).not.toContain("/etc/passwd");

      const before = events.length;
      const second = reconcileLegacyMarkers(db, { apply: true, runtimeDir: runtime, quarantineDir: quarantine, now: () => NOW });
      expect(second).toMatchObject({ scanned: 0, imported: 0, discarded: 0, quarantined: 0 });
      expect(db.raw.query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM event_journal WHERE type LIKE 'legacy.marker.%'",
      ).get()?.n).toBe(before);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a shared writable legacy directory without arming its forged wait", () => {
    const root = mkdtempSync(join(tmpdir(), "xtmux-legacy-markers-unowned-"));
    const runtime = join(root, "runtime");
    const cfg: Config = { dbPath: join(root, "state", "observability.db"), mode: "on", busyTimeoutMs: 3000 };
    const db = openDb(cfg);
    try {
      migrate(db, () => NOW);
      register(db, {
        id: "mon-forged", target: "$target", sessionId: "$target", paneId: "%target",
        state: "working", intervalMs: 60_000, timeoutMs: 28_800_000, nowMs: NOW - 2_000,
      });
      registerOutboundWait(db, {
        waitId: "wait-victim", requesterSessionId: "$victim", requesterPaneId: "%victim",
        targetSessionId: "$target", targetPaneId: "%target", nowMs: NOW - 2_000,
      });
      const path = marker(runtime, "xtmux-outbound-expectations", "wait-for-$target-from-%victim_pending", {
        target: "$target", monitorId: "mon-forged", paneId: "%victim", createdAtMs: NOW - 1_000,
      });
      chmodSync(join(runtime, "xtmux-outbound-expectations"), 0o777);

      const report = reconcileLegacyMarkers(db, {
        apply: true, runtimeDir: runtime, quarantineDir: join(root, "quarantine"), now: () => NOW,
      });
      expect(report).toMatchObject({ scanned: 0, imported: 0, rejectedDirectories: 1 });
      expect(report.byReason.unsafe_directory_ownership).toBe(1);
      expect(Bun.file(path).size).toBeGreaterThan(0);
      expect(db.raw.query<{ monitor_id: string | null; state: string }, [string]>(
        "SELECT monitor_id, state FROM outbound_waits WHERE id = ?",
      ).get("wait-victim")).toEqual({ monitor_id: null, state: "unarmed" });
      expect(db.raw.query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM event_journal WHERE type = 'legacy.marker.directory_rejected'",
      ).get()?.n).toBe(1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dry-run is read-only", () => {
    const root = mkdtempSync(join(tmpdir(), "xtmux-legacy-markers-dry-"));
    const runtime = join(root, "runtime");
    const path = marker(runtime, "xtmux-auto-monitor", "$target_pending", "");
    const cfg: Config = { dbPath: join(root, "state", "observability.db"), mode: "on", busyTimeoutMs: 3000 };
    const db = openDb(cfg);
    try {
      migrate(db, () => NOW);
      const report = reconcileLegacyMarkers(db, {
        apply: false, runtimeDir: runtime, quarantineDir: join(root, "quarantine"), now: () => NOW,
      });
      expect(report.scanned).toBe(1);
      expect(Bun.file(path).size).toBe(0);
      expect(db.raw.query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM event_journal WHERE type LIKE 'legacy.marker.%'",
      ).get()?.n).toBe(0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
