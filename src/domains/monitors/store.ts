import type { Db } from "../../db/connection.ts";
import { insertEnvelope } from "../../db/journal.ts";
import {
  assertHeartbeat,
  assertTransition,
  leaseExpiry,
  reconcile as decide,
  type TerminalStatus,
} from "./terminal.ts";

/**
 * Monitor registry (xtmux-3xs.4, PRD §11).
 *
 * V1 kept this in per-monitor TSV files under /tmp, rewritten on every poll tick,
 * deleted when the poller exited — so a crashed poller leaked a file, and a
 * finished monitor left no history at all. Here the row is authoritative, poll
 * ticks update columns in place, and terminal state is preserved.
 */

export class MonitorNotFoundError extends Error {
  readonly code = "monitor.not_found";
  constructor(readonly monitorId: string) {
    super(`monitor not found: ${monitorId}`);
    this.name = "MonitorNotFoundError";
  }
}

export interface RegisterInput {
  id: string;
  target: string;
  paneId: string;
  sessionId?: string | undefined;
  instanceId?: string | undefined;
  state: string;
  /** V1 encodes "no timeout" as 0; NULL means the same thing here */
  timeoutMs?: number | undefined;
  intervalMs: number;
  nowMs: number;
}

interface LifecycleRow {
  terminal_status: TerminalStatus | null;
  interval_ms: number;
  state: string;
  session_id: string | null;
  pane_id: string;
}

function lifecycle(db: Db, id: string): LifecycleRow {
  const row = db.raw
    .query<LifecycleRow, { $id: string }>(
      `SELECT terminal_status, interval_ms, state, session_id, pane_id FROM monitors WHERE id = $id`,
    )
    .get({ $id: id });
  if (!row) throw new MonitorNotFoundError(id);
  return row;
}

export function registerWithinTransaction(db: Db, m: RegisterInput): void {
  db.raw
    .query(
      `INSERT INTO monitors (id, owner_pid, target, session_id, pane_id, instance_id, state,
                             started_at_ms, updated_at_ms, heartbeat_at_ms, lease_expires_at_ms,
                             timeout_ms, interval_ms)
       VALUES ($id, NULL, $target, $sessionId, $paneId, $instanceId, $state,
               $now, $now, $now, $lease, $timeoutMs, $intervalMs)`,
    )
    .run({
      $id: m.id,
      $target: m.target,
      $sessionId: m.sessionId ?? null,
      $paneId: m.paneId,
      $instanceId: m.instanceId ?? null,
      $state: m.state,
      $now: m.nowMs,
      $lease: leaseExpiry(m.nowMs, m.intervalMs),
      $timeoutMs: m.timeoutMs && m.timeoutMs > 0 ? m.timeoutMs : null,
      $intervalMs: m.intervalMs,
    });

  insertEnvelope(db, {
    type: "monitor.started",
    domain: "monitors",
    correlationId: m.id,
    sessionId: m.sessionId,
    paneId: m.paneId,
    instanceId: m.instanceId,
    payload: {
      target: m.target,
      state: m.state,
      timeout_ms: m.timeoutMs ?? 0,
      interval_ms: m.intervalMs,
    },
    createdAtMs: m.nowMs,
  });
}

export function register(db: Db, m: RegisterInput): void {
  const tx = db.raw.transaction(() => registerWithinTransaction(db, m));
  tx();
}

/**
 * The background poller has forked and has a PID. This is V1's second TSV write;
 * here it is an UPDATE of the same row, never a second insert.
 */
export function adopt(db: Db, id: string, ownerPid: number, nowMs: number): void {
  db.raw
    .query(
      `UPDATE monitors SET owner_pid = $pid, updated_at_ms = $now
        WHERE id = $id AND terminal_status IS NULL`,
    )
    .run({ $pid: ownerPid, $now: nowMs, $id: id });
}

/**
 * One poll tick: refresh observed state, heartbeat, and lease — in place, always.
 *
 * An envelope is written only when the observed state actually *changed*. That is
 * what reconciles the phase's two constraints: "every state transition writes an
 * event_journal envelope" and "do not append one historical event per poll tick".
 * A monitor polling every 30s for an hour and seeing `working` throughout is one
 * fact, not 120 of them.
 *
 * @returns true if the observed state changed (and an envelope was written).
 */
export function heartbeat(db: Db, id: string, state: string, nowMs: number): boolean {
  const row = lifecycle(db, id);
  assertHeartbeat(id, row.terminal_status); // a terminal monitor observes nothing

  db.raw
    .query(
      `UPDATE monitors
          SET state = $state, updated_at_ms = $now, heartbeat_at_ms = $now,
              lease_expires_at_ms = $lease
        WHERE id = $id AND terminal_status IS NULL`,
    )
    .run({ $state: state, $now: nowMs, $lease: leaseExpiry(nowMs, row.interval_ms), $id: id });

  if (state === row.state) return false;

  insertEnvelope(db, {
    type: "monitor.state",
    domain: "monitors",
    correlationId: id,
    sessionId: row.session_id ?? undefined,
    paneId: row.pane_id,
    payload: { from: row.state, to: state },
    createdAtMs: nowMs,
  });
  return true;
}

/**
 * Move the monitor to its one terminal status.
 *
 * Idempotent when the same status is re-asserted: the poll loop and a
 * reconciliation pass can independently reach the same conclusion, and that is
 * one fact observed twice, not an illegal transition. A *different* terminal
 * status on an already-terminal row throws.
 *
 * @returns true if this call performed the transition, false if it was a no-op.
 */
export function terminate(
  db: Db,
  id: string,
  status: TerminalStatus,
  nowMs: number,
  detail?: string,
): boolean {
  const row = lifecycle(db, id);
  if (!assertTransition(id, row.terminal_status, status)) return false;

  db.raw
    .query(
      `UPDATE monitors
          SET terminal_status = $status, terminal_at_ms = $now, terminal_detail = $detail,
              updated_at_ms = $now
        WHERE id = $id AND terminal_status IS NULL`,
    )
    .run({ $status: status, $now: nowMs, $detail: detail ?? null, $id: id });

  insertEnvelope(db, {
    type: `monitor.${status}`,
    domain: "monitors",
    correlationId: id,
    sessionId: row.session_id ?? undefined,
    paneId: row.pane_id,
    payload: {
      outcome: status === "error" ? "error" : "ok",
      ...(detail ? { detail } : {}),
    },
    createdAtMs: nowMs,
  });
  return true;
}

export interface Probes {
  /** kill -0 */
  pidAlive(pid: number): boolean;
  /** does the tmux pane still exist? */
  paneAlive(paneId: string): boolean;
}

interface ActiveRow {
  id: string;
  owner_pid: number | null;
  pane_id: string;
  lease_expires_at_ms: number | null;
  started_at_ms: number;
  timeout_ms: number | null;
}

/**
 * Decide and apply a terminal status for every active monitor that has one coming.
 *
 * V1 had no crash recovery: a monitor whose poller died left an orphan TSV until
 * someone happened to run monitor-list with a dead PID, and a lease did not exist
 * at all. Every monitor-list runs this, so a crash mid-poll converges on the next
 * read instead of leaking forever.
 */
export function reconcileAll(
  db: Db,
  probes: Probes,
  nowMs: number,
): Array<{ id: string; status: TerminalStatus }> {
  const active = db.raw
    .query<ActiveRow, []>(
      `SELECT id, owner_pid, pane_id, lease_expires_at_ms, started_at_ms, timeout_ms
         FROM monitors WHERE terminal_status IS NULL`,
    )
    .all();

  const terminated: Array<{ id: string; status: TerminalStatus }> = [];

  for (const row of active) {
    const status = decide({
      terminalStatus: null,
      ownerPid: row.owner_pid,
      leaseExpiresAtMs: row.lease_expires_at_ms,
      startedAtMs: row.started_at_ms,
      timeoutMs: row.timeout_ms,
      nowMs,
      pidAlive: row.owner_pid === null ? true : probes.pidAlive(row.owner_pid),
      paneAlive: probes.paneAlive(row.pane_id),
    });
    if (!status) continue;

    // terminate() is idempotent, so racing the monitor's own poll loop to the
    // same conclusion is safe.
    if (terminate(db, row.id, status, nowMs, "reconcile")) {
      terminated.push({ id: row.id, status });
    }
  }
  return terminated;
}

export interface KillDeps {
  /** SIGTERM the poller. V1 ignores failure — the process may already be gone. */
  signal(pid: number): void;
}

/**
 * monitor-kill. V1 killed the PID and deleted the TSV, so the monitor's history
 * went with it. The process is still signalled, but the row is PRESERVED with
 * terminal_status='killed' — the contract requires terminal history to survive.
 *
 * V1 stdout is preserved: `killed\t<id>`.
 */
export function kill(db: Db, deps: KillDeps, id: string, nowMs: number): string {
  const row = db.raw
    .query<{ owner_pid: number | null }, { $id: string }>(
      `SELECT owner_pid FROM monitors WHERE id = $id`,
    )
    .get({ $id: id });
  if (!row) throw new MonitorNotFoundError(id);

  if (row.owner_pid !== null) deps.signal(row.owner_pid);
  terminate(db, id, "killed", nowMs);
  return `killed\t${id}`;
}

export interface ListDeps extends Probes {
  /** current @agent_state of the pane; '' if it cannot be observed */
  observe(paneId: string): string;
}

interface ListRow {
  id: string;
  owner_pid: number | null;
  target: string;
  session_id: string | null;
  pane_id: string;
  state: string;
  started_at_ms: number;
  timeout_ms: number | null;
  interval_ms: number;
}

export interface MonitorResult {
  monitorId: string;
  ownerPid: number | null;
  target: string;
  sessionId: string | null;
  paneId: string;
  state: string;
  startedAtMs: number;
  updatedAtMs: number;
  timeoutMs: number | null;
  intervalMs: number;
  terminalStatus: null;
  terminalAtMs: null;
  terminalDetail: null;
}

const msToS = (ms: number): number => Math.floor(ms / 1000);

/**
 * monitor-list, byte-identical to V1's stdout (PRD §20): a 10-column TSV in
 * seconds — monitor, id, pid, target, pane, state, start, timeout, interval, updated.
 *
 * V1 semantics preserved deliberately:
 *   - only ACTIVE monitors are listed. V1 deleted a dead monitor's TSV as it
 *     scanned, so a terminal monitor never appeared. Here the row survives (Phase 9
 *     needs its terminal history) but stays out of the listing.
 *   - the pane is re-observed on read and the row's heartbeat refreshed — V1's
 *     "mutate on read". Kept: monitor-list is what pushes a stalled monitor forward.
 *     The difference is that V2 updates columns in place instead of rewriting a TSV
 *     and appending a historical event per tick.
 *   - `pid` prints `starting` until the poller is adopted; `timeout` prints 0 when
 *     there is none; sorted by start then id (V1: `sort -k6,6 -k2,2`, lexical).
 */
export function listResults(db: Db, deps: ListDeps, nowMs: number): MonitorResult[] {
  reconcileAll(db, deps, nowMs);
  const rows = db.raw
    .query<ListRow, []>(
      `SELECT id, owner_pid, target, session_id, pane_id, state, started_at_ms, timeout_ms, interval_ms
         FROM monitors WHERE terminal_status IS NULL`,
    )
    .all();
  const results = rows.map((row) => {
    const state = deps.observe(row.pane_id) || row.state;
    heartbeat(db, row.id, state, nowMs);
    return {
      monitorId: row.id,
      ownerPid: row.owner_pid,
      target: row.target,
      sessionId: row.session_id,
      paneId: row.pane_id,
      state,
      startedAtMs: row.started_at_ms,
      updatedAtMs: nowMs,
      timeoutMs: row.timeout_ms,
      intervalMs: row.interval_ms,
      terminalStatus: null,
      terminalAtMs: null,
      terminalDetail: null,
    } satisfies MonitorResult;
  });
  return results.sort((a, b) => a.startedAtMs - b.startedAtMs || a.monitorId.localeCompare(b.monitorId));
}

export function list(db: Db, deps: ListDeps, nowMs: number): string[] {
  return listResults(db, deps, nowMs).map((row) => [
    "monitor",
    row.monitorId,
    row.ownerPid === null ? "starting" : String(row.ownerPid),
    row.target,
    row.paneId,
    row.state,
    msToS(row.startedAtMs),
    row.timeoutMs === null ? 0 : msToS(row.timeoutMs),
    msToS(row.intervalMs),
    msToS(row.updatedAtMs),
  ].join("\t"));
}
