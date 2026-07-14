import type { Db } from "../../db/connection.ts";
import { insertEnvelope } from "../../db/journal.ts";
import { MessageError } from "./errors.ts";

export interface SendInput {
  messageKey: string;
  senderId: string;
  senderPaneId?: string | undefined;
  recipientId: string;
  targetPaneId?: string | undefined;
  beadId?: string | undefined;
  summary: string;
  payloadJson?: string | undefined;
  expectsReply?: boolean | undefined;
  replyToMessageId?: number | undefined;
}

export interface SendResult {
  messageId: number;
  duplicate: boolean;
  expectsReply: boolean;
  createdAtMs: number;
  fulfilled: boolean;
  replyToMessageId: number | null;
  fulfilledMessageKey: string | null;
}

interface ExistingMessage {
  id: number;
  message_key: string;
  sender_id: string;
  sender_pane_id: string | null;
  recipient_id: string;
  target_pane_id: string | null;
  bead_id: string | null;
  summary: string;
  payload_json: string | null;
  expects_reply: number;
  created_at_ms: number;
  reply_to_message_id: number | null;
}

function rejectEnvelope(db: Db, input: SendInput, error: MessageError, nowMs: number): void {
  insertEnvelope(db, {
    type: input.replyToMessageId === undefined ? "messages.send.rejected" : "messages.reply.rejected",
    domain: "messages",
    sessionId: input.recipientId,
    paneId: input.targetPaneId,
    correlationId: input.messageKey,
    payload: {
      outcome: "rejected",
      code: error.code,
      message_id: input.replyToMessageId ?? null,
    },
    createdAtMs: nowMs,
  });
}

function sameMessage(existing: ExistingMessage, input: SendInput, expectsReply: boolean): boolean {
  return existing.message_key === input.messageKey
    && existing.sender_id === input.senderId
    && existing.sender_pane_id === (input.senderPaneId ?? null)
    && existing.recipient_id === input.recipientId
    && existing.target_pane_id === (input.targetPaneId ?? null)
    && existing.bead_id === (input.beadId ?? null)
    && existing.summary === input.summary
    && existing.payload_json === (input.payloadJson ?? null)
    && existing.expects_reply === (expectsReply ? 1 : 0)
    && existing.reply_to_message_id === (input.replyToMessageId ?? null);
}

/**
 * Insert durable message + receipt atomically. Existing callers keep old
 * positional shape because correlation remains optional in SendInput.
 */
export function sendMessage(db: Db, input: SendInput, now: () => number = Date.now): SendResult {
  const findByKey = db.raw.prepare<ExistingMessage, [string]>(
    "SELECT id, message_key, sender_id, sender_pane_id, recipient_id, target_pane_id, bead_id, summary, payload_json, expects_reply, created_at_ms, reply_to_message_id FROM messages WHERE message_key = ?",
  );
  const findOriginal = db.raw.prepare<ExistingMessage & {
    fulfilled_by_message_id: number | null;
    fulfilled_at_ms: number | null;
    cancelled_at_ms: number | null;
  }, [number]>(
    "SELECT id, message_key, sender_id, sender_pane_id, recipient_id, target_pane_id, bead_id, summary, payload_json, expects_reply, created_at_ms, reply_to_message_id, fulfilled_by_message_id, fulfilled_at_ms, cancelled_at_ms FROM messages WHERE id = ?",
  );
  const insertMessage = db.raw.prepare<{ id: number }, [
    string, string, string | null, string, string | null, string | null,
    string, string | null, number, number, number | null,
  ]>(
    `INSERT INTO messages
       (message_key, sender_id, sender_pane_id, recipient_id, target_pane_id,
        bead_id, summary, payload_json, expects_reply, created_at_ms, reply_to_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  );
  const insertReceipt = db.raw.prepare<unknown, [number, string]>(
    "INSERT INTO message_receipts (message_id, recipient_id) VALUES (?, ?)",
  );
  const fulfillOriginal = db.raw.prepare<unknown, [number, number, number]>(
    "UPDATE messages SET fulfilled_by_message_id = ?, fulfilled_at_ms = ? WHERE id = ? AND fulfilled_at_ms IS NULL AND cancelled_at_ms IS NULL",
  );

  let result: SendResult = {
    messageId: 0,
    duplicate: false,
    expectsReply: input.expectsReply ?? false,
    createdAtMs: 0,
    fulfilled: false,
    replyToMessageId: input.replyToMessageId ?? null,
    fulfilledMessageKey: input.replyToMessageId === undefined ? null : input.messageKey,
  };
  let rejection: MessageError | null = null;
  const tx = db.raw.transaction(() => {
    const existing = findByKey.get(input.messageKey);
    const expectsReply = input.expectsReply ?? false;
    if (existing) {
      if (!sameMessage(existing, input, expectsReply)) {
        throw new MessageError("XTMUX_MESSAGE_KEY_CONFLICT", "message key already contains different payload or correlation", {
          messageKey: input.messageKey,
          messageId: existing.id,
        });
      }
      result = {
        messageId: existing.id,
        duplicate: true,
        expectsReply: existing.expects_reply === 1,
        createdAtMs: existing.created_at_ms,
        fulfilled: existing.reply_to_message_id !== null,
        replyToMessageId: existing.reply_to_message_id,
        fulfilledMessageKey: existing.reply_to_message_id === null
          ? null
          : db.raw.query<{ message_key: string }, [number]>("SELECT message_key FROM messages WHERE id = ?").get(existing.reply_to_message_id)?.message_key ?? null,
      };
      return;
    }

    const original = input.replyToMessageId === undefined
      ? null
      : findOriginal.get(input.replyToMessageId);
    if (input.replyToMessageId !== undefined) {
      if (!original || original.message_key === input.messageKey || original.reply_to_message_id !== null || original.expects_reply !== 1) {
        throw new MessageError("XTMUX_INVALID_CORRELATION", "reply target is not a valid pending obligation", {
          messageId: input.replyToMessageId,
        });
      }
      if (original.recipient_id !== input.senderId) {
        throw new MessageError("XTMUX_WRONG_RECIPIENT", "reply sender is not original recipient", {
          messageId: original.id,
          expectedRecipientId: original.recipient_id,
          actualSenderId: input.senderId,
        });
      }
      if (original.target_pane_id !== (input.senderPaneId ?? null)) {
        throw new MessageError("XTMUX_WRONG_PANE", "reply sender pane does not match original target pane", {
          messageId: original.id,
          expectedPaneId: original.target_pane_id,
          actualPaneId: input.senderPaneId ?? null,
        });
      }
      if (original.sender_id !== input.recipientId) {
        throw new MessageError("XTMUX_WRONG_RECIPIENT", "reply destination is not original sender", {
          messageId: original.id,
          expectedRecipientId: original.sender_id,
          actualRecipientId: input.recipientId,
        });
      }
      if (original.sender_pane_id !== (input.targetPaneId ?? null)) {
        throw new MessageError("XTMUX_WRONG_PANE", "reply destination pane does not reverse original sender pane", {
          messageId: original.id,
          expectedPaneId: original.sender_pane_id,
          actualPaneId: input.targetPaneId ?? null,
        });
      }
      if (original.cancelled_at_ms !== null) {
        throw new MessageError("XTMUX_REPLY_TERMINAL", "reply target was cancelled", { messageId: original.id });
      }
      if (original.fulfilled_at_ms !== null) {
        throw new MessageError("XTMUX_ALREADY_FULFILLED", "reply target already fulfilled", { messageId: original.id });
      }
    }

    const createdAtMs = now();
    const row = insertMessage.get(
      input.messageKey,
      input.senderId,
      input.senderPaneId ?? null,
      input.recipientId,
      input.targetPaneId ?? null,
      input.beadId ?? null,
      input.summary,
      input.payloadJson ?? null,
      expectsReply ? 1 : 0,
      createdAtMs,
      input.replyToMessageId ?? null,
    );
    const messageId = row?.id ?? 0;
    insertReceipt.run(messageId, input.recipientId);
    if (input.replyToMessageId !== undefined) fulfillOriginal.run(messageId, createdAtMs, input.replyToMessageId);
    insertEnvelope(db, {
      eventKey: `messages.sent:${input.messageKey}`,
      type: "messages.sent",
      domain: "messages",
      sessionId: input.recipientId,
      paneId: input.targetPaneId,
      beadId: input.beadId,
      correlationId: input.messageKey,
      payload: {
        message_id: messageId,
        sender_id: input.senderId,
        recipient_id: input.recipientId,
        reply_to_message_id: input.replyToMessageId ?? null,
        expects_reply: expectsReply,
      },
      createdAtMs,
    });
    if (input.replyToMessageId !== undefined) {
      insertEnvelope(db, {
        type: "messages.reply.linked",
        domain: "messages",
        sessionId: input.recipientId,
        paneId: input.targetPaneId,
        correlationId: input.messageKey,
        payload: {
          message_id: messageId,
          reply_to_message_id: input.replyToMessageId,
          fulfilled_at_ms: createdAtMs,
          outcome: "fulfilled",
        },
        createdAtMs,
      });
    }
    result = {
      messageId,
      duplicate: false,
      expectsReply,
      createdAtMs,
      fulfilled: input.replyToMessageId !== undefined,
      replyToMessageId: input.replyToMessageId ?? null,
      fulfilledMessageKey: input.replyToMessageId === undefined ? null : original?.message_key ?? null,
    };
  });

  try {
    tx();
  } catch (error) {
    if (error instanceof MessageError) {
      rejection = error;
    } else if (input.replyToMessageId !== undefined
      && error instanceof Error
      && /msg_one_reply_per_request|UNIQUE constraint failed: messages.reply_to_message_id/i.test(error.message)) {
      rejection = new MessageError("XTMUX_ALREADY_FULFILLED", "reply target already fulfilled", {
        messageId: input.replyToMessageId,
      });
    } else {
      throw error;
    }
  }
  if (rejection) {
    const t = now();
    rejectEnvelope(db, input, rejection, t);
    throw rejection;
  }
  return result;
}
