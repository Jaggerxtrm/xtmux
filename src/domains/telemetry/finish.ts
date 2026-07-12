/**
 * telemetry wrapper, step 3: update the SAME row with the result (xtmux-3xs.7).
 *
 * Never a second INSERT — that is the whole correlation guarantee. The journal
 * envelope keeps V1's per-tool event type (git.commit, bd.claim, git.pr.create …)
 * so existing log queries and the golden fixtures stay byte-identical.
 */
import type { Database } from 'bun:sqlite'
import type { EventJournal } from '../journal'
import { classify, terminalStatusFor } from './classify'

export interface FinishInput {
  id: string
  exitCode: number
  /** captured after the command ran, for git/gh only */
  branchAfter?: string | null
  headAfter?: string | null
  nowMs: number
}

interface RunRow {
  tool: string
  operation: string
  argv: string | null
  cwd: string | null
  repo: string | null
  session_id: string | null
  pane_id: string | null
  bead_id: string | null
  started_at_ms: number
}

export function finish(db: Database, journal: EventJournal, f: FinishInput): void {
  const row = db
    .query(
      `SELECT tool, operation, argv, cwd, repo, session_id, pane_id, bead_id, started_at_ms
         FROM command_runs WHERE id = $id`,
    )
    .get({ $id: f.id }) as RunRow | null
  if (!row) throw new Error(`telemetry: no such command run: ${f.id}`)

  const status = terminalStatusFor(f.exitCode)

  db.query(
    `UPDATE command_runs
        SET finished_at_ms = $now, exit_code = $exit, terminal_status = $status,
            branch_after = $branchAfter, head_after = $headAfter
      WHERE id = $id`,
  ).run({
    $now: f.nowMs,
    $exit: f.exitCode,
    $status: status,
    $branchAfter: f.branchAfter ?? null,
    $headAfter: f.headAfter ?? null,
    $id: f.id,
  })

  const { journalType } = classify(row.tool, (row.argv ?? '').split(' ').filter(Boolean))

  journal.write({
    domain: 'telemetry',
    event: journalType,
    correlationId: f.id,
    outcome: status === 'success' ? 'ok' : 'error',
    durationMs: f.nowMs - row.started_at_ms,
    sessionId: row.session_id,
    paneId: row.pane_id,
    beadId: row.bead_id,
    detail: { tool: row.tool, exit: String(f.exitCode), argv: row.argv, cwd: row.cwd, repo: row.repo },
  })
}
