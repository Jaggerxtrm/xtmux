#!/usr/bin/env node
// Stop: block once when this live pane owns a durable reply expectation without
// a requester-owned SQLite monitor arm. Terminal wakes must be consumed once.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const PICKER = process.env.XTMUX_PICKER || `${process.env.HOME}/.local/bin/xtmux`;
const SKIP_TARGETS = new Set((process.env.XTMUX_AUTO_MONITOR_SKIP_TARGETS || "").split(":").filter(Boolean));

function readInput() {
  try { return JSON.parse(readFileSync(0, "utf8")); } catch { return null; }
}

function pickerJson(args, command) {
  const result = spawnSync(PICKER, args, { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || `exit ${result.status}`).trim().replace(/\s+/g, " ").slice(0, 400);
    throw new Error(`${command} failed${detail ? `: ${detail}` : ""}`);
  }
  try { return JSON.parse(result.stdout || ""); }
  catch (error) { throw new Error(`Malformed ${command} JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

function targetExists(target) {
  const result = spawnSync("tmux", ["display-message", "-p", "-t", target, "#{pane_id}"], { stdio: "ignore", timeout: 2000 });
  return result.status !== 1;
}

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason: reason.slice(0, 1000) }) + "\n");
}

const CANONICAL_TMUX_HANDLE = /^[$%][0-9]+$/;
const SAFE_MESSAGE_KEY = /^[A-Za-z0-9_$%:.-]{1,96}$/;
const MAX_INBOX_KEYS = 20;

function monitorTarget(obligation) {
  const target = obligation?.targetPaneId || obligation?.recipientId;
  return typeof target === "string" && CANONICAL_TMUX_HANDLE.test(target) ? target : null;
}

function commandFor(target) {
  if (!CANONICAL_TMUX_HANDLE.test(target)) throw new Error("noncanonical monitor target");
  return `Monitor(command: "xtmux wait-agent ${target} --wait-for-transition --consume --timeout 30m --interval 30s", description: "reply from ${target}", timeout_ms: 1800000)`;
}

function remindInbox() {
  const pane = process.env.TMUX_PANE || "";
  if (!CANONICAL_TMUX_HANDLE.test(pane)) return;
  const session = String(spawnSync("tmux", ["display-message", "-p", "-t", pane, "#{session_id}"], {
    encoding: "utf8", timeout: 1000,
  }).stdout || "").trim();
  if (!CANONICAL_TMUX_HANDLE.test(session)) return;
  const rows = pickerJson([
    "message-list", "--for", session, "--pane", pane, "--expects-reply", "--json", "--limit", String(MAX_INBOX_KEYS + 1),
  ], "message-list");
  if (!Array.isArray(rows)) return;
  const keys = rows.filter((row) => row?.expectsReply === true && row?.replyStatus === "pending"
    && typeof row.messageKey === "string" && SAFE_MESSAGE_KEY.test(row.messageKey))
    .map((row) => row.messageKey);
  if (keys.length) process.stderr.write(`[xtmux-inbox] reply required: ${keys.slice(0, MAX_INBOX_KEYS).join(", ")}${keys.length > MAX_INBOX_KEYS ? ", …" : ""}\n`);
}

function main() {
  if (process.env.XTMUX_AUTO_MONITOR_DRAIN_DISABLE === "1") return;
  const input = readInput();
  if (!input || input.stop_hook_active) return;

  try { remindInbox(); } catch { /* Reminder is fail-open; the obligation gate below remains authoritative. */ }

  try {
    const obligations = pickerJson(["obligations", "list", "--json"], "obligations list");
    if (!Array.isArray(obligations)) throw new Error("Incompatible obligations list JSON result");
    const invalid = obligations.filter((row) => typeof row?.messageKey !== "string"
      || typeof row?.senderId !== "string" || typeof row?.recipientId !== "string"
      || typeof row?.createdAtMs !== "number" || !Number.isFinite(row.createdAtMs)
      || monitorTarget(row) === null);
    if (invalid.length > 0) {
      block(`Auto-monitor rejected ${invalid.length} noncanonical target value(s). Inspect or cancel the affected obligations with: xtmux obligations list --json`);
      return;
    }
    const pending = obligations.filter((row) => {
      const target = monitorTarget(row);
      return target !== null && !SKIP_TARGETS.has(row.recipientId)
        && !SKIP_TARGETS.has(target) && targetExists(target);
    });
    if (pending.length === 0) return;

    const monitors = pickerJson(["monitor-list", "--json"], "monitor-list");
    if (!Array.isArray(monitors)) throw new Error("Incompatible monitor-list JSON result");
    const unarmed = pending.filter((obligation) => !monitors.some((monitor) => {
      const sameRequester = monitor?.requesterSessionId === obligation.senderId
        && monitor?.requesterPaneId === obligation.senderPaneId;
      const sameTarget = monitor?.sessionId === obligation.recipientId
        && (obligation.targetPaneId === null || obligation.targetPaneId === undefined || monitor?.paneId === obligation.targetPaneId);
      const fresh = typeof monitor?.startedAtMs === "number" && Number.isFinite(monitor.startedAtMs)
        && monitor.startedAtMs >= obligation.createdAtMs;
      return sameRequester && sameTarget && fresh && (monitor.terminalStatus === null || monitor.wakeConsumed === true);
    }));
    if (unarmed.length === 0) return;

    const targets = [...new Set(unarmed.map(monitorTarget))];
    block([
      `Durable replies are expected for ${targets.join(", ")}, but this pane has no active or consumed SQLite wait.`,
      "Arm each native Claude wake exactly as follows:",
      ...targets.map(commandFor),
      "For a one-way message, send it with --expects-reply=false instead of bypassing this gate.",
    ].join("\n\n"));
  } catch (error) {
    block(`xtmux auto-monitor database gate unavailable: ${String(error instanceof Error ? error.message : error).slice(0, 600)}\nRun: xtmux obligations list --json\nThe Stop loop guard allows the next Stop while you repair the CLI or database.`);
  }
}

main();
