import type { Db } from "../../db/connection.ts";
import { insertEnvelope } from "../../db/journal.ts";
import type { TerminalStatus } from "./terminal.ts";

export const OUTBOUND_WAIT_STATES = [
  "unarmed",
  "armed",
  "terminal-unconsumed",
  "consumed",
  "cancelled",
  "expired",
] as const;

export type OutboundWaitState = (typeof OUTBOUND_WAIT_STATES)[number];

interface WaitRow {
  id: string;
  requester_session_id: string;
  requester_pane_id: string;
  target_session_id: string;
  target_pane_id: string;
  related_message_id: number | null;
  monitor_id: string | null;
  state: OutboundWaitState;
  terminal_status: TerminalStatus | null;
  terminal_at_ms: number | null;
  wake_delivered_at_ms: number | null;
  wake_consumed_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
  expires_at_ms: number | null;
}

export interface OutboundWait {
  waitId: string;
  requesterSessionId: string;
  requesterPaneId: string;
  targetSessionId: string;
  targetPaneId: string;
  relatedMessageId: number | null;
  monitorId: string | null;
  state: OutboundWaitState;
  terminalStatus: TerminalStatus | null;
  terminalAtMs: number | null;
  wakeDeliveredAtMs: number | null;
  wakeConsumedAtMs: number | null;
  wakeDelivered: boolean;
  wakeConsumed: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number | null;
}

export interface RegisterOutboundWaitInput {
  waitId: string;
  requesterSessionId: string;
  requesterPaneId: string;
  targetSessionId: string;
  targetPaneId: string;
  relatedMessageId?: number | undefined;
  expiresAtMs?: number | undefined;
  nowMs: number;
}

export interface ArmOutboundWaitInput {
  waitId: string;
  monitorId: string;
  requesterSessionId?: string | undefined;
  requesterPaneId?: string | undefined;
  nowMs: number;
}

export interface ConsumeOutboundWakeInput {
  waitId: string;
  requesterSessionId: string;
  requesterPaneId: string;
  nowMs: number;
}

export interface OwnedWaitInput {
  waitId: string;
  requesterSessionId: string;
  requesterPaneId: string;
  nowMs: number;
  reasonCode?: string | undefined;
}

export interface WaitMutationResult {
  wait: OutboundWait;
  duplicate: boolean;
}

export interface WakeDeliveryResult {
  wait: OutboundWait;
  delivered: boolean;
  duplicate: boolean;
}

export interface WakeConsumptionResult {
  wait: OutboundWait;
  consumed: boolean;
  duplicate: boolean;
}

export class OutboundWaitNotFoundError extends Error {
  readonly code = "wait.not_found";
  constructor(readonly waitId: string) {
    super(`outbound wait not found: ${waitId}`);
    this.name = "OutboundWaitNotFoundError";
  }
}

export class OutboundWaitOwnershipError extends Error {
  readonly code = "wait.not_owner";
  constructor(
    readonly waitId: string,
    readonly expectedSessionId: string,
    readonly expectedPaneId: string,
    readonly actualSessionId: string,
    readonly actualPaneId: string,
  ) {
    super(`outbound wait is owned by ${expectedSessionId}/${expectedPaneId}`);
    this.name = "OutboundWaitOwnershipError";
  }
}

export class OutboundWaitTargetMismatchError extends Error {
  readonly code = "wait.target_mismatch";
  constructor(readonly waitId: string, readonly monitorId: string) {
    super(`monitor ${monitorId} does not target outbound wait ${waitId}`);
    this.name = "OutboundWaitTargetMismatchError";
  }
}

function requireId(value: string, field: string): void {
  if (value.length === 0) throw new Error(`outbound wait: ${field} is required`);
}

function asWait(row: WaitRow): OutboundWait {
  return {
    waitId: row.id,
    requesterSessionId: row.requester_session_id,
    requesterPaneId: row.requester_pane_id,
    targetSessionId: row.target_session_id,
    targetPaneId: row.target_pane_id,
    relatedMessageId: row.related_message_id,
    monitorId: row.monitor_id,
    state: row.state,
    terminalStatus: row.terminal_status,
    terminalAtMs: row.terminal_at_ms,
    wakeDeliveredAtMs: row.wake_delivered_at_ms,
    wakeConsumedAtMs: row.wake_consumed_at_ms,
    wakeDelivered: row.wake_delivered_at_ms !== null,
    wakeConsumed: row.wake_consumed_at_ms !== null,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    expiresAtMs: row.expires_at_ms,
  };
}

const WAIT_COLUMNS = `
  id, requester_session_id, requester_pane_id, target_session_id, target_pane_id,
  related_message_id, monitor_id, state, terminal_status, terminal_at_ms,
  wake_delivered_at_ms, wake_consumed_at_ms, created_at_ms, updated_at_ms, expires_at_ms
`;

const QUALIFIED_WAIT_COLUMNS = `
  w.id, w.requester_session_id, w.requester_pane_id, w.target_session_id, w.target_pane_id,
  w.related_message_id, w.monitor_id, w.state, w.terminal_status, w.terminal_at_ms,
  w.wake_delivered_at_ms, w.wake_consumed_at_ms, w.created_at_ms, w.updated_at_ms, w.expires_at_ms
`;

function findWait(db: Db, waitId: string): WaitRow | null {
  return db.raw
    .query<WaitRow, [string]>(`SELECT ${WAIT_COLUMNS} FROM outbound_waits WHERE id = ?`)
    .get(waitId) ?? null;
}

function requireWait(db: Db, waitId: string): WaitRow {
  const row = findWait(db, waitId);
  if (!row) throw new OutboundWaitNotFoundError(waitId);
  return row;
}

function journalWait(
  db: Db,
  type: string,
  row: WaitRow,
  payload: Record<string, unknown>,
  createdAtMs: number,
): void {
  insertEnvelope(db, {
    type,
    domain: "monitors",
    sessionId: row.requester_session_id,
    paneId: row.requester_pane_id,
    correlationId: `wait:${row.id}`,
    payload: {
      wait_id: row.id,
      requester_session_id: row.requester_session_id,
      requester_pane_id: row.requester_pane_id,
      target_session_id: row.target_session_id,
      target_pane_id: row.target_pane_id,
      ...payload,
    },
    createdAtMs,
  });
}

function boundedReason(reasonCode: string | undefined): string {
  if (reasonCode === undefined) return "requested";
  return /^[a-z0-9_.-]{1,64}$/.test(reasonCode) ? reasonCode : "invalid_reason";
}

function assertOwner(row: WaitRow, sessionId: string, paneId: string): void {
  if (row.requester_session_id === sessionId && row.requester_pane_id === paneId) return;
  throw new OutboundWaitOwnershipError(
    row.id,
    row.requester_session_id,
    row.requester_pane_id,
    sessionId,
    paneId,
  );
}

function journalOwnershipFailure(
  db: Db,
  row: WaitRow,
  sessionId: string,
  paneId: string,
  operation: string,
  nowMs: number,
): void {
  journalWait(db, "wait.validation_failed", row, {
    operation,
    reason_code: "not_owner",
    actual_session_id: sessionId,
    actual_pane_id: paneId,
  }, nowMs);
}

export function registerOutboundWait(
  db: Db,
  input: RegisterOutboundWaitInput,
): WaitMutationResult {
  requireId(input.waitId, "waitId");
  requireId(input.requesterSessionId, "requesterSessionId");
  requireId(input.requesterPaneId, "requesterPaneId");
  requireId(input.targetSessionId, "targetSessionId");
  requireId(input.targetPaneId, "targetPaneId");

  let result: WaitMutationResult | undefined;
  const tx = db.raw.transaction(() => {
    const existing = findWait(db, input.waitId);
    if (existing) {
      if (
        existing.requester_session_id !== input.requesterSessionId ||
        existing.requester_pane_id !== input.requesterPaneId ||
        existing.target_session_id !== input.targetSessionId ||
        existing.target_pane_id !== input.targetPaneId
      ) {
        throw new Error(`outbound wait ${input.waitId}: identity conflict`);
      }
      result = { wait: asWait(existing), duplicate: true };
      return;
    }

    db.raw
      .prepare<unknown, [string, string, string, string, string, number | null, number, number, number | null]>(
        `INSERT INTO outbound_waits
          (id, requester_session_id, requester_pane_id, target_session_id, target_pane_id,
           related_message_id, state, created_at_ms, updated_at_ms, expires_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, 'unarmed', ?, ?, ?)`,
      )
      .run(
        input.waitId,
        input.requesterSessionId,
        input.requesterPaneId,
        input.targetSessionId,
        input.targetPaneId,
        input.relatedMessageId ?? null,
        input.nowMs,
        input.nowMs,
        input.expiresAtMs ?? null,
      );
    const row = requireWait(db, input.waitId);
    journalWait(db, "wait.registered", row, {
      related_message_id: row.related_message_id,
      expires_at_ms: row.expires_at_ms,
    }, input.nowMs);
    result = { wait: asWait(row), duplicate: false };
  });
  tx.immediate();
  if (!result) throw new Error(`outbound wait ${input.waitId}: registration produced no result`);
  return result;
}

export function armOutboundWait(
  db: Db,
  input: ArmOutboundWaitInput,
): WaitMutationResult {
  requireId(input.waitId, "waitId");
  requireId(input.monitorId, "monitorId");

  let result: WaitMutationResult | undefined;
  let targetMismatch = false;
  let ownershipError: OutboundWaitOwnershipError | undefined;
  const tx = db.raw.transaction(() => {
    const row = requireWait(db, input.waitId);
    if (input.requesterSessionId !== undefined && input.requesterPaneId !== undefined) {
      try {
        assertOwner(row, input.requesterSessionId, input.requesterPaneId);
      } catch (err) {
        if (!(err instanceof OutboundWaitOwnershipError)) throw err;
        journalOwnershipFailure(db, row, input.requesterSessionId, input.requesterPaneId, "arm", input.nowMs);
        ownershipError = err;
        return;
      }
    }
    if (row.state !== "unarmed") {
      result = { wait: asWait(row), duplicate: true };
      return;
    }
    if (row.expires_at_ms !== null && input.nowMs >= row.expires_at_ms) {
      db.raw
        .prepare<unknown, [number, string]>(
          "UPDATE outbound_waits SET state = 'expired', updated_at_ms = ? WHERE id = ? AND state = 'unarmed'",
        )
        .run(input.nowMs, input.waitId);
      const expired = requireWait(db, input.waitId);
      journalWait(db, "wait.expired", expired, {
        reason_code: "expired_before_arm",
      }, input.nowMs);
      result = { wait: asWait(expired), duplicate: false };
      return;
    }

    const monitor = db.raw
      .query<{ session_id: string | null; pane_id: string }, [string]>(
        "SELECT session_id, pane_id FROM monitors WHERE id = ?",
      )
      .get(input.monitorId);
    if (!monitor || monitor.session_id !== row.target_session_id || monitor.pane_id !== row.target_pane_id) {
      journalWait(db, "wait.validation_failed", row, {
        operation: "arm",
        reason_code: "target_mismatch",
        monitor_id: input.monitorId,
        actual_target_session_id: monitor?.session_id ?? null,
        actual_target_pane_id: monitor?.pane_id ?? null,
      }, input.nowMs);
      targetMismatch = true;
      return;
    }

    db.raw
      .prepare<unknown, [string, number, string]>(
        `UPDATE outbound_waits
            SET monitor_id = ?, state = 'armed', updated_at_ms = ?
          WHERE id = ? AND state = 'unarmed' AND monitor_id IS NULL`,
      )
      .run(input.monitorId, input.nowMs, input.waitId);
    const armed = requireWait(db, input.waitId);
    journalWait(db, "wait.monitor.armed", armed, {
      monitor_id: input.monitorId,
      duplicate: false,
    }, input.nowMs);
    result = { wait: asWait(armed), duplicate: false };
  });
  tx.immediate();

  if (ownershipError) throw ownershipError;
  if (targetMismatch) throw new OutboundWaitTargetMismatchError(input.waitId, input.monitorId);
  if (!result) throw new Error(`outbound wait ${input.waitId}: arm produced no result`);
  return result;
}

export function terminalizeOutboundWait(
  db: Db,
  monitorId: string,
  terminalStatus: TerminalStatus,
  nowMs: number,
): boolean {
  requireId(monitorId, "monitorId");
  let changed = false;
  const tx = db.raw.transaction(() => {
    const row = db.raw
      .query<WaitRow, [string]>(
        `SELECT ${WAIT_COLUMNS} FROM outbound_waits
          WHERE monitor_id = ? AND state = 'armed'`,
      )
      .get(monitorId);
    if (!row) return;
    db.raw
      .prepare<unknown, [string, number, number, string]>(
        `UPDATE outbound_waits
            SET state = 'terminal-unconsumed', terminal_status = ?, terminal_at_ms = ?, updated_at_ms = ?
          WHERE monitor_id = ? AND state = 'armed'`,
      )
      .run(terminalStatus, nowMs, nowMs, monitorId);
    journalWait(db, "wait.terminal", row, {
      monitor_id: monitorId,
      terminal_status: terminalStatus,
      terminal_at_ms: nowMs,
    }, nowMs);
    changed = true;
  });
  tx.immediate();
  return changed;
}

export function replayOutboundWakes(db: Db, nowMs: number): number {
  let replayed = 0;
  const tx = db.raw.transaction(() => {
    const rows = db.raw
      .query<WaitRow, []>(
        `SELECT ${QUALIFIED_WAIT_COLUMNS}
           FROM outbound_waits AS w
           JOIN monitors AS m ON m.id = w.monitor_id
          WHERE w.state = 'armed' AND m.terminal_status IS NOT NULL`,
      )
      .all();
    for (const row of rows) {
      const monitor = db.raw
        .query<{ terminal_status: TerminalStatus; terminal_at_ms: number | null }, [string]>(
          "SELECT terminal_status, terminal_at_ms FROM monitors WHERE id = ?",
        )
        .get(row.monitor_id ?? "");
      if (!monitor || row.monitor_id === null) continue;
      db.raw
        .prepare<unknown, [string, number, number, string]>(
          `UPDATE outbound_waits
              SET state = 'terminal-unconsumed', terminal_status = ?, terminal_at_ms = ?, updated_at_ms = ?
            WHERE monitor_id = ? AND state = 'armed'`,
        )
        .run(monitor.terminal_status, monitor.terminal_at_ms ?? nowMs, nowMs, row.monitor_id);
      journalWait(db, "wait.terminal", row, {
        monitor_id: row.monitor_id,
        terminal_status: monitor.terminal_status,
        terminal_at_ms: monitor.terminal_at_ms ?? nowMs,
        replayed: true,
      }, nowMs);
      replayed++;
    }
    const orphans = db.raw
      .query<{
        id: string;
        session_id: string | null;
        pane_id: string;
        terminal_status: TerminalStatus;
      }, []>(
        `SELECT m.id, m.session_id, m.pane_id, m.terminal_status
           FROM monitors AS m
           LEFT JOIN outbound_waits AS w ON w.monitor_id = m.id
          WHERE m.terminal_status IS NOT NULL AND w.id IS NULL`,
      )
      .all();
    for (const orphan of orphans) {
      const eventKey = `wait.orphan:${orphan.id}`;
      const alreadyJournaled = db.raw
        .query<{ id: number }, [string]>("SELECT id FROM event_journal WHERE event_key = ?")
        .get(eventKey);
      if (alreadyJournaled) continue;
      insertEnvelope(db, {
        eventKey,
        type: "wait.wake.orphan",
        domain: "monitors",
        sessionId: orphan.session_id ?? undefined,
        paneId: orphan.pane_id,
        correlationId: `monitor:${orphan.id}`,
        payload: {
          monitor_id: orphan.id,
          target_session_id: orphan.session_id,
          target_pane_id: orphan.pane_id,
          terminal_status: orphan.terminal_status,
          reason_code: "no_linked_wait",
        },
        createdAtMs: nowMs,
      });
    }
  });
  tx.immediate();
  return replayed;
}

export function deliverOutboundWake(
  db: Db,
  waitId: string,
  nowMs: number,
): WakeDeliveryResult {
  let result: WakeDeliveryResult | undefined;
  const tx = db.raw.transaction(() => {
    const row = requireWait(db, waitId);
    if (row.state !== "terminal-unconsumed" || row.wake_delivered_at_ms !== null) {
      result = { wait: asWait(row), delivered: false, duplicate: row.wake_delivered_at_ms !== null };
      return;
    }
    db.raw
      .prepare<unknown, [number, number, string]>(
        `UPDATE outbound_waits
            SET wake_delivered_at_ms = ?, updated_at_ms = ?
          WHERE id = ? AND state = 'terminal-unconsumed' AND wake_delivered_at_ms IS NULL`,
      )
      .run(nowMs, nowMs, waitId);
    const delivered = requireWait(db, waitId);
    journalWait(db, "wait.wake.delivered", delivered, {
      monitor_id: delivered.monitor_id,
      delivery_timestamp_ms: nowMs,
      duplicate: false,
    }, nowMs);
    result = { wait: asWait(delivered), delivered: true, duplicate: false };
  });
  tx.immediate();
  if (!result) throw new Error(`outbound wait ${waitId}: delivery produced no result`);
  return result;
}

export function consumeOutboundWake(
  db: Db,
  input: ConsumeOutboundWakeInput,
): WakeConsumptionResult {
  let result: WakeConsumptionResult | undefined;
  let ownershipError: OutboundWaitOwnershipError | undefined;
  const tx = db.raw.transaction(() => {
    const row = requireWait(db, input.waitId);
    if (row.requester_session_id !== input.requesterSessionId || row.requester_pane_id !== input.requesterPaneId) {
      journalOwnershipFailure(db, row, input.requesterSessionId, input.requesterPaneId, "consume", input.nowMs);
      ownershipError = new OutboundWaitOwnershipError(
        row.id,
        row.requester_session_id,
        row.requester_pane_id,
        input.requesterSessionId,
        input.requesterPaneId,
      );
      return;
    }
    if (row.state === "consumed") {
      result = { wait: asWait(row), consumed: false, duplicate: true };
      return;
    }
    if (row.state !== "terminal-unconsumed") {
      result = { wait: asWait(row), consumed: false, duplicate: false };
      return;
    }
    db.raw
      .prepare<unknown, [number, number, string]>(
        `UPDATE outbound_waits
            SET state = 'consumed', wake_consumed_at_ms = ?, updated_at_ms = ?
          WHERE id = ? AND state = 'terminal-unconsumed'`,
      )
      .run(input.nowMs, input.nowMs, input.waitId);
    const consumed = requireWait(db, input.waitId);
    journalWait(db, "wait.wake.consumed", consumed, {
      monitor_id: consumed.monitor_id,
      wake_consumed_at_ms: input.nowMs,
    }, input.nowMs);
    result = { wait: asWait(consumed), consumed: true, duplicate: false };
  });
  tx.immediate();
  if (ownershipError) throw ownershipError;
  if (!result) throw new Error(`outbound wait ${input.waitId}: consumption produced no result`);
  return result;
}

function transitionOwnedWait(
  db: Db,
  input: OwnedWaitInput,
  state: "cancelled" | "expired",
  eventType: "wait.cancelled" | "wait.expired",
): WaitMutationResult {
  let result: WaitMutationResult | undefined;
  let ownershipError: OutboundWaitOwnershipError | undefined;
  const tx = db.raw.transaction(() => {
    const row = requireWait(db, input.waitId);
    try {
      assertOwner(row, input.requesterSessionId, input.requesterPaneId);
    } catch (err) {
      if (!(err instanceof OutboundWaitOwnershipError)) throw err;
      journalOwnershipFailure(db, row, input.requesterSessionId, input.requesterPaneId, state, input.nowMs);
      ownershipError = err;
      return;
    }
    if (row.state !== "unarmed" && row.state !== "armed") {
      result = { wait: asWait(row), duplicate: true };
      return;
    }
    db.raw
      .prepare<unknown, [string, number, string]>(
        "UPDATE outbound_waits SET state = ?, updated_at_ms = ? WHERE id = ? AND state IN ('unarmed', 'armed')",
      )
      .run(state, input.nowMs, input.waitId);
    const transitioned = requireWait(db, input.waitId);
    journalWait(db, eventType, transitioned, {
      reason_code: boundedReason(input.reasonCode),
    }, input.nowMs);
    result = { wait: asWait(transitioned), duplicate: false };
  });
  tx.immediate();
  if (ownershipError) throw ownershipError;
  if (!result) throw new Error(`outbound wait ${input.waitId}: transition produced no result`);
  return result;
}

export function cancelOutboundWait(db: Db, input: OwnedWaitInput): WaitMutationResult {
  return transitionOwnedWait(db, input, "cancelled", "wait.cancelled");
}

export function expireOutboundWait(db: Db, input: OwnedWaitInput): WaitMutationResult {
  return transitionOwnedWait(db, input, "expired", "wait.expired");
}

export function getOutboundWait(
  db: Db,
  waitId: string,
  requesterSessionId: string,
  requesterPaneId: string,
): OutboundWait {
  const row = requireWait(db, waitId);
  assertOwner(row, requesterSessionId, requesterPaneId);
  return asWait(row);
}

export function listOutboundWaits(
  db: Db,
  requesterSessionId: string,
  requesterPaneId: string,
): OutboundWait[] {
  return db.raw
    .query<WaitRow, [string, string]>(
      `SELECT ${WAIT_COLUMNS} FROM outbound_waits
        WHERE requester_session_id = ? AND requester_pane_id = ?
          AND state IN ('unarmed', 'armed', 'terminal-unconsumed')
        ORDER BY created_at_ms, id`,
    )
    .all(requesterSessionId, requesterPaneId)
    .map(asWait);
}

export const registerWait = registerOutboundWait;
export const armWait = armOutboundWait;
export const terminalizeWait = terminalizeOutboundWait;
export const reconcileOutboundWakes = replayOutboundWakes;
export const deliverWake = deliverOutboundWake;
export const consumeWake = consumeOutboundWake;
export const cancelWait = cancelOutboundWait;
export const expireWait = expireOutboundWait;
export const listWaits = listOutboundWaits;
