import { Readable, Writable } from "node:stream";
import { journalPage } from "../domains/events/page.ts";
import { hostId as readHostId } from "../domains/identity/host-id.ts";
import {
  handleRequest,
  MAX_FRAME_BYTES,
  type BridgeDeps,
  type BridgeError,
} from "./stdio.ts";

/**
 * NDJSON framing for the read-only bridge. stdout carries protocol and nothing
 * else — a stray console.log here corrupts the stream for the peer, which is why
 * every diagnostic in this file goes to stderr.
 */

const FOLLOW_INTERVAL_MS = 500;

// One connection is one process (stdio), so this is a per-peer cap. A viewer
// follows one journal; the small headroom is for a reconnect that races its own
// teardown. Without a cap, a peer opens an unbounded number of 500ms poll loops,
// each opening the DB every tick — CPU, fd, and timer pressure from valid frames.
export const MAX_FOLLOWS = 4;

// Per-connection request-rate cap (defense-in-depth for the remote surface). A
// cheap turn-away for a flood of valid requests, applied before any work. It is
// complementary to — not a substitute for — the subprocess concurrency cap below:
// this bounds request *arrival rate*, that bounds concurrent *blocking work*.
// bridge.cancel is exempt — it REDUCES load, and rate-limiting the one control
// that stops work would be perverse.
export const RATE_WINDOW_MS = 1000;
export const MAX_REQUESTS_PER_WINDOW = 20;

// Subprocess methods (topology.snapshot, pane.capture) run ASYNC (§P2-07): they no
// longer block the event loop, so a slow picker or capture cannot starve active
// journal follows or delay a bridge.cancel. What still needs bounding is how many
// run at once (fd/CPU/child-process pressure) and how long any one may run.
export const MAX_INFLIGHT_SUBPROCS = 4;
export const SUBPROC_TIMEOUT_MS = 10_000;

interface Follow {
  cancelled: boolean;
}

// Why an in-flight subprocess op was aborted. Distinguishes the terminal frame the
// requester receives (cancelled vs timed-out) and lets a peer-disconnect abort stay
// silent. Carried on the AbortController's `reason`.
const ABORT_CANCEL = Symbol("bridge.cancel");
const ABORT_TIMEOUT = Symbol("bridge.timeout");
const ABORT_CLOSE = Symbol("bridge.close");

interface Inflight {
  abort: (reason: symbol) => void;
}

export async function serveBridge(deps: BridgeDeps, input: Readable, output: Writable): Promise<number> {
  const follows = new Map<string | number, Follow>();
  // In-flight async subprocess ops, keyed by request id. Shares the id namespace
  // with `follows` so one id can never own two concurrent operations — the guard
  // that keeps the one-response-per-request-id invariant intact.
  const inflight = new Map<string | number, Inflight>();
  let buffer = "";

  // Honor stdout backpressure. If the peer stops reading, out.write() returns
  // false and Node buffers in memory without bound — a remote peer growing our
  // RSS by refusing to read is a denial-of-service. Pause the input side while
  // the socket is not draining so we stop producing replies we cannot flush.
  let draining = false;
  const writeFrame = (frame: unknown): void => {
    const ok = output.write(JSON.stringify(frame) + "\n");
    if (!ok && !draining) {
      draining = true;
      input.pause();
      output.once("drain", () => { draining = false; input.resume(); });
    }
  };
  // Set after an oversized frame: everything up to the NEXT newline belongs to
  // that frame and must be thrown away, or we would parse its tail as if it were
  // a fresh request — which is how an attacker smuggles one.
  let resyncing = false;
  // `closed`: the output is gone (peer disconnect / stream error) — stop writing.
  // `inputEnded`: stdin hit EOF — no MORE requests, but in-flight subprocess ops
  // may still owe a reply the peer is waiting to read, so we do not tear them down.
  let closed = false;
  let inputEnded = false;
  let resolveBridge: (code: number) => void = () => {};
  // Exit once stdin is done AND every in-flight subprocess op has flushed its one
  // reply. Follows are infinite and are cancelled on end; finite subprocess ops are
  // allowed to finish (bounded by their per-op timeout) so a `printf req | xtmux
  // bridge --stdio` one-shot still receives its topology/capture response.
  const maybeFinish = (): void => {
    if (inputEnded && inflight.size === 0) {
      closed = true;
      resolveBridge(0);
    }
  };

  const startFollow = (id: string | number, afterId: number): void => {
    const follow: Follow = { cancelled: false };
    follows.set(id, follow);
    // A DETACHED async task. Any throw it does not catch becomes an
    // unhandledRejection, which on modern Node terminates the process — so this
    // whole body is wrapped, and deps.db() (which opens the DB and can throw
    // SQLITE_BUSY whenever a local writer holds the lock past busy_timeout) is
    // INSIDE the try. A remote peer must not be able to kill the server by timing
    // a follow poll against local DB contention.
    void (async () => {
      let cursor = afterId;
      try {
        while (!follow.cancelled && !closed) {
          const db = deps.db();
          let done = false;
          try {
            const result = journalPage(db, { afterId: cursor, limit: 500 });
            if (!result.ok) {
              writeFrame({ id, error: result.error });
              done = true;
            } else if (result.page.items.length > 0) {
              writeFrame({ id, streaming: true, result: { host_id: readHostId(), page: result.page } });
              // Advance only after the page is written. A crash between the two
              // replays one page — which the consumer's own cursor absorbs —
              // whereas advancing first would DROP it, silently and forever.
              cursor = result.page.next_after_id;
            }
          } finally {
            db.close();
          }
          if (done) break;
          await new Promise((r) => setTimeout(r, FOLLOW_INTERVAL_MS));
        }
        if (!closed) writeFrame({ id, result: { done: true } });
      } catch (err) {
        // The stream ends, the process does not. The peer can re-follow from its
        // last cursor once whatever contended the DB has cleared.
        if (!closed) writeFrame({ id, error: { code: "XTMUX_BRIDGE_STREAM_ERROR", message: "follow stream ended on an internal error", detail: { cause: err instanceof Error ? err.message : String(err) } } });
      } finally {
        follows.delete(id);
      }
    })();
  };

  // Run one async subprocess-backed method (topology.snapshot, pane.capture) off
  // the event loop. Owns the four invariants §P2-07 asks for: bounded concurrency
  // (reject past MAX_INFLIGHT_SUBPROCS), a per-operation timeout (abort at
  // SUBPROC_TIMEOUT_MS), cancellation (bridge.cancel aborts the signal), and
  // exactly one frame per request id (the `settled` latch + registry delete).
  type OpResult = { ok: true; result: Record<string, unknown> } | { ok: false; error: BridgeError };
  const startSubproc = (id: string | number, op: (signal: AbortSignal) => Promise<OpResult>): void => {
    // One operation per id at a time (subproc OR follow). A second request reusing
    // a live id is refused rather than silently producing a second response.
    if (inflight.has(id) || follows.has(id)) {
      writeFrame({ id, error: { code: "XTMUX_BRIDGE_INVALID_REQUEST", message: "a request is already in flight for this id" } });
      return;
    }
    if (inflight.size >= MAX_INFLIGHT_SUBPROCS) {
      writeFrame({ id, error: { code: "XTMUX_BRIDGE_RESOURCE_LIMIT", message: `at most ${MAX_INFLIGHT_SUBPROCS} concurrent subprocess operations per connection`, detail: { max_inflight_subprocs: MAX_INFLIGHT_SUBPROCS } } });
      return;
    }

    const controller = new AbortController();
    const timeoutMs = deps.subprocTimeoutMs ?? SUBPROC_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(ABORT_TIMEOUT), timeoutMs);
    let settled = false;
    const settle = (frame: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      inflight.delete(id);
      // A hard peer-disconnect (closed) produces no frame: the socket is gone.
      // Every other terminal path — including a graceful stdin EOF — writes exactly
      // once, guarded by the latch above.
      if (!closed) writeFrame(frame);
      // If stdin already ended, this may have been the last reply owed.
      maybeFinish();
    };

    inflight.set(id, { abort: (reason) => controller.abort(reason) });

    void (async () => {
      try {
        const out = await op(controller.signal);
        settle(out.ok ? { id, result: out.result } : { id, error: out.error });
      } catch (err) {
        const reason = controller.signal.aborted ? controller.signal.reason : undefined;
        if (reason === ABORT_CANCEL) {
          settle({ id, error: { code: "XTMUX_BRIDGE_CANCELLED", message: "request cancelled by bridge.cancel", detail: {} } });
        } else if (reason === ABORT_TIMEOUT) {
          settle({ id, error: { code: "XTMUX_BRIDGE_TIMEOUT", message: `operation exceeded ${timeoutMs}ms`, detail: { timeout_ms: timeoutMs } } });
        } else if (reason === ABORT_CLOSE) {
          settle(null); // no frame written (closed), just clears the registry
        } else {
          settle({ id, error: { code: "XTMUX_BRIDGE_INTERNAL", message: "operation failed", detail: { cause: err instanceof Error ? err.message : String(err) } } });
        }
      }
    })();
  };

  // Sliding-window request counter. Timestamps older than the window are dropped
  // on each check, so this is O(requests-in-window), not unbounded — a flood is
  // capped, so the array cannot grow past MAX_REQUESTS_PER_WINDOW + 1.
  const requestTimes: number[] = [];
  const overRate = (): boolean => {
    const nowMs = deps.now();
    const cutoff = nowMs - RATE_WINDOW_MS;
    while (requestTimes.length > 0 && requestTimes[0]! <= cutoff) requestTimes.shift();
    if (requestTimes.length >= MAX_REQUESTS_PER_WINDOW) return true;
    requestTimes.push(nowMs);
    return false;
  };

  const dispatch = (line: string): void => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      // Malformed JSON is the peer's problem, not ours: answer and keep serving.
      // We have no id to echo, because the id lived in the bytes we could not read.
      writeFrame({ id: null, error: { code: "XTMUX_BRIDGE_INVALID_JSON", message: "request frame is not valid JSON" } });
      return;
    }
    const req = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    const id = typeof req["id"] === "string" || typeof req["id"] === "number" ? (req["id"] as string | number) : null;

    // Rate cap before any work, so a flood is turned away CHEAPLY rather than
    // after spawning a subprocess. bridge.cancel is exempt (it reduces load).
    if (req["method"] !== "bridge.cancel" && overRate()) {
      writeFrame({ id, error: { code: "XTMUX_BRIDGE_RESOURCE_LIMIT", message: `at most ${MAX_REQUESTS_PER_WINDOW} requests per ${RATE_WINDOW_MS}ms per connection`, detail: { max_requests_per_window: MAX_REQUESTS_PER_WINDOW, window_ms: RATE_WINDOW_MS } } });
      return;
    }

    // A handler that throws (a DB open failing with SQLITE_BUSY, a bad payload
    // reaching a sink) runs synchronously inside the stdin 'data' listener, where
    // an uncaught throw becomes an uncaughtException and exits the process.
    // Answer with the request's own id and survive.
    try {
      dispatchOne(req, id, parsed);
    } catch (err) {
      writeFrame({ id, error: { code: "XTMUX_BRIDGE_INTERNAL", message: "request failed", detail: { cause: err instanceof Error ? err.message : String(err) } } });
    }
  };

  const dispatchOne = (req: Record<string, unknown>, id: string | number | null, parsed: unknown): void => {
    if (req["method"] === "journal.follow" && id !== null) {
      if (follows.has(id)) {
        writeFrame({ id, error: { code: "XTMUX_BRIDGE_INVALID_REQUEST", message: "a follow is already active for this id" } });
        return;
      }
      // Per-peer follow cap. Excess follows are the DoS: unique ids each spin up
      // their own poll loop, so the count — not just duplicate ids — must be bounded.
      if (follows.size >= MAX_FOLLOWS) {
        writeFrame({ id, error: { code: "XTMUX_BRIDGE_RESOURCE_LIMIT", message: `at most ${MAX_FOLLOWS} concurrent follows per connection`, detail: { max_follows: MAX_FOLLOWS } } });
        return;
      }
      const params = req["params"] && typeof req["params"] === "object" ? (req["params"] as Record<string, unknown>) : {};
      const rawAfter = params["after_id"];
      const afterId = typeof rawAfter === "number" ? rawAfter : typeof rawAfter === "string" ? Number(rawAfter) : NaN;
      if (!Number.isFinite(afterId) || afterId < 0) {
        // No implicit "from the beginning". A follow that silently starts at 0
        // replays the whole journal into a consumer that asked to resume.
        writeFrame({ id, error: { code: "XTMUX_BRIDGE_INVALID_REQUEST", message: "journal.follow needs params.after_id (use 0 to start from the beginning)" } });
        return;
      }
      startFollow(id, afterId);
      return;
    }

    // Async subprocess methods: dispatched here, never through the synchronous
    // handleRequest, so the event loop stays free while tmux/the picker runs.
    if (req["method"] === "topology.snapshot" && id !== null) {
      startSubproc(id, async (signal) => {
        const topo = await deps.topology(signal);
        return topo.ok ? { ok: true, result: { host_id: readHostId(), topology: topo.value } } : { ok: false, error: topo.error };
      });
      return;
    }

    if (req["method"] === "pane.capture" && id !== null) {
      const params = req["params"] && typeof req["params"] === "object" ? (req["params"] as Record<string, unknown>) : {};
      const rawPane = params["pane_id"];
      const paneId = typeof rawPane === "string" && rawPane !== "" ? rawPane : undefined;
      if (!paneId) {
        writeFrame({ id, error: { code: "XTMUX_BRIDGE_INVALID_REQUEST", message: "pane.capture needs params.pane_id" } });
        return;
      }
      const rawLines = params["lines"];
      const lines = typeof rawLines === "number" ? rawLines : typeof rawLines === "string" ? Number(rawLines) : 200;
      startSubproc(id, async (signal) => {
        const result = await deps.capture(paneId, Number.isFinite(lines) ? lines : 200, signal);
        return result.ok ? { ok: true, result: { host_id: readHostId(), capture: result.capture } } : { ok: false, error: result.error };
      });
      return;
    }

    if (req["method"] === "bridge.cancel") {
      const params = req["params"] && typeof req["params"] === "object" ? (req["params"] as Record<string, unknown>) : {};
      const target = params["follow_id"];
      if (typeof target === "string" || typeof target === "number") {
        const follow = follows.get(target);
        if (follow) follow.cancelled = true;
        // Also cancel an in-flight subprocess op with this id: the aborted op emits
        // its own single CANCELLED frame; this request emits its own ack below.
        const op = inflight.get(target);
        if (op) op.abort(ABORT_CANCEL);
      }
    }

    writeFrame(handleRequest(deps, parsed));
  };

  // The limit is in BYTES, so measure bytes. buffer.length counts UTF-16 code
  // units; a frame of 3-byte UTF-8 characters is one code unit each, so a
  // code-unit check would admit ~3x the documented byte budget before tripping.
  const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
  return await new Promise<number>((resolve) => {
    resolveBridge = resolve;
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      // Bound the UNPARSED buffer, not just a complete frame: a peer that never
      // sends a newline would otherwise grow it without limit.
      if (bytes(buffer) + bytes(chunk) > MAX_FRAME_BYTES && !resyncing && !chunk.includes("\n")) {
        buffer = "";
        resyncing = true;
        writeFrame({ id: null, error: { code: "XTMUX_BRIDGE_FRAME_TOO_LARGE", message: `request frame exceeds ${MAX_FRAME_BYTES} bytes`, detail: { max_frame_bytes: MAX_FRAME_BYTES } } });
        return;
      }
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (resyncing) {
          // That newline terminated the oversized frame. Resume with the next one.
          resyncing = false;
          continue;
        }
        if (bytes(line) > MAX_FRAME_BYTES) {
          writeFrame({ id: null, error: { code: "XTMUX_BRIDGE_FRAME_TOO_LARGE", message: `request frame exceeds ${MAX_FRAME_BYTES} bytes`, detail: { max_frame_bytes: MAX_FRAME_BYTES } } });
          continue;
        }
        dispatch(line);
      }
      if (bytes(buffer) > MAX_FRAME_BYTES) {
        buffer = "";
        resyncing = true;
        writeFrame({ id: null, error: { code: "XTMUX_BRIDGE_FRAME_TOO_LARGE", message: `request frame exceeds ${MAX_FRAME_BYTES} bytes`, detail: { max_frame_bytes: MAX_FRAME_BYTES } } });
      }
    });
    // Stdin EOF is graceful: no more requests are coming, but the peer may still be
    // reading replies (the canonical `printf req | xtmux bridge --stdio` closes
    // stdin before it reads). Cancel the infinite follows, let finite subprocess ops
    // flush their one reply, then exit once none remain in flight.
    const onInputDone = (): void => {
      inputEnded = true;
      for (const f of follows.values()) f.cancelled = true;
      maybeFinish();
    };
    input.on("end", onInputDone);
    input.on("error", onInputDone);
    // The output going away IS a hard fault: there is nobody to reply to. Abort
    // in-flight ops (no frames), stop follows, and exit — do not sit spinning on a
    // subprocess whose result can never be delivered.
    output.on("error", () => {
      closed = true;
      for (const f of follows.values()) f.cancelled = true;
      for (const op of inflight.values()) op.abort(ABORT_CLOSE);
      resolve(0);
    });
  });
}
