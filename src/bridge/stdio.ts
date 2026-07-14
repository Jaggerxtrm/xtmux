import { spawnSync } from "node:child_process";
import type { Db } from "../db/connection.ts";
import { checkHealth } from "../db/health.ts";
import { hostId as readHostId } from "../domains/identity/host-id.ts";
import { capturePane, MAX_LINES } from "../domains/identity/pane-capture.ts";
import { journalPage, MAX_PAGE } from "../domains/events/page.ts";

/**
 * The read-only remote bridge (docs/xtmux-gaps.md §7).
 *
 * This is the first surface of xtmux that a REMOTE caller can reach, so the
 * threat model is different from every other command: the peer is untrusted
 * input, not an operator. Three rules follow from that and are load-bearing:
 *
 *   1. Default deny. Methods are dispatched from an ALLOWLIST. A method that is
 *      not in the table is refused — there is no fallthrough to the local CLI,
 *      and no way to name a command into existence. The mutation names below
 *      exist only so a viewer gets "not permitted here" instead of "unknown",
 *      never as a route.
 *   2. Bounded everything. A frame has a maximum size, and every result that a
 *      caller can influence the size of (journal pages, pane captures) is
 *      clamped by the same constant the local command uses.
 *   3. Survivable. Garbage on the wire answers with an error and keeps serving.
 *      The process dies only when framing is unrecoverable, because a peer that
 *      can kill the server with one bad byte is a denial-of-service primitive.
 *
 * Transport is OpenSSH: `ssh <host> xtmux bridge --stdio`. We store no keys, we
 * open no sockets, and we listen on nothing.
 */

export const BRIDGE_SCHEMA = "xtrm.xtmux.bridge.v1";

/** One megabyte. Large enough for any legitimate request (they are all small),
 *  small enough that a peer cannot exhaust memory by never sending a newline. */
export const MAX_FRAME_BYTES = 1_048_576;

export const READ_ONLY_METHODS = [
  "bridge.hello",
  "bridge.cancel",
  "topology.snapshot",
  "journal.query",
  "journal.follow",
  "pane.capture",
  "health.get",
] as const;

/** Named ONLY to produce an honest refusal. None of these is reachable: the
 *  dispatcher never looks past the allowlist above. */
const MUTATION_METHODS = new Set([
  "pane.input",
  "message.send",
  "message.ack",
  "handoff.create",
  "handoff.send",
  "monitor.register",
  "monitor.kill",
  "log.emit",
  "telemetry.record",
]);

export interface BridgeError {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

type Reply =
  | { id: string | number | null; result: Record<string, unknown> }
  | { id: string | number | null; error: BridgeError };

export interface BridgeDeps {
  db: () => Db;
  dbPath: string;
  /** Topology lives in the picker (bash) and is the one contract this process
   *  cannot produce itself. Relay it verbatim rather than re-deriving it here:
   *  a second implementation of the same schema is a second thing to drift. */
  topology: () => { ok: true; value: unknown } | { ok: false; error: BridgeError };
  now: () => number;
}

export function defaultTopology(): { ok: true; value: unknown } | { ok: false; error: BridgeError } {
  const picker = process.env["XTMUX_PICKER"];
  if (!picker) {
    return { ok: false, error: { code: "XTMUX_BRIDGE_UNAVAILABLE", message: "topology.snapshot requires XTMUX_PICKER to point at tmux-session-picker" } };
  }
  const run = spawnSync(picker, ["topology", "--json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (run.status !== 0) {
    return { ok: false, error: { code: "XTMUX_BRIDGE_UNAVAILABLE", message: "topology.snapshot failed", detail: { exit_code: run.status } } };
  }
  try {
    return { ok: true, value: JSON.parse(run.stdout) as unknown };
  } catch {
    return { ok: false, error: { code: "XTMUX_BRIDGE_UNAVAILABLE", message: "topology.snapshot returned unparseable output" } };
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * Handle one decoded request. Pure with respect to the wire: it returns the
 * reply rather than writing it, so the framing layer stays the only thing that
 * touches stdout and the method table can be tested without a pipe.
 */
export function handleRequest(deps: BridgeDeps, raw: unknown): Reply {
  const req = asRecord(raw);
  const id = typeof req["id"] === "string" || typeof req["id"] === "number" ? (req["id"] as string | number) : null;
  const method = req["method"];
  if (typeof method !== "string" || method === "") {
    return { id, error: { code: "XTMUX_BRIDGE_INVALID_REQUEST", message: "request needs a string 'method'" } };
  }
  // Every request carries an id, and every reply echoes it. A caller with more
  // than one request in flight cannot otherwise tell which reply is whose.
  if (id === null) {
    return { id: null, error: { code: "XTMUX_BRIDGE_INVALID_REQUEST", message: "request needs a string or number 'id'" } };
  }
  const params = asRecord(req["params"]);

  if (!(READ_ONLY_METHODS as readonly string[]).includes(method)) {
    // Default deny. The distinction below is a courtesy to the caller, not a
    // branch in the security decision — both arms refuse.
    return MUTATION_METHODS.has(method)
      ? { id, error: { code: "XTMUX_BRIDGE_READ_ONLY", message: `${method} mutates state; this bridge is read-only`, detail: { method } } }
      : { id, error: { code: "XTMUX_BRIDGE_UNKNOWN_METHOD", message: `unknown method: ${method}`, detail: { method } } };
  }

  switch (method) {
    case "bridge.hello":
      return {
        id,
        result: {
          schema_version: BRIDGE_SCHEMA,
          host_id: readHostId(),
          read_only: true,
          capabilities: [...READ_ONLY_METHODS],
          limits: { max_frame_bytes: MAX_FRAME_BYTES, max_journal_page: MAX_PAGE, max_capture_lines: MAX_LINES },
        },
      };

    case "bridge.cancel":
      // Cancellation is handled by the follow loop; a cancel for an id that is
      // not following is not an error (the race is normal: the stream may have
      // ended on its own between the caller's decision and this frame).
      return { id, result: { cancelled: true } };

    case "health.get": {
      const db = deps.db();
      try {
        const report = checkHealth(db, deps.dbPath);
        return { id, result: { host_id: readHostId(), schema_version: report.schemaVersion } };
      } finally {
        db.close();
      }
    }

    case "topology.snapshot": {
      const topo = deps.topology();
      return topo.ok ? { id, result: { host_id: readHostId(), topology: topo.value } } : { id, error: topo.error };
    }

    case "pane.capture": {
      const paneId = str(params["pane_id"]);
      if (!paneId) return { id, error: { code: "XTMUX_BRIDGE_INVALID_REQUEST", message: "pane.capture needs params.pane_id" } };
      const result = capturePane(paneId, num(params["lines"], 200));
      return result.ok
        ? { id, result: { host_id: readHostId(), capture: result.capture } }
        : { id, error: result.error };
    }

    case "journal.query": {
      const db = deps.db();
      try {
        const result = journalPage(db, {
          afterId: num(params["after_id"], 0),
          limit: params["limit"] === undefined ? undefined : num(params["limit"], MAX_PAGE),
          type: str(params["type"]),
          sessionId: str(params["session_id"]),
          paneId: str(params["pane_id"]),
          beadId: str(params["bead_id"]),
        });
        return result.ok
          ? { id, result: { host_id: readHostId(), page: result.page } }
          : { id, error: result.error };
      } finally {
        db.close();
      }
    }

    // journal.follow is dispatched by the loop below, which owns the streaming.
    default:
      return { id, error: { code: "XTMUX_BRIDGE_UNKNOWN_METHOD", message: `unknown method: ${method}` } };
  }
}
