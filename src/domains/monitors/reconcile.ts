/**
 * Reconciliation (xtmux-3xs.4).
 *
 * V1 had no crash recovery: a monitor whose poller died left an orphan TSV until
 * someone happened to run monitor-list, and a lease concept did not exist. Here,
 * every monitor-list runs this pass, so a crash mid-poll converges on the next
 * read instead of leaking a row forever.
 */
import type { Database } from 'bun:sqlite'
import type { EventJournal } from '../journal'
import { terminate } from './heartbeat'
import { reconcile as decide, type TerminalStatus } from './terminal'

export interface Probes {
  /** kill -0 */
  pidAlive(pid: number): boolean
  /** does the tmux pane still exist? */
  paneAlive(paneId: string): boolean
}

interface ActiveRow {
  id: string
  owner_pid: number | null
  pane_id: string
  lease_expires_at_ms: number | null
  started_at_ms: number
  timeout_ms: number | null
}

/**
 * Decide and apply a terminal status for every active monitor that has one
 * coming. Returns the ids that were terminated, most-specific-fact-first per
 * `decide()` (target_gone > process_gone > timeout).
 */
export function reconcileAll(
  db: Database,
  journal: EventJournal,
  probes: Probes,
  nowMs: number,
): Array<{ id: string; status: TerminalStatus }> {
  const active = db
    .query(
      `SELECT id, owner_pid, pane_id, lease_expires_at_ms, started_at_ms, timeout_ms
         FROM monitors WHERE terminal_status IS NULL`,
    )
    .all() as ActiveRow[]

  const terminated: Array<{ id: string; status: TerminalStatus }> = []

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
    })
    if (!status) continue

    // terminate() is idempotent, so racing with the monitor's own poll loop
    // reaching the same conclusion is safe.
    if (terminate(db, journal, row.id, status, nowMs, 'reconcile')) {
      terminated.push({ id: row.id, status })
    }
  }
  return terminated
}
