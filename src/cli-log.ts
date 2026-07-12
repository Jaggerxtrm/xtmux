/**
 * V1-compatible `log emit|tail|query` under V2. V1 stores each event as a
 * newline-delimited JSON object in events.jsonl; V2 stores the same envelope
 * shape in event_journal with the payload as JSON in `payload_json`. Output
 * preserves the newline-delimited JSON shape.
 */
import type { Db } from "./db/connection.ts";
import { emitEvent, query as journalQuery, tail as journalTail } from "./domains/events/query.ts";
import type { JournalRow } from "./domains/events/query.ts";
import { openInstance } from "./domains/agents/instance.ts";
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
        state: fields["state"] ?? "",
        sourceEvent: fields["hook_event"] ?? fields["source_event"],
        beadId: fields["bead"] ?? fields["bead_id"],
        task: fields["task"],
        promptFile: fields["prompt_file"],
        parentSessionId: fields["parent"] ?? fields["parent_session"],
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
  const n = Number(argv[0] ?? 50);
  const rows = journalTail(db, isNaN(n) ? 50 : n);
  for (const r of [...rows].reverse()) process.stdout.write(fmtRow(r) + "\n");
  return 0;
}

export function cliLogQuery(db: Db, argv: string[]): number {
  const { flags } = parseArgs(argv);
  const rows = journalQuery(db, {
    type: flags.get("type") as string | undefined,
    sessionId: flags.get("session") as string | undefined,
    paneId: flags.get("pane") as string | undefined,
    beadId: flags.get("bead") as string | undefined,
    sinceMs: flags.has("since") ? Number(flags.get("since")) : undefined,
    limit: flags.has("limit") ? Number(flags.get("limit")) : undefined,
  });
  for (const r of [...rows].reverse()) process.stdout.write(fmtRow(r) + "\n");
  return 0;
}
