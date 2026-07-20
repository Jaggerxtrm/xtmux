import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";
import { serveBridge } from "../../src/bridge/serve.ts";
import type { BridgeDeps, TopologyResult } from "../../src/bridge/stdio.ts";

// Async bridge subprocess behaviour (audit §P2-07). Drives serveBridge over
// in-memory streams with injected topology/capture deps, so the invariants —
// one response per request id, fairness for concurrent work, cancellation,
// per-op timeout, bounded concurrency — are provable without a live tmux server.

type Frame = { id: string | number | null; result?: Record<string, unknown>; error?: { code: string } };

function baseDeps(overrides: Partial<BridgeDeps> = {}): BridgeDeps {
  return {
    db: () => {
      throw new Error("db() must not be called by the subprocess-path tests");
    },
    dbPath: ":memory:",
    topology: async (): Promise<TopologyResult> => ({ ok: true, value: { sessions: [] } }),
    capture: async () => ({
      ok: true,
      capture: {
        schema_version: "xtrm.xtmux.pane-capture.v1",
        pane_id: "%1",
        captured_at_ms: 0,
        requested_lines: 1,
        returned_lines: 0,
        max_lines: 2000,
        truncated: false,
        content: "",
      },
    }),
    now: () => 0,
    ...overrides,
  };
}

function harness(deps: BridgeDeps) {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Frame[] = [];
  let buf = "";
  output.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) frames.push(JSON.parse(line) as Frame);
    }
  });
  const done = serveBridge(deps, input, output);
  return {
    frames,
    feed: (obj: unknown) => input.write(JSON.stringify(obj) + "\n"),
    finish: async () => {
      input.end();
      return done;
    },
  };
}

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A topology dep that hangs until its AbortSignal fires, then rejects. Models a
 *  slow/stuck picker so cancel and timeout paths are exercised deterministically. */
function hangingTopology(): (signal: AbortSignal) => Promise<TopologyResult> {
  return (signal) =>
    new Promise<TopologyResult>((_resolve, reject) => {
      if (signal.aborted) return reject(new Error("aborted"));
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
}

describe("async bridge subprocesses (§P2-07)", () => {
  test("topology.snapshot returns exactly one result frame for its id", async () => {
    const h = harness(baseDeps({ topology: async () => ({ ok: true, value: { marker: 42 } }) }));
    h.feed({ id: 1, method: "topology.snapshot" });
    await waitFor(() => h.frames.some((f) => f.id === 1));
    await h.finish();
    const mine = h.frames.filter((f) => f.id === 1);
    expect(mine).toHaveLength(1);
    expect((mine[0]!.result!.topology as { marker: number }).marker).toBe(42);
  });

  test("a slow subprocess op does not block other requests (fairness)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const h = harness(
      baseDeps({
        topology: async () => {
          await gate;
          return { ok: true, value: {} };
        },
      }),
    );
    h.feed({ id: "slow", method: "topology.snapshot" });
    h.feed({ id: "fast", method: "bridge.hello" });
    // The fast method is answered while topology is still pending — proof the
    // event loop was never blocked by the in-flight subprocess op.
    await waitFor(() => h.frames.some((f) => f.id === "fast"));
    expect(h.frames.some((f) => f.id === "slow")).toBe(false);
    release();
    await waitFor(() => h.frames.some((f) => f.id === "slow"));
    await h.finish();
  });

  test("bridge.cancel aborts an in-flight op with exactly one CANCELLED frame", async () => {
    const h = harness(baseDeps({ topology: hangingTopology() }));
    h.feed({ id: "op", method: "topology.snapshot" });
    await new Promise((r) => setTimeout(r, 20));
    h.feed({ id: "c", method: "bridge.cancel", params: { follow_id: "op" } });
    await waitFor(() => h.frames.some((f) => f.id === "op"));
    await h.finish();
    const opFrames = h.frames.filter((f) => f.id === "op");
    expect(opFrames).toHaveLength(1);
    expect(opFrames[0]!.error!.code).toBe("XTMUX_BRIDGE_CANCELLED");
    // The cancel request itself is acknowledged on its own id.
    expect(h.frames.find((f) => f.id === "c")!.result!.cancelled).toBe(true);
  });

  test("a subprocess op exceeding the per-op timeout yields one TIMEOUT frame", async () => {
    const h = harness(baseDeps({ subprocTimeoutMs: 30, topology: hangingTopology() }));
    h.feed({ id: "t", method: "topology.snapshot" });
    await waitFor(() => h.frames.some((f) => f.id === "t"));
    await h.finish();
    const mine = h.frames.filter((f) => f.id === "t");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.error!.code).toBe("XTMUX_BRIDGE_TIMEOUT");
  });

  test("bounded concurrency: ops past MAX_INFLIGHT_SUBPROCS are refused", async () => {
    // Small timeout so the four in-flight hangers clear quickly on finish().
    const h = harness(baseDeps({ subprocTimeoutMs: 50, topology: hangingTopology() }));
    for (let i = 0; i < 5; i++) h.feed({ id: i, method: "topology.snapshot" });
    await waitFor(() => h.frames.some((f) => f.error?.code === "XTMUX_BRIDGE_RESOURCE_LIMIT"));
    const limited = h.frames.find((f) => f.error?.code === "XTMUX_BRIDGE_RESOURCE_LIMIT");
    // The 5th op (id 4) is the one turned away; the first four are in flight.
    expect(limited!.id).toBe(4);
    await h.finish();
  });

  test("a reused id cannot own two concurrent ops", async () => {
    const h = harness(baseDeps({ subprocTimeoutMs: 50, topology: hangingTopology() }));
    h.feed({ id: "dup", method: "topology.snapshot" });
    await new Promise((r) => setTimeout(r, 10));
    h.feed({ id: "dup", method: "topology.snapshot" });
    await waitFor(() => h.frames.some((f) => f.id === "dup" && f.error?.code === "XTMUX_BRIDGE_INVALID_REQUEST"));
    await h.finish();
    // The second request is refused; the first is aborted silently by finish().
    const invalid = h.frames.filter((f) => f.id === "dup" && f.error?.code === "XTMUX_BRIDGE_INVALID_REQUEST");
    expect(invalid).toHaveLength(1);
  });

  test("an op that completes after stdin EOF still flushes its reply (pipe-and-close)", async () => {
    // The canonical `printf req | xtmux bridge --stdio` closes stdin before reading
    // the reply. A subprocess op in flight when EOF lands must NOT be abandoned.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const h = harness(
      baseDeps({
        topology: async () => {
          await gate;
          return { ok: true, value: { late: true } };
        },
      }),
    );
    h.feed({ id: "late", method: "topology.snapshot" });
    await new Promise((r) => setTimeout(r, 10));
    const done = h.finish(); // stdin EOF while the op is still running
    release(); // op finishes after EOF
    await done;
    const mine = h.frames.filter((f) => f.id === "late");
    expect(mine).toHaveLength(1);
    expect((mine[0]!.result!.topology as { late: boolean }).late).toBe(true);
  });

  test("pane.capture runs on the async path and returns one frame", async () => {
    const h = harness(baseDeps());
    h.feed({ id: 7, method: "pane.capture", params: { pane_id: "%1", lines: 5 } });
    await waitFor(() => h.frames.some((f) => f.id === 7));
    await h.finish();
    const mine = h.frames.filter((f) => f.id === 7);
    expect(mine).toHaveLength(1);
    expect((mine[0]!.result!.capture as { schema_version: string }).schema_version).toBe("xtrm.xtmux.pane-capture.v1");
  });
});
