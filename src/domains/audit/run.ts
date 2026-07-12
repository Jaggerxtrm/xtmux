/**
 * Audit run lifecycle (xtmux-3xs.8).
 *
 * `completed_at_ms` is the load-bearing column: it is the *only* thing that
 * distinguishes a complete audit (whose absent findings mean "resolved") from a
 * partial one (whose absent findings mean "I crashed before I looked"). It is
 * written exactly once, at the end, and only if the walk finished — and in the
 * same transaction as the resolution pass, so the two cannot come apart.
 */
import type { Database } from 'bun:sqlite'
import type { EventJournal } from '../journal'
import { resolveAbsent } from './resolve'

export function startRun(
  db: Database,
  journal: EventJournal,
  id: string,
  sessionId: string | null,
  nowMs: number,
): string {
  db.query(
    `INSERT INTO audit_runs (id, session_id, started_at_ms) VALUES ($id, $sessionId, $now)`,
  ).run({ $id: id, $sessionId: sessionId, $now: nowMs })

  journal.write({
    domain: 'audit',
    event: 'audit.run.started',
    correlationId: id,
    sessionId,
  })
  return id
}

/**
 * Close a *complete* run: record the counts, resolve everything this run did not
 * see, and only then stamp completed_at_ms.
 *
 * A partial run simply never calls this, so its findings still count as observed
 * (last_run_id was advanced for each one it did see) but nothing is resolved.
 */
export function completeRun(
  db: Database,
  journal: EventJournal,
  runId: string,
  counts: { warnings: number; cleanups: number },
  nowMs: number,
): { resolved: number } {
  let resolved = 0

  db.transaction(() => {
    resolved = resolveAbsent(db, runId, nowMs)
    db.query(
      `UPDATE audit_runs
          SET completed_at_ms = $now, warning_count = $warnings, cleanup_count = $cleanups
        WHERE id = $id`,
    ).run({ $now: nowMs, $warnings: counts.warnings, $cleanups: counts.cleanups, $id: runId })
  })()

  journal.write({
    domain: 'audit',
    event: 'audit.run.completed',
    correlationId: runId,
    outcome: 'ok',
    detail: { warnings: counts.warnings, cleanups: counts.cleanups, resolved },
  })
  return { resolved }
}
