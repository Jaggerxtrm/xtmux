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

interface Follow {
  cancelled: boolean;
}

function writeFrame(out: Writable, frame: unknown): void {
  out.write(JSON.stringify(frame) + "\n");
}

export async function serveBridge(deps: BridgeDeps, input: Readable, output: Writable): Promise<number> {
  const follows = new Map<string | number, Follow>();
  let buffer = "";
  // Set after an oversized frame: everything up to the NEXT newline belongs to
  // that frame and must be thrown away, or we would parse its tail as if it were
  // a fresh request — which is how an attacker smuggles one.
  let resyncing = false;
  let closed = false;

  const startFollow = (id: string | number, afterId: number): void => {
    const follow: Follow = { cancelled: false };
    follows.set(id, follow);
    void (async () => {
      let cursor = afterId;
      while (!follow.cancelled && !closed) {
        const db = deps.db();
        let done = false;
        try {
          const result = journalPage(db, { afterId: cursor, limit: 500 });
          if (!result.ok) {
            writeFrame(output, { id, error: result.error });
            done = true;
          } else if (result.page.items.length > 0) {
            writeFrame(output, { id, streaming: true, result: { host_id: readHostId(), page: result.page } });
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
      follows.delete(id);
      if (!closed) writeFrame(output, { id, result: { done: true } });
    })();
  };

  const dispatch = (line: string): void => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      // Malformed JSON is the peer's problem, not ours: answer and keep serving.
      // We have no id to echo, because the id lived in the bytes we could not read.
      writeFrame(output, { id: null, error: { code: "XTMUX_BRIDGE_INVALID_JSON", message: "request frame is not valid JSON" } });
      return;
    }
    const req = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    const id = typeof req["id"] === "string" || typeof req["id"] === "number" ? (req["id"] as string | number) : null;

    if (req["method"] === "journal.follow" && id !== null) {
      if (follows.has(id)) {
        writeFrame(output, { id, error: { code: "XTMUX_BRIDGE_INVALID_REQUEST", message: "a follow is already active for this id" } });
        return;
      }
      const params = req["params"] && typeof req["params"] === "object" ? (req["params"] as Record<string, unknown>) : {};
      const rawAfter = params["after_id"];
      const afterId = typeof rawAfter === "number" ? rawAfter : typeof rawAfter === "string" ? Number(rawAfter) : NaN;
      if (!Number.isFinite(afterId) || afterId < 0) {
        // No implicit "from the beginning". A follow that silently starts at 0
        // replays the whole journal into a consumer that asked to resume.
        writeFrame(output, { id, error: { code: "XTMUX_BRIDGE_INVALID_REQUEST", message: "journal.follow needs params.after_id (use 0 to start from the beginning)" } });
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

    writeFrame(output, handleRequest(deps, parsed));
  };

  return await new Promise<number>((resolve) => {
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      // Bound the UNPARSED buffer, not just a complete frame: a peer that never
      // sends a newline would otherwise grow it without limit.
      if (buffer.length + chunk.length > MAX_FRAME_BYTES && !resyncing && !chunk.includes("\n")) {
        buffer = "";
        resyncing = true;
        writeFrame(output, { id: null, error: { code: "XTMUX_BRIDGE_FRAME_TOO_LARGE", message: `request frame exceeds ${MAX_FRAME_BYTES} bytes`, detail: { max_frame_bytes: MAX_FRAME_BYTES } } });
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
        if (line.length > MAX_FRAME_BYTES) {
          writeFrame(output, { id: null, error: { code: "XTMUX_BRIDGE_FRAME_TOO_LARGE", message: `request frame exceeds ${MAX_FRAME_BYTES} bytes`, detail: { max_frame_bytes: MAX_FRAME_BYTES } } });
          continue;
        }
        dispatch(line);
      }
      if (buffer.length > MAX_FRAME_BYTES) {
        buffer = "";
        resyncing = true;
        writeFrame(output, { id: null, error: { code: "XTMUX_BRIDGE_FRAME_TOO_LARGE", message: `request frame exceeds ${MAX_FRAME_BYTES} bytes`, detail: { max_frame_bytes: MAX_FRAME_BYTES } } });
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
