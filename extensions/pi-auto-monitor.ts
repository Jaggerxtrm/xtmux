import type { ExtensionAPI, ExecResult } from "@earendil-works/pi-coding-agent";
import { coordinationResult } from "./coordination-json.ts";
import xtmuxInboxReply, { type SenderObligation } from "./pi-inbox-reply.ts";

const PICKER = process.env.XTMUX_PICKER || `${process.env.HOME}/.local/bin/xtmux`;
const TIMEOUT = process.env.XTMUX_AUTO_MONITOR_TIMEOUT || "8h";
const INTERVAL = process.env.XTMUX_AUTO_MONITOR_INTERVAL || "60s";
const TMUX = process.env.XTMUX_TMUX || "tmux";
const SKIP_TARGETS = new Set((process.env.XTMUX_AUTO_MONITOR_SKIP_TARGETS || "").split(":").filter(Boolean));
const MAX_MONITOR_ROWS = 500;

function requireSuccess(result: ExecResult, command: string): string {
  if (result.code !== 0) throw new Error(`${command} failed (exit ${result.code})`);
  return result.stdout;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 160);
}

async function targetExists(pi: ExtensionAPI, target: string): Promise<boolean> {
  try {
    return (await pi.exec(TMUX, ["has-session", "-t", target], { timeout: 2000 })).code !== 1;
  } catch {
    return true;
  }
}

async function monitorIdFor(pi: ExtensionAPI, target: string, requesterPaneId: string): Promise<string | null> {
  const output = requireSuccess(await pi.exec(PICKER, ["monitor-list", "--json"], { timeout: 2000 }), "monitor-list");
  const rows: unknown = JSON.parse(output);
  if (!Array.isArray(rows)) throw new Error("monitor-list returned incompatible JSON");
  for (const row of rows) {
    if (!row || typeof row !== "object") throw new Error("monitor-list returned incompatible JSON");
    const value = row as { monitorId?: unknown; target?: unknown; requesterPaneId?: unknown; terminalStatus?: unknown };
    if (typeof value.monitorId !== "string" || typeof value.target !== "string") throw new Error("monitor-list returned incompatible JSON");
    if (value.target === target && value.requesterPaneId === requesterPaneId && value.terminalStatus === null) return value.monitorId;
  }
  return null;
}

async function fireMonitor(pi: ExtensionAPI, target: string, requesterPaneId: string): Promise<string> {
  const output = requireSuccess(await pi.exec(
    PICKER,
    ["monitor-agent", target, "--json", "--wait-for-transition", "--timeout", TIMEOUT, "--interval", INTERVAL],
    { timeout: 5000 },
  ), "monitor-agent");
  const result: unknown = JSON.parse(output);
  if (!result || typeof result !== "object" || typeof (result as { monitorId?: unknown }).monitorId !== "string"
    || typeof (result as { waitId?: unknown }).waitId !== "string"
    || (result as { requesterPaneId?: unknown }).requesterPaneId !== requesterPaneId) {
    throw new Error("monitor-agent returned incompatible JSON");
  }
  return (result as { monitorId: string }).monitorId;
}

async function reconcileSenderMonitors(
  pi: ExtensionAPI,
  obligations: readonly SenderObligation[],
  maxOperations: number,
): Promise<number> {
  if (!process.env.TMUX_PANE || maxOperations <= 0) return 0;
  const output = requireSuccess(await pi.exec(PICKER, ["monitor-list", "--json"], { timeout: 2000 }), "monitor-list");
  const value: unknown = JSON.parse(output);
  if (!Array.isArray(value) || value.length > MAX_MONITOR_ROWS) throw new Error("monitor-list returned incompatible JSON");
  const armedTargets = new Set<string>();
  let used = 0;
  for (const obligation of obligations) {
    if (used >= maxOperations || obligation.senderPaneId !== process.env.TMUX_PANE) continue;
    const target = obligation.targetPaneId || obligation.recipientId;
    if (armedTargets.has(target)) continue;
    if (SKIP_TARGETS.has(target) || SKIP_TARGETS.has(obligation.recipientId)) continue;
    const covered = value.some((row) => {
      if (!row || typeof row !== "object") return false;
      const monitor = row as Record<string, unknown>;
      return monitor.requesterSessionId === obligation.senderId
        && monitor.requesterPaneId === obligation.senderPaneId
        && monitor.sessionId === obligation.recipientId
        && (obligation.targetPaneId === null || monitor.paneId === obligation.targetPaneId)
        && typeof monitor.startedAtMs === "number" && monitor.startedAtMs >= obligation.createdAtMs
        && (monitor.terminalStatus === null || monitor.wakeConsumed === true);
    });
    if (covered || !await targetExists(pi, target)) continue;
    await fireMonitor(pi, target, process.env.TMUX_PANE);
    armedTargets.add(target);
    used++;
  }
  return used;
}

export default function xtmuxAutoMonitor(pi: ExtensionAPI): void {
  const disabled = process.env.XTMUX_AUTO_MONITOR_DISABLE === "1";
  xtmuxInboxReply(pi, disabled ? undefined : (obligations, maxOperations) => reconcileSenderMonitors(pi, obligations, maxOperations));
  if (disabled) return;

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "bash" || event.isError) return undefined;
    try {
      const action = coordinationResult(event.content);
      if (!action || action.kind !== "message-send" || !action.expectsReply) return undefined;
      const target = action.target;
      if (!process.env.TMUX || !process.env.TMUX_PANE || SKIP_TARGETS.has(target)) return undefined;
      if (!await targetExists(pi, target)) return undefined;
      const existing = await monitorIdFor(pi, target, process.env.TMUX_PANE);
      const monitorId = existing || await fireMonitor(pi, target, process.env.TMUX_PANE);
      const note = `\n\n[auto-monitor] ${existing ? "tracking existing monitor" : "armed"} on ${target} (${TIMEOUT}, ${INTERVAL}) — waiting for its next work cycle. [${monitorId}]`;
      return { content: [...event.content, { type: "text", text: note }] };
    } catch (error) {
      const note = `\n\n[auto-monitor] unavailable: ${boundedError(error)}`;
      return { content: [...event.content, { type: "text", text: note }] };
    }
  });
}
