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
import { insertEnvelope } from "./db/journal.ts";
import { listMessages } from "./domains/messages/list.ts";
import { replyMessage } from "./domains/messages/reply.ts";
import { sendMessage } from "./domains/messages/send.ts";
import { computeUnread } from "./domains/messages/reconcile-unread.ts";
import { messageStatus } from "./domains/messages/status.ts";
import { MessageError } from "./domains/messages/errors.ts";
import { captureRuntimeContext } from "./domains/identity/runtime-context.ts";

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

function fail(json: boolean, code: string, message: string, exitCode: number, detail: Record<string, unknown> = {}, includeErrorCode = false): number {
  process.stderr.write(json ? `${JSON.stringify({ code, ...(includeErrorCode ? { error_code: code } : {}), message, detail })}\n` : `${message}\n`);
  return exitCode;
}

export type LiveTmuxRequester =
  | { ok: true; sessionId: string; paneId: string }
  | { ok: false; code: "XTMUX_NOT_IN_TMUX" | "XTMUX_PANE_UNRESOLVED"; message: string; detail: Record<string, string> };

export function liveTmuxRequester(): LiveTmuxRequester {
  const result = captureRuntimeContext();
  if (!result.ok) return { ok: false, ...result.error };
  if (result.origin.tmux_pane_id !== process.env.TMUX_PANE) {
    return {
      ok: false,
      code: "XTMUX_PANE_UNRESOLVED",
      message: `xtmux context resolved a different pane than TMUX_PANE ${process.env.TMUX_PANE ?? ""}`,
      detail: { pane: process.env.TMUX_PANE ?? "", resolved: result.origin.tmux_pane_id },
    };
  }
  return { ok: true, sessionId: result.origin.tmux_session_id, paneId: result.origin.tmux_pane_id };
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
  replyTo?: string;
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
  const replyTo = flags.get("reply-to") as string | undefined;
  if (!to || !text || (!from && !replyTo)) return fail(json, "XTMUX_INVALID_ARGUMENT", "message-send: --to, --from, and --text are required unless --reply-to supplies the live requester", 2);
  const messageKey =
    (flags.get("message-key") as string | undefined) ??
    (flags.get("id") as string | undefined) ??
    `msg-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const bead = (flags.get("bead") as string | undefined) ?? "";
  const expectsReply = booleanFlag(flags, "expects-reply", Boolean(bead));
  if (expectsReply === null) return fail(json, "XTMUX_INVALID_ARGUMENT", "message-send: --expects-reply must be true or false", 2);
  const senderPaneId = (flags.get("from-pane") as string | undefined) ?? null;
  const targetPaneId = (flags.get("to-pane") as string | undefined) ?? null;
  let result;
  let responseSenderId = from;
  let responseSenderPaneId = senderPaneId;
  if (replyTo) {
    const requester = liveTmuxRequester();
    if (!requester.ok) return fail(json, requester.code, requester.message, 4, requester.detail);
    const target = db.raw.query<{
      id: number;
      sender_id: string;
      sender_pane_id: string | null;
      recipient_id: string;
      target_pane_id: string | null;
    }, [string]>(
      "SELECT id, sender_id, sender_pane_id, recipient_id, target_pane_id FROM messages WHERE message_key = ?",
    ).get(replyTo);
    if (!target) return fail(json, "XTMUX_MESSAGE_NOT_FOUND", "message-send: reply target was not found", 5, { replyToMessageKey: replyTo });
    if (requester.sessionId !== target.recipient_id || (from && from !== requester.sessionId)) {
      return fail(json, "XTMUX_WRONG_RECIPIENT", "message-send: live tmux requester is not original recipient", 4, {
        replyToMessageKey: replyTo,
      });
    }
    if (target.target_pane_id !== null && requester.paneId !== target.target_pane_id) {
      return fail(json, "XTMUX_WRONG_PANE", "message-send: live tmux pane is not original target pane", 4, {
        replyToMessageKey: replyTo,
      });
    }
    if (senderPaneId !== null && senderPaneId !== requester.paneId) {
      return fail(json, "XTMUX_WRONG_PANE", "message-send: --from-pane does not match live tmux pane", 4, {
        replyToMessageKey: replyTo,
      });
    }
    if (to !== target.sender_id || targetPaneId !== target.sender_pane_id) {
      return fail(json, "XTMUX_ENDPOINT_OVERRIDE", "message-send: reply endpoints must reverse original message", 4, {
        replyToMessageKey: replyTo,
      });
    }
    if (senderPaneId !== null && senderPaneId !== target.target_pane_id) {
      return fail(json, "XTMUX_ENDPOINT_OVERRIDE", "message-send: reply sender pane must reverse original target pane", 4, {
        replyToMessageKey: replyTo,
      });
    }
    if (expectsReply) return fail(json, "XTMUX_INVALID_CORRELATION", "message-send: correlated reply cannot expect another reply", 4, { replyToMessageKey: replyTo });
    responseSenderId = requester.sessionId;
    responseSenderPaneId = target.target_pane_id === null ? null : requester.paneId;
    try {
      result = sendMessage(db, {
        messageKey,
        senderId: responseSenderId,
        senderPaneId: responseSenderPaneId ?? undefined,
        recipientId: target.sender_id,
        targetPaneId: target.sender_pane_id ?? undefined,
        beadId: bead || undefined,
        summary: text,
        expectsReply: false,
        replyToMessageId: target.id,
      });
    } catch (error) {
      if (!(error instanceof MessageError)) throw error;
      return fail(json, error.code, error.message, 4, error.detail, true);
    }
  } else {
    result = sendMessage(db, {
      messageKey,
      senderId: from,
      senderPaneId: senderPaneId ?? undefined,
      recipientId: to,
      targetPaneId: targetPaneId ?? undefined,
      beadId: bead || undefined,
      summary: text,
      expectsReply,
    });
  }
  if (json) {
    const createdAtMs = db.raw.query<{ created_at_ms: number }, [string]>("SELECT created_at_ms FROM messages WHERE message_key = ?").get(messageKey)?.created_at_ms ?? null;
    process.stdout.write(JSON.stringify({
      messageKey,
      messageId: result.messageId,
      duplicate: result.duplicate,
      senderId: responseSenderId,
      senderPaneId: responseSenderPaneId,
      senderKind: identityKind(responseSenderId, responseSenderPaneId),
      recipientId: to,
      targetPaneId,
      recipientKind: identityKind(to, targetPaneId),
      beadId: bead || null,
      expectsReply: replyTo ? false : expectsReply,
      createdAtMs,
    }) + "\n");
  } else {
    process.stdout.write(`message\t${messageKey}\t${responseSenderId}\t${to}\t${bead}\t${text}\n`);
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
  }, { includeReplyState: true });
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
      ...(flags.get("expects-reply") === true ? {
        replyStatus: r.replyStatus,
        fulfilledAtMs: r.fulfilledAtMs,
        fulfilledByMessageKey: r.fulfilled_by_message_key,
        correlatedReply: r.correlatedReply,
      } : {}),
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
  const { positional, flags } = parseArgs(argv);
  const key = positional[0] ?? "";
  const json = flags.get("json") === true;
  if (!key) return fail(json, "XTMUX_INVALID_ARGUMENT", "message-status: <message_key> required", 2, {}, true);
  const includeReplyState = json;
  const status = includeReplyState ? messageStatus(db, key, { includeReplyState: true }) : messageStatus(db, key);
  if (!status) {
    if (json) return fail(true, "XTMUX_MESSAGE_NOT_FOUND", "message-status: unknown message key", 5, { messageKey: key }, true);
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

export function cliMessageReply(db: Db, argv: string[]): number {
  const { flags } = parseArgs(argv);
  const json = flags.get("json") === true;
  const replyToMessageKey = String(flags.get("in-reply-to") ?? "");
  const text = String(flags.get("text") ?? "");
  const messageKey = flags.get("message-key") as string | undefined;
  if (!replyToMessageKey || !text) {
    return fail(json, "XTMUX_INVALID_ARGUMENT", "message-reply: --in-reply-to and --text are required", 2, {}, true);
  }
  const requester = liveTmuxRequester();
  if (!requester.ok) return fail(json, requester.code, requester.message, 4, requester.detail, true);
  const target = db.raw.query<{ recipient_id: string; target_pane_id: string | null }, [string]>(
    "SELECT recipient_id, target_pane_id FROM messages WHERE message_key = ?",
  ).get(replyToMessageKey);
  if (!target) return fail(json, "XTMUX_MESSAGE_NOT_FOUND", "message-reply: reply target was not found", 5, { replyToMessageKey }, true);
  if (requester.sessionId !== target.recipient_id) {
    return fail(json, "XTMUX_WRONG_RECIPIENT", "message-reply: live tmux requester is not original recipient", 4, { replyToMessageKey }, true);
  }
  if (target.target_pane_id !== null && requester.paneId !== target.target_pane_id) {
    return fail(json, "XTMUX_WRONG_PANE", "message-reply: live tmux pane is not original target pane", 4, { replyToMessageKey }, true);
  }
  try {
    const result = replyMessage(db, {
      messageKey,
      replyToMessageKey,
      senderId: requester.sessionId,
      senderPaneId: target.target_pane_id === null ? undefined : requester.paneId,
      summary: text,
    });
    if (json) process.stdout.write(JSON.stringify(result) + "\n");
    else process.stdout.write(`reply\t${result.messageKey}\t${result.replyToMessageKey}\t${result.fulfilled}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof MessageError)) throw error;
    return fail(json, error.code, error.message, 4, error.detail, true);
  }
}

export function cliMessageCancel(db: Db, argv: string[]): number {
  const { flags } = parseArgs(argv);
  const json = flags.get("json") === true;
  const messageKey = String(flags.get("message-key") ?? "");
  if (!messageKey) return fail(json, "XTMUX_INVALID_ARGUMENT", "message-cancel: --message-key is required", 2, {}, true);
  const requester = liveTmuxRequester();
  if (!requester.ok) return fail(json, requester.code, requester.message, 4, requester.detail, true);
  const row = db.raw.query<{
    id: number;
    sender_id: string;
    sender_pane_id: string | null;
    fulfilled_at_ms: number | null;
    cancelled_at_ms: number | null;
  }, [string]>(
    "SELECT id, sender_id, sender_pane_id, fulfilled_at_ms, cancelled_at_ms FROM messages WHERE message_key = ?",
  ).get(messageKey);
  if (!row) return fail(json, "XTMUX_MESSAGE_NOT_FOUND", "message-cancel: message was not found", 5, { messageKey }, true);
  if (requester.sessionId !== row.sender_id) {
    return fail(json, "XTMUX_WRONG_RECIPIENT", "message-cancel: live tmux requester is not message owner", 4, { messageKey }, true);
  }
  if (row.sender_pane_id !== null && requester.paneId !== row.sender_pane_id) {
    return fail(json, "XTMUX_WRONG_PANE", "message-cancel: live tmux pane is not message owner pane", 4, { messageKey }, true);
  }
  if (row.fulfilled_at_ms !== null) return fail(json, "XTMUX_ALREADY_FULFILLED", "message-cancel: message was already fulfilled", 4, { messageKey }, true);
  if (row.cancelled_at_ms !== null) {
    const result = { messageKey, cancelled: false, cancelledAtMs: row.cancelled_at_ms };
    if (json) process.stdout.write(JSON.stringify(result) + "\n"); else process.stdout.write(`cancelled\t${messageKey}\t${row.cancelled_at_ms}\n`);
    return 0;
  }
  const cancelledAtMs = Date.now();
  db.raw.transaction(() => {
    db.raw.query("UPDATE messages SET cancelled_at_ms = ?, cancel_reason = ? WHERE id = ? AND cancelled_at_ms IS NULL")
      .run(cancelledAtMs, "requested", row.id);
    insertEnvelope(db, {
      type: "messages.cancelled",
      domain: "messages",
      correlationId: messageKey,
      payload: { message_id: row.id, outcome: "cancelled" },
      createdAtMs: cancelledAtMs,
    });
  }).immediate();
  const result = { messageKey, cancelled: true, cancelledAtMs };
  if (json) process.stdout.write(JSON.stringify(result) + "\n"); else process.stdout.write(`cancelled\t${messageKey}\t${cancelledAtMs}\n`);
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
