import type { Db } from "../../db/connection.ts";
import { closeInstance } from "./instance.ts";

/**
 * Agent-instance restart recovery (K4-xtmux, xtmux-s96.4).
 *
 * Monitors have converged on their own crash state since Phase 4: every
 * `monitor-list` runs `reconcileAll`, so a poller that died mid-poll is
 * reconciled on the next read instead of leaking forever. Agent INSTANCES had
 * no equivalent. `agent_instances.ended_at_ms` was written by exactly one
 * caller — `state=off`, i.e. a graceful SessionEnd — so a pane killed without
 * one (`tmux kill-pane`, a crashed harness, an OOM, a closed terminal) left a
 * row that stayed open for the lifetime of the database. The partial index
 * `ai_active ... WHERE ended_at_ms IS NULL` was created in migration 0004 "for
 * the reconciliation scan" that never existed; this is that scan.
 *
 * Two independent repairs, in the order of most specific fact first:
 *
 *  1. The pane is GONE. The occupation cannot still be running, whatever the
 *     row says: `pane_gone`.
 *  2. The pane is alive but a NEWER occupation has opened on it. Handled
 *     eagerly by `openInstance` (reason `superseded`) rather than here, because
 *     the successor's open is the exact moment the fact becomes true and
 *     waiting for a reconciliation read would attribute the successor's early
 *     transitions to the predecessor.
 *
 * Fail-safe on the probe: `paneAlive` is a live tmux query, and a tmux server
 * that is merely unreachable would answer "gone" for EVERY pane. Closing every
 * instance in the database on a transient probe outage is worse than closing
 * none, so the caller must pass `serverAlive: false` when it cannot distinguish
 * the two — see `reconcileAll` in the monitors domain, which is the single
 * entry point this hangs off.
 */
export interface InstanceProbes {
  paneAlive(paneId: string): boolean;
}

export interface ReconciledInstance {
  instanceId: string;
  paneId: string;
  sessionId: string;
  reason: "pane_gone";
}

interface ActiveRow {
  instance_id: string;
  pane_id: string;
  session_id: string;
}

export function reconcileAgentInstances(
  db: Db,
  probes: InstanceProbes,
  nowMs: number,
): ReconciledInstance[] {
  const active = db.raw
    .query<ActiveRow, []>(
      `SELECT instance_id, pane_id, session_id
         FROM agent_instances WHERE ended_at_ms IS NULL`,
    )
    .all();
  if (active.length === 0) return [];

  // One probe per DISTINCT pane: several instances can share a pane id, and the
  // probe is a process spawn.
  const alive = new Map<string, boolean>();
  const closed: ReconciledInstance[] = [];
  for (const row of active) {
    let paneAlive = alive.get(row.pane_id);
    if (paneAlive === undefined) {
      paneAlive = probes.paneAlive(row.pane_id);
      alive.set(row.pane_id, paneAlive);
    }
    if (paneAlive) continue;
    // closeInstance is idempotent on an already-closed row, so racing another
    // reconciliation pass to the same conclusion is safe.
    if (closeInstance(db, { instanceId: row.instance_id, reason: "pane_gone" }, () => nowMs)) {
      closed.push({
        instanceId: row.instance_id,
        paneId: row.pane_id,
        sessionId: row.session_id,
        reason: "pane_gone",
      });
    }
  }
  return closed;
}
