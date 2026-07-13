#!/usr/bin/env node
// auto-monitor-on-send — PostToolUse hook, matcher: Bash
//
// After ANY Bash command that sends a message or pointer to a tmux target,
// automatically register a monitor on that target so state changes surface
// as task-notifications. Idempotent: if a monitor is already active for the
// target, do nothing.
//
// Motivation: the user's assistant (xtmux:1.1) repeatedly forgets to re-arm
// monitors after sending. This hook enforces it structurally.
//
// Reads stable `message-send --json` and `safe-send-pointer --json` results;
// command spelling, quoting, and flag order are intentionally irrelevant.
//
// Monitor defaults: 8h timeout, 60s interval. Overridable via env:
//   XTMUX_AUTO_MONITOR_TIMEOUT=8h
//   XTMUX_AUTO_MONITOR_INTERVAL=60s
//   XTMUX_AUTO_MONITOR_DISABLE=1   (bypass entirely)

import { readFileSync, mkdirSync, utimesSync, closeSync, openSync } from "node:fs";
import { spawnSync } from "node:child_process";

const TIMEOUT = process.env.XTMUX_AUTO_MONITOR_TIMEOUT || "8h";
const INTERVAL = process.env.XTMUX_AUTO_MONITOR_INTERVAL || "60s";
const PICKER = process.env.XTMUX_PICKER || `${process.env.HOME}/.local/bin/xtmux`;
const STATE_DIR = `${process.env.XDG_RUNTIME_DIR || "/tmp"}/xtmux-auto-monitor`;
// xtmux-3xs.29: colon-separated list of targets to skip entirely (no marker,
// no monitor). Same shape as PATH. Set in smoke-test env so synthetic
// recipients (alice, dst, smoke:1.99, ...) don't trip the drain-stop hook.
const SKIP_TARGETS = new Set(
  (process.env.XTMUX_AUTO_MONITOR_SKIP_TARGETS || "")
    .split(":")
    .filter((s) => s.length > 0),
);

function pendingPath(target) {
  return `${STATE_DIR}/${target.replace(/[^A-Za-z0-9._:%$-]/g, "_")}_pending`;
}

function touchPending(target) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const p = pendingPath(target);
    const fd = openSync(p, "a");
    closeSync(fd);
    const now = new Date();
    utimesSync(p, now, now);
  } catch {
    // Best-effort — don't crash the hook on state-dir failure.
  }
}

function readInput() {
  try {
    return JSON.parse(readFileSync(0, "utf-8"));
  } catch {
    return null;
  }
}

function responseText(response) {
  if (typeof response === "string") return response.trim();
  if (!response || typeof response !== "object") return "";
  for (const key of ["stdout", "output"]) {
    if (typeof response[key] === "string") return response[key].trim();
  }
  if (Array.isArray(response.content)) {
    return response.content.map((part) => typeof part?.text === "string" ? part.text : "").join("").trim();
  }
  return "";
}

function coordinationTarget(response) {
  const text = responseText(response);
  if (!text.startsWith("{")) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Malformed xtmux JSON result: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if ("duplicate" in value || ("recipientId" in value && "messageKey" in value)) {
    if (typeof value.messageKey !== "string" || typeof value.duplicate !== "boolean" || typeof value.senderId !== "string" || typeof value.recipientId !== "string") {
      throw new Error("Incompatible xtmux message-send JSON result");
    }
    return value.recipientId;
  }
  if ("doubleEnter" in value || ("sent" in value && "target" in value)) {
    if (typeof value.target !== "string" || typeof value.sent !== "boolean" || typeof value.doubleEnter !== "boolean") {
      throw new Error("Incompatible xtmux safe-send-pointer JSON result");
    }
    return value.sent ? value.target : null;
  }
  return null;
}

// xtmux-3xs.30: `tmux has-session -t <target>` precheck. Exit 1 = target
// missing → skip touch + monitor spawn. Anything else (exit 0, subprocess
// error, timeout) falls through: better to touch than silently drop a wake
// we could have armed.
function targetExists(target) {
  try {
    const r = spawnSync("tmux", ["has-session", "-t", target], {
      stdio: "ignore",
      timeout: 2000,
    });
    return r.status !== 1;
  } catch {
    return true; // can't check → assume exists
  }
}

function pickerJson(args, command) {
  const result = spawnSync(PICKER, args, { encoding: "utf8", stdio: "pipe", timeout: 5000 });
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}: ${(result.stderr || "").trim()}`);
  try {
    return JSON.parse(result.stdout || "");
  } catch (error) {
    throw new Error(`Malformed ${command} JSON result: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function alreadyMonitored(target) {
  const rows = pickerJson(["monitor-list", "--json"], "monitor-list");
  if (!Array.isArray(rows)) throw new Error("Incompatible xtmux monitor-list JSON result");
  return rows.some((row) => {
    if (!row || typeof row !== "object" || typeof row.monitorId !== "string" || typeof row.target !== "string") {
      throw new Error("Incompatible xtmux monitor-list JSON row");
    }
    return row.target === target;
  });
}

function fireMonitor(target) {
  const result = pickerJson(["monitor-agent", target, "--json", "--wait-for-transition", "--timeout", TIMEOUT, "--interval", INTERVAL], "monitor-agent");
  if (!result || typeof result !== "object" || typeof result.monitorId !== "string") {
    throw new Error("Incompatible xtmux monitor-agent JSON result");
  }
}

function main() {
  if (process.env.XTMUX_AUTO_MONITOR_DISABLE === "1") return;

  const input = readInput();
  if (!input) return;

  if (input.tool_name !== "Bash") return;
  const exitCode = input.tool_response?.exitCode ?? input.exit_code ?? 0;
  if (exitCode !== 0) return;

  const target = coordinationTarget(input.tool_response);
  if (!target) return;

  // xtmux-3xs.29: synthetic smoke-test targets never wake anyone — skip.
  if (SKIP_TARGETS.has(target)) return;
  // xtmux-3xs.30: also skip when tmux confirms the target doesn't exist.
  if (!targetExists(target)) return;

  // Mark this target as needing a Monitor arm before the next Stop.
  // Kept even if a monitor-agent daemon is already active — daemon feeds pi/
  // shadow-mode but does NOT wake Claude Code; only Monitor(wait-agent) does.
  touchPending(target);

  if (alreadyMonitored(target)) return;

  fireMonitor(target);
  process.stderr.write(`[auto-monitor] armed on ${target} (${TIMEOUT}, ${INTERVAL})\n`);
}

main();
