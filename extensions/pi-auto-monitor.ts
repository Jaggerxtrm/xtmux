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
 *   XTMUX_AUTO_MONITOR_TIMEOUT  (default 8h)
 *   XTMUX_AUTO_MONITOR_INTERVAL (default 60s)
 *   XTMUX_AUTO_MONITOR_DISABLE=1 (bypass)
 *   XTMUX_PICKER                (default /home/dawid/dev/xtmux/bin/tmux-session-picker)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isBashToolResult } from "@earendil-works/pi-coding-agent";
import { spawn, spawnSync } from "node:child_process";

const PICKER =
  process.env.XTMUX_PICKER || "/home/dawid/dev/xtmux/bin/tmux-session-picker";
const TIMEOUT = process.env.XTMUX_AUTO_MONITOR_TIMEOUT || "8h";
const INTERVAL = process.env.XTMUX_AUTO_MONITOR_INTERVAL || "60s";

function extractTarget(cmd: string): string | null {
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

function alreadyMonitored(target: string): boolean {
  const r = spawnSync(PICKER, ["monitor-list"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (r.status !== 0) return false;
  const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
  for (const l of lines) {
    const parts = l.split("\t");
    if (parts.length >= 5 && parts[3] === target) return true;
  }
  return false;
}

function fireMonitor(target: string): void {
  const child = spawn(
    PICKER,
    ["monitor-agent", target, "--wait-for-transition", "--timeout", TIMEOUT, "--interval", INTERVAL],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

export default function xtmuxAutoMonitor(pi: ExtensionAPI): void {
  if (process.env.XTMUX_AUTO_MONITOR_DISABLE === "1") return;

  pi.on("tool_result", async (event) => {
    if (!isBashToolResult(event)) return undefined;
    if (event.isError) return undefined;

    const cmd = (event as unknown as { input?: { command?: string } }).input?.command ?? "";
    // Skip commands that already manage monitors — avoids double-arm loops.
    if (/monitor-(agent|list|kill)\b/.test(cmd)) return undefined;

    const target = extractTarget(cmd);
    if (!target) return undefined;
    if (alreadyMonitored(target)) return undefined;

    fireMonitor(target);

    const note = `\n\n[auto-monitor] armed on ${target} (${TIMEOUT}, ${INTERVAL}) — waiting for its next work cycle.`;
    return { content: [...event.content, { type: "text", text: note }] };
  });
}
