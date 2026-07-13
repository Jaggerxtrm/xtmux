import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PICKER = process.env.XTMUX_PICKER || "/home/dawid/dev/xtmux/bin/tmux-session-picker";
const WIDGET = "xtmux-inbox";

type ExecResult = { stdout?: string } | string;
type ExtensionContext = {
  hasUI: boolean;
  ui: {
    setWidget?: (key: string, lines: string[] | undefined, options?: { placement?: "belowEditor" }) => void;
    notify(message: string, type?: "warning"): void;
  };
};
type ToolResultEvent = { toolName: string; input: Record<string, unknown>; isError: boolean };
type ExtensionAPI = {
  exec(command: string, args: string[], options?: { timeout?: number }): Promise<ExecResult>;
  on(event: "session_start" | "agent_start" | "agent_end" | "session_shutdown", handler: (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>): void;
  on(event: "tool_result", handler: (event: ToolResultEvent, ctx: ExtensionContext) => unknown | Promise<unknown>): void;
};

interface Obligation {
  senderId: string;
  messageKey: string;
  beadId: string;
  summary: string;
  acceptedAtMs: number;
}

interface MessageStatus {
  senderId: string;
  messageKey: string;
  recipientId: string;
  beadId: string | null;
  summary: string;
  acked: boolean;
}

function stateDir(): string {
  return join(process.env.XDG_RUNTIME_DIR || "/tmp", "xtmux-reply-obligations");
}

function ttlMs(): number {
  const value = Number(process.env.XTMUX_REPLY_OBLIGATION_TTL_MS || 3_600_000);
  return Number.isFinite(value) && value >= 0 ? value : 3_600_000;
}

function markerPath(senderId: string): string {
  const safe = senderId.replace(/[^A-Za-z0-9._:%$-]/g, "_");
  return join(stateDir(), `reply-to-${safe}_pending`);
}

export function readObligations(now = Date.now()): Obligation[] {
  const dir = stateDir();
  if (!existsSync(dir)) return [];
  const obligations: Obligation[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("reply-to-") || !name.endsWith("_pending")) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > ttlMs()) {
        rmSync(path, { force: true });
        continue;
      }
      const value = JSON.parse(readFileSync(path, "utf8")) as Obligation;
      if (!value.senderId || !value.messageKey || !value.beadId) throw new Error("invalid marker");
      obligations.push(value);
    } catch {
      rmSync(path, { force: true });
    }
  }
  return obligations.sort((a, b) => a.senderId.localeCompare(b.senderId));
}

function recordObligation(status: MessageStatus): void {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  const path = markerPath(status.senderId);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify({
    senderId: status.senderId,
    messageKey: status.messageKey,
    beadId: status.beadId,
    summary: status.summary.replace(/\s+/g, " ").trim().slice(0, 240),
    acceptedAtMs: Date.now(),
  }));
  renameSync(tmp, path);
}

function clearObligation(senderId: string): void {
  rmSync(markerPath(senderId), { force: true });
}

function commandMatch(command: string, subcommand: string): RegExpMatchArray | null {
  return command.match(new RegExp(`(?:^|(?:&&|\\|\\||;|\\n)\\s*)(?:(?:[^\\s;&|]*/)?tmux-session-picker\\s+)?${subcommand}\\b([^;&|\\n]*)`));
}

export function commandAction(command: string): { ackKey?: string; sendTarget?: string; relevant: boolean } {
  const ack = commandMatch(command, "message-ack");
  const send = commandMatch(command, "message-send");
  const list = commandMatch(command, "message-list");
  const ackKey = ack?.[1]?.trim().match(/^['"]?([^\s'"]+)/)?.[1];
  const sendTarget = send?.[1]?.match(/--to(?:=|\s+)['"]?([^\s'";]+)/)?.[1];
  return { ...(ackKey ? { ackKey } : {}), ...(sendTarget ? { sendTarget } : {}), relevant: Boolean(ack || send || list) };
}

function stdoutOf(value: unknown): string {
  if (!value || typeof value !== "object") return typeof value === "string" ? value : "";
  const result = value as { stdout?: unknown };
  return typeof result.stdout === "string" ? result.stdout : "";
}

function setWidget(ctx: ExtensionContext, lines: string[] | undefined): void {
  ctx.ui.setWidget?.(WIDGET, lines, { placement: "belowEditor" });
}

export default function xtmuxInboxReply(pi: ExtensionAPI): void {
  let ownPaneId = "";

  async function sessionId(): Promise<string> {
    if (!process.env.TMUX) return "";
    try {
      return stdoutOf(await pi.exec("tmux", ["display-message", "-p", "#{session_id}"], { timeout: 1000 })).trim();
    } catch {
      return "";
    }
  }

  async function canonicalTarget(target: string): Promise<string> {
    if (!process.env.TMUX) return target;
    try {
      return stdoutOf(await pi.exec("tmux", ["display-message", "-t", target, "-p", "#{session_id}"], { timeout: 1000 })).trim() || target;
    } catch {
      return target;
    }
  }

  async function status(key: string): Promise<MessageStatus | null> {
    try {
      const result = await pi.exec(PICKER, ["message-status", key], { timeout: 1500 });
      return JSON.parse(stdoutOf(result)) as MessageStatus;
    } catch {
      return null;
    }
  }

  async function render(ctx: ExtensionContext): Promise<Obligation[]> {
    const obligations = readObligations();
    const id = await sessionId();
    if (!id) {
      setWidget(ctx, undefined);
      return obligations;
    }
    let unread = 0;
    try {
      const args = ["unread-count", "--for", id];
      if (ownPaneId) args.push("--pane", ownPaneId);
      const result = await pi.exec(PICKER, args, { timeout: 1500 });
      unread = Number((JSON.parse(stdoutOf(result)) as { unreadCount?: unknown }).unreadCount) || 0;
    } catch {
      const reminderLines = obligations.map((item) => `Reply required: ${item.senderId} (${item.beadId})`);
      setWidget(ctx, reminderLines.length ? reminderLines : undefined);
      return obligations;
    }
    const lines = [
      ...(unread > 0 ? [`Inbox: ${unread} unread`] : []),
      ...obligations.map((item) => `Reply required: ${item.senderId} (${item.beadId})`),
    ];
    setWidget(ctx, lines.length ? lines : undefined);
    return obligations;
  }

  const refresh = async (_event: unknown, ctx: ExtensionContext) => { await render(ctx); };
  pi.on("session_start", async (_event, ctx) => {
    ownPaneId = "";
    if (process.env.TMUX) {
      try {
        ownPaneId = stdoutOf(await pi.exec("tmux", ["display-message", "-p", "#{pane_id}"], { timeout: 1000 })).trim();
      } catch {
        // Session-wide count is the safe fallback when pane identity is unavailable.
      }
    }
    await render(ctx);
  });
  pi.on("agent_start", refresh);

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash" || typeof event.input.command !== "string") return;
    const action = commandAction(event.input.command);
    if (!action.relevant) return;
    if (!event.isError) {
      if (action.ackKey) {
        const [message, me] = await Promise.all([status(action.ackKey), sessionId()]);
        if (message?.acked && message.beadId && message.recipientId === me) recordObligation(message);
      }
      if (action.sendTarget) clearObligation(await canonicalTarget(action.sendTarget));
    }
    await render(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const obligations = await render(ctx);
    if (obligations.length && ctx.hasUI) {
      ctx.ui.notify(`Reply required: ${obligations.map((item) => `${item.senderId} (${item.beadId})`).join(", ")}`, "warning");
    }
  });

  pi.on("session_shutdown", (_event, ctx) => setWidget(ctx, undefined));
}
