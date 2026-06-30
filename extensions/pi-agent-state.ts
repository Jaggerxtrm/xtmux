type AgentState = "running" | "needs-input" | "done" | "idle" | "off";
type PiEventName =
  | "session_start"
  | "before_agent_start"
  | "agent_start"
  | "message_update"
  | "tool_execution_start"
  | "agent_end"
  | "session_shutdown";

type SessionShutdownEvent = { reason?: string };
type ExtensionAPI = {
  on(event: "session_shutdown", handler: (event: SessionShutdownEvent) => unknown | Promise<unknown>): void;
  on(event: Exclude<PiEventName, "session_shutdown">, handler: () => unknown | Promise<unknown>): void;
  exec(command: string, args?: string[], options?: { timeout?: number; signal?: AbortSignal }): Promise<unknown>;
};

const SCRIPT = process.env.XTMUX_AGENT_STATE_SCRIPT ?? `${process.env.HOME}/.tmux/scripts/agent-state.sh`;

export default function xtmuxAgentState(pi: ExtensionAPI) {
  async function setState(state: AgentState) {
    try {
      // The script is intentionally best-effort: outside tmux it exits 0, and
      // dead panes are ignored. Keep a short timeout so hook latency is bounded.
      await pi.exec(SCRIPT, [state], { timeout: 1000 });
    } catch {
      // Never fail an agent turn because a tmux pane option could not be written.
    }
  }

  pi.on("session_start", async () => {
    await setState("idle");
  });

  pi.on("before_agent_start", async () => {
    await setState("running");
  });

  pi.on("agent_start", async () => {
    await setState("running");
  });

  pi.on("message_update", async () => {
    await setState("running");
  });

  pi.on("tool_execution_start", async () => {
    await setState("running");
  });

  pi.on("agent_end", async () => {
    await setState("done");
  });

  pi.on("session_shutdown", async (event) => {
    await setState(event.reason === "quit" ? "off" : "idle");
  });
}
