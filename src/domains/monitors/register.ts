/**
 * monitor-agent: create the monitor row (xtmux-3xs.4).
 *
 * V1 wrote a /tmp TSV here and rewrote it once the poller had a PID. The row is
 * created the same way — before the background poller exists, so owner_pid is
 * NULL until adopt() runs — but it lands in SQLite and emits one journal
 * envelope instead of an append to events.jsonl.
 */
import type { Database } from 'bun:sqlite'
import type { EventJournal } from '../journal'
import { leaseExpiry } from './terminal'

export interface RegisterInput {
  id: string
  target: string
  paneId: string
  sessionId?: string | null
  instanceId?: string | null
  state: string
  /** V1 encodes "no timeout" as 0; NULL is the same thing here */
  timeoutMs?: number | null
  intervalMs: number
  nowMs: number
}

export function register(db: Database, journal: EventJournal, m: RegisterInput): void {
  db.query(
    `INSERT INTO monitors (id, owner_pid, target, session_id, pane_id, instance_id, state,
                           started_at_ms, updated_at_ms, heartbeat_at_ms, lease_expires_at_ms,
                           timeout_ms, interval_ms)
     VALUES ($id, NULL, $target, $sessionId, $paneId, $instanceId, $state,
             $now, $now, $now, $lease, $timeoutMs, $intervalMs)`,
  ).run({
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
  })

  journal.write({
    domain: 'monitors',
    event: 'monitor.started',
    correlationId: m.id,
    sessionId: m.sessionId ?? null,
    paneId: m.paneId,
    detail: { target: m.target, state: m.state, timeout_ms: m.timeoutMs, interval_ms: m.intervalMs },
  })
}

/**
 * The poller has forked and has a PID. V1's second TSV write; here it is an
 * UPDATE of the same row, never a second insert.
 */
export function adopt(db: Database, id: string, ownerPid: number, nowMs: number): void {
  db.query(
    `UPDATE monitors SET owner_pid = $pid, updated_at_ms = $now
     WHERE id = $id AND terminal_status IS NULL`,
  ).run({ $pid: ownerPid, $now: nowMs, $id: id })
}
