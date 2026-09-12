import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type AgentState = "running" | "needs-input" | "done" | "idle" | "off";

const SCRIPT = process.env.XTMUX_AGENT_STATE_SCRIPT ?? `${process.env.HOME}/.tmux/scripts/agent-state.sh`;
const PICKER = process.env.XTMUX_PICKER ?? `${process.env.HOME}/.local/bin/tmux-session-picker`;
const MAX_LAST_MESSAGE = Number(process.env.XTMUX_PI_LAST_MESSAGE_MAX ?? "600");
const STATE_DEBOUNCE_MS = Number(process.env.XTMUX_PI_STATE_DEBOUNCE_MS ?? "5000");

function stdoutOf(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    for (const key of ["stdout", "out", "output"]) {
      const value = r[key];
      if (typeof value === "string") return value;
    }
  }
  return "";
}

function compactText(text: string, max = MAX_LAST_MESSAGE): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return "";
  return oneLine.length > max ? `${oneLine.slice(0, Math.max(0, max - 1))}…` : oneLine;
}

function extractText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
  if (typeof value === "object") {
    const r = value as Record<string, unknown>;
    if (typeof r.text === "string") return r.text;
    if (typeof r.content === "string") return r.content;
    if (Array.isArray(r.content)) return extractText(r.content);
    if (typeof r.message === "string") return r.message;
    if (r.message) return extractText(r.message);
  }
  return "";
}

/**
 * Last assistant text, read from the session at settle time (xtmux-cq2.1).
 *
 * The previous shape read it from agent_end's event.messages. agent_end is the
 * wrong terminal event (pi may still auto-retry, auto-compact and retry, or run
 * queued follow-ups) and keeping a handler on it — or on turn_end/message_update —
 * put a subprocess on the hot path. Reading the settled session instead keeps the
 * transcript write on agent_settled alone.
 *
 * Entry shapes vary by pi version, so this accepts `entry.message`, `entry.msg`,
 * or a message-shaped entry, and skips non-assistant roles.
 */
export function lastAssistantTextFromEntries(entries: unknown[] | undefined): string {
  if (!entries) return "";
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (typeof entry === "string") {
      if (entry) return entry;
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const message = (record.message ?? record.msg ?? record) as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") continue;
    const role = typeof message.role === "string" ? message.role : "";
    if (role && role !== "assistant") continue;
    const text = extractText(message.content ?? message.message ?? message.text);
    if (text) return text;
  }
  return "";
}

export default function xtmuxAgentState(pi: ExtensionAPI) {
  let lastState: AgentState | undefined;
  let lastStateAt = 0;
  let stateBeforePrompt: AgentState | undefined;

  // State events are the settled set only (xtmux-cq2.1):
  //   session_start      -> idle (new instance)
  //   agent_start        -> running
  //   ui_prompt_start    -> needs-input
  //   ui_prompt_end      -> the state the prompt interrupted
  //   agent_settled      -> done
  //   session_shutdown   -> off (quit) | idle
  //
  // Anything derived from a per-tool, per-turn, or per-streamed-chunk event is
  // deliberately absent: pi awaits extension handlers, and every handler here
  // awaits a subprocess, so hot-path registration is agent-execution latency.
  // "Not settled" is exactly what `running` means — pi documents agent_settled
  // as the event for status integrations that must know pi will not continue on
  // its own.
  async function setState(state: AgentState, newInstance = false) {
    const now = Date.now();
    // A new occupation must always reach the script: debouncing it away would
    // leave the pane wearing the previous agent's instance id.
    if (!newInstance && state === lastState && now - lastStateAt < STATE_DEBOUNCE_MS) return;
    lastState = state;
    lastStateAt = now;

    const args = newInstance ? [state, "--new-instance"] : [state];
    try {
      // The script is intentionally best-effort: outside tmux it exits 0, and
      // dead panes are ignored. Keep a short timeout so hook latency is bounded.
      await pi.exec(SCRIPT, args, { timeout: 1000 });
    } catch {
      // Never fail an agent turn because a tmux pane option could not be written.
    }
  }

  async function tmuxValue(args: string[]): Promise<string> {
    try {
      return stdoutOf(await pi.exec("tmux", args, { timeout: 1000 })).trim();
    } catch {
      return "";
    }
  }

  async function publishTurnDone(ctx: ExtensionContext) {
    // Without the client socket, tmux may return a bystander pane from its
    // default server. Agent turn/message writes need a real invocation context.
    if (!process.env.TMUX) return;
    // One tmux read, not five (xtmux-cq2.1): display-message resolves pane,
    // session and user options from a single format string, and this whole
    // handler is awaited by pi on the settle path.
    const info = await tmuxValue([
      "display-message",
      "-p",
      "#{pane_id}\t#{session_id}\t#S\t#{@agent_bead}\t#{@agent_parent_session}",
    ]);
    if (!info) return;
    // Defaults are load-bearing: tmuxValue trims, and trailing tabs ARE trailing
    // whitespace, so an unset @agent_bead/@agent_parent_session drops those fields
    // entirely and the destructured tail is undefined — which stringifies into
    // "bead=undefined" in the emitted row. Absent tail fields mean empty values.
    const [pane, sessionId, sessionName, bead = "", parent = ""] = info.split("\t");
    if (!pane) return;
    // xtmux-avz: spill the UNCOMPACTED message to a temp file so the picker can
    // store the full text. A single argv field is capped at ~128KB by the kernel
    // (MAX_ARG_STRLEN), well under a real turn, so the path is the transport.
    // obs reads + unlinks; this finally unlinks the no-op case. The byte cap lives
    // on the obs reader side as the single chokepoint.
    let entries: unknown[] | undefined;
    try {
      entries = ctx.sessionManager?.getEntries?.();
    } catch {
      entries = undefined;
    }
    const fullText = lastAssistantTextFromEntries(entries);
    const text = compactText(fullText);
    let lastMessageDir = "";
    let lastMessageFile = "";
    if (fullText) {
      try {
        lastMessageDir = mkdtempSync(join(tmpdir(), "xtmux-last-msg-"));
        lastMessageFile = join(lastMessageDir, "message.txt");
        writeFileSync(lastMessageFile, fullText, { encoding: "utf8", mode: 0o600 });
      } catch {
        lastMessageDir = "";
        lastMessageFile = "";
      }
    }

    try {
      await pi.exec(PICKER, [
        "log",
        "emit",
        "agent.turn.done",
        `pane=${pane}`,
        `session=${sessionId}`,
        `session_name=${sessionName}`,
        `bead=${bead}`,
        `parent=${parent}`,
        // xtmux-gdk: one settled run = one response episode.
        `episode_open=1`,
        `last_message=${text}`,
        ...(lastMessageFile ? [`last_message_file=${lastMessageFile}`] : []),
      ], { timeout: 1500 });
    } catch {
      // Best-effort only.
    } finally {
      // obs consumes + unlinks on success; this covers the no-op / failure path
      // so a temp file never outlives the emit attempt.
      if (lastMessageFile) { try { unlinkSync(lastMessageFile); } catch { /* already consumed */ } }
      if (lastMessageDir) { try { rmSync(lastMessageDir, { recursive: true, force: true }); } catch { /* already removed */ } }
    }

    // xtmux-cq2.1: the pi->parent message-send is gone with the deprecated
    // messaging surface. A settled run publishes its turn to obs and stops there.
  }

  pi.on("session_start", async () => {
    // One new agent instance per pi session — not per idle transition.
    await setState("idle", true);
  });

  pi.on("agent_start", async () => {
    await setState("running");
  });

  // pi coalesces nested user-facing prompts into one waiting span and does not
  // await these handlers, so reporting "waiting for user" costs no agent time.
  pi.on("ui_prompt_start", async () => {
    stateBeforePrompt = lastState && lastState !== "needs-input" ? lastState : "running";
    await setState("needs-input");
  });

  pi.on("ui_prompt_end", async () => {
    await setState(stateBeforePrompt ?? "running");
    stateBeforePrompt = undefined;
  });

  // The terminal transition. Deliberately NOT agent_end: pi may auto-retry,
  // auto-compact and retry, or continue with queued follow-ups after agent_end,
  // so a pane marked done there reports done while pi is still working.
  pi.on("agent_settled", async (_event, ctx) => {
    await setState("done");
    await publishTurnDone(ctx);
  });

  pi.on("session_shutdown", async (event) => {
    await setState(event.reason === "quit" ? "off" : "idle");
  });
}
