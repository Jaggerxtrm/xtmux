import type { Db } from "../../db/connection.ts";
import { insertEnvelope } from "../../db/journal.ts";
import { classify, INTERRUPTED_THRESHOLD_MS, isInterrupted, terminalStatusFor } from "./classify.ts";

/**
 * Correlated command telemetry (xtmux-3xs.7, PRD §13).
 *
 * V1 logged `telemetry.command.started` and, later, a separate per-tool event,
 * with nothing tying the two together — so "started but never finished" was not a
 * question you could ask. One row per invocation, insert-then-update, and both
 * envelopes share the row id as correlation_id.
 */

export interface StartInput {
  id: string;
  tool: string;
  argv: readonly string[];
  ownerPid: number;
  sessionId?: string | undefined;
  paneId?: string | undefined;
  instanceId?: string | undefined;
  beadId?: string | undefined;
  cwd?: string | undefined;
  /** resolved by the caller only when classify().capturesGitMetadata */
  repo?: string | undefined;
  branchBefore?: string | undefined;
  headBefore?: string | undefined;
  nowMs: number;
}

export function start(db: Db, c: StartInput): string {
  const { tool, operation, journalType } = classify(c.tool, c.argv);
  const argv = c.argv.join(" ");

  db.raw
    .query(
      `INSERT INTO command_runs (id, tool, operation, owner_pid, session_id, pane_id, instance_id,
                                 bead_id, cwd, repo, argv, branch_before, head_before, started_at_ms)
       VALUES ($id, $tool, $operation, $pid, $sessionId, $paneId, $instanceId,
               $beadId, $cwd, $repo, $argv, $branchBefore, $headBefore, $now)`,
    )
    .run({
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
      $argv: argv,
      $branchBefore: c.branchBefore ?? null,
      $headBefore: c.headBefore ?? null,
      $now: c.nowMs,
    });

  insertEnvelope(db, {
    type: "telemetry.command.started",
    domain: "telemetry",
    correlationId: c.id,
    sessionId: c.sessionId,
    paneId: c.paneId,
    instanceId: c.instanceId,
    beadId: c.beadId,
    payload: { tool, event: journalType, argv, cwd: c.cwd ?? "", repo: c.repo ?? "" },
    createdAtMs: c.nowMs,
  });
  return c.id;
}

export interface FinishInput {
  id: string;
  exitCode: number;
  /** captured after the command ran — git and gh only */
  branchAfter?: string | undefined;
  headAfter?: string | undefined;
  nowMs: number;
}

interface RunRow {
  tool: string;
  operation: string;
  argv: string | null;
  cwd: string | null;
  repo: string | null;
  session_id: string | null;
  pane_id: string | null;
  instance_id: string | null;
  bead_id: string | null;
  started_at_ms: number;
}

/**
 * Update the SAME row with the result. Never a second INSERT — that is the whole
 * correlation guarantee. The envelope keeps V1's per-tool event type (git.commit,
 * bd.claim, git.pr.create …) so existing log queries stay byte-identical.
 */
export function finish(db: Db, f: FinishInput): void {
  const row = db.raw
    .query<RunRow, { $id: string }>(
      `SELECT tool, operation, argv, cwd, repo, session_id, pane_id, instance_id, bead_id,
              started_at_ms
         FROM command_runs WHERE id = $id`,
    )
    .get({ $id: f.id });
  if (!row) throw new Error(`telemetry: no such command run: ${f.id}`);

  const status = terminalStatusFor(f.exitCode);

  db.raw
    .query(
      `UPDATE command_runs
          SET finished_at_ms = $now, exit_code = $exit, terminal_status = $status,
              branch_after = $branchAfter, head_after = $headAfter
        WHERE id = $id`,
    )
    .run({
      $now: f.nowMs,
      $exit: f.exitCode,
      $status: status,
      $branchAfter: f.branchAfter ?? null,
      $headAfter: f.headAfter ?? null,
      $id: f.id,
    });

  const { journalType } = classify(row.tool, (row.argv ?? "").split(" ").filter(Boolean));

  insertEnvelope(db, {
    type: journalType,
    domain: "telemetry",
    correlationId: f.id,
    sessionId: row.session_id ?? undefined,
    paneId: row.pane_id ?? undefined,
    instanceId: row.instance_id ?? undefined,
    beadId: row.bead_id ?? undefined,
    payload: {
      tool: row.tool,
      outcome: status === "success" ? "ok" : "error",
      exit: String(f.exitCode),
      argv: row.argv ?? "",
      cwd: row.cwd ?? "",
      repo: row.repo ?? "",
      duration_ms: f.nowMs - row.started_at_ms,
    },
    createdAtMs: f.nowMs,
  });
}

export interface ReconcileDeps {
  pidAlive(pid: number): boolean;
}

interface IncompleteRow {
  id: string;
  owner_pid: number | null;
  started_at_ms: number;
  session_id: string | null;
  pane_id: string | null;
  bead_id: string | null;
}

/**
 * A run with no finish is either in flight or orphaned (SIGINT, crash, killed
 * pane). The wrapper cannot write its own epitaph, so this runs opportunistically
 * on the next telemetry invocation. No daemon.
 */
export function reconcileIncomplete(db: Db, deps: ReconcileDeps, nowMs: number): string[] {
  const rows = db.raw
    .query<IncompleteRow, []>(
      `SELECT id, owner_pid, started_at_ms, session_id, pane_id, bead_id
         FROM command_runs WHERE finished_at_ms IS NULL`,
    )
    .all();

  const interrupted: string[] = [];

  for (const r of rows) {
    const orphaned = isInterrupted(
      { startedAtMs: r.started_at_ms, finishedAtMs: null, ownerPid: r.owner_pid },
      nowMs,
      deps.pidAlive,
    );
    if (!orphaned) continue;

    // exit_code stays NULL: we genuinely do not know what it would have been.
    db.raw
      .query(
        `UPDATE command_runs SET terminal_status = 'interrupted', finished_at_ms = $now
          WHERE id = $id AND finished_at_ms IS NULL`,
      )
      .run({ $now: nowMs, $id: r.id });

    insertEnvelope(db, {
      type: "telemetry.command.interrupted",
      domain: "telemetry",
      correlationId: r.id,
      sessionId: r.session_id ?? undefined,
      paneId: r.pane_id ?? undefined,
      beadId: r.bead_id ?? undefined,
      payload: { outcome: "error", duration_ms: nowMs - r.started_at_ms },
      createdAtMs: nowMs,
    });
    interrupted.push(r.id);
  }
  return interrupted;
}

export interface IncompleteRun {
  id: string;
  tool: string;
  operation: string;
  started_at_ms: number;
}

/** The "started but never finished" query the contract asks for. */
export function incompleteRuns(
  db: Db,
  nowMs: number,
  thresholdMs: number = INTERRUPTED_THRESHOLD_MS,
): IncompleteRun[] {
  return db.raw
    .query<IncompleteRun, { $cutoff: number }>(
      `SELECT id, tool, operation, started_at_ms FROM command_runs
        WHERE finished_at_ms IS NULL AND started_at_ms < $cutoff
        ORDER BY started_at_ms`,
    )
    .all({ $cutoff: nowMs - thresholdMs });
}
