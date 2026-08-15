#!/usr/bin/env node
// claude-agent-turn-capture — Claude Code Stop hook (xtmux-avz, xtmux-gdk).
//
// On every Stop, capture the assistant text of the turn just completed and
// emit `log emit agent.turn.done` so the obs binary stores it in
// agent_turns.last_message_text (symmetric with the pi extension).
//
// Response episodes (xtmux-gdk): each row is a CANDIDATE inside the pane's
// current episode (one user prompt + all continuations caused before control
// returns to the operator). The UserPromptSubmit hook opens the episode and
// records a transcript cursor; this hook reports episode_open=1 on every
// non-continuation stop, 0 on stop_hook_active continuations, and the obs
// attaches rows to the right episode. The viewer renders the episode, never
// the latest row.
//
// Text source: input.last_assistant_message is primary — Claude's docs state
// the transcript "isn't guaranteed to include the final message at Stop time
// on all versions", so the settle-retry tail read is only the fallback for
// payloads without it. The fallback polls until the file size settles or a
// new assistant line appears after the episode cursor (~1s cap).
//
// Fail-open by contract: unreadable/malformed transcripts emit a metadata-only
// completed-turn row; missing tmux context or emit failures remain silent.

import { closeSync, fstatSync, openSync, readFileSync, readSync, writeFileSync, unlinkSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// Scan raw transcript text tail-to-head for the last assistant turn with text.
// transcript lines are one JSON object each; the assistant turn we want is the
// last top-level entry whose message.role === 'assistant' with non-empty text.
function parseTail(raw) {
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

// Read only the tail — the full transcript can be large and only the most
// recent assistant turn matters. 1MB tail covers thousands of lines. When a
// cursor (byte offset recorded at episode open) is given, only source at or
// after the cursor is scanned, so a previous episode's text can never satisfy
// the read.
function readTail(transcriptPath, fromOffset = 0) {
  if (!transcriptPath) return { size: 0, text: "" };
  let fd;
  try {
    fd = openSync(transcriptPath, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, 1024 * 1024);
    const windowStart = size - length;
    const buf = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buf, 0, length, windowStart);
    const sliceStart = Math.max(0, fromOffset - windowStart);
    return { size, text: parseTail(buf.subarray(sliceStart, bytesRead).toString("utf8")) };
  } catch { return { size: 0, text: "" }; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* fail-open */ } } }
}

// Claude's transcript writer flushes asynchronously: a Stop fired mid-flush
// can read a tail where the final assistant line has not landed yet, which
// would store the previous turn's text. Poll until the file size settles or
// the assistant text advances (the final line landed), bounded by SETTLE_MS.
const SETTLE_MS = 1000;
const POLL_MS = 25;
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { Atomics.wait(SLEEP_BUF, 0, 0, ms); }

function settledTranscript(transcriptPath, fromOffset = 0) {
  const deadline = Date.now() + SETTLE_MS;
  let prev = readTail(transcriptPath, fromOffset);
  sleepSync(POLL_MS);
  while (Date.now() < deadline) {
    const cur = readTail(transcriptPath, fromOffset);
    // Newer assistant text landing (after the episode cursor) is the flush
    // completing; a size unchanged across a full poll gap means the writer has
    // settled. Either ends the retry with the freshest read.
    if (cur.text !== prev.text || cur.size === prev.size) return cur;
    prev = cur;
    sleepSync(POLL_MS);
  }
  return prev;
}

function main() {
  const input = readJsonStdin();
  if (!input) return;
  // Hooks run fine outside tmux (tests, detached launches); without the client
  // socket tmux resolves a bystander pane, so skip — same guard as
  // agent-state.sh.
  if (!process.env.TMUX || !process.env.TMUX_PANE) return;
  const pane = process.env.TMUX_PANE;
  const transcriptPath = input.transcript_path ?? input.transcriptPath;
  const continuation = input.stop_hook_active === true;

  // Episode correlation (xtmux-gdk). The UserPromptSubmit hook opens the
  // episode and arms @agent_episode_pending; every other non-continuation stop
  // starts a fresh episode itself (covers a missing UserPromptSubmit hook and
  // sessions that never fired one). The pending flag is consumed here.
  const cursor = Number(tmuxValue(["show-options", "-p", "-qv", "@agent_episode_cursor"], pane)) || 0;
  const promptArmed = tmuxValue(["show-options", "-p", "-qv", "@agent_episode_pending"], pane) === "1";
  const episodeOpen = continuation ? 0 : (promptArmed ? 0 : 1);
  if (!continuation) {
    try {
      spawnSync("tmux", ["set-option", "-p", "-q", "@agent_episode_pending", "0"], { encoding: "utf8", timeout: 1000 });
    } catch { /* best-effort: a stale flag only re-arms once per prompt */ }
  }

  // Text source: the Stop payload's own last_assistant_message is authoritative
  // (race-free by contract); the settle-retry tail read after the episode
  // cursor is the fallback for payloads without it.
  const payloadText = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
  let transcriptSize = 0;
  let fullText = payloadText;
  if (fullText) {
    try { transcriptSize = statSync(transcriptPath).size; } catch { /* size only improves dedup identity */ }
  } else {
    const settled = settledTranscript(transcriptPath, cursor);
    transcriptSize = settled.size;
    fullText = settled.text;
  }

  const sessionId = tmuxValue(["display-message", "-p", "#{session_id}"], pane);
  const sessionName = tmuxValue(["display-message", "-p", "#S"], pane);
  const bead = tmuxValue(["show-options", "-p", "-qv", "@agent_bead"], pane);
  const parent = tmuxValue(["show-options", "-p", "-qv", "@agent_parent_session"], pane);
  const turnKey = createHash("sha256")
    .update(`${sessionId}\0${transcriptPath}\0${transcriptSize}\0${fullText}`)
    .digest("hex").slice(0, 24);

  let tmpDir = "";
  let tmpFile = "";
  try {
    if (fullText) {
      tmpDir = mkdtempSync(join(tmpdir(), "xtmux-claude-turn-"));
      tmpFile = join(tmpDir, "message.txt");
      writeFileSync(tmpFile, fullText, { encoding: "utf8", mode: 0o600 });
    }
    const args = [
      "log", "emit", "agent.turn.done",
      `pane=${pane}`,
      `session=${sessionId}`,
      `session_name=${sessionName}`,
      `bead=${bead}`,
      `parent=${parent}`,
      `episode_open=${episodeOpen}`,
      `last_message=${compactSummary(fullText)}`,
      `last_message_file=${tmpFile}`,
    ];
    spawnSync(PICKER, args, { encoding: "utf8", timeout: 2000 });
  } catch {
    // Fail-open: a capture miss never interrupts a Claude turn.
  } finally {
    if (tmpFile) { try { unlinkSync(tmpFile); } catch { /* consumed by obs */ } }
    if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* already removed */ } }
  }

  if (parent && parent !== sessionId && parent !== pane && fullText) {
    try {
      spawnSync(PICKER, [
        "message-send", "--from", sessionId || pane, "--to", parent, "--bead", bead,
        "--expects-reply=false", "--text", `turn done: ${compactSummary(fullText)}`,
        "--id", `claude-turn-${turnKey}`,
      ], { encoding: "utf8", timeout: 2000 });
    } catch {
      // Best-effort only.
    }
  }
}

main();
