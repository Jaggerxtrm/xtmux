/**
 * monitor-kill (xtmux-3xs.4).
 *
 * V1 killed the poller PID and deleted the TSV, so the monitor's history went
 * with it. Here the process is still signalled, but the row is *preserved* with
 * terminal_status='killed' — the contract requires the terminal history to
 * survive the kill.
 *
 * V1 stdout and exit status are preserved: `killed\t<id>` on success; on an
 * unknown id, `monitor-kill: not found: <id>` on stderr and exit 1.
 */
import type { Database } from 'bun:sqlite'
import type { EventJournal } from '../journal'
import { MonitorNotFoundError, terminate } from './heartbeat'

export interface KillDeps {
  /** SIGTERM the poller. V1 ignores failure here (the process may already be gone). */
  signal(pid: number): void
}

export function kill(
  db: Database,
  journal: EventJournal,
  deps: KillDeps,
  id: string,
  nowMs: number,
): string {
  const row = db.query(`SELECT owner_pid FROM monitors WHERE id = $id`).get({ $id: id }) as
    | { owner_pid: number | null }
    | null
  if (!row) throw new MonitorNotFoundError(id)

  if (row.owner_pid !== null) deps.signal(row.owner_pid)
  terminate(db, journal, id, 'killed', nowMs)
  return `killed\t${id}`
}
