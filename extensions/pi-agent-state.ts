import type { AgentEndEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

function lastAssistantTextFromMessages(messages: unknown[] | undefined): string {
  if (!messages) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg && typeof msg === "object") {
      const r = msg as Record<string, unknown>;
      const role = typeof r.role === "string" ? r.role : "";
      if (role && role !== "assistant") continue;
      const text = extractText(r.content ?? r.message ?? r.text);
      if (text) return text;
    } else if (typeof msg === "string") {
      return msg;
    }
  }
  return "";
}

export default function xtmuxAgentState(pi: ExtensionAPI) {
  let lastTurnMessage = "";
  let lastState: AgentState | undefined;
  let lastStateAt = 0;

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

  async function publishTurnDone(event: AgentEndEvent) {
    // Without the client socket, tmux may return a bystander pane from its
    // default server. Agent turn/message writes need a real invocation context.
    if (!process.env.TMUX) return;
    const pane = await tmuxValue(["display-message", "-p", "#{pane_id}"]);
    if (!pane) return;
    // Use #{session_id} (stable, per-instance, never recycled) rather than #S
    // (mutable session name reused across attaches). See xtmux-7ob.
    const sessionId = await tmuxValue(["display-message", "-p", "#{session_id}"]);
    const sessionName = await tmuxValue(["display-message", "-p", "#S"]);
    const bead = await tmuxValue(["show-options", "-p", "-qv", "@agent_bead"]);
    const parent = await tmuxValue(["show-options", "-p", "-qv", "@agent_parent_session"]);
    const text = compactText(lastAssistantTextFromMessages(event.messages) || lastTurnMessage);

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
        `last_message=${text}`,
      ], { timeout: 1500 });
    } catch {
      // Best-effort only.
    }

    if (parent && text) {
      try {
        await pi.exec(PICKER, [
          "message-send",
          "--from", sessionId || pane,
          "--to", parent,
          "--bead", bead,
          "--expects-reply", "false",
          "--text", `turn done: ${text}`,
        ], { timeout: 1500 });
      } catch {
        // Best-effort only.
      }
    }
  }

  pi.on("session_start", async () => {
    // One new agent instance per pi session — not per idle transition.
    await setState("idle", true);
  });

  pi.on("before_agent_start", async () => {
    await setState("running");
  });

  pi.on("agent_start", async () => {
    lastTurnMessage = "";
    await setState("running");
  });

  pi.on("tool_execution_start", async () => {
    await setState("running");
  });

  pi.on("turn_start", async () => {
    await setState("running");
  });

  pi.on("turn_end", async (event) => {
    const text = compactText(extractText(event.message));
    if (text) lastTurnMessage = text;
  });

  pi.on("agent_end", async (event) => {
    await setState("done");
    await publishTurnDone(event);
  });

  pi.on("session_shutdown", async (event) => {
    await setState(event.reason === "quit" ? "off" : "idle");
  });
}
