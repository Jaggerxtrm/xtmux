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
// Candidate identity (xtmux-gdk review P1): source_key is derived from the
// assistant record's OWN immutable provider identity (message.id, fallback
// entry uuid) — never from text, live transcript size, or timestamp. A
// replay resolves the same record (and thus the same key) even when the file
// grows between deliveries; two distinct events with identical text resolve
// different records. When the provider payload leads the transcript, the
// payload text is correlated to its record within the settle window; if no
// record exists by the deadline the candidate is NOT finalized with a guessed
// key — the emission is skipped and a later replay reconciles (the rich view
// may lag; the turn still lands via agent-state.sh).
//
// Fail-open by contract: unreadable/malformed transcripts emit a metadata-only
// completed-turn row; missing tmux context or emit failures remain silent.

import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync, writeFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
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
// With expectedText, only records whose trimmed text equals it qualify — the
// payload's own record — so a replay finds the SAME record even when newer
// entries exist (a later identical-text "done" still resolves its own record).
// Returns the record's immutable identity: message.id (msg_…) preferred,
// entry uuid fallback. Empty identity means the record carries none — the
// candidate is not finalized with a guessed key.
function parseTail(raw, expectedText = "") {
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || !line.startsWith("{")) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== "assistant") continue;
    const text = textOfMessage(entry.message);
    if (!text) continue;
    if (expectedText && text.trim() !== expectedText.trim()) continue;
    return { text, messageId: entry?.message?.id ?? entry?.uuid ?? "" };
  }
  return { text: "", messageId: "" };
}

// Read only the tail — the full transcript can be large and only the most
// recent assistant turn matters. 1MB tail covers thousands of lines. When a
// cursor (byte offset recorded at episode open) is given, only source at or
// after the cursor is scanned, so a previous episode's text can never satisfy
// the read.
function readTail(transcriptPath, fromOffset = 0, expectedText = "") {
  if (!transcriptPath) return { size: 0, text: "", messageId: "" };
  let fd;
  try {
    fd = openSync(transcriptPath, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, 1024 * 1024);
    const windowStart = size - length;
    const buf = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buf, 0, length, windowStart);
    const sliceStart = Math.max(0, fromOffset - windowStart);
    return { size, ...parseTail(buf.subarray(sliceStart, bytesRead).toString("utf8"), expectedText) };
  } catch { return { size: 0, text: "", messageId: "" }; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* fail-open */ } } }
}

// Claude's transcript writer flushes asynchronously: a Stop fired mid-flush
// can read a tail where the final assistant line has not landed yet, which
// would store the previous turn's text. The retry NEVER settles on a quiet
// interval alone — the writer can pause >25ms before the new assistant record
// lands, and a hook/system record can land first. It polls until a NEW
// candidate (text that differs from the last one this hook already emitted
// for this transcript) appears, bounded by SETTLE_MS; at the deadline it
// reports no text (metadata-only row) rather than the stale candidate.
const SETTLE_MS = 1000;
const POLL_MS = 25;
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { Atomics.wait(SLEEP_BUF, 0, 0, ms); }

function settledTranscript(transcriptPath, fromOffset = 0, lastCandidate = "", expectedText = "", anchor = 0) {
  // The capture anchor is validated against the live file size (compaction can
  // shrink the transcript below a stored offset); the scan then starts past
  // the last correlated record so a same-text earlier record can never satisfy
  // a later stop's correlation (xtmux-gdk post-merge P1).
  let size = 0;
  try { size = statSync(transcriptPath).size; } catch { /* readTail reports 0 */ }
  const start = (anchor > 0 && anchor <= size) ? Math.max(fromOffset, anchor) : fromOffset;
  const deadline = Date.now() + SETTLE_MS;
  let prev = readTail(transcriptPath, start, expectedText);
  if (prev.size === 0) return prev; // no transcript at all: nothing can arrive
  if (expectedText && prev.text) return prev; // payload's record already landed
  sleepSync(POLL_MS);
  while (Date.now() < deadline) {
    const cur = readTail(transcriptPath, start, expectedText);
    if (expectedText) {
      // Payload-correlation mode: the read only qualifies records whose text
      // equals the payload's — the first qualified read IS the source
      // occurrence; its messageId becomes the identity.
      if (cur.text) return cur;
    } else if (cur.text) {
      const isNewCandidate = compactSummary(cur.text) !== lastCandidate;
      if (isNewCandidate) {
        if (lastCandidate !== "") return cur; // unambiguously this turn's text
        // No prior candidate: the text could still be the previous turn's
        // mid-flush. Trust it only when the transcript advanced or the writer
        // is idle — with a fresh episode cursor this region holds only this
        // turn's content, so a settled size makes it authoritative.
        if (cur.text !== prev.text || cur.size === prev.size) return cur;
      }
    }
    prev = cur;
    sleepSync(POLL_MS);
  }
  // Never persist the previous candidate as this turn's text; the turn still
  // lands as a metadata-only row (fail-open).
  return { size: prev.size, text: "", messageId: "" };
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
  // The compact text this hook last emitted for this transcript: the fallback
  // read must never report it again as a new turn's text (xtmux-9yo review).
  const lastCandidate = tmuxValue(["show-options", "-p", "-qv", "@agent_last_candidate"], pane);
  // Monotonic per-candidate capture anchor (xtmux-gdk post-merge P1):
  // "<transcript_path>|<byte offset>" of the transcript when the last candidate
  // was emitted. Correlation scans only source AFTER the anchor, so a later
  // stop whose payload text equals an earlier candidate's text can never
  // absorb that earlier record while its own record is still flushing. Path
  // scoping keeps anchors from one session file from leaking into another.
  const anchorRaw = tmuxValue(["show-options", "-p", "-qv", "@agent_capture_anchor"], pane);
  const anchorSep = anchorRaw.lastIndexOf("|");
  const anchorOffset = (anchorSep > 0 && anchorRaw.slice(0, anchorSep) === transcriptPath)
    ? Number(anchorRaw.slice(anchorSep + 1)) || 0
    : 0;
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
  let fullText = "";
  let sourceMessageId = "";
  let skipEmission = false;
  let capturedSize = 0;
  if (payloadText) {
    // Provider payload leads the transcript: correlate the payload to its
    // assistant record (the immutable source occurrence) within the bounded
    // window. The record supplies ONLY the identity — the payload text stays
    // authoritative. No record by the deadline: the candidate is not finalized
    // with a guessed key (xtmux-gdk review P1); the emission is skipped and a
    // later replay reconciles once the record exists. The baseline turn row
    // still lands via agent-state.sh — fail-open, the rich view may lag.
    const settled = settledTranscript(transcriptPath, cursor, lastCandidate, payloadText, anchorOffset);
    if (settled.text) {
      fullText = payloadText;
      sourceMessageId = settled.messageId;
      capturedSize = settled.size;
    } else {
      skipEmission = true;
    }
  } else {
    const settled = settledTranscript(transcriptPath, cursor, lastCandidate, "", anchorOffset);
    fullText = settled.text;
    sourceMessageId = settled.messageId;
    capturedSize = settled.size;
  }

  const sessionId = tmuxValue(["display-message", "-p", "#{session_id}"], pane);
  const sessionName = tmuxValue(["display-message", "-p", "#S"], pane);
  const bead = tmuxValue(["show-options", "-p", "-qv", "@agent_bead"], pane);
  const parent = tmuxValue(["show-options", "-p", "-qv", "@agent_parent_session"], pane);
  // Immutable candidate identity: the assistant record's own provider id. A
  // replay of the same Stop resolves the same record → same key → one row; a
  // distinct event (even byte-identical text) resolves a different record →
  // its own key. Empty when the record carries no id — the row lands with
  // source_key NULL (never guessed from text/size/timestamp).
  const sourceKey = sourceMessageId
    ? createHash("sha256").update(`${sessionId}\0${transcriptPath}\0${sourceMessageId}`).digest("hex").slice(0, 24)
    : "";
  // The FYI message id is message-level idempotency, not candidate identity:
  // the source key when available, otherwise a stable hash of the emitted
  // text so repeated deliveries of the same turn stay one message.
  const fyiId = sourceKey || createHash("sha256")
    .update(`${sessionId}\0${transcriptPath}\0${fullText}`)
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
      // Durable source identity (xtmux-gdk review P2/P1): the assistant
      // record's immutable provider id — never live size/text. Empty when the
      // source occurrence is not yet correlated: obs stores NULL and the row
      // is not replay-deduped (fail-open) rather than guessing an identity.
      `source_key=${sourceKey}`,
      `last_message=${compactSummary(fullText)}`,
      `last_message_file=${tmpFile}`,
    ];
    if (!skipEmission) spawnSync(PICKER, args, { encoding: "utf8", timeout: 2000 });
  } catch {
    // Fail-open: a capture miss never interrupts a Claude turn.
  } finally {
    if (tmpFile) { try { unlinkSync(tmpFile); } catch { /* consumed by obs */ } }
    if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* already removed */ } }
  }

  // Remember the emitted candidate so the next stop's fallback read never
  // re-reports it as new text. Only text-bearing candidates are recorded.
  if (fullText) {
    try {
      spawnSync("tmux", ["set-option", "-p", "-q", "@agent_last_candidate", compactSummary(fullText)], { encoding: "utf8", timeout: 1000 });
    } catch { /* best-effort */ }
    // Advance the monotonic capture anchor past this candidate. The transcript
    // is append-only, so every later source occurrence starts beyond this
    // offset; a same-text earlier record stays invisible to later scans.
    try {
      spawnSync("tmux", ["set-option", "-p", "-q", "@agent_capture_anchor", `${transcriptPath}|${capturedSize}`], { encoding: "utf8", timeout: 1000 });
    } catch { /* best-effort */ }
  }

  if (parent && parent !== sessionId && parent !== pane && fullText) {
    try {
      spawnSync(PICKER, [
        "message-send", "--from", sessionId || pane, "--to", parent, "--bead", bead,
        "--expects-reply=false", "--text", `turn done: ${compactSummary(fullText)}`,
        "--id", `claude-turn-${fyiId}`,
      ], { encoding: "utf8", timeout: 2000 });
    } catch {
      // Best-effort only.
    }
  }
}

main();
