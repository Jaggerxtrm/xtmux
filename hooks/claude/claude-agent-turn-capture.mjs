#!/usr/bin/env node
// claude-agent-turn-capture — Claude Code Stop hook (xtmux-avz).
//
// On every Stop, parse the current session's transcript jsonl for the last
// assistant text turn and spill it to a temp file, then emit
// `log emit agent.turn.done` so the obs binary stores the uncompacted text in
// agent_turns.last_message_text (symmetric with the pi extension).
//
// Fail-open by contract: any unreadable/malformed transcript, missing tmux
// context, or emit failure is a silent no-op. A Claude turn still lands a row
// via agent-state.sh; this hook only enriches it with full text.

import { readFileSync, writeFileSync, unlinkSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const PICKER = process.env.XTMUX_PICKER || `${process.env.HOME}/.local/bin/xtmux`;
const SUMMARY_MAX = Number(process.env.XTMUX_CLAUDE_SUMMARY_MAX ?? "600");

function readJsonStdin() {
  try { return JSON.parse(readFileSync(0, "utf8")); } catch { return null; }
}

function tmuxValue(args, target) {
  try {
    const scoped = target ? [args[0], ...args.slice(1, 2), "-t", target, ...args.slice(2)] : args;
    return String(spawnSync("tmux", scoped, { encoding: "utf8", timeout: 1000 }).stdout ?? "").trim();
  } catch { return ""; }
}

function compactSummary(text) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return "";
  return oneLine.length > SUMMARY_MAX ? `${oneLine.slice(0, Math.max(0, SUMMARY_MAX - 1))}…` : oneLine;
}

// Concatenate text blocks of one assistant message; skip tool_use / thinking /
// images — only the prose answer is what "what did this agent conclude?" wants.
function textOfMessage(message) {
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

// Scan the transcript tail-to-head for the last assistant turn with text.
// transcript lines are one JSON object each; the assistant turn we want is the
// last top-level entry whose message.role === 'assistant' with non-empty text.
function lastAssistantText(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return "";
  let raw;
  try {
    const stat = statSync(transcriptPath);
    // Read only the tail — the full transcript can be large and only the most
    // recent assistant turn matters. 1MB tail covers thousands of lines.
    const tailStart = Math.max(0, stat.size - 1024 * 1024);
    const buf = readFileSync(transcriptPath);
    raw = buf.subarray(tailStart).toString("utf8");
  } catch { return ""; }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || !line.startsWith("{")) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== "assistant") continue;
    const text = textOfMessage(entry.message);
    if (text) return text;
  }
  return "";
}

function main() {
  const input = readJsonStdin();
  if (!input) return;
  // Hooks run fine outside tmux (tests, detached launches); without the client
  // socket tmux resolves a bystander pane, so skip — same guard as
  // agent-state.sh.
  if (!process.env.TMUX || !process.env.TMUX_PANE) return;
  const transcriptPath = input.transcript_path ?? input.transcriptPath;
  const fullText = lastAssistantText(transcriptPath);
  if (!fullText) return;

  const pane = process.env.TMUX_PANE;
  const sessionId = tmuxValue(["display-message", "-p", "#{session_id}"], pane);
  const sessionName = tmuxValue(["display-message", "-p", "#S"], pane);
  const bead = tmuxValue(["show-options", "-p", "-qv", "@agent_bead"], pane);
  const parent = tmuxValue(["show-options", "-p", "-qv", "@agent_parent_session"], pane);

  let tmpFile = "";
  try {
    tmpFile = join(tmpdir(), `xtmux-claude-turn-${process.pid}-${randomBytes(6).toString("hex")}.txt`);
    writeFileSync(tmpFile, fullText, "utf8");
    const args = [
      "log", "emit", "agent.turn.done",
      `pane=${pane}`,
      `session=${sessionId}`,
      `session_name=${sessionName}`,
      `bead=${bead}`,
      `parent=${parent}`,
      `last_message=${compactSummary(fullText)}`,
      `last_message_file=${tmpFile}`,
    ];
    spawnSync(PICKER, args, { encoding: "utf8", timeout: 2000 });
  } catch {
    // Fail-open: a capture miss never interrupts a Claude turn.
  } finally {
    if (tmpFile) { try { unlinkSync(tmpFile); } catch { /* consumed by obs */ } }
  }
}

main();
