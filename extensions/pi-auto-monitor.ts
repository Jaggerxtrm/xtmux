/**
 * pi extension: auto-monitor-on-send
 *
 * After the bash tool executes a `message-send` or `safe-send-pointer`
 * command against a tmux target, automatically register a monitor on that
 * target so its next work cycle is captured by the durable monitor registry.
 *
 * Idempotent: if a monitor is already active for the target, no-op.
 * Silent by default; the tool_result gets an appended note so the agent
 * knows a monitor was armed.
 *
 * Motivation: xtmux:1.2 (pi) and xtmux:1.1 (Claude) coordinate via
 * xtmux message-send + safe-send-pointer. Neither reliably fires a
 * monitor after send — so replies are missed until the operator prods.
 * This extension enforces monitor arming structurally.
 *
 * Env overrides:
 *   XTMUX_AUTO_MONITOR_TIMEOUT       (default 8h)
 *   XTMUX_AUTO_MONITOR_INTERVAL      (default 60s)
 *   XTMUX_AUTO_MONITOR_DISABLE=1     (bypass entirely)
 *   XTMUX_AUTO_MONITOR_SKIP_TARGETS  (colon-separated; skip these targets. xtmux-3xs.29)
 *   XTMUX_PICKER                     (default $HOME/.local/bin/xtmux)
 */
import type { ExtensionAPI, ExecResult } from "@earendil-works/pi-coding-agent";
import { coordinationResult } from "./coordination-json.ts";
import xtmuxInboxReply, { recordOutboundExpectation } from "./pi-inbox-reply.ts";

const PICKER =
  process.env.XTMUX_PICKER || `${process.env.HOME}/.local/bin/xtmux`;
const TIMEOUT = process.env.XTMUX_AUTO_MONITOR_TIMEOUT || "8h";
const INTERVAL = process.env.XTMUX_AUTO_MONITOR_INTERVAL || "60s";
const TMUX = process.env.XTMUX_TMUX || "tmux";
// xtmux-3xs.29: colon-separated list of targets to skip entirely (no monitor
// spawn). Same shape as PATH. Set in smoke-test env so synthetic recipients
// (alice, dst, smoke:1.99, ...) don't spawn useless monitor-agent daemons.
const SKIP_TARGETS = new Set(
  (process.env.XTMUX_AUTO_MONITOR_SKIP_TARGETS || "")
    .split(":")
    .filter((s) => s.length > 0),
);

function requireSuccess(result: ExecResult, command: string): string {
  if (result.code !== 0) throw new Error(`${command} failed with exit code ${result.code}: ${result.stderr.trim()}`);
  return result.stdout;
}

// xtmux-3xs.30: `tmux has-session -t <target>` precheck. Exit 1 = target
// missing → skip. Anything else (exit 0, subprocess error, timeout) falls
// through: better to spawn a monitor than silently drop a wake.
async function targetExists(pi: ExtensionAPI, target: string): Promise<boolean> {
  try {
    return (await pi.exec(TMUX, ["has-session", "-t", target], { timeout: 2000 })).code !== 1;
  } catch {
    return true;
  }
}

async function monitorIdFor(pi: ExtensionAPI, target: string): Promise<string | null> {
  const output = requireSuccess(await pi.exec(PICKER, ["monitor-list", "--json"], { timeout: 2000 }), "monitor-list");
  const rows: unknown = JSON.parse(output);
  if (!Array.isArray(rows)) throw new Error("Incompatible xtmux monitor-list JSON result");
  for (const row of rows) {
    if (!row || typeof row !== "object") throw new Error("Incompatible xtmux monitor-list JSON row");
    const value = row as { monitorId?: unknown; target?: unknown };
    if (typeof value.monitorId !== "string" || typeof value.target !== "string") throw new Error("Incompatible xtmux monitor-list JSON row");
    if (value.target === target) return value.monitorId;
  }
  return null;
}

async function fireMonitor(pi: ExtensionAPI, target: string): Promise<string> {
  const output = requireSuccess(await pi.exec(
    PICKER,
    ["monitor-agent", target, "--json", "--wait-for-transition", "--timeout", TIMEOUT, "--interval", INTERVAL],
    { timeout: 5000 },
  ), "monitor-agent");
  const result: unknown = JSON.parse(output);
  if (!result || typeof result !== "object" || typeof (result as { monitorId?: unknown }).monitorId !== "string") {
    throw new Error("Incompatible xtmux monitor-agent JSON result");
  }
  return (result as { monitorId: string }).monitorId;
}

export default function xtmuxAutoMonitor(pi: ExtensionAPI): void {
  xtmuxInboxReply(pi);
  if (process.env.XTMUX_AUTO_MONITOR_DISABLE === "1") return;

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "bash" || event.isError) return undefined;

    const action = coordinationResult(event.content);
    if (!action || action.kind === "message-ack") return undefined;
    const target = action.target;
    // xtmux-3xs.29: synthetic smoke-test targets never wake anyone — skip.
    if (SKIP_TARGETS.has(target)) return undefined;
    // xtmux-3xs.30: also skip when tmux confirms the target doesn't exist.
    if (!await targetExists(pi, target)) return undefined;
    const existing = await monitorIdFor(pi, target);
    const monitorId = existing || await fireMonitor(pi, target);
    if (process.env.TMUX && process.env.TMUX_PANE) recordOutboundExpectation(target, monitorId, process.env.TMUX_PANE);

    const note = `\n\n[auto-monitor] ${existing ? "tracking existing monitor" : "armed"} on ${target} (${TIMEOUT}, ${INTERVAL}) — waiting for its next work cycle.`;
    return { content: [...event.content, { type: "text", text: note }] };
  });
}
