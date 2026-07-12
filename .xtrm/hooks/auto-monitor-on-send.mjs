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
// Detects these command shapes:
//   tmux-session-picker message-send --to <target> ...
//   tmux-session-picker safe-send-pointer [...flags] <target> <pointer>
//   tmux send-keys -t <target> ...            (raw send-keys fallback)
//
// Monitor defaults: 8h timeout, 60s interval. Overridable via env:
//   XTMUX_AUTO_MONITOR_TIMEOUT=8h
//   XTMUX_AUTO_MONITOR_INTERVAL=60s
//   XTMUX_AUTO_MONITOR_DISABLE=1   (bypass entirely)

import { readFileSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";

const TIMEOUT = process.env.XTMUX_AUTO_MONITOR_TIMEOUT || "8h";
const INTERVAL = process.env.XTMUX_AUTO_MONITOR_INTERVAL || "60s";
const PICKER = process.env.XTMUX_PICKER || "/home/dawid/dev/xtmux/bin/tmux-session-picker";

function readInput() {
  try {
    return JSON.parse(readFileSync(0, "utf-8"));
  } catch {
    return null;
  }
}

function extractTarget(cmd) {
  if (!cmd || typeof cmd !== "string") return null;

  // message-send --to <target>
  {
    const m = cmd.match(/message-send\b[^\n]*?(?:--to[= ]|--to\s+)['"]?([^\s'"]+)['"]?/);
    if (m) return m[1];
  }
  // safe-send-pointer [flags] <target> <pointer>
  {
    const m = cmd.match(/safe-send-pointer\s+((?:--\S+\s+)*)([^\s'"]+)\s+\S+/);
    if (m) return m[2];
  }
  // raw tmux send-keys -t <target>
  {
    const m = cmd.match(/tmux\s+send-keys\s+(?:-\S+\s+)*-t\s+['"]?([^\s'"]+)['"]?/);
    if (m) return m[1];
  }
  return null;
}

function alreadyMonitored(target) {
  const r = spawnSync(PICKER, ["monitor-list"], { encoding: "utf8", stdio: "pipe" });
  if (r.status !== 0) return false;
  // monitor-list rows: monitor\t<id>\t<pid>\t<target>\t<pane>\t<state>\t...
  const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
  for (const l of lines) {
    const parts = l.split("\t");
    if (parts.length >= 5 && parts[3] === target) return true;
  }
  return false;
}

function fireMonitor(target) {
  const child = spawn(PICKER, ["monitor-agent", target, "--timeout", TIMEOUT, "--interval", INTERVAL], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function main() {
  if (process.env.XTMUX_AUTO_MONITOR_DISABLE === "1") return;

  const input = readInput();
  if (!input) return;

  if (input.tool_name !== "Bash") return;
  const exitCode = input.tool_response?.exitCode ?? input.exit_code ?? 0;
  if (exitCode !== 0) return;

  const cmd = input.tool_input?.command;
  const target = extractTarget(cmd);
  if (!target) return;

  // Never fire on commands that themselves manage monitors — avoids double-arms.
  if (/monitor-(agent|list|kill)\b/.test(cmd)) return;

  if (alreadyMonitored(target)) return;

  fireMonitor(target);
  process.stderr.write(`[auto-monitor] armed on ${target} (${TIMEOUT}, ${INTERVAL})\n`);
}

main();
