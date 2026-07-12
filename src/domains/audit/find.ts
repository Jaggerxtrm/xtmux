/**
 * Recording an observed finding (xtmux-3xs.8).
 *
 * One upsert per observation, keyed on the fingerprint. A finding seen in three
 * consecutive audits is one row whose last_seen_ms advanced twice — never three
 * rows. The volatile part of the finding (dirty count, observed state) is
 * overwritten in detail_json; it is not identity, so it cannot fork the row.
 */
import type { Database } from 'bun:sqlite'
import type { EventJournal } from '../journal'
import { fingerprint, SEVERITY_OF, type Kind } from './fingerprint'

export interface Finding {
  kind: Kind
  sessionName: string
  sessionId?: string | null
  paneId?: string | null
  /** window.pane — stable across tmux restarts, unlike pane_id */
  paneIndex?: string | null
  repo?: string | null
  path?: string | null
  /** the volatile part: dirty_count, observed state, cmd, peers … */
  detail?: Record<string, unknown>
}

export function record(
  db: Database,
  journal: EventJournal,
  runId: string,
  f: Finding,
  nowMs: number,
): string {
  const fp = fingerprint(f.kind, {
    session_name: f.sessionName,
    path: f.path,
    pane_index: f.paneIndex,
  })

  db.query(
    `INSERT INTO audit_findings (run_id, last_run_id, fingerprint, severity, kind,
                                 session_id, session_name, pane_id, repo, path, detail_json,
                                 first_seen_ms, last_seen_ms)
     VALUES ($runId, $runId, $fp, $severity, $kind,
             $sessionId, $sessionName, $paneId, $repo, $path, $detail, $now, $now)
     ON CONFLICT (fingerprint) DO UPDATE SET
         last_run_id    = $runId,
         last_seen_ms   = $now,
         resolved_at_ms = NULL,
         detail_json    = $detail,
         session_id     = $sessionId,
         pane_id        = $paneId`,
  ).run({
    $runId: runId,
    $fp: fp,
    $severity: SEVERITY_OF[f.kind],
    $kind: f.kind,
    $sessionId: f.sessionId ?? null,
    $sessionName: f.sessionName,
    $paneId: f.paneId ?? null,
    $repo: f.repo ?? null,
    $path: f.path ?? null,
    $detail: f.detail ? JSON.stringify(f.detail) : null,
    $now: nowMs,
  })

  journal.write({
    domain: 'audit',
    event: 'audit.finding.observed',
    correlationId: runId,
    sessionId: f.sessionId ?? null,
    paneId: f.paneId ?? null,
    detail: { fingerprint: fp, kind: f.kind, severity: SEVERITY_OF[f.kind] },
  })
  return fp
}

/** Findings currently open, for the query surface the contract asks for. */
export function openFindings(db: Database, kind?: Kind) {
  const sql = `SELECT fingerprint, kind, severity, session_name, path, first_seen_ms, last_seen_ms
                 FROM audit_findings
                WHERE resolved_at_ms IS NULL ${kind ? 'AND kind = $kind' : ''}
                ORDER BY severity, kind, session_name`
  return kind ? db.query(sql).all({ $kind: kind }) : db.query(sql).all()
}
