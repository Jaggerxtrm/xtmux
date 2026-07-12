#!/usr/bin/env node
// auto-monitor-consumed — PostToolUse hook, matcher: Monitor|Bash
//
// When Claude arms Monitor(command: "...wait-agent <target>...") or runs a
// foreground Bash wait-agent, this hook clears the <target>_pending marker so
// the Stop-drain gate lets the turn end.
//
// Silent — no output. Best-effort — never crashes the tool loop.

import { readFileSync, rmSync } from "node:fs";

const STATE_DIR = `${process.env.XDG_RUNTIME_DIR || "/tmp"}/xtmux-auto-monitor`;

function readInput() {
  try {
    return JSON.parse(readFileSync(0, "utf-8"));
  } catch {
    return null;
  }
}

function pendingPath(target) {
  return `${STATE_DIR}/${target.replace(/[^A-Za-z0-9._:%$-]/g, "_")}_pending`;
}

function extractWaitTarget(cmd) {
  if (!cmd || typeof cmd !== "string") return null;
  const m = cmd.match(/\bwait-agent\s+['"]?([^\s'"]+)['"]?/);
  return m ? m[1] : null;
}

function main() {
  const input = readInput();
  if (!input) return;

  // Monitor tool: input.tool_input.command; Bash tool: same shape.
  const cmd = input.tool_input?.command;
  const target = extractWaitTarget(cmd);
  if (!target) return;

  try {
    rmSync(pendingPath(target), { force: true });
  } catch {
    // Best-effort.
  }
}

main();
