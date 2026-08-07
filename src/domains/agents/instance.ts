import type { Db } from "../../db/connection.ts";
import { insertEnvelope } from "../../db/journal.ts";
import { cancelPaneObligations } from "../messages/obligations.ts";
import type { AgentInstanceRow, EndReason } from "./types.ts";

export interface OpenInstanceInput {
  instanceId: string;
  sessionId: string;
  sessionName?: string | undefined;
  paneId: string;
  runtime?: string | undefined;
  role?: string | undefined;
  beadId?: string | undefined;
  task?: string | undefined;
  promptFile?: string | undefined;
  parentSessionId?: string | undefined;
  sourceEvent: string;
}

/**
 * Idempotent on instance_id. Returns { created: true, instanceId } on first
 * open, { created: false } if a row already exists (e.g. duplicate launcher
 * event).
 */
export function openInstance(
  db: Db,
  input: OpenInstanceInput,
  now: () => number = Date.now,
): { created: boolean; instanceId: string } {
  const existing = db.raw
    .query<{ instance_id: string }, [string]>(
      "SELECT instance_id FROM agent_instances WHERE instance_id = ?",
    )
    .get(input.instanceId);
  if (existing) return { created: false, instanceId: input.instanceId };

  // K4 restart recovery (xtmux-s96.4): a pane hosts at most ONE live agent
  // occupation. A new occupation opening on a pane that still has an active
  // instance is proof that the previous one ended without a lifecycle event —
  // only `off` used to close a row, so a Codex pane killed with `tmux kill-pane`
  // or lost to a harness restart left a permanently-open instance that no later
  // event could ever repair (openInstance is idempotent; closeInstance needs the
  // dead instance's id, which nothing still holds).
  //
  // Done BEFORE the insert and OUTSIDE its transaction so the predecessor's
  // close and the successor's open are separate journal facts in causal order.
  for (const stale of activeInstancesForPane(db, input.paneId)) {
    if (stale.instance_id === input.instanceId) continue;
    closeInstance(db, { instanceId: stale.instance_id, reason: "superseded" }, now);
  }

  const insert = db.raw.prepare<
    unknown,
    [
      string, string, string | null, string, string | null, string | null,
      string | null, string | null, string | null, string | null, number,
    ]
  >(
    `INSERT INTO agent_instances
       (instance_id, session_id, session_name, pane_id, runtime, role,
        bead_id, task, prompt_file, parent_session_id, started_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const startedAtMs = now();
  const tx = db.raw.transaction(() => {
    insert.run(
      input.instanceId,
      input.sessionId,
      input.sessionName ?? null,
      input.paneId,
      input.runtime ?? null,
      input.role ?? null,
      input.beadId ?? null,
      input.task ?? null,
      input.promptFile ?? null,
      input.parentSessionId ?? null,
      startedAtMs,
    );
    insertEnvelope(db, {
      type: "agents.instance.open",
      domain: "agents",
      sessionId: input.sessionId,
      paneId: input.paneId,
      instanceId: input.instanceId,
      beadId: input.beadId,
      correlationId: input.instanceId,
      payload: {
        source_event: input.sourceEvent,
        role: input.role,
        runtime: input.runtime,
        parent_session_id: input.parentSessionId,
        task: input.task,
      },
      createdAtMs: startedAtMs,
    });
  });
  tx();
  return { created: true, instanceId: input.instanceId };
}

export interface CloseInstanceInput {
  instanceId: string;
  reason: EndReason;
}

/**
 * End one agent occupation.
 *
 * K4 terminal cleanup (xtmux-s96.4): closing the row also CANCELS the reply
 * obligations that occupation still owed a reply to. The agent that sent them
 * is gone, so nothing can ever discharge them; left pending they keep surfacing
 * in `obligations list` and keep the Stop-time gate arming waits against a dead
 * requester. Scoping is the ending pane's own `sender_pane_id` — never another
 * pane's duty, and never a pane-less sender (see cancelPaneObligations).
 *
 * Monitors and waits armed BY the pane are cancelled by the monitors domain
 * (cancelMonitorsOwnedByPane), which owns the monitor lifecycle; this function
 * deliberately does not reach into it.
 */
export function closeInstance(
  db: Db,
  input: CloseInstanceInput,
  now: () => number = Date.now,
): boolean {
  const existing = db.raw
    .query<{ ended_at_ms: number | null; session_id: string; pane_id: string }, [string]>(
      "SELECT ended_at_ms, session_id, pane_id FROM agent_instances WHERE instance_id = ?",
    )
    .get(input.instanceId);
  if (!existing) return false;
  if (existing.ended_at_ms !== null) return false; // already closed

  const endedAtMs = now();
  const tx = db.raw.transaction(() => {
    db.raw
      .prepare<unknown, [number, string, string]>(
        "UPDATE agent_instances SET ended_at_ms = ?, end_reason = ? WHERE instance_id = ?",
      )
      .run(endedAtMs, input.reason, input.instanceId);
    insertEnvelope(db, {
      type: `agents.instance.end.${input.reason}`,
      domain: "agents",
      sessionId: existing.session_id,
      paneId: existing.pane_id,
      instanceId: input.instanceId,
      correlationId: input.instanceId,
      payload: { end_reason: input.reason },
      createdAtMs: endedAtMs,
    });
    cancelPaneObligations(db, {
      senderPaneId: existing.pane_id,
      senderId: existing.session_id,
      reason: `instance_${input.reason}`,
      nowMs: endedAtMs,
    });
  });
  tx();
  return true;
}

/** One instance row by id, or null. */
export function getInstance(db: Db, instanceId: string): AgentInstanceRow | null {
  if (!instanceId) return null;
  const row = db.raw
    .query<AgentInstanceRow, [string]>(
      "SELECT * FROM agent_instances WHERE instance_id = ?",
    )
    .get(instanceId);
  return row ?? null;
}

/**
 * Every open instance bound to a pane, newest first. Normally at most one; more
 * than one means a previous occupation was never closed, which openInstance
 * repairs by superseding all but the newcomer.
 */
export function activeInstancesForPane(db: Db, paneId: string): AgentInstanceRow[] {
  return db.raw
    .query<AgentInstanceRow, [string]>(
      "SELECT * FROM agent_instances WHERE pane_id = ? AND ended_at_ms IS NULL ORDER BY started_at_ms DESC",
    )
    .all(paneId);
}

/**
 * Find the active (ended_at_ms IS NULL) instance for a pane, if any. Used by
 * transition() to attribute state changes to the right instance and by
 * reconcile() to end instances whose panes vanished.
 */
export function findActiveInstanceForPane(db: Db, paneId: string): AgentInstanceRow | null {
  const row = db.raw
    .query<AgentInstanceRow, [string]>(
      "SELECT * FROM agent_instances WHERE pane_id = ? AND ended_at_ms IS NULL ORDER BY started_at_ms DESC LIMIT 1",
    )
    .get(paneId);
  return row ?? null;
}
