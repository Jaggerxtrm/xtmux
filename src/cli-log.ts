/**
 * V1-compatible `log emit|tail|query` under V2. V1 stores each event as a
 * newline-delimited JSON object in events.jsonl; V2 stores the same envelope
 * shape in event_journal with the payload as JSON in `payload_json`. Output
 * preserves the newline-delimited JSON shape.
 */
import type { Db } from "./db/connection.ts";
import { emitEvent, query as journalQuery, tail as journalTail } from "./domains/events/query.ts";
import { journalPage } from "./domains/events/page.ts";
import type { JournalRow } from "./domains/events/query.ts";
import { closeInstance, openInstance } from "./domains/agents/instance.ts";
import { insertEnvelope } from "./db/journal.ts";
import { isUniqueViolation } from "./db/errors.ts";
import { recordTransition } from "./domains/agents/transition.ts";
import { completeTurn } from "./domains/agents/turn.ts";

interface Args {
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function fmtRow(r: JournalRow): string {
  // V1 event-line shape: {"ts":"iso","ts_epoch":N,"type":"...","k":"v",...}
  const payload = safeParseObject(r.payload_json);
  const merged: Record<string, unknown> = {
    ts: new Date(r.created_at_ms).toISOString().replace(/\.\d{3}Z$/, "Z"),
    ts_epoch: Math.floor(r.created_at_ms / 1000),
    type: r.type,
    ...payload,
  };
  if (r.bead_id !== null) merged["bead"] = r.bead_id;
  if (r.session_id !== null) merged["session"] = r.session_id;
  if (r.pane_id !== null) merged["pane"] = r.pane_id;
  return JSON.stringify(merged);
}

function jsonRow(r: JournalRow): Record<string, unknown> {
  return {
    ...safeParseObject(r.payload_json),
    createdAtMs: r.created_at_ms,
    type: r.type,
    domain: r.domain,
    eventKey: r.event_key,
    sessionId: r.session_id,
    paneId: r.pane_id,
    instanceId: r.instance_id,
    beadId: r.bead_id,
    correlationId: r.correlation_id,
  };
}

function safeParseObject(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function cliLogEmit(db: Db, argv: string[]): number {
  const { positional } = parseArgs(argv);
  const type = positional[0];
  if (!type) {
    process.stderr.write("log emit: <type> [k=v ...] required\n");
    return 2;
  }
  const fields: Record<string, string> = {};
  for (const kv of positional.slice(1)) {
    const eq = kv.indexOf("=");
    if (eq <= 0) continue;
    fields[kv.slice(0, eq)] = kv.slice(eq + 1);
  }

  // Typed-event smart dispatch: agent-state.sh emits `log emit agent.state ...`
  // and pi-agent-state.ts emits `log emit agent.turn.done ...`. Under V2 route
  // them to typed writers so agent_state_transitions / agent_turns get the row
  // + envelope in one transaction. Anything else falls through to the generic
  // event_journal writer.
  switch (type) {
    case "agent.role.launched":
      openInstance(db, {
        instanceId: fields["instance_id"] ?? fields["instance"] ?? `inst-${Date.now()}-${fields["pane"] ?? ""}`,
        sessionId: fields["session"] ?? fields["session_id"] ?? "",
        sessionName: fields["session_name"],
        paneId: fields["pane"] ?? fields["pane_id"] ?? "",
        runtime: fields["runtime"],
        role: fields["role"],
        beadId: fields["bead"] ?? fields["bead_id"],
        task: fields["task"],
        promptFile: fields["prompt_file"],
        parentSessionId: fields["parent"] ?? fields["parent_session"],
        sourceEvent: "agent.role.launched",
      });
      return 0;
    case "agent.state":
      recordTransition(db, {
        paneId: fields["pane"] ?? fields["pane_id"] ?? "",
        sessionId: fields["session"] ?? fields["session_id"],
        // Without this the transition is attributed by pane lookup alone, so a
        // pane whose occupant just rotated would hang its first transitions off
        // the PREVIOUS agent's instance — the exact confusion @agent_instance_id
        // exists to prevent.
        instanceId: fields["instance_id"] ?? fields["instance"],
        state: fields["state"] ?? "",
        sourceEvent: fields["hook_event"] ?? fields["source_event"],
        beadId: fields["bead"] ?? fields["bead_id"],
        task: fields["task"],
        promptFile: fields["prompt_file"],
        parentSessionId: fields["parent"] ?? fields["parent_session"],
      });
      return 0;
    case "agent.instance.started":
      openInstance(db, {
        instanceId: fields["instance_id"] ?? fields["instance"] ?? "",
        sessionId: fields["session"] ?? fields["session_id"] ?? "",
        sessionName: fields["session_name"],
        paneId: fields["pane"] ?? fields["pane_id"] ?? "",
        runtime: fields["runtime"],
        role: fields["role"],
        beadId: fields["bead"] ?? fields["bead_id"],
        task: fields["task"],
        promptFile: fields["prompt_file"],
        parentSessionId: fields["parent"] ?? fields["parent_session"],
        sourceEvent: "agent.instance.started",
      });
      return 0;
    case "agent.ready": {
      // "Pane exists" is not "agent can receive work". This is the handshake a
      // coordinator waits on before delivering, and it must fire exactly ONCE
      // per agent occupation — distinct from `idle`, which recurs after every
      // turn. Exactly-once is enforced by the store, not by the caller: the
      // event_key is UNIQUE, so a re-emit (hook fired twice, session resumed)
      // collides and is dropped rather than waking a coordinator a second time.
      const instanceId = fields["instance_id"] ?? fields["instance"] ?? "";
      if (!instanceId) {
        process.stderr.write("log emit agent.ready: instance_id= required\n");
        return 2;
      }
      try {
        insertEnvelope(db, {
          eventKey: `agent.ready:${instanceId}`,
          type: "agent.ready",
          domain: "agents",
          instanceId,
          sessionId: fields["session"] ?? fields["session_id"],
          paneId: fields["pane"] ?? fields["pane_id"],
          beadId: fields["bead"] ?? fields["bead_id"],
          payload: { runtime: fields["runtime"] ?? null, host_id: fields["host_id"] ?? null },
          createdAtMs: Date.now(),
        });
      } catch (err) {
        // A duplicate ready is a no-op, not an error: hooks are best-effort and
        // may fire twice. Anything else is a real failure and must surface.
        if (!isUniqueViolation(err)) throw err;
      }
      return 0;
    }
    case "agent.instance.ended":
      closeInstance(db, {
        instanceId: fields["instance_id"] ?? fields["instance"] ?? "",
        // `off` is the lifecycle end marker the hooks send; the other EndReasons
        // belong to callers that observed the pane die, not the agent exit.
        reason: "state_off",
      });
      return 0;
    case "agent.turn.done":
      completeTurn(db, {
        paneId: fields["pane"] ?? fields["pane_id"] ?? "",
        sessionId: fields["session"] ?? fields["session_id"] ?? "",
        sessionName: fields["session_name"],
        beadId: fields["bead"] ?? fields["bead_id"],
        parentSessionId: fields["parent"] ?? fields["parent_session"],
        summary: fields["last_message"] ?? fields["summary"],
      });
      return 0;
    default:
      emitEvent(db, { type, fields });
      return 0;
  }
}

export function cliLogTail(db: Db, argv: string[]): number {
  const { positional, flags } = parseArgs(argv);
  const n = Number(positional[0] ?? 50);
  const rows = [...journalTail(db, isNaN(n) ? 50 : n)].reverse();
  if (flags.get("json") === true) process.stdout.write(JSON.stringify(rows.map(jsonRow)) + "\n");
  else for (const row of rows) process.stdout.write(fmtRow(row) + "\n");
  return 0;
}

export function cliLogQuery(db: Db, argv: string[]): number {
  const { flags } = parseArgs(argv);

  // --after-id opts into the cursor-paged envelope (xtrm.xtmux.journal-page.v1).
  // Without it, the legacy array shape is returned unchanged: existing consumers
  // and the V1 goldens both depend on it, and a cursor is meaningless to a caller
  // that never sends one.
  if (flags.has("after-id")) {
    const afterId = Number(flags.get("after-id"));
    if (!Number.isInteger(afterId) || afterId < 0) {
      process.stderr.write(JSON.stringify({
        code: "XTMUX_INVALID_ARGUMENT",
        message: "log query --after-id requires a non-negative integer journal id",
        detail: { after_id: String(flags.get("after-id")) },
      }) + "\n");
      return 2;
    }
    const result = journalPage(db, {
      afterId,
      limit: flags.has("limit") ? Number(flags.get("limit")) : undefined,
      type: flags.get("type") as string | undefined,
      sessionId: flags.get("session") as string | undefined,
      paneId: flags.get("pane") as string | undefined,
      beadId: flags.get("bead") as string | undefined,
    });
    if (!result.ok) {
      // A protocol outcome, not a crash: the consumer needs oldest_available_id
      // to re-anchor, which a stack trace would never give it.
      process.stderr.write(JSON.stringify(result.error) + "\n");
      return 2;
    }
    if (flags.get("json") === true) {
      process.stdout.write(JSON.stringify(result.page) + "\n");
    } else {
      for (const item of result.page.items) {
        process.stdout.write(`${item.journal_id}\t${item.event_type}\t${item.recorded_at_ms}\n`);
      }
    }
    return 0;
  }

  const rows = journalQuery(db, {
    type: flags.get("type") as string | undefined,
    sessionId: flags.get("session") as string | undefined,
    paneId: flags.get("pane") as string | undefined,
    beadId: flags.get("bead") as string | undefined,
    sinceMs: flags.has("since") ? Number(flags.get("since")) : undefined,
    limit: flags.has("limit") ? Number(flags.get("limit")) : undefined,
  });
  const ordered = [...rows].reverse();
  if (flags.get("json") === true) process.stdout.write(JSON.stringify(ordered.map(jsonRow)) + "\n");
  else for (const row of ordered) process.stdout.write(fmtRow(row) + "\n");
  return 0;
}
