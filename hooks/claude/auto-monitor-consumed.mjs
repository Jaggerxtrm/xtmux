#!/usr/bin/env node
// PostToolUse(Monitor|Bash): consume a completed requester-owned SQLite wake.
// Active native Monitor arms remain untouched; repeated completion hooks are
// idempotent and no runtime marker files are read or deleted.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const PICKER = process.env.XTMUX_PICKER || `${process.env.HOME}/.local/bin/xtmux`;

function readInput() {
  try { return JSON.parse(readFileSync(0, "utf8")); } catch { return null; }
}

function extractWaitTarget(command) {
  if (typeof command !== "string") return null;
  return command.match(/\bwait-agent\s+['"]?([^\s'"]+)['"]?/)?.[1] ?? null;
}

function picker(args, command) {
  const result = spawnSync(PICKER, args, { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim()}`);
  try { return JSON.parse(result.stdout || ""); }
  catch (error) { throw new Error(`Malformed ${command} JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

function main() {
  const input = readInput();
  const target = extractWaitTarget(input?.tool_input?.command);
  if (!target || (input.tool_response?.exitCode ?? input.exit_code ?? 0) !== 0) return;
  try {
    const rows = picker(["monitor-list", "--json"], "monitor-list");
    if (!Array.isArray(rows)) throw new Error("Incompatible monitor-list JSON result");
    const pending = rows.find((row) => row?.requesterPaneId === process.env.TMUX_PANE
      && (row.target === target || row.paneId === target || row.sessionId === target)
      && row.terminalStatus !== null && row.wakeDelivered === true && row.wakeConsumed === false);
    if (!pending) return;
    picker(["wait-agent", target, "--consume", "--timeout", "0", "--interval", "0", "--json"], "wait-agent --consume");
  } catch (error) {
    process.stderr.write(`[auto-monitor] ${String(error instanceof Error ? error.message : error).slice(0, 400)}\n`);
  }
}

main();
