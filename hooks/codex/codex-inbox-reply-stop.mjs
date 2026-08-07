#!/usr/bin/env node
// codex-inbox-reply-stop — Codex Stop hook (K4-xtmux, xtmux-s96.4).
//
// The Codex counterpart of hooks/claude/auto-monitor-drain-stop.mjs and
// extensions/pi-inbox-reply.ts. Before K4 the Codex column had turn capture
// (outbound FYIs) and nothing at all on the inbound side: a reply-required
// message addressed to a Codex pane had no delivery surface, no obligation
// gate, and no Codex hook armed or consumed a monitor/wake.
//
// Three duties, in this order:
//
//   1. BOUNDED INBOX REMINDER. Surface inbound reply-required messages that are
//      still pending, exactly once each. See the write-first note on
//      rememberReminded() — the ordering there is the whole guarantee.
//   2. OBLIGATION GATE. This pane's own reply-required sends need a durable
//      wait, or their replies wake nobody. Claude BLOCKS the Stop and tells the
//      model to arm a native Monitor. Codex gets no such lever: whether a Codex
//      command hook can veto a Stop is NOT part of the verified 0.146.0
//      surface, and inventing a decision protocol on an unverified contract
//      would be a silent no-op at best. So the hook does what the Pi extension
//      does instead — it ARMS the wait itself, through the same
//      `xtmux monitor-agent` authority, and writes nothing to stdout.
//   3. WAKE CONSUMPTION. A delivered wake this pane owns is consumed here, so a
//      completed wait cannot sit undelivered forever (Claude does this from
//      PostToolUse; Codex has no equivalent tool seam, so Stop carries it).
//
// Fail-open by contract, like every other xtmux Codex hook: an unreadable
// payload, a missing tmux context, an unavailable CLI or a malformed JSON
// answer all exit 0 silently. Nothing here writes to stdout — Codex must never
// be able to read this hook as a decision.
//
// Untrusted data: every payload field is DATA. The payload is used only to
// confirm the event and to skip re-entrant stops; pane and session identity are
// read back from tmux, and message keys are matched against SAFE_MESSAGE_KEY
// before they are printed or persisted.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

const PICKER = process.env.XTMUX_PICKER || `${process.env.HOME}/.local/bin/xtmux`;
const PICKER_TIMEOUT_MS = 5000;
const CANONICAL_TMUX_HANDLE = /^[$%][0-9]+$/;
const SAFE_MESSAGE_KEY = /^[A-Za-z0-9_$%:.-]{1,96}$/;
// Same cap as the Claude hook's reminder set: the reminder is a pointer, not a
// payload, and an unbounded one is a context-window denial of service.
const MAX_INBOX_KEYS = 20;
// Arming is a durable write per call; a pane that somehow owes fifty replies
// gets five arms per Stop and converges over the following turns.
const MAX_ARMS = 5;
const TIMEOUT = process.env.XTMUX_AUTO_MONITOR_TIMEOUT || "8h";
const INTERVAL = process.env.XTMUX_AUTO_MONITOR_INTERVAL || "60s";
const SKIP_TARGETS = new Set((process.env.XTMUX_AUTO_MONITOR_SKIP_TARGETS || "").split(":").filter(Boolean));

function readJsonStdin() {
  try { return JSON.parse(readFileSync(0, "utf8")); } catch { return null; }
}

function pickerJson(args, command) {
  const result = spawnSync(PICKER, args, { encoding: "utf8", timeout: PICKER_TIMEOUT_MS });
  if (result.status !== 0) throw new Error(`${command} failed (exit ${result.status})`);
  try { return JSON.parse(result.stdout || ""); }
  catch { throw new Error(`${command} returned incompatible JSON`); }
}

function tmuxValue(args) {
  try {
    return String(spawnSync("tmux", args, { encoding: "utf8", timeout: 1000 }).stdout ?? "").trim();
  } catch { return ""; }
}

function targetExists(target) {
  const result = spawnSync("tmux", ["display-message", "-p", "-t", target, "#{pane_id}"], { stdio: "ignore", timeout: 2000 });
  return result.status !== 1;
}

function stateRoot() {
  const base = process.env.XDG_STATE_HOME || join(process.env.HOME || "/tmp", ".local", "state");
  return join(base, "xtmux", "codex-inbox");
}

/** One file per pane; the pane id is the only variable part and is validated. */
function reminderFile(paneId) {
  return join(stateRoot(), `${paneId.replace(/[^A-Za-z0-9]/g, "_")}.json`);
}

function readReminded(paneId) {
  try {
    const parsed = JSON.parse(readFileSync(reminderFile(paneId), "utf8"));
    const keys = Array.isArray(parsed?.keys) ? parsed.keys : [];
    return keys.filter((key) => typeof key === "string" && SAFE_MESSAGE_KEY.test(key));
  } catch {
    // Missing or corrupt state means "nothing reminded yet". That direction is
    // safe: it can only cause a repeated reminder, never a swallowed one.
    return [];
  }
}

/**
 * PERSIST BEFORE EMITTING. This ordering is the bounded-work guarantee and it
 * is deliberately the unnatural one.
 *
 * The natural shape — print the reminder, then record that it was printed — is
 * silently broken: if the write fails (read-only state dir, full disk, a
 * sandbox that never created XDG_STATE_HOME), the reminder was already emitted
 * and the key was never recorded, so the SAME message is re-surfaced on every
 * later Stop, forever. That is not a degraded reminder, it is an unbounded one:
 * a spin that grows the model's context every turn and never terminates.
 *
 * So the write happens first and the caller ABORTS the reminder when it fails.
 * The failure mode of this direction is a missed reminder — bounded, visible in
 * the durable inbox (`xtmux message-list --expects-reply`), and recoverable on
 * the next Stop once the state directory is writable.
 *
 * Atomic: written to a temp file, fsynced, then renamed over the target, so a
 * crash mid-write cannot leave a truncated set that under-reports what was
 * already emitted.
 *
 * @throws if the set could not be durably persisted.
 */
function rememberReminded(paneId, keys) {
  const file = reminderFile(paneId);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  const payload = JSON.stringify({ keys: keys.slice(-MAX_INBOX_KEYS), updatedAtMs: Date.now() });
  let fd;
  try {
    fd = openSync(temp, "w", 0o600);
    writeSync(fd, payload);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  try {
    renameSync(temp, file);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}

/** Duty 1: bounded inbox reminder, write-first. */
function remindInbox(paneId, sessionId) {
  const rows = pickerJson([
    "message-list", "--for", sessionId, "--pane", paneId, "--expects-reply", "--json",
    "--limit", String(MAX_INBOX_KEYS + 1),
  ], "message-list");
  if (!Array.isArray(rows)) throw new Error("message-list returned incompatible JSON");
  const pending = rows
    .filter((row) => row?.expectsReply === true && row?.replyStatus === "pending"
      && typeof row.messageKey === "string" && SAFE_MESSAGE_KEY.test(row.messageKey))
    .map((row) => row.messageKey);
  if (pending.length === 0) return [];

  const already = new Set(readReminded(paneId));
  const fresh = pending.filter((key) => !already.has(key));
  if (fresh.length === 0) return [];

  // Prune keys that are no longer pending in the same write: dropping a key can
  // only ever cause one extra reminder later, never a lost one.
  const next = [...pending.filter((key) => already.has(key)), ...fresh];
  rememberReminded(paneId, next); // throws => caller emits nothing

  const shown = fresh.slice(0, MAX_INBOX_KEYS);
  const overflow = fresh.length > shown.length ? ", …" : "";
  process.stderr.write(`[xtmux-inbox] reply required: ${shown.join(", ")}${overflow}\n`);
  // Durable evidence of the emission, independent of whether the Codex UI
  // surfaces hook stderr (which is not part of the verified 0.146.0 contract).
  try {
    spawnSync(PICKER, [
      "log", "emit", "agent.inbox.reminder",
      `pane=${paneId}`, `session=${sessionId}`,
      `keys=${shown.join(",")}`, `count=${String(fresh.length)}`,
    ], { encoding: "utf8", timeout: PICKER_TIMEOUT_MS });
  } catch { /* the reminder itself already landed on stderr */ }
  return shown;
}

function monitorTarget(obligation) {
  const target = obligation?.targetPaneId || obligation?.recipientId;
  return typeof target === "string" && CANONICAL_TMUX_HANDLE.test(target) ? target : null;
}

/** Duties 2 and 3: arm the missing waits, consume the delivered wakes. */
function reconcileWaits(paneId) {
  const monitors = pickerJson(["monitor-list", "--json"], "monitor-list");
  if (!Array.isArray(monitors)) throw new Error("monitor-list returned incompatible JSON");

  // Duty 3 first: a consumed wake frees this pane's own completed wait, and the
  // arming pass below then sees an accurate picture of what is still missing.
  let consumed = 0;
  for (const row of monitors) {
    if (consumed >= MAX_ARMS) break;
    if (row?.requesterPaneId !== paneId) continue;
    if (row.terminalStatus === null || row.wakeDelivered !== true || row.wakeConsumed !== false) continue;
    const target = typeof row.target === "string" ? row.target : null;
    if (!target) continue;
    try {
      pickerJson(["wait-agent", target, "--consume", "--timeout", "0", "--interval", "0", "--json"], "wait-agent --consume");
      consumed += 1;
    } catch { /* another consumer won the race; the journal records it once */ }
  }

  const obligations = pickerJson(["obligations", "list", "--json"], "obligations list");
  if (!Array.isArray(obligations)) throw new Error("obligations list returned incompatible JSON");
  const armed = new Set();
  let arms = 0;
  for (const obligation of obligations) {
    if (arms >= MAX_ARMS) break;
    if (obligation?.senderPaneId !== paneId) continue;
    const target = monitorTarget(obligation);
    if (target === null || armed.has(target)) continue;
    if (SKIP_TARGETS.has(target) || SKIP_TARGETS.has(obligation.recipientId)) continue;
    const covered = monitors.some((monitor) => monitor?.requesterSessionId === obligation.senderId
      && monitor?.requesterPaneId === obligation.senderPaneId
      && monitor?.sessionId === obligation.recipientId
      && (obligation.targetPaneId === null || obligation.targetPaneId === undefined
        || monitor?.paneId === obligation.targetPaneId)
      && typeof monitor?.startedAtMs === "number" && Number.isFinite(monitor.startedAtMs)
      && monitor.startedAtMs >= obligation.createdAtMs
      && (monitor.terminalStatus === null || monitor.wakeConsumed === true));
    if (covered || !targetExists(target)) continue;
    pickerJson([
      "monitor-agent", target, "--wait-for-transition",
      "--timeout", TIMEOUT, "--interval", INTERVAL, "--json",
    ], "monitor-agent");
    armed.add(target);
    arms += 1;
  }
  return { armed: [...armed], consumed };
}

function main() {
  if (process.env.XTMUX_CODEX_INBOX_DISABLE === "1") return;
  const input = readJsonStdin();
  if (!input) return;
  // Wired to Stop only. A payload that lies about its event is hostile
  // metadata: rejected as data, no reads, no writes, exit 0.
  if (input.hook_event_name !== "Stop") return;
  // Observed-only in the turn-capture hook; honoured here because this hook
  // performs durable writes and a re-entrant stop must not double-arm.
  if (input.stop_hook_active) return;
  if (!process.env.TMUX || !CANONICAL_TMUX_HANDLE.test(process.env.TMUX_PANE || "")) return;

  const paneId = process.env.TMUX_PANE;
  const sessionId = tmuxValue(["display-message", "-p", "-t", paneId, "#{session_id}"]);
  if (!CANONICAL_TMUX_HANDLE.test(sessionId)) return;

  // The two duties are independent: a broken inbox read must not cost the pane
  // its obligation gate, and vice versa.
  try { remindInbox(paneId, sessionId); } catch { /* fail open */ }
  try { reconcileWaits(paneId); } catch { /* fail open */ }
}

main();
