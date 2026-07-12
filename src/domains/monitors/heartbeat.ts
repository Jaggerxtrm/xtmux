/**
 * Poll-tick writes (xtmux-3xs.4).
 *
 * The whole point of the phase: a tick updates columns in place. It does NOT
 * append a historical row, and it does NOT touch /tmp. V1 rewrote a TSV file and
 * appended to events.jsonl on every tick of every monitor, which is what made
 * message-list scan mountains of unrelated traffic.
 */
import type { Database } from 'bun:sqlite'
import type { EventJournal } from '../journal'
import { assertHeartbeat, assertTransition, leaseExpiry, type TerminalStatus } from './terminal'

export class MonitorNotFoundError extends Error {
  readonly code = 'monitor.not_found'
  constructor(readonly monitorId: string) {
    super(`monitor not found: ${monitorId}`)
    this.name = 'MonitorNotFoundError'
  }
}

interface LifecycleRow {
  terminal_status: TerminalStatus | null
  interval_ms: number
  state: string
  session_id: string | null
  pane_id: string
}

function lifecycle(db: Database, id: string): LifecycleRow {
  const row = db
    .query(
      `SELECT terminal_status, interval_ms, state, session_id, pane_id FROM monitors WHERE id = $id`,
    )
    .get({ $id: id }) as LifecycleRow | null
  if (!row) throw new MonitorNotFoundError(id)
  return row
}

/**
 * One poll tick: refresh the observed state, the heartbeat, and the lease — in
 * place, always.
 *
 * An envelope is written only when the observed state actually *changed*. This is
 * what reconciles the phase's two constraints: "every state transition writes an
 * event_journal envelope" and "do not append one historical event per poll tick".
 * A monitor polling every 30s for an hour that sees `working` throughout is one
 * fact, not 120 of them.
 *
 * @returns true if the observed state changed (and an envelope was written).
 */
export function heartbeat(
  db: Database,
  journal: EventJournal,
  id: string,
  state: string,
  nowMs: number,
): boolean {
  const row = lifecycle(db, id)
  assertHeartbeat(id, row.terminal_status) // a terminal monitor is not observing anything

  db.query(
    `UPDATE monitors
        SET state = $state, updated_at_ms = $now, heartbeat_at_ms = $now, lease_expires_at_ms = $lease
      WHERE id = $id AND terminal_status IS NULL`,
  ).run({ $state: state, $now: nowMs, $lease: leaseExpiry(nowMs, row.interval_ms), $id: id })

  if (state === row.state) return false

  journal.write({
    domain: 'monitors',
    event: 'monitor.state',
    correlationId: id,
    sessionId: row.session_id,
    paneId: row.pane_id,
    detail: { from: row.state, to: state },
  })
  return true
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
  db: Database,
  journal: EventJournal,
  id: string,
  status: TerminalStatus,
  nowMs: number,
  detail?: string,
): boolean {
  const row = lifecycle(db, id)
  if (!assertTransition(id, row.terminal_status, status)) return false

  db.query(
    `UPDATE monitors
        SET terminal_status = $status, terminal_at_ms = $now, terminal_detail = $detail,
            updated_at_ms = $now
      WHERE id = $id AND terminal_status IS NULL`,
  ).run({ $status: status, $now: nowMs, $detail: detail ?? null, $id: id })

  journal.write({
    domain: 'monitors',
    event: `monitor.${status}`,
    correlationId: id,
    outcome: status === 'error' ? 'error' : 'ok',
    sessionId: row.session_id,
    paneId: row.pane_id,
    detail: detail ? { detail } : undefined,
  })
  return true
}
