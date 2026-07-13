/**
 * V1-compatible stdout for messages. See tests/fixtures/golden/v1/ for the
 * TSV shapes the picker currently prints; these formatters reproduce them
 * byte-for-byte so `XTMUX_OBS_V2=0` and `=1` outputs remain interchangeable.
 *
 * Called by src/cli.ts under the `message-send`, `message-list`, `message-ack`
 * subcommands, and via the picker delegation branch under V2.
 */
import type { Db } from "./db/connection.ts";
import { ackMessage } from "./domains/messages/ack.ts";
import { listMessages } from "./domains/messages/list.ts";
import { sendMessage } from "./domains/messages/send.ts";
import { computeUnread } from "./domains/messages/reconcile-unread.ts";
import { messageStatus } from "./domains/messages/status.ts";

interface Args {
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// xtmux-3xs.27: emit local-tz ISO with colon-separated numeric offset (matches
// `date -Is`, which is what the V1 shell picker emits). Byte-parity with V1
// is required so XTMUX_OBS_V2=shadow doesn't record a false divergence on
// every message-list call.
function booleanFlag(flags: Map<string, string | boolean>, name: string, fallback: boolean): boolean | null {
  const value = flags.get(name);
  if (value === undefined) return fallback;
  if (value === true || value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return null;
}

function fail(json: boolean, code: string, message: string, exitCode: number, detail: Record<string, unknown> = {}): number {
  process.stderr.write(json ? `${JSON.stringify({ code, message, detail })}\n` : `${message}\n`);
  return exitCode;
}

function identityKind(id: string, paneId?: string | null): "session" | "pane" | "name" | "unknown" {
  if (paneId || id.startsWith("%")) return "pane";
  if (id.startsWith("$")) return "session";
  return id && id !== "unknown" ? "name" : "unknown";
}

function fmtTsIso(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const HH = pad(d.getHours());
  const MM = pad(d.getMinutes());
  const SS = pad(d.getSeconds());
  // getTimezoneOffset returns minutes WEST of UTC, so invert the sign to
  // match `date -Is` conventions (+02:00 for CEST, -05:00 for EST).
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(offMin) / 60));
  const om = pad(Math.abs(offMin) % 60);
  return `${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}${sign}${oh}:${om}`;
}

function fmtAge(epochMs: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export interface MessageSendArgs {
  to: string;
  toPaneId?: string;
  from: string;
  fromPaneId?: string;
  bead?: string;
  text: string;
  messageKey?: string;
}

/**
 * V1 shape (from picker::message_send):
 * `message\t<id>\t<from>\t<to>\t<bead>\t<text>` on stdout after successful send.
 * Non-existent tmux target ($/%/@ prefix): stderr + rc=1 (validated by shell caller
 * before we get here; V2 accepts opaque strings).
 */
export function cliMessageSend(db: Db, argv: string[]): number {
  const { flags } = parseArgs(argv);
  const json = flags.get("json") === true;
  const to = String(flags.get("to") ?? "");
  const from = String(flags.get("from") ?? "");
  const text = String(flags.get("text") ?? "");
  if (!to || !from || !text) return fail(json, "XTMUX_INVALID_ARGUMENT", "message-send: --to, --from, and --text are required", 2);
  const messageKey =
    (flags.get("message-key") as string | undefined) ??
    (flags.get("id") as string | undefined) ??
    `msg-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const bead = (flags.get("bead") as string | undefined) ?? "";
  const expectsReply = booleanFlag(flags, "expects-reply", Boolean(bead));
  if (expectsReply === null) return fail(json, "XTMUX_INVALID_ARGUMENT", "message-send: --expects-reply must be true or false", 2);
  const senderPaneId = (flags.get("from-pane") as string | undefined) ?? null;
  const targetPaneId = (flags.get("to-pane") as string | undefined) ?? null;
  const result = sendMessage(db, {
    messageKey,
    senderId: from,
    senderPaneId: senderPaneId ?? undefined,
    recipientId: to,
    targetPaneId: targetPaneId ?? undefined,
    beadId: bead || undefined,
    summary: text,
    expectsReply,
  });
  if (json) {
    const createdAtMs = db.raw.query<{ created_at_ms: number }, [string]>("SELECT created_at_ms FROM messages WHERE message_key = ?").get(messageKey)?.created_at_ms ?? null;
    process.stdout.write(JSON.stringify({
      messageKey,
      messageId: result.messageId,
      duplicate: result.duplicate,
      senderId: from,
      senderPaneId,
      senderKind: identityKind(from, senderPaneId),
      recipientId: to,
      targetPaneId,
      recipientKind: identityKind(to, targetPaneId),
      beadId: bead || null,
      expectsReply,
      createdAtMs,
    }) + "\n");
  } else {
    process.stdout.write(`message\t${messageKey}\t${from}\t${to}\t${bead}\t${text}\n`);
  }
  return 0;
}

/**
 * V1 shape (from picker):
 * `message\t<message_key>\t<ts>\t<from>\t<to>\t<bead>\t<summary>`
 * with rows ordered newest-first.
 */
export function cliMessageList(db: Db, argv: string[]): number {
  const { flags } = parseArgs(argv);
  const forTarget = String(flags.get("for") ?? "");
  if (!forTarget) {
    process.stderr.write("message-list: --for is required\n");
    return 2;
  }
  const rows = listMessages(db, {
    recipientId: forTarget,
    targetPaneId: (flags.get("pane") as string | undefined) ?? undefined,
    senderId: (flags.get("from") as string | undefined) ?? undefined,
    sinceMs: flags.has("since") ? Number(flags.get("since")) : undefined,
    unackedOnly: flags.get("unacked") === true,
    expectsReplyOnly: flags.get("expects-reply") === true,
    limit: flags.has("limit") ? Number(flags.get("limit")) : undefined,
  });
  if (flags.get("json") === true) {
    process.stdout.write(JSON.stringify(rows.map((r) => ({
      messageKey: r.message_key,
      senderId: r.sender_id,
      senderPaneId: r.sender_pane_id,
      senderKind: identityKind(r.sender_id, r.sender_pane_id),
      recipientId: r.recipient_id,
      targetPaneId: r.target_pane_id,
      recipientKind: identityKind(r.recipient_id, r.target_pane_id),
      beadId: r.bead_id,
      summary: r.summary,
      createdAtMs: r.created_at_ms,
      expectsReply: r.expects_reply === 1,
      acked: r.acked_at_ms !== null,
      ackedAtMs: r.acked_at_ms,
      ackedBy: r.acked_by,
    }))) + "\n");
    return 0;
  }
  // V1 prints oldest-first when it drains rotated files; --limit implies newest.
  // Match V1: reverse so the tail (newest) shows last.
  for (const r of [...rows].reverse()) {
    const parts = [
      "message",
      r.message_key,
      fmtTsIso(r.created_at_ms),
      ...(flags.get("unacked") === true ? [fmtAge(r.created_at_ms)] : []),
      r.sender_id,
      r.recipient_id,
      r.bead_id ?? "",
      (r.summary ?? "").replace(/\n/g, " "),
    ];
    process.stdout.write(parts.join("\t") + "\n");
  }
  return 0;
}

/**
 * V1 shape: `ack\t<id-or-->\t<by-session>`. Idempotent + wrong-recipient
 * rejection is a stderr note with a distinct exit code so the picker or a
 * downstream test can branch on it.
 */
export function cliMessageStatus(db: Db, argv: string[]): number {
  const { positional } = parseArgs(argv);
  const key = positional[0] ?? "";
  if (!key) {
    process.stderr.write("message-status: <message_key> required\n");
    return 2;
  }
  const status = messageStatus(db, key);
  if (!status) {
    process.stderr.write("message-status: unknown message key\n");
    return 5;
  }
  process.stdout.write(JSON.stringify(status) + "\n");
  return 0;
}

export function cliUnreadCount(db: Db, argv: string[]): number {
  const { flags } = parseArgs(argv);
  const recipientId = String(flags.get("for") ?? "");
  if (!recipientId) {
    process.stderr.write("unread-count: --for <recipient> required\n");
    return 2;
  }
  // Optional --pane %N: pane-scoped count (xtmux-3xs.28). Filters to messages
  // explicitly targeted at that pane or unpaned; excludes cohabiting-pane traffic.
  const paneFlag = flags.get("pane");
  const paneId = typeof paneFlag === "string" && paneFlag ? paneFlag : undefined;
  process.stdout.write(JSON.stringify(computeUnread(db, recipientId, paneId)) + "\n");
  return 0;
}

export function cliMessageAck(db: Db, argv: string[]): number {
  const { positional, flags } = parseArgs(argv);
  const json = flags.get("json") === true;
  const messageKey = positional[0] ?? "";
  const ackedBy = String(flags.get("by") ?? "");
  if (!messageKey || !ackedBy) return fail(json, "XTMUX_INVALID_ARGUMENT", "message-ack: <message_id> --by <session> required", 2);
  const messageId = db.raw.query<{ id: number }, [string]>("SELECT id FROM messages WHERE message_key = ?").get(messageKey)?.id
    ?? Number(messageKey);
  if (!messageId) return fail(json, "XTMUX_MESSAGE_NOT_FOUND", "message-ack: unknown message id", 5, { messageKey });
  const r = ackMessage(db, { messageId, ackedBy });
  if (r.status === "wrong-recipient") return fail(json, "XTMUX_ACK_WRONG_RECIPIENT", "message-ack: wrong recipient (no mutation)", 4, { messageKey, ackedBy });
  if (r.status === "unknown-message") return fail(json, "XTMUX_MESSAGE_NOT_FOUND", "message-ack: unknown message id", 5, { messageKey });
  if (json) {
    process.stdout.write(JSON.stringify({
      messageKey,
      status: r.status,
      acked: true,
      ackedAtMs: r.ackedAtMs ?? null,
      ackedBy,
    }) + "\n");
  } else {
    process.stdout.write(`ack\t${messageKey}\t${ackedBy}\n`);
  }
  return 0;
}
