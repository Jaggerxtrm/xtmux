/**
 * monitor-list (xtmux-3xs.4).
 *
 * Byte-identical to V1's stdout (PRD §20), which is a 10-column TSV in seconds:
 *
 *   monitor \t id \t pid \t target \t pane \t state \t start \t timeout \t interval \t updated
 *
 * V1 semantics preserved deliberately:
 *   - only *active* monitors are listed. V1 deleted the TSV of a dead monitor as
 *     it scanned, so a terminal monitor never appeared. Here the row survives (it
 *     carries the terminal history Phase 9 needs) but stays out of the listing.
 *   - the pane is re-observed on read, and the row's heartbeat is refreshed —
 *     V1's "mutate on read". Kept, because monitor-list is what pushes a stalled
 *     monitor's state forward. The difference is that V2 updates columns in place
 *     rather than rewriting a TSV and appending a historical event.
 *   - `pid` prints as `starting` before the poller is adopted; `timeout` prints as
 *     0 when there is none.
 *   - sorted by start, then id (V1: `sort -t $'\t' -k6,6 -k2,2`, i.e. lexical).
 */
import type { Database } from 'bun:sqlite'
import type { EventJournal } from '../journal'
import { heartbeat } from './heartbeat'
import { reconcileAll, type Probes } from './reconcile'

export interface ListDeps extends Probes {
  /** current @agent_state of the pane; '' if it cannot be observed */
  observe(paneId: string): string
}

interface ListRow {
  id: string
  owner_pid: number | null
  target: string
  pane_id: string
  state: string
  started_at_ms: number
  timeout_ms: number | null
  interval_ms: number
}

const msToS = (ms: number): number => Math.floor(ms / 1000)

export function list(db: Database, journal: EventJournal, deps: ListDeps, nowMs: number): string[] {
  // A crashed poller must not linger just because nobody killed it.
  reconcileAll(db, journal, deps, nowMs)

  const rows = db
    .query(
      `SELECT id, owner_pid, target, pane_id, state, started_at_ms, timeout_ms, interval_ms
         FROM monitors WHERE terminal_status IS NULL`,
    )
    .all() as ListRow[]

  const out = rows.map((r) => {
    const state = deps.observe(r.pane_id) || r.state
    heartbeat(db, journal, r.id, state, nowMs)
    return {
      sortStart: String(msToS(r.started_at_ms)),
      sortId: r.id,
      line: [
        'monitor',
        r.id,
        r.owner_pid === null ? 'starting' : String(r.owner_pid),
        r.target,
        r.pane_id,
        state,
        msToS(r.started_at_ms),
        r.timeout_ms === null ? 0 : msToS(r.timeout_ms),
        msToS(r.interval_ms),
        msToS(nowMs),
      ].join('\t'),
    }
  })

  // V1 sorts with sort(1) on the raw text fields — lexical, not numeric.
  out.sort((a, b) => a.sortStart.localeCompare(b.sortStart) || a.sortId.localeCompare(b.sortId))
  return out.map((o) => o.line)
}
