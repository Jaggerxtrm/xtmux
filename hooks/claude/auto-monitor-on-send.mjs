#!/usr/bin/env node
// PostToolUse(Bash): confirm that an explicit reply expectation is durable.
// Native Claude Monitor(wait-agent) arms the requester-owned SQLite wait; this
// hook never creates sidecar marker files.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const PICKER = process.env.XTMUX_PICKER || `${process.env.HOME}/.local/bin/xtmux`;
const SKIP_TARGETS = new Set((process.env.XTMUX_AUTO_MONITOR_SKIP_TARGETS || "").split(":").filter(Boolean));

function readInput() {
  try { return JSON.parse(readFileSync(0, "utf8")); } catch { return null; }
}

function responseText(response) {
  if (typeof response === "string") return response.trim();
  if (!response || typeof response !== "object") return "";
  for (const key of ["stdout", "output"]) if (typeof response[key] === "string") return response[key].trim();
  if (Array.isArray(response.content)) return response.content.map((part) => typeof part?.text === "string" ? part.text : "").join("").trim();
  return "";
}

function firstJsonObject(text) {
  if (!text.startsWith("{")) return null;
  let depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return JSON.parse(text.slice(0, i + 1));
  }
  throw new Error("Malformed xtmux JSON result: incomplete object");
}

function expectedMessage(response) {
  const value = firstJsonObject(responseText(response));
  if (!value || typeof value !== "object" || Array.isArray(value) || !("expectsReply" in value)) return null;
  if (typeof value.messageKey !== "string" || typeof value.recipientId !== "string" || typeof value.expectsReply !== "boolean") {
    throw new Error("Incompatible xtmux message-send JSON result");
  }
  if (value.targetPaneId !== null && value.targetPaneId !== undefined && typeof value.targetPaneId !== "string") {
    throw new Error("Incompatible xtmux message-send target pane");
  }
  return value.expectsReply ? value : null;
}

function targetExists(target) {
  const result = spawnSync("tmux", ["display-message", "-p", "-t", target, "#{pane_id}"], { stdio: "ignore", timeout: 2000 });
  return result.status !== 1;
}

function pickerJson(args, command) {
  const result = spawnSync(PICKER, args, { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim()}`);
  try { return JSON.parse(result.stdout || ""); }
  catch (error) { throw new Error(`Malformed ${command} JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

function main() {
  if (process.env.XTMUX_AUTO_MONITOR_DISABLE === "1") return;
  const input = readInput();
  if (!input || input.tool_name !== "Bash" || (input.tool_response?.exitCode ?? input.exit_code ?? 0) !== 0) return;
  try {
    const message = expectedMessage(input.tool_response);
    if (!message) return;
    const target = message.targetPaneId || message.recipientId;
    if (SKIP_TARGETS.has(message.recipientId) || SKIP_TARGETS.has(target) || !targetExists(target)) return;
    const obligations = pickerJson(["obligations", "list", "--json"], "obligations list");
    if (!Array.isArray(obligations) || !obligations.some((row) => row?.messageKey === message.messageKey)) {
      throw new Error(`obligations list did not return ${message.messageKey}`);
    }
    process.stderr.write(`[auto-monitor] durable reply expected from ${target}; Stop will require a native Monitor arm.\n`);
  } catch (error) {
    process.stderr.write(`[auto-monitor] ${String(error instanceof Error ? error.message : error).slice(0, 400)}\n`);
  }
}

main();
