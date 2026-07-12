import type { Db } from "../../db/connection.ts";
import { insertEnvelope } from "../../db/journal.ts";

export type DeliveryKind =
  | "send_keys"
  | "display_message"
  | "unread_projection"
  | "second_enter"
  | "picker_action"
  | "pane_pointer"
  | "handoff_pointer";

export interface DeliveryInput {
  kind: DeliveryKind;
  sourceSessionId?: string | undefined;
  targetSessionId?: string | undefined;
  targetPaneId?: string | undefined;
  relatedMessageId?: number | undefined;
  relatedHandoffId?: string | undefined;
  payloadSummary?: string | undefined;
  succeeded: boolean;
  failureCode?: string | undefined;
  detailsJson?: string | undefined;
}

export function recordDelivery(
  db: Db,
  input: DeliveryInput,
  now: () => number = Date.now,
): number {
  const insert = db.raw.prepare<
    { id: number },
    [
      string,
      string | null,
      string | null,
      string | null,
      number | null,
      string | null,
      string | null,
      number,
      number,
      string | null,
      string | null,
    ]
  >(
    `INSERT INTO delivery_attempts
       (kind, source_session_id, target_session_id, target_pane_id,
        related_message_id, related_handoff_id, payload_summary,
        attempted_at_ms, succeeded, failure_code, details_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  );
  let id = 0;
  const attemptedAtMs = now();
  const tx = db.raw.transaction(() => {
    const row = insert.get(
      input.kind,
      input.sourceSessionId ?? null,
      input.targetSessionId ?? null,
      input.targetPaneId ?? null,
      input.relatedMessageId ?? null,
      input.relatedHandoffId ?? null,
      input.payloadSummary ?? null,
      attemptedAtMs,
      input.succeeded ? 1 : 0,
      input.failureCode ?? null,
      input.detailsJson ?? null,
    );
    id = row?.id ?? 0;
    insertEnvelope(db, {
      type: `deliveries.${input.kind}.${input.succeeded ? "ok" : "fail"}`,
      domain: "deliveries",
      sessionId: input.targetSessionId,
      paneId: input.targetPaneId,
      correlationId:
        input.relatedMessageId !== undefined
          ? `msg:${input.relatedMessageId}`
          : input.relatedHandoffId !== undefined
            ? `ho:${input.relatedHandoffId}`
            : undefined,
      payload: {
        delivery_id: id,
        kind: input.kind,
        succeeded: input.succeeded,
        failure_code: input.failureCode,
      },
      createdAtMs: attemptedAtMs,
    });
  });
  tx();
  return id;
}
