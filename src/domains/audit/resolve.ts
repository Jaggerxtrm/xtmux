/**
 * Resolution detection (xtmux-3xs.8).
 *
 * "Absent from a later *complete* audit" is the definition of resolved. Keyed on
 * last_run_id, not run_id: with one row per fingerprint, run_id stays pinned to
 * the run that FIRST saw the finding, so a finding observed in ten consecutive
 * audits still carries run #1's id. last_run_id is the one that moves.
 *
 * Callable only from completeRun(), inside its transaction — a partial audit must
 * never reach this, or a crash halfway through the session list would resolve
 * every finding it simply had not got to yet.
 */
import type { Database } from 'bun:sqlite'

export function resolveAbsent(db: Database, runId: string, nowMs: number): number {
  const res = db
    .query(
      `UPDATE audit_findings SET resolved_at_ms = $now
        WHERE resolved_at_ms IS NULL AND last_run_id <> $runId`,
    )
    .run({ $now: nowMs, $runId: runId })
  return Number(res.changes ?? 0)
}
