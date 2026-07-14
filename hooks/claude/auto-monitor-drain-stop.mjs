#!/usr/bin/env node
// auto-monitor-drain-stop — Stop hook
//
// If any <target>_pending files exist under the auto-monitor state dir, block
// stop with a reason that includes the exact Monitor(wait-agent) invocation
// the assistant must call. This forces Claude to arm a native wake mechanism
// before going idle — the only path into Claude Code's task-notification pipe.
//
// Silent when nothing is pending (exit 0). Prunes stale entries (>TTL) first
// so a forgotten pending never permanently blocks stop.
//
// Loop guard: honors `stop_hook_active` from the hook input — Claude Code sets
// this on subsequent Stop triggers to signal "the assistant is already reacting
// to a prior block". We refuse to block twice in a row.
//
// Bypass: XTMUX_AUTO_MONITOR_DRAIN_DISABLE=1 skips the gate entirely.

import { readFileSync, readdirSync, statSync, rmSync } from "node:fs";

const STATE_DIR = `${process.env.XDG_RUNTIME_DIR || "/tmp"}/xtmux-auto-monitor`;
const TTL_MS = Number(process.env.XTMUX_AUTO_MONITOR_TTL_MS) || 3600 * 1000;

function readInput() {
  try {
    return JSON.parse(readFileSync(0, "utf-8"));
  } catch {
    return null;
  }
}

function listPending() {
  let entries;
  try {
    entries = readdirSync(STATE_DIR);
  } catch {
    return [];
  }
  const now = Date.now();
  const alive = [];
  for (const name of entries) {
    if (!name.endsWith("_pending")) continue;
    const path = `${STATE_DIR}/${name}`;
    let mtime;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtime > TTL_MS) {
      try { rmSync(path, { force: true }); } catch { /* best-effort */ }
      continue;
    }
    const target = name.slice(0, -"_pending".length);
    alive.push(target);
  }
  return alive;
}

function buildReason(targets) {
  const lines = [
    `You sent to ${targets.length === 1 ? "" : "these targets "}${targets.join(", ")} and have not armed a Monitor for ${targets.length === 1 ? "it" : "them"}.`,
    "",
    "Without a Monitor(wait-agent) arm, replies from these targets will NOT wake you from idle. The auto-monitor daemon feeds pi and shadow-mode audit but does not reach Claude Code's task-notification pipe.",
    "",
    "For each pending target, invoke:",
    "",
  ];
  for (const t of targets) {
    lines.push(
      `  Monitor(command: "tmux-session-picker wait-agent ${t} --wait-for-transition --timeout 30m --interval 30s", description: "reply from ${t}", timeout_ms: 1800000)`,
    );
  }
  lines.push(
    "",
    "Then finish your turn. If a reply is not expected (e.g. one-way notification), you can clear the marker manually:",
    `  rm -f ${STATE_DIR}/<target>_pending`,
  );
  return lines.join("\n");
}

function main() {
  if (process.env.XTMUX_AUTO_MONITOR_DRAIN_DISABLE === "1") return;

  const input = readInput();
  if (!input) return;

  // Loop guard: never block twice in a row.
  if (input.stop_hook_active) return;

  const pending = listPending();
  if (pending.length === 0) return;

  const payload = {
    decision: "block",
    reason: buildReason(pending),
  };
  process.stdout.write(JSON.stringify(payload) + "\n");
  process.exit(0);
}

main();
