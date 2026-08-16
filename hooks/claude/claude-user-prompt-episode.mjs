#!/usr/bin/env node
// claude-user-prompt-episode — Claude Code UserPromptSubmit hook (xtmux-gdk).
//
// A real user prompt opens a fresh response episode: emit `log emit
// agent.episode.open` so the obs closes the pane's previous episode, and arm
// the per-pane flags the Stop hook consumes:
//   @agent_episode_pending = 1  — this prompt already opened an episode, so the
//                                 next non-continuation Stop attaches to it
//   @agent_episode_cursor  = N  — settled transcript byte offset when the
//                                 prompt arrived; the Stop hook's fallback read
//                                 correlates only source produced after it
//
// Never blocks: exit 0 always. The prompt itself is not this hook's business —
// UserPromptSubmit exit 2 would erase the user's prompt, so this hook only
// observes and records.

import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

const PICKER = process.env.XTMUX_PICKER || `${process.env.HOME}/.local/bin/xtmux`;
// The transcript writer flushes asynchronously, so the cursor is the SETTLED
// size: poll until the size is stable across a poll gap, bounded below.
const SETTLE_MS = 500;
const POLL_MS = 25;
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function readJsonStdin() {
  try { return JSON.parse(readFileSync(0, "utf8")); } catch { return null; }
}

function tmuxValue(args, target) {
  try {
    const scoped = target ? [args[0], ...args.slice(1, 2), "-t", target, ...args.slice(2)] : args;
    return String(spawnSync("tmux", scoped, { encoding: "utf8", timeout: 1000 }).stdout ?? "").trim();
  } catch { return ""; }
}

// Byte offset of the transcript when the prompt landed, once the async writer
// has caught up. Missing transcript → 0 (the Stop hook then scans the full
// tail, i.e. the pre-episode fallback behavior).
function settledSize(transcriptPath) {
  const deadline = Date.now() + SETTLE_MS;
  let prev = -1;
  while (Date.now() < deadline) {
    let size = 0;
    try { size = statSync(transcriptPath).size; } catch { /* not flushed yet */ }
    if (size === prev) return size;
    prev = size;
    Atomics.wait(SLEEP_BUF, 0, 0, POLL_MS);
  }
  return prev;
}

function main() {
  const input = readJsonStdin();
  if (!input) return;
  // Same guard as the Stop hook: without the client socket tmux resolves a
  // bystander pane, so episode state must not be written to it.
  if (!process.env.TMUX || !process.env.TMUX_PANE) return;
  const pane = process.env.TMUX_PANE;
  const transcriptPath = input.transcript_path ?? input.transcriptPath;
  const cursor = transcriptPath ? settledSize(transcriptPath) : 0;

  const sessionId = tmuxValue(["display-message", "-p", "#{session_id}"], pane);
  const sessionName = tmuxValue(["display-message", "-p", "#S"], pane);
  const bead = tmuxValue(["show-options", "-p", "-qv", "@agent_bead"], pane);
  const parent = tmuxValue(["show-options", "-p", "-qv", "@agent_parent_session"], pane);

  // Arm the Stop hook first: even if the emit below fails, the next stop
  // attaches (and the obs lazy-opens), keeping one episode per prompt.
  try {
    spawnSync("tmux", ["set-option", "-p", "-q", "@agent_episode_pending", "1"], { encoding: "utf8", timeout: 1000 });
    spawnSync("tmux", ["set-option", "-p", "-q", "@agent_episode_cursor", String(cursor)], { encoding: "utf8", timeout: 1000 });
  } catch { /* best-effort: Stop hook falls back to episode_open=1 */ }

  try {
    spawnSync(PICKER, [
      "log", "emit", "agent.episode.open",
      `pane=${pane}`,
      `session=${sessionId}`,
      `session_name=${sessionName}`,
      `bead=${bead}`,
      `parent=${parent}`,
      `cursor=${cursor}`,
    ], { encoding: "utf8", timeout: 2000 });
  } catch {
    // Fail-open: an episode-open miss never interrupts a user prompt.
  }
}

main();
