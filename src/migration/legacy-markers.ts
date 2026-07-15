import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/connection.ts";
import { insertEnvelope } from "../db/journal.ts";
import { armOutboundWait } from "../domains/monitors/outbound-wake.ts";

const PATH_CLASSES = [
  "xtmux-reply-obligations",
  "xtmux-outbound-expectations",
  "xtmux-auto-monitor",
] as const;
const SAFE_ID = /^[A-Za-z0-9_$%:.-]{1,96}$/;
const MAX_MARKERS = 1_000;
const MAX_MARKER_BYTES = 16_384;
const REPLY_TTL_MS = 3_600_000;
const OUTBOUND_TTL_MS = 28_800_000;

type PathClass = (typeof PATH_CLASSES)[number];
type FileAction = "delete" | "quarantine";

interface DirectoryRejection {
  path: string;
  pathClass: PathClass;
  reason: "unsafe_directory_ownership" | "unsafe_directory_type";
}

interface MarkerPlan {
  path: string;
  name: string;
  pathClass: PathClass;
  sourceHash: string;
  sourceSize: number;
  device: number;
  inode: number;
  type: "legacy.marker.imported" | "legacy.marker.discarded";
  reason: string;
  action: FileAction;
  ids: Record<string, string | number | null>;
}

export interface LegacyMarkerManifest {
  pathClass: PathClass;
  files: number;
  sha256: string;
}

export interface LegacyMarkerReport {
  scanned: number;
  imported: number;
  discarded: number;
  quarantined: number;
  cleanupFailures: number;
  rejectedDirectories: number;
  bounded: boolean;
  removedDirectories: number;
  byReason: Record<string, number>;
  manifest: LegacyMarkerManifest[];
}

export interface LegacyMarkerOptions {
  apply: boolean;
  runtimeDir: string;
  quarantineDir: string;
  now?: () => number;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._:%$-]/g, "_");
}

function validTimestamp(value: unknown, nowMs: number, ttlMs: number, mtimeMs: number): "ok" | "invalid_timestamp" | "stale" {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > nowMs + 300_000) return "invalid_timestamp";
  if (nowMs - value > ttlMs || nowMs - mtimeMs > ttlMs) return "stale";
  return "ok";
}

function replyPlan(db: Db, plan: MarkerPlan, text: string, mtimeMs: number, nowMs: number): MarkerPlan {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ...plan, reason: "malformed_json" };
  }
  const senderId = value.senderId;
  const messageKey = value.messageKey ?? value.message_key;
  const beadId = value.beadId;
  const paneId = value.paneId ?? "";
  if (typeof senderId !== "string" || typeof messageKey !== "string" || typeof beadId !== "string" || typeof paneId !== "string"
    || !SAFE_ID.test(senderId) || !SAFE_ID.test(messageKey) || !SAFE_ID.test(beadId) || (paneId !== "" && !SAFE_ID.test(paneId))) {
    return { ...plan, reason: "invalid_shape" };
  }
  const expectedName = `reply-to-${safeName(senderId)}${paneId ? `-for-${safeName(paneId)}` : ""}_pending`;
  if (plan.name !== expectedName) return { ...plan, reason: "foreign_identity", action: "quarantine" };
  const age = validTimestamp(value.acceptedAtMs, nowMs, REPLY_TTL_MS, mtimeMs);
  if (age !== "ok") return { ...plan, reason: age, ids: { message_key: messageKey, sender_id: senderId, pane_id: paneId || null } };

  const row = db.raw.query<{
    sender_id: string;
    recipient_id: string;
    target_pane_id: string | null;
    expects_reply: number;
    fulfilled_at_ms: number | null;
    cancelled_at_ms: number | null;
  }, [string]>(
    `SELECT sender_id, recipient_id, target_pane_id, expects_reply, fulfilled_at_ms, cancelled_at_ms
       FROM messages WHERE message_key = ?`,
  ).get(messageKey);
  const ids = { message_key: messageKey, sender_id: senderId, pane_id: paneId || null };
  if (!row) return { ...plan, reason: "missing_message", ids };
  if (row.fulfilled_at_ms !== null) return { ...plan, reason: "already_fulfilled", ids };
  if (row.cancelled_at_ms !== null) return { ...plan, reason: "already_cancelled", ids };
  if (row.expects_reply !== 1) return { ...plan, reason: "not_reply_expected", ids };
  if (row.sender_id !== senderId) return { ...plan, reason: "sender_mismatch", ids };
  if (row.target_pane_id !== (paneId || null)) return { ...plan, reason: "pane_mismatch", ids };
  return { ...plan, type: "legacy.marker.imported", reason: "pending_message", ids };
}

function outboundPlan(db: Db, plan: MarkerPlan, text: string, mtimeMs: number, nowMs: number, apply: boolean): MarkerPlan {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ...plan, reason: "malformed_json" };
  }
  const target = value.target;
  const monitorId = value.monitorId;
  const paneId = value.paneId;
  if (typeof target !== "string" || typeof monitorId !== "string" || typeof paneId !== "string"
    || !SAFE_ID.test(target) || !SAFE_ID.test(monitorId) || !SAFE_ID.test(paneId)) {
    return { ...plan, reason: "invalid_shape" };
  }
  const ids = { target_id: target, monitor_id: monitorId, requester_pane_id: paneId };
  const expectedName = `wait-for-${safeName(target)}-from-${safeName(paneId)}_pending`;
  if (plan.name !== expectedName) return { ...plan, reason: "foreign_identity", action: "quarantine", ids };
  const age = validTimestamp(value.createdAtMs, nowMs, OUTBOUND_TTL_MS, mtimeMs);
  if (age !== "ok") return { ...plan, reason: age, ids };

  const monitor = db.raw.query<{
    target: string;
    session_id: string | null;
    pane_id: string;
    terminal_status: string | null;
  }, [string]>(
    "SELECT target, session_id, pane_id, terminal_status FROM monitors WHERE id = ?",
  ).get(monitorId);
  if (!monitor) return { ...plan, reason: "missing_monitor", ids };
  if (monitor.terminal_status !== null) return { ...plan, reason: "inactive_monitor", ids };
  if (monitor.target !== target) return { ...plan, reason: "target_mismatch", ids };

  const linked = db.raw.query<{
    id: string;
    requester_session_id: string;
    requester_pane_id: string;
    target_session_id: string;
    target_pane_id: string;
    state: string;
  }, [string]>(
    `SELECT id, requester_session_id, requester_pane_id, target_session_id, target_pane_id, state
       FROM outbound_waits WHERE monitor_id = ?`,
  ).get(monitorId);
  if (linked) {
    if (linked.requester_pane_id !== paneId || linked.target_session_id !== monitor.session_id || linked.target_pane_id !== monitor.pane_id) {
      return { ...plan, reason: "wait_mismatch", ids: { ...ids, wait_id: linked.id } };
    }
    return { ...plan, type: "legacy.marker.imported", reason: "active_monitor_attached", ids: { ...ids, wait_id: linked.id } };
  }

  const candidates = monitor.session_id === null ? [] : db.raw.query<{
    id: string;
    requester_session_id: string;
    requester_pane_id: string;
  }, [string, string, string]>(
    `SELECT id, requester_session_id, requester_pane_id FROM outbound_waits
      WHERE requester_pane_id = ? AND target_session_id = ? AND target_pane_id = ?
        AND state = 'unarmed' AND monitor_id IS NULL`,
  ).all(paneId, monitor.session_id, monitor.pane_id);
  if (candidates.length !== 1) return { ...plan, reason: candidates.length ? "ambiguous_wait" : "missing_wait", ids };
  const wait = candidates[0]!;
  if (apply) {
    try {
      armOutboundWait(db, {
        waitId: wait.id,
        monitorId,
        requesterSessionId: wait.requester_session_id,
        requesterPaneId: wait.requester_pane_id,
        nowMs,
      });
    } catch {
      return { ...plan, reason: "attach_conflict", ids: { ...ids, wait_id: wait.id } };
    }
  }
  return { ...plan, type: "legacy.marker.imported", reason: "active_monitor_attached", ids: { ...ids, wait_id: wait.id } };
}

function claudePlan(db: Db, plan: MarkerPlan): MarkerPlan {
  const match = /^(.+)_pending$/.exec(plan.name);
  const target = match?.[1] ?? "";
  if (!SAFE_ID.test(target) || plan.name !== `${safeName(target)}_pending`) {
    return { ...plan, reason: "foreign_identity", action: "quarantine" };
  }
  const waits = db.raw.query<{ id: string }, [string, string, string]>(
    `SELECT w.id FROM outbound_waits AS w
       LEFT JOIN monitors AS m ON m.id = w.monitor_id
      WHERE w.state IN ('unarmed', 'armed')
        AND (w.target_session_id = ? OR w.target_pane_id = ? OR m.target = ?)
        AND (w.monitor_id IS NULL OR m.terminal_status IS NULL)`,
  ).all(target, target, target);
  if (waits.length !== 1) {
    return { ...plan, reason: waits.length ? "ambiguous_wait" : "missing_wait", ids: { target_id: target } };
  }
  return {
    ...plan,
    type: "legacy.marker.imported",
    reason: "matched_wait",
    ids: { target_id: target, wait_id: waits[0]!.id },
  };
}

function recognized(pathClass: PathClass, name: string): boolean {
  if (pathClass === "xtmux-reply-obligations") return name.startsWith("reply-to-") && name.endsWith("_pending");
  if (pathClass === "xtmux-outbound-expectations") return name.startsWith("wait-for-") && name.endsWith("_pending");
  return name.endsWith("_pending");
}

function readRegularFile(path: string, device: number, inode: number): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== device || opened.ino !== inode || opened.size > MAX_MARKER_BYTES) return null;
    return readFileSync(fd);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function eventKey(plan: MarkerPlan): string {
  return `legacy-marker:${sha256(`${plan.pathClass}\0${plan.path}\0${plan.sourceHash}`)}`;
}

function quarantineDestination(root: string, plan: MarkerPlan): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new Error("unsafe quarantine root");
  const destinationDir = join(root, plan.pathClass);
  mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
  if (lstatSync(destinationDir).isSymbolicLink() || !lstatSync(destinationDir).isDirectory()) throw new Error("unsafe quarantine directory");
  return join(destinationDir, `${sha256(plan.path).slice(0, 16)}-${plan.name}`);
}

export function reconcileLegacyMarkers(db: Db, options: LegacyMarkerOptions): LegacyMarkerReport {
  const nowMs = (options.now ?? Date.now)();
  const plans: MarkerPlan[] = [];
  const rejections: DirectoryRejection[] = [];
  const manifests: LegacyMarkerManifest[] = [];
  let bounded = false;

  for (const pathClass of PATH_CLASSES) {
    const dir = join(options.runtimeDir, pathClass);
    let entries;
    try {
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        rejections.push({ path: dir, pathClass, reason: "unsafe_directory_type" });
        manifests.push({ pathClass, files: 0, sha256: sha256("rejected") });
        continue;
      }
      const euid = process.geteuid?.();
      if ((euid !== undefined && stat.uid !== euid) || (stat.mode & 0o022) !== 0) {
        rejections.push({ path: dir, pathClass, reason: "unsafe_directory_ownership" });
        manifests.push({ pathClass, files: 0, sha256: sha256("rejected") });
        continue;
      }
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const hashes: string[] = [];
    for (const entry of entries) {
      if (plans.length >= MAX_MARKERS) {
        bounded = true;
        break;
      }
      const path = join(dir, entry.name);
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      const euid = process.geteuid?.();
      const ownedFile = (euid === undefined || stat.uid === euid) && (stat.mode & 0o022) === 0;
      let sourceHash = sha256(`${entry.name}\0${stat.size}\0${stat.mtimeMs}`);
      let text = "";
      if (stat.isFile() && ownedFile && stat.size <= MAX_MARKER_BYTES) {
        const bytes = readRegularFile(path, stat.dev, stat.ino);
        if (bytes !== null) {
          sourceHash = sha256(bytes);
          text = bytes.toString("utf8");
        }
      }
      hashes.push(sha256(`${entry.name}\0${sourceHash}`));
      const base: MarkerPlan = {
        path,
        name: entry.name,
        pathClass,
        sourceHash,
        sourceSize: stat.size,
        device: stat.dev,
        inode: stat.ino,
        type: "legacy.marker.discarded",
        reason: "unreadable",
        action: "delete",
        ids: {},
      };
      if (!recognized(pathClass, entry.name)) {
        plans.push({ ...base, reason: "foreign_filename", action: "quarantine" });
      } else if (stat.isSymbolicLink()) {
        plans.push({ ...base, reason: "symlink", action: "quarantine" });
      } else if (!stat.isFile()) {
        plans.push({ ...base, reason: "foreign_type", action: "quarantine" });
      } else if (!ownedFile) {
        plans.push({ ...base, reason: "foreign_ownership", action: "quarantine" });
      } else if (stat.size > MAX_MARKER_BYTES) {
        plans.push({ ...base, reason: "oversized" });
      } else if (pathClass === "xtmux-reply-obligations") {
        plans.push(replyPlan(db, base, text, stat.mtimeMs, nowMs));
      } else if (pathClass === "xtmux-outbound-expectations") {
        plans.push(outboundPlan(db, base, text, stat.mtimeMs, nowMs, options.apply));
      } else {
        plans.push(claudePlan(db, base));
      }
    }
    manifests.push({ pathClass, files: entries.length, sha256: sha256(hashes.sort().join("\n")) });
    if (bounded) break;
  }

  const byReason: Record<string, number> = {};
  for (const rejection of rejections) byReason[rejection.reason] = (byReason[rejection.reason] ?? 0) + 1;
  for (const plan of plans) byReason[plan.reason] = (byReason[plan.reason] ?? 0) + 1;
  const report: LegacyMarkerReport = {
    scanned: plans.length,
    imported: plans.filter((plan) => plan.type === "legacy.marker.imported").length,
    discarded: plans.filter((plan) => plan.type === "legacy.marker.discarded" && plan.action === "delete").length,
    quarantined: plans.filter((plan) => plan.action === "quarantine").length,
    cleanupFailures: 0,
    rejectedDirectories: rejections.length,
    bounded,
    removedDirectories: 0,
    byReason,
    manifest: manifests,
  };
  if (!options.apply) return report;

  const writeEvidence = db.raw.transaction(() => {
    for (const rejection of rejections) {
      const key = `legacy-marker-directory:${sha256(`${rejection.pathClass}\0${rejection.path}`)}`;
      if (db.raw.query<{ id: number }, [string]>("SELECT id FROM event_journal WHERE event_key = ?").get(key)) continue;
      insertEnvelope(db, {
        eventKey: key,
        type: "legacy.marker.directory_rejected",
        domain: "migration",
        payload: {
          path_class: rejection.pathClass,
          reason: rejection.reason,
          outcome: "rejected",
        },
        createdAtMs: nowMs,
      });
    }
    for (const plan of plans) {
      const key = eventKey(plan);
      if (db.raw.query<{ id: number }, [string]>("SELECT id FROM event_journal WHERE event_key = ?").get(key)) continue;
      insertEnvelope(db, {
        eventKey: key,
        type: plan.type,
        domain: "migration",
        paneId: typeof plan.ids.pane_id === "string" ? plan.ids.pane_id : undefined,
        correlationId: typeof plan.ids.message_key === "string"
          ? plan.ids.message_key
          : typeof plan.ids.wait_id === "string" ? plan.ids.wait_id : undefined,
        payload: {
          path_class: plan.pathClass,
          reason: plan.reason,
          outcome: plan.type === "legacy.marker.imported" ? "imported" : plan.action === "quarantine" ? "quarantined" : "discarded",
          source_sha256: plan.sourceHash,
          source_size_bytes: plan.sourceSize,
          ...plan.ids,
        },
        createdAtMs: nowMs,
      });
    }
  });
  writeEvidence.immediate();

  for (const plan of plans) {
    try {
      const current = lstatSync(plan.path);
      if (current.dev !== plan.device || current.ino !== plan.inode) throw new Error("marker identity changed");
      if (plan.action === "delete") {
        rmSync(plan.path, { force: true });
      } else {
        const destination = quarantineDestination(options.quarantineDir, plan);
        if (existsSync(destination)) throw new Error("quarantine collision");
        renameSync(plan.path, destination);
      }
    } catch {
      report.cleanupFailures++;
    }
  }
  for (const pathClass of PATH_CLASSES) {
    try {
      rmdirSync(join(options.runtimeDir, pathClass));
      report.removedDirectories++;
    } catch {
      // Non-empty, absent, or foreign directory: leave it untouched.
    }
  }
  return report;
}
