import type { Db } from "../../db/connection.ts";
import { insertEnvelope } from "../../db/journal.ts";
import { fingerprint, SEVERITY_OF, type Kind } from "./fingerprint.ts";

/**
 * Audit runs and finding persistence (xtmux-3xs.8, PRD §14).
 *
 * V1 recorded only that an audit ran; the findings themselves went to stdout and
 * were lost, so "is this still broken?" and "when did this appear?" had no answer.
 *
 * `audit_runs.completed_at_ms` is the load-bearing column: it is the only thing
 * distinguishing a complete audit (whose absent findings mean "resolved") from a
 * partial one (whose absent findings mean "I crashed before I looked").
 */

export function startRun(db: Db, id: string, sessionId: string | undefined, nowMs: number): string {
  db.raw
    .query(`INSERT INTO audit_runs (id, session_id, started_at_ms) VALUES ($id, $sessionId, $now)`)
    .run({ $id: id, $sessionId: sessionId ?? null, $now: nowMs });

  insertEnvelope(db, {
    type: "audit.run.started",
    domain: "audit",
    correlationId: id,
    sessionId,
    payload: {},
    createdAtMs: nowMs,
  });
  return id;
}

export interface Finding {
  kind: Kind;
  sessionName: string;
  sessionId?: string | undefined;
  paneId?: string | undefined;
  /** window.pane — stable across tmux restarts, unlike pane_id */
  paneIndex?: string | undefined;
  repo?: string | undefined;
  path?: string | undefined;
  /** the volatile part: dirty_count, observed state, cmd, peers … */
  detail?: Record<string, unknown> | undefined;
}

/**
 * One upsert per observation, keyed on the fingerprint. A finding seen in three
 * consecutive audits is one row whose last_seen_ms advanced twice — never three
 * rows. The volatile part is overwritten in detail_json; it is not identity, so it
 * cannot fork the row.
 */
export function record(db: Db, runId: string, f: Finding, nowMs: number): string {
  const fp = fingerprint(f.kind, {
    session_name: f.sessionName,
    path: f.path,
    pane_index: f.paneIndex,
  });

  db.raw
    .query(
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
    )
    .run({
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
    });

  insertEnvelope(db, {
    type: "audit.finding.observed",
    domain: "audit",
    correlationId: runId,
    sessionId: f.sessionId,
    paneId: f.paneId,
    payload: { fingerprint: fp, kind: f.kind, severity: SEVERITY_OF[f.kind] },
    createdAtMs: nowMs,
  });
  return fp;
}

/**
 * "Absent from a later COMPLETE audit" is the definition of resolved. Keyed on
 * last_run_id, not run_id: with one row per fingerprint, run_id stays pinned to the
 * run that FIRST saw the finding, so a finding observed in ten consecutive audits
 * still carries run #1's id. last_run_id is the one that moves.
 *
 * Private on purpose — reachable only through completeRun(), inside its transaction.
 * A partial audit must never reach this, or a crash halfway through the session
 * list would resolve every finding it simply had not got to yet.
 */
function resolveAbsent(db: Db, runId: string, nowMs: number): number {
  const res = db.raw
    .query(
      `UPDATE audit_findings SET resolved_at_ms = $now
        WHERE resolved_at_ms IS NULL AND last_run_id <> $runId`,
    )
    .run({ $now: nowMs, $runId: runId });
  return Number(res.changes ?? 0);
}

/**
 * Close a COMPLETE run: resolve everything this run did not see, then stamp
 * completed_at_ms — in one transaction, so the two cannot come apart.
 *
 * A partial run simply never calls this. Its findings still count as observed
 * (last_run_id advanced for each one it did see), but nothing is resolved.
 */
export function completeRun(
  db: Db,
  runId: string,
  counts: { warnings: number; cleanups: number },
  nowMs: number,
): { resolved: number } {
  let resolved = 0;

  db.raw.transaction(() => {
    resolved = resolveAbsent(db, runId, nowMs);
    db.raw
      .query(
        `UPDATE audit_runs
            SET completed_at_ms = $now, warning_count = $warnings, cleanup_count = $cleanups
          WHERE id = $id`,
      )
      .run({ $now: nowMs, $warnings: counts.warnings, $cleanups: counts.cleanups, $id: runId });
  })();

  insertEnvelope(db, {
    type: "audit.run.completed",
    domain: "audit",
    correlationId: runId,
    payload: { warnings: counts.warnings, cleanups: counts.cleanups, resolved },
    createdAtMs: nowMs,
  });
  return { resolved };
}

export interface OpenFinding {
  fingerprint: string;
  kind: string;
  severity: string;
  session_name: string | null;
  path: string | null;
  first_seen_ms: number;
  last_seen_ms: number;
}

/** Findings currently open — the query surface the contract asks for. */
export function openFindings(db: Db, kind?: Kind): OpenFinding[] {
  const sql = `SELECT fingerprint, kind, severity, session_name, path, first_seen_ms, last_seen_ms
                 FROM audit_findings
                WHERE resolved_at_ms IS NULL ${kind ? "AND kind = $kind" : ""}
                ORDER BY severity, kind, session_name`;
  return kind
    ? db.raw.query<OpenFinding, { $kind: string }>(sql).all({ $kind: kind })
    : db.raw.query<OpenFinding, []>(sql).all();
}
