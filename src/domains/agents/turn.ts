import type { Db } from "../../db/connection.ts";
import { insertEnvelope } from "../../db/journal.ts";
import { sendMessage } from "../messages/send.ts";
import { findActiveInstanceForPane } from "./instance.ts";
import { resolveEpisodeForTurn } from "./episode.ts";

export interface TurnCompleteInput {
  paneId: string;
  sessionId: string;
  sessionName?: string | undefined;
  beadId?: string | undefined;
  parentSessionId?: string | undefined;
  summary?: string | undefined;
  // Full uncompacted assistant text (xtmux-avz). Nullable in the DB and optional
  // here: turn rows predate the column and capture failures leave it null. The
  // compact `summary` remains the always-present preview field.
  lastMessageText?: string | undefined;
  turnIndex?: number | undefined;
  parentMessageText?: string | undefined;   // if set + parent, send message and link
  instanceId?: string | undefined;
  // xtmux-gdk: true when this turn starts a fresh response episode (a Stop
  // that is not a stop_hook_active continuation). False/absent attaches to the
  // pane's open episode, lazy-opening one when none exists.
  episodeOpen?: boolean | undefined;
  // Durable source/event identity for replay dedupe (xtmux-gdk review P2):
  // the Claude Stop hook emits sha256(session\0transcript_path\0size\0text).
  // An exact replay reproduces the key and is absorbed (one candidate row, no
  // fresh episode); identical text at a distinct source position differs in
  // the transcript size and stays a legitimate second candidate.
  sourceKey?: string | undefined;
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

    // Replay dedupe runs BEFORE episode resolution: a replayed Stop must not
    // open a fresh episode (episode_open=1) or attach again — the original
    // delivery already did. The unique index is the atomic net for a raced
    // double-delivery; the look-up keeps the replay fully side-effect free.
    if (input.sourceKey) {
      const existing = db.raw
        .prepare<{ id: number }, [string]>(
          "SELECT id FROM agent_turns WHERE source_key = ?",
        )
        .get(input.sourceKey);
      if (existing) {
        turnId = existing.id;
        return;
      }
    }

    const episodeId = resolveEpisodeForTurn(db, input.paneId, input.sessionId, instanceId, input.episodeOpen === true, now);
    const turnRow = db.raw
      .prepare<{ id: number }, [
        string | null, string, string, string | null, string | null,
        number | null, string | null, string | null, number, number | null,
        string | null,
      ]>(
        `INSERT OR IGNORE INTO agent_turns
           (instance_id, session_id, pane_id, bead_id, parent_session_id,
            turn_index, summary, last_message_text, completed_at_ms, episode_id,
            source_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        input.lastMessageText ?? null,
        completedAtMs,
        episodeId,
        input.sourceKey ?? null,
      );
    turnId = turnRow?.id ?? 0;
    if (!turnId) return; // raced replay: the unique index won — no row, no message

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
        module: "agents",
        level: "info",
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

export interface LastTurn {
  turnId: number;
  paneId: string;
  sessionId: string;
  instanceId: string | null;
  beadId: string | null;
  turnIndex: number | null;
  summary: string | null;
  lastMessageText: string | null;
  completedAtMs: number;
  runtime: string | null;
}

/**
 * Most recent agent_turns row for a pane or session, newest first. A pane id
 * (`%N`) matches pane_id; anything else is treated as a session id (`$N`).
 * Returns null when no turn exists. `last_message_text` is the full uncompacted text;
 * `summary` is the always-present compact fallback for badges/previews.
 */
export function findLastTurn(db: Db, target: string): LastTurn | null {
  if (!target) return null;
  const byPane = target.startsWith("%");
  const where = byPane ? "t.pane_id = ?" : "t.session_id = ?";
  // Pane ids are canonical `%N`; every other target is treated as the stable
  // session id (`$N`). Session names are not stored on turn rows.
  const row = db.raw
    .prepare<
      {
        id: number;
        pane_id: string;
        session_id: string;
        instance_id: string | null;
        bead_id: string | null;
        turn_index: number | null;
        summary: string | null;
        last_message_text: string | null;
        completed_at_ms: number;
        runtime: string | null;
      },
      [string]
    >(
      `SELECT t.id, t.pane_id, t.session_id, t.instance_id, t.bead_id,
              t.turn_index, t.summary, t.last_message_text, t.completed_at_ms,
              i.runtime
         FROM agent_turns t
         LEFT JOIN agent_instances i ON i.instance_id = t.instance_id
         WHERE ${where}
         ORDER BY t.completed_at_ms DESC, t.id DESC
         LIMIT 1`,
    )
    .get(target);
  if (!row) return null;
  return {
    turnId: row.id,
    paneId: row.pane_id,
    sessionId: row.session_id,
    instanceId: row.instance_id,
    beadId: row.bead_id,
    turnIndex: row.turn_index,
    summary: row.summary,
    lastMessageText: row.last_message_text,
    completedAtMs: row.completed_at_ms,
    runtime: row.runtime,
  };
}
