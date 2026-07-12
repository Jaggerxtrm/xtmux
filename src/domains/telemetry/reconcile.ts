/**
 * Interrupted-run reconciliation (xtmux-3xs.7).
 *
 * A row with no finish is either in flight or orphaned (SIGINT, crash, killed
 * pane). The wrapper cannot write its own epitaph, so somebody else has to:
 * this runs opportunistically on the next telemetry invocation. No daemon.
 */
import type { Database } from 'bun:sqlite'
import type { EventJournal } from '../journal'
import { INTERRUPTED_THRESHOLD_MS, isInterrupted } from './classify'

export interface ReconcileDeps {
  pidAlive(pid: number): boolean
}

interface IncompleteRow {
  id: string
  owner_pid: number | null
  started_at_ms: number
  session_id: string | null
  pane_id: string | null
  bead_id: string | null
}

export function reconcileIncomplete(
  db: Database,
  journal: EventJournal,
  deps: ReconcileDeps,
  nowMs: number,
): string[] {
  const rows = db
    .query(
      `SELECT id, owner_pid, started_at_ms, session_id, pane_id, bead_id
         FROM command_runs WHERE finished_at_ms IS NULL`,
    )
    .all() as IncompleteRow[]

  const interrupted: string[] = []

  for (const r of rows) {
    const orphaned = isInterrupted(
      { startedAtMs: r.started_at_ms, finishedAtMs: null, ownerPid: r.owner_pid },
      nowMs,
      deps.pidAlive,
    )
    if (!orphaned) continue

    // exit_code stays NULL: we genuinely do not know what it would have been.
    db.query(
      `UPDATE command_runs SET terminal_status = 'interrupted', finished_at_ms = $now
        WHERE id = $id AND finished_at_ms IS NULL`,
    ).run({ $now: nowMs, $id: r.id })

    journal.write({
      domain: 'telemetry',
      event: 'telemetry.command.interrupted',
      correlationId: r.id,
      outcome: 'error',
      durationMs: nowMs - r.started_at_ms,
      sessionId: r.session_id,
      paneId: r.pane_id,
      beadId: r.bead_id,
    })
    interrupted.push(r.id)
  }
  return interrupted
}

/** The "started but never finished" query the contract asks for. */
export function incompleteRuns(db: Database, nowMs: number, thresholdMs = INTERRUPTED_THRESHOLD_MS) {
  return db
    .query(
      `SELECT id, tool, operation, started_at_ms FROM command_runs
        WHERE finished_at_ms IS NULL AND started_at_ms < $cutoff
        ORDER BY started_at_ms`,
    )
    .all({ $cutoff: nowMs - thresholdMs })
}
