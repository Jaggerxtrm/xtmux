/**
 * telemetry wrapper, step 1: insert the started run (xtmux-3xs.7).
 *
 * V1 logged a `telemetry.command.started` event and, later, a separate per-tool
 * event, with nothing tying the two together — so "started but never finished"
 * was not a question you could ask. Same two envelopes here, now sharing
 * command_runs.id as correlation_id.
 */
import type { Database } from 'bun:sqlite'
import type { EventJournal } from '../journal'
import { classify } from './classify'

export interface StartInput {
  id: string
  tool: string
  argv: readonly string[]
  ownerPid: number
  sessionId?: string | null
  paneId?: string | null
  instanceId?: string | null
  beadId?: string | null
  cwd?: string | null
  /** resolved by the caller only when capturesGitMetadata is true */
  repo?: string | null
  branchBefore?: string | null
  headBefore?: string | null
  nowMs: number
}

export function start(db: Database, journal: EventJournal, c: StartInput): string {
  const { tool, operation, journalType } = classify(c.tool, c.argv)

  db.query(
    `INSERT INTO command_runs (id, tool, operation, owner_pid, session_id, pane_id, instance_id,
                               bead_id, cwd, repo, argv, branch_before, head_before, started_at_ms)
     VALUES ($id, $tool, $operation, $pid, $sessionId, $paneId, $instanceId,
             $beadId, $cwd, $repo, $argv, $branchBefore, $headBefore, $now)`,
  ).run({
    $id: c.id,
    $tool: tool,
    $operation: operation,
    $pid: c.ownerPid,
    $sessionId: c.sessionId ?? null,
    $paneId: c.paneId ?? null,
    $instanceId: c.instanceId ?? null,
    $beadId: c.beadId ?? null,
    $cwd: c.cwd ?? null,
    $repo: c.repo ?? null,
    $argv: c.argv.join(' '),
    $branchBefore: c.branchBefore ?? null,
    $headBefore: c.headBefore ?? null,
    $now: c.nowMs,
  })

  journal.write({
    domain: 'telemetry',
    event: 'telemetry.command.started',
    correlationId: c.id,
    sessionId: c.sessionId ?? null,
    paneId: c.paneId ?? null,
    beadId: c.beadId ?? null,
    detail: { tool, event: journalType, argv: c.argv.join(' '), cwd: c.cwd, repo: c.repo },
  })
  return c.id
}
