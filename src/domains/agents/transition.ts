import type { Db } from "../../db/connection.ts";
import { insertEnvelope } from "../../db/journal.ts";
import { closeInstance, findActiveInstanceForPane } from "./instance.ts";

export interface TransitionInput {
  paneId: string;
  sessionId?: string | undefined;
  state: string;
  sourceEvent?: string | undefined;
  beadId?: string | undefined;
  task?: string | undefined;
  promptFile?: string | undefined;
  parentSessionId?: string | undefined;
  instanceId?: string | undefined;   // caller-supplied (from launcher context)
}

export interface TransitionResult {
  transitionId: number;
  instanceId: string | null;
  debounced: boolean;              // true if same-state and skipped
  endedInstance: boolean;          // true when state=off ended the active instance
}

/**
 * Insert an `agent_state_transitions` row and update `agent_instances.last_state`
 * + `last_transition_ms` transactionally. Same-state as previous is skipped
 * (matches XTMUX_PI_STATE_DEBOUNCE_MS semantics). `state=off` triggers
 * closeInstance(reason=state_off) for the active instance on this pane.
 */
export function recordTransition(
  db: Db,
  input: TransitionInput,
  now: () => number = Date.now,
): TransitionResult {
  let transitionId = 0;
  let instanceId: string | null = input.instanceId ?? null;
  let debounced = false;
  let endedInstance = false;

  const tx = db.raw.transaction(() => {
    // Resolve instance: prefer caller-supplied, else look up active-for-pane.
    if (!instanceId) {
      const inst = findActiveInstanceForPane(db, input.paneId);
      instanceId = inst?.instance_id ?? null;
    }

    // Same-state debounce (matches XTMUX_PI_STATE_DEBOUNCE_MS): if the
    // pane's last state matches this one, skip. Bounded same-state refreshes
    // are the caller's responsibility to force via a distinct source_event.
    if (instanceId) {
      const cur = db.raw
        .query<{ last_state: string | null }, [string]>(
          "SELECT last_state FROM agent_instances WHERE instance_id = ?",
        )
        .get(instanceId);
      if (cur?.last_state === input.state && input.sourceEvent === undefined) {
        debounced = true;
        return;
      }
    }

    const createdAtMs = now();
    const row = db.raw
      .prepare<{ id: number }, [
        string | null, string | null, string, string, string | null,
        string | null, string | null, string | null, string | null, number,
      ]>(
        `INSERT INTO agent_state_transitions
           (instance_id, session_id, pane_id, state, source_event,
            bead_id, task, prompt_file, parent_session_id, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .get(
        instanceId,
        input.sessionId ?? null,
        input.paneId,
        input.state,
        input.sourceEvent ?? null,
        input.beadId ?? null,
        input.task ?? null,
        input.promptFile ?? null,
        input.parentSessionId ?? null,
        createdAtMs,
      );
    transitionId = row?.id ?? 0;

    if (instanceId) {
      db.raw
        .prepare<unknown, [string, number, string]>(
          "UPDATE agent_instances SET last_state = ?, last_transition_ms = ? WHERE instance_id = ?",
        )
        .run(input.state, createdAtMs, instanceId);
    }

    insertEnvelope(db, {
      type: `agents.state.${input.state}`,
      domain: "agents",
      sessionId: input.sessionId,
      paneId: input.paneId,
      instanceId: instanceId ?? undefined,
      beadId: input.beadId,
      correlationId: instanceId ?? input.paneId,
      payload: {
        state: input.state,
        source_event: input.sourceEvent,
        task: input.task,
        prompt_file: input.promptFile,
      },
      createdAtMs,
    });
  });
  tx();

  // `state=off` ends the active instance. Done outside the transition tx so
  // its own tx-boundary shows up as a separate journal envelope. Ordering
  // preserved: transition row lands first with the off state, then close.
  if (!debounced && input.state === "off" && instanceId) {
    endedInstance = closeInstance(db, { instanceId, reason: "state_off" }, now);
  }

  return { transitionId, instanceId, debounced, endedInstance };
}
