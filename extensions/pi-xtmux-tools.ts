import type { ExecResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";

const PICKER = process.env.XTMUX_PICKER || "xtmux";
const MAX_OUTPUT_BYTES = 50 * 1024;

export type XtmuxToolDetails = { exitCode: 0; result: unknown };

export class XtmuxCliError extends Error {
  constructor(
    readonly exitCode: number,
    readonly payload: unknown,
  ) {
    super(`xtmux exited ${exitCode}: ${errorMessage(payload)}`);
    this.name = "XtmuxCliError";
  }
}

function errorMessage(value: unknown): string {
  if (value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string") {
    return (value as { message: string }).message;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function decode(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Malformed ${label} JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function runXtmuxJson(
  pi: Pick<ExtensionAPI, "exec">,
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; value: unknown }> {
  const result: ExecResult = await pi.exec(PICKER, [...args, "--json"], signal ? { signal } : {});
  if (result.code !== 0) throw new XtmuxCliError(result.code, decode(result.stderr.trim() || "{}", "xtmux error"));
  const stdout = result.stdout.trim();
  if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) throw new Error(`xtmux JSON exceeds ${MAX_OUTPUT_BYTES} bytes`);
  return { stdout, value: decode(stdout, "xtmux result") };
}

function objectWith(fields: string[]) {
  return (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value) || fields.some((field) => !(field in value))) {
      throw new Error(`Incompatible xtmux JSON result; expected fields: ${fields.join(", ")}`);
    }
  };
}

function arrayOf(fields: string[]) {
  const check = objectWith(fields);
  return (value: unknown): void => {
    if (!Array.isArray(value)) throw new Error("Incompatible xtmux JSON result; expected array");
    value.forEach(check);
  };
}

function flag(args: string[], name: string, value: string | number | boolean | undefined): void {
  if (value === undefined) return;
  args.push(name, String(value));
}

function toggle(args: string[], name: string, value: boolean | undefined): void {
  if (value) args.push(name);
}

type NativeTool<T extends TSchema> = Omit<ToolDefinition<T, XtmuxToolDetails>, "execute"> & {
  argv(params: Static<T>): string[];
  validate(value: unknown): void;
};

function register<T extends TSchema>(pi: ExtensionAPI, tool: NativeTool<T>): void {
  const { argv, validate, ...definition } = tool;
  pi.registerTool<T, XtmuxToolDetails>({
    ...definition,
    async execute(_toolCallId, params, signal) {
      const result = await runXtmuxJson(pi, argv(params), signal);
      validate(result.value);
      return {
        content: [{ type: "text", text: result.stdout }],
        details: { exitCode: 0, result: result.value },
      };
    },
  });
}

const messageFields = ["messageKey", "senderId", "senderPaneId", "senderKind", "recipientId", "targetPaneId", "recipientKind", "beadId", "summary", "createdAtMs", "expectsReply", "acked", "ackedAtMs", "ackedBy"];
const messageStatusFields = ["messageKey", "senderId", "recipientId", "beadId", "summary", "expectsReply", "acked", "ackedAtMs", "ackedBy"];
const monitorFields = ["monitorId", "target", "sessionId", "paneId", "state", "startedAtMs", "updatedAtMs", "timeoutMs", "intervalMs", "terminalStatus", "terminalAtMs", "terminalDetail"];

export default function xtmuxTools(pi: ExtensionAPI): void {
  const send = Type.Object({
    to: Type.String(),
    text: Type.String(),
    from: Type.Optional(Type.String()),
    bead: Type.Optional(Type.String()),
    expectsReply: Type.Optional(Type.Boolean()),
    messageKey: Type.Optional(Type.String()),
  });
  register(pi, {
    name: "xtmux_message_send", label: "xtmux message-send", description: "Run xtmux message-send --json.", parameters: send,
    argv(p) { const a = ["message-send", "--to", p.to, "--text", p.text]; flag(a, "--from", p.from); flag(a, "--bead", p.bead); flag(a, "--expects-reply", p.expectsReply); flag(a, "--id", p.messageKey); return a; },
    validate: objectWith(["messageKey", "messageId", "duplicate", "senderId", "senderPaneId", "senderKind", "recipientId", "recipientKind", "targetPaneId", "beadId", "expectsReply", "createdAtMs"]),
  });

  const list = Type.Object({
    for: Type.String(),
    pane: Type.Optional(Type.String()),
    from: Type.Optional(Type.String()),
    unacked: Type.Optional(Type.Boolean()),
    expectsReply: Type.Optional(Type.Boolean()),
    since: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  });
  register(pi, {
    name: "xtmux_message_list", label: "xtmux message-list", description: "Run xtmux message-list --json.", parameters: list,
    argv(p) { const a = ["message-list", "--for", p.for]; flag(a, "--pane", p.pane); flag(a, "--from", p.from); toggle(a, "--unacked", p.unacked); toggle(a, "--expects-reply", p.expectsReply); flag(a, "--since", p.since); flag(a, "--limit", p.limit); return a; },
    validate: arrayOf(messageFields),
  });

  const status = Type.Object({ messageKey: Type.String() });
  register(pi, {
    name: "xtmux_message_status", label: "xtmux message-status", description: "Run xtmux message-status --json.", parameters: status,
    argv: (p) => ["message-status", p.messageKey], validate: objectWith(messageStatusFields),
  });

  const ack = Type.Object({ messageKey: Type.String(), by: Type.Optional(Type.String()) });
  register(pi, {
    name: "xtmux_message_ack", label: "xtmux message-ack", description: "Run xtmux message-ack --json.", parameters: ack,
    argv(p) { const a = ["message-ack", p.messageKey]; flag(a, "--by", p.by); return a; },
    validate: objectWith(["messageKey", "acked", "ackedAtMs", "ackedBy", "status"]),
  });

  const unread = Type.Object({ for: Type.String(), pane: Type.Optional(Type.String()) });
  register(pi, {
    name: "xtmux_unread_count", label: "xtmux unread-count", description: "Run xtmux unread-count --json.", parameters: unread,
    argv(p) { const a = ["unread-count", "--for", p.for]; flag(a, "--pane", p.pane); return a; },
    validate: objectWith(["recipientId", "unreadCount", "oldestUnackedAtMs"]),
  });

  register(pi, {
    name: "xtmux_monitor_list", label: "xtmux monitor-list", description: "Run xtmux monitor-list --json.", parameters: Type.Object({}),
    argv: () => ["monitor-list"], validate: arrayOf(monitorFields),
  });

  const monitor = Type.Object({
    target: Type.String(),
    waitForTransition: Type.Optional(Type.Boolean()),
    timeout: Type.Optional(Type.String()),
    interval: Type.Optional(Type.String()),
  });
  register(pi, {
    name: "xtmux_monitor_agent", label: "xtmux monitor-agent", description: "Run xtmux monitor-agent --json.", parameters: monitor,
    argv(p) { const a = ["monitor-agent", p.target]; toggle(a, "--wait-for-transition", p.waitForTransition); flag(a, "--timeout", p.timeout); flag(a, "--interval", p.interval); return a; },
    validate: objectWith(["monitorId", "target", "sessionId", "paneId", "state", "startedAtMs", "timeoutMs", "intervalMs"]),
  });

  register(pi, {
    name: "xtmux_wait_agent", label: "xtmux wait-agent", description: "Run xtmux wait-agent --json.", parameters: monitor,
    argv(p) { const a = ["wait-agent", p.target]; toggle(a, "--wait-for-transition", p.waitForTransition); flag(a, "--timeout", p.timeout); flag(a, "--interval", p.interval); return a; },
    validate: objectWith(["target", "sessionId", "paneId", "state", "status", "startedAtMs", "completedAtMs", "timeoutMs", "intervalMs"]),
  });

  const kill = Type.Object({ monitorId: Type.String() });
  register(pi, {
    name: "xtmux_monitor_kill", label: "xtmux monitor-kill", description: "Run xtmux monitor-kill --json.", parameters: kill,
    argv: (p) => ["monitor-kill", p.monitorId], validate: objectWith(["monitorId", "status"]),
  });
}
