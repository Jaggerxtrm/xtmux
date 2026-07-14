import type { Db } from "../../db/connection.ts";
import { insertEnvelope } from "../../db/journal.ts";
import { MessageError } from "./errors.ts";
import { sendMessage, type SendResult } from "./send.ts";

export interface ReplyInput {
  messageKey?: string | undefined;
  replyToMessageKey?: string | undefined;
  inReplyTo?: string | undefined;
  senderId: string;
  senderPaneId?: string | undefined;
  summary?: string | undefined;
  text?: string | undefined;
  payloadJson?: string | undefined;
  recipientId?: string | undefined;
  targetPaneId?: string | undefined;
}

export interface ReplyResult {
  messageKey: string;
  messageId: number;
  duplicate: boolean;
  replyToMessageKey: string;
  fulfilledMessageKey: string;
  fulfilled: true;
  senderId: string;
  senderPaneId: string | null;
  recipientId: string;
  targetPaneId: string | null;
  createdAtMs: number;
}

function replyErrorEvent(db: Db, input: ReplyInput, error: MessageError, nowMs: number): void {
  insertEnvelope(db, {
    type: "messages.reply.rejected",
    domain: "messages",
    sessionId: input.senderId,
    paneId: input.senderPaneId,
    correlationId: input.messageKey ?? input.replyToMessageKey ?? input.inReplyTo,
    payload: { outcome: "rejected", error_code: error.code },
    createdAtMs: nowMs,
  });
}

/** Write explicit correlated reply. Endpoints are always reversed from target row. */
export function replyMessage(
  db: Db,
  input: ReplyInput,
  now: () => number = Date.now,
): ReplyResult {
  const replyToMessageKey = input.replyToMessageKey ?? input.inReplyTo ?? "";
  const messageKey = input.messageKey ?? `reply-${replyToMessageKey}`;
  const summary = input.summary ?? input.text ?? "";
  let target: {
    id: number;
    message_key: string;
    sender_id: string;
    sender_pane_id: string | null;
    recipient_id: string;
    target_pane_id: string | null;
  } | undefined;
  let sendAttempted = false;

  try {
    if (!replyToMessageKey || !messageKey || !summary || !input.senderId) {
      throw new MessageError("XTMUX_INVALID_CORRELATION", "reply requires message key, target, sender, and text", {
        messageKey: messageKey || null,
        replyToMessageKey: replyToMessageKey || null,
      });
    }
    if (input.recipientId !== undefined || input.targetPaneId !== undefined) {
      throw new MessageError("XTMUX_ENDPOINT_OVERRIDE", "reply endpoints are derived from original message", {
        replyToMessageKey,
      });
    }
    target = db.raw.query<{
      id: number;
      message_key: string;
      sender_id: string;
      sender_pane_id: string | null;
      recipient_id: string;
      target_pane_id: string | null;
    }, [string]>(
      `SELECT id, message_key, sender_id, sender_pane_id, recipient_id, target_pane_id
         FROM messages WHERE message_key = ?`,
    ).get(replyToMessageKey) ?? undefined;
    if (!target) {
      throw new MessageError("XTMUX_INVALID_CORRELATION", "reply target message was not found", { replyToMessageKey });
    }

    sendAttempted = true;
    const result: SendResult = sendMessage(db, {
      messageKey,
      senderId: input.senderId,
      senderPaneId: input.senderPaneId,
      recipientId: target.sender_id,
      targetPaneId: target.sender_pane_id ?? undefined,
      summary,
      payloadJson: input.payloadJson,
      expectsReply: false,
      replyToMessageId: target.id,
    }, now);
    return {
      messageKey,
      messageId: result.messageId,
      duplicate: result.duplicate,
      replyToMessageKey: target.message_key,
      fulfilledMessageKey: result.fulfilledMessageKey ?? target.message_key,
      fulfilled: true,
      senderId: input.senderId,
      senderPaneId: input.senderPaneId ?? null,
      recipientId: target.sender_id,
      targetPaneId: target.sender_pane_id,
      createdAtMs: result.createdAtMs,
    };
  } catch (error) {
    if (!(error instanceof MessageError)) throw error;
    if (!sendAttempted) replyErrorEvent(db, input, error, now());
    throw error;
  }
}

export const messageReply = replyMessage;
export const sendReply = replyMessage;
