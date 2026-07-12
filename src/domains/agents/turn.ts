import type { Db } from "../../db/connection.ts";
import { insertEnvelope } from "../../db/journal.ts";
import { sendMessage } from "../messages/send.ts";
import { findActiveInstanceForPane } from "./instance.ts";

export interface TurnCompleteInput {
  paneId: string;
  sessionId: string;
  sessionName?: string | undefined;
  beadId?: string | undefined;
  parentSessionId?: string | undefined;
  summary?: string | undefined;
  turnIndex?: number | undefined;
  parentMessageText?: string | undefined;   // if set + parent, send message and link
  instanceId?: string | undefined;
}

export interface TurnCompleteResult {
  turnId: number;
  instanceId: string | null;
  parentMessageId: number | null;
}

/**
 * Turn completion is the atomic unit:
 *  1. insert agent_turns row
 *  2. (if parentSessionId + parentMessageText) insert messages row + receipt
 *  3. link agent_turns.parent_message_id = message.id
 *  4. commit
 * If step 2 or 3 fails, the whole transaction rolls back — no orphan turn row,
 * no orphan message row. tmux projection updates are the caller's separate
 * best-effort step.
 */
export function completeTurn(
  db: Db,
  input: TurnCompleteInput,
  now: () => number = Date.now,
): TurnCompleteResult {
  let turnId = 0;
  let instanceId: string | null = input.instanceId ?? null;
  let parentMessageId: number | null = null;

  const tx = db.raw.transaction(() => {
    if (!instanceId) {
      const inst = findActiveInstanceForPane(db, input.paneId);
      instanceId = inst?.instance_id ?? null;
    }

    const completedAtMs = now();
    const turnRow = db.raw
      .prepare<{ id: number }, [
        string | null, string, string, string | null, string | null,
        number | null, string | null, number,
      ]>(
        `INSERT INTO agent_turns
           (instance_id, session_id, pane_id, bead_id, parent_session_id,
            turn_index, summary, completed_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .get(
        instanceId,
        input.sessionId,
        input.paneId,
        input.beadId ?? null,
        input.parentSessionId ?? null,
        input.turnIndex ?? null,
        input.summary ?? null,
        completedAtMs,
      );
    turnId = turnRow?.id ?? 0;

    if (input.parentSessionId && input.parentMessageText) {
      const key = `turn:${instanceId ?? input.paneId}:${turnId}`;
      const sent = sendMessage(
        db,
        {
          messageKey: key,
          senderId: input.sessionId,
          senderPaneId: input.paneId,
          recipientId: input.parentSessionId,
          beadId: input.beadId,
          summary: input.parentMessageText,
        },
        () => completedAtMs,
      );
      parentMessageId = sent.messageId;
      db.raw
        .prepare<unknown, [number, number]>(
          "UPDATE agent_turns SET parent_message_id = ? WHERE id = ?",
        )
        .run(parentMessageId, turnId);
    }

    insertEnvelope(db, {
      type: "agents.turn.done",
      domain: "agents",
      sessionId: input.sessionId,
      paneId: input.paneId,
      instanceId: instanceId ?? undefined,
      beadId: input.beadId,
      correlationId: instanceId ?? input.paneId,
      payload: {
        turn_id: turnId,
        parent_message_id: parentMessageId,
        summary: input.summary,
      },
      createdAtMs: completedAtMs,
    });
  });
  tx();

  return { turnId, instanceId, parentMessageId };
}
