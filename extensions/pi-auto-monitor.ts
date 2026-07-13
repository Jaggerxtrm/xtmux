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
 *   XTMUX_PICKER                     (default /home/dawid/dev/xtmux/bin/tmux-session-picker)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import xtmuxInboxReply, { recordOutboundExpectation } from "./pi-inbox-reply.ts";

const PICKER =
  process.env.XTMUX_PICKER || "/home/dawid/dev/xtmux/bin/tmux-session-picker";
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

export function extractTarget(cmd: string): string | null {
  // message-send --to <target>
  let m = cmd.match(/message-send\b[^\n]*?(?:--to[= ]|--to\s+)['"]?([^\s'"]+)['"]?/);
  if (m) return m[1] ?? null;

  // safe-send-pointer [flags] <target> <pointer>
  m = cmd.match(/safe-send-pointer\s+((?:--\S+\s+)*)([^\s'"]+)\s+\S+/);
  if (m) return m[2] ?? null;

  // raw tmux send-keys -t <target>
  m = cmd.match(/tmux\s+send-keys\s+(?:-\S+\s+)*-t\s+['"]?([^\s'"]+)['"]?/);
  if (m) return m[1] ?? null;

  return null;
}

// xtmux-3xs.30: `tmux has-session -t <target>` precheck. Exit 1 = target
// missing → skip. Anything else (exit 0, subprocess error, timeout) falls
// through: better to spawn a monitor than silently drop a wake.
function targetExists(target: string): boolean {
  try {
    const r = spawnSync(TMUX, ["has-session", "-t", target], {
      stdio: "ignore",
      timeout: 2000,
    });
    return r.status !== 1;
  } catch {
    return true;
  }
}

function monitorIdFor(target: string): string | null {
  const r = spawnSync(PICKER, ["monitor-list"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (r.status !== 0) return null;
  const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
  for (const l of lines) {
    const parts = l.split("\t");
    if (parts.length >= 5 && parts[3] === target) return parts[1] ?? null;
  }
  return null;
}

function fireMonitor(target: string): string | null {
  const result = spawnSync(
    PICKER,
    ["monitor-agent", target, "--wait-for-transition", "--timeout", TIMEOUT, "--interval", INTERVAL],
    { encoding: "utf8", stdio: "pipe", timeout: 5000 },
  );
  if (result.status !== 0) return null;
  const fields = (result.stdout || "").trim().split("\t");
  return fields[0] === "monitor" ? fields[1] ?? null : null;
}

export default function xtmuxAutoMonitor(pi: ExtensionAPI): void {
  xtmuxInboxReply(pi);
  if (process.env.XTMUX_AUTO_MONITOR_DISABLE === "1") return;

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "bash" || event.isError) return undefined;

    const cmd = (event as unknown as { input?: { command?: string } }).input?.command ?? "";
    // Skip commands that already manage monitors — avoids double-arm loops.
    if (/monitor-(agent|list|kill)\b/.test(cmd)) return undefined;

    const target = extractTarget(cmd);
    if (!target) return undefined;
    // xtmux-3xs.29: synthetic smoke-test targets never wake anyone — skip.
    if (SKIP_TARGETS.has(target)) return undefined;
    // xtmux-3xs.30: also skip when tmux confirms the target doesn't exist.
    if (!targetExists(target)) return undefined;
    const existing = monitorIdFor(target);
    const monitorId = existing || fireMonitor(target);
    if (!monitorId) return undefined;
    if (process.env.TMUX && process.env.TMUX_PANE) recordOutboundExpectation(target, monitorId, process.env.TMUX_PANE);

    const note = `\n\n[auto-monitor] ${existing ? "tracking existing monitor" : "armed"} on ${target} (${TIMEOUT}, ${INTERVAL}) — waiting for its next work cycle.`;
    return { content: [...event.content, { type: "text", text: note }] };
  });
}
