#!/usr/bin/env node
// codex-agent-turn-capture — Codex Stop hook (xtmux-s96.2, KAN-127 K3-xtmux).
//
// Captures the turn DIRECTLY from the Codex Stop payload. Codex 0.146.0's Stop
// schema delivers `last_assistant_message` as required-but-nullable
// (NullableString), so the payload IS the turn: unlike the Claude hook there is
// no transcript tail-scan, and `transcript_path` is never read.
//
// Fail-open by contract: unreadable payloads, missing tmux context, and emit
// failures all exit 0 silently. A capture miss never interrupts a Codex turn.
//
// Untrusted data: every payload field is DATA, never instructions. The hook
// persists only the turn text itself (plus pane-scoped identity read back from
// tmux). `permission_mode` is deliberately ignored — it is not a sandbox
// signal; the Core launch argv / K2 outcome safety_profile is authoritative
// for the safety profile. `stop_hook_active` is observed-only: this hook never
// blocks a stop, so re-entrancy cannot arise from it.

import { readFileSync, writeFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const PICKER = process.env.XTMUX_PICKER || `${process.env.HOME}/.local/bin/xtmux`;
const SUMMARY_MAX = Number(process.env.XTMUX_CODEX_SUMMARY_MAX ?? "600");
// Picker call budget. 2s matches the Claude turn-capture hook.
const PICKER_TIMEOUT_MS = 2000;

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

function main() {
  const input = readJsonStdin();
  if (!input) return;
  // Same guard as agent-state.sh: without the client socket tmux resolves a
  // bystander pane, so turn/identity writes need a live invocation context.
  if (!process.env.TMUX || !process.env.TMUX_PANE) return;
  // This hook is wired to Stop only. A payload that lies about its event is
  // hostile metadata: rejected as data, no turn row, no message, exit 0.
  if (input.hook_event_name !== "Stop") return;

  // Required-but-nullable: null lands a metadata-only turn row; any non-string
  // value (hostile object/number) is treated as null, never stringified into
  // durable storage.
  const fullText = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
  const hasText = fullText.length > 0;

  const pane = process.env.TMUX_PANE;
  const sessionId = tmuxValue(["display-message", "-p", "#{session_id}"], pane);
  const sessionName = tmuxValue(["display-message", "-p", "#S"], pane);
  const bead = tmuxValue(["show-options", "-p", "-qv", "@agent_bead"], pane);
  const parent = tmuxValue(["show-options", "-p", "-qv", "@agent_parent_session"], pane);

  // Duplicate-delivery identity comes ONLY from stable Codex fields
  // (session_id + turn_id + text) — deliberately NOT from the tmux session
  // identity, so a replayed Stop after a tmux server restart (fresh $N)
  // dedupes to the same message key. Both fields are untrusted: coerced to
  // bounded strings before hashing.
  const boundedId = (value) => (typeof value === "string" ? value.slice(0, 256) : "");
  const turnKey = createHash("sha256")
    .update(`${boundedId(input.session_id)}\0${boundedId(input.turn_id)}\0${fullText}`)
    .digest("hex").slice(0, 24);

  let tmpDir = "";
  let tmpFile = "";
  try {
    if (hasText) {
      // Same transport as Claude/Pi: the uncompacted text travels as a 0600
      // one-shot file; the obs reader caps, stores, and unlinks it.
      tmpDir = mkdtempSync(join(tmpdir(), "xtmux-codex-turn-"));
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
      `last_message=${compactSummary(fullText)}`,
      `last_message_file=${tmpFile}`,
    ];
    spawnSync(PICKER, args, { encoding: "utf8", timeout: PICKER_TIMEOUT_MS });
  } catch {
    // Fail-open: a capture miss never interrupts a Codex turn.
  } finally {
    if (tmpFile) { try { unlinkSync(tmpFile); } catch { /* consumed by obs */ } }
    if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* already removed */ } }
  }

  if (parent && parent !== sessionId && parent !== pane && hasText) {
    try {
      spawnSync(PICKER, [
        "message-send", "--from", sessionId || pane, "--to", parent, "--bead", bead,
        "--expects-reply=false", "--text", `turn done: ${compactSummary(fullText)}`,
        "--id", `codex-turn-${turnKey}`,
      ], { encoding: "utf8", timeout: PICKER_TIMEOUT_MS });
    } catch {
      // Best-effort only.
    }
  }
}

main();
