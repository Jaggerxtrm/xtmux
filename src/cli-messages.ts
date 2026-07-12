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

function fmtTsIso(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, "Z");
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
  const to = String(flags.get("to") ?? "");
  const from = String(flags.get("from") ?? "");
  const text = String(flags.get("text") ?? "");
  if (!to || !from || !text) {
    process.stderr.write("message-send: --to, --from, and --text are required\n");
    return 2;
  }
  const messageKey =
    (flags.get("message-key") as string | undefined) ??
    (flags.get("id") as string | undefined) ??
    `msg-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const bead = (flags.get("bead") as string | undefined) ?? "";
  sendMessage(db, {
    messageKey,
    senderId: from,
    senderPaneId: (flags.get("from-pane") as string | undefined) ?? undefined,
    recipientId: to,
    targetPaneId: (flags.get("to-pane") as string | undefined) ?? undefined,
    beadId: bead || undefined,
    summary: text,
  });
  // Match V1 stdout: message\tid\tfrom\tto\tbead\ttext
  process.stdout.write(`message\t${messageKey}\t${from}\t${to}\t${bead}\t${text}\n`);
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
    limit: flags.has("limit") ? Number(flags.get("limit")) : undefined,
  });
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
  const messageKey = positional[0] ?? "";
  const ackedBy = String(flags.get("by") ?? "");
  if (!messageKey || !ackedBy) {
    process.stderr.write("message-ack: <message_id> --by <session> required\n");
    return 2;
  }
  const messageId = db.raw.query<{ id: number }, [string]>("SELECT id FROM messages WHERE message_key = ?").get(messageKey)?.id
    ?? Number(messageKey);
  if (!messageId) {
    process.stderr.write("message-ack: unknown message id\n");
    return 5;
  }
  const r = ackMessage(db, { messageId, ackedBy });
  process.stdout.write(`ack\t${messageKey}\t${ackedBy}\n`);
  switch (r.status) {
    case "acked":
    case "already-acked":
      return 0;
    case "wrong-recipient":
      process.stderr.write("message-ack: wrong recipient (no mutation)\n");
      return 4;
    case "unknown-message":
      process.stderr.write("message-ack: unknown message id\n");
      return 5;
  }
}
