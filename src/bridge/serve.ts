import { Readable, Writable } from "node:stream";
import { journalPage } from "../domains/events/page.ts";
import { hostId as readHostId } from "../domains/identity/host-id.ts";
import {
  handleRequest,
  MAX_FRAME_BYTES,
  type BridgeDeps,
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

// Per-connection request-rate cap (defense-in-depth for the remote surface). Each
// request is handled synchronously in the stdin listener, and topology.snapshot /
// pane.capture spawnSync a subprocess that blocks the event loop for its duration
// — so a flood of valid requests starves every active follow. This bounds the
// blocking budget without touching legitimate use: a viewer polling topology and
// opening a handful of panes stays far under it. It bounds, it does not eliminate:
// the complete fix is async subprocess execution, a runtime-wide change out of
// scope here (tracked separately). bridge.cancel is exempt — it REDUCES load, and
// rate-limiting the one control that stops work would be perverse.
export const RATE_WINDOW_MS = 1000;
export const MAX_REQUESTS_PER_WINDOW = 20;

interface Follow {
  cancelled: boolean;
}

export async function serveBridge(deps: BridgeDeps, input: Readable, output: Writable): Promise<number> {
  const follows = new Map<string | number, Follow>();
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
  let closed = false;

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

    if (req["method"] === "bridge.cancel") {
      const params = req["params"] && typeof req["params"] === "object" ? (req["params"] as Record<string, unknown>) : {};
      const target = params["follow_id"];
      if (typeof target === "string" || typeof target === "number") {
        const follow = follows.get(target);
        if (follow) follow.cancelled = true;
      }
    }

    writeFrame(handleRequest(deps, parsed));
  };

  // The limit is in BYTES, so measure bytes. buffer.length counts UTF-16 code
  // units; a frame of 3-byte UTF-8 characters is one code unit each, so a
  // code-unit check would admit ~3x the documented byte budget before tripping.
  const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
  return await new Promise<number>((resolve) => {
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
    // EOF is a graceful close, not a fault: the peer hung up (ssh exited, the
    // viewer closed the tab). Stop the follows and exit 0.
    input.on("end", () => {
      closed = true;
      for (const f of follows.values()) f.cancelled = true;
      resolve(0);
    });
    input.on("error", () => {
      closed = true;
      for (const f of follows.values()) f.cancelled = true;
      resolve(0);
    });
  });
}
