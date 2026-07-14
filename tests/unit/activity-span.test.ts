import { describe, expect, test } from "bun:test";
import { activitySpanArgs } from "../../extensions/pi-agent-state.ts";

function fields(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of args.slice(3)) {
    const eq = a.indexOf("=");
    out[a.slice(0, eq)] = a.slice(eq + 1);
  }
  return out;
}

describe("activitySpanArgs", () => {
  test("emits a completed span: log emit agent.activity with duration derived from the boundaries", () => {
    const args = activitySpanArgs({
      activity: "thinking", segmentId: "3:1", turnIndex: 3,
      startedAtMs: 1_000, endedAtMs: 1_250, charCount: 1_400,
    });
    expect(args.slice(0, 3)).toEqual(["log", "emit", "agent.activity"]);
    const f = fields(args);
    expect(f).toEqual({
      activity: "thinking",
      segment_id: "3:1",
      turn_index: "3",
      started_at_ms: "1000",
      // duration is derived, not passed in — the load-bearing computation.
      duration_ms: "250",
      char_count: "1400",
    });
  });

  test("char_count is OMITTED for a tool span, never emitted as 0", () => {
    const f = fields(activitySpanArgs({
      activity: "tool", segmentId: "toolcall-x", turnIndex: 0,
      startedAtMs: 5_000, endedAtMs: 5_080,
    }));
    // A tool result is content (a NON_GOAL), so there is no char_count. Emitting 0
    // would read as "measured zero characters" rather than "not text-bearing".
    expect("char_count" in f).toBe(false);
    expect(f.duration_ms).toBe("80");
  });

  test("a clock that moved backwards clamps duration to 0, never a negative span", () => {
    const f = fields(activitySpanArgs({
      activity: "text", segmentId: "0:2", turnIndex: 0,
      startedAtMs: 9_000, endedAtMs: 8_900, charCount: 10,
    }));
    // Observed stream duration comes from wall clock; NTP/suspend can move it back.
    // A negative duration is nonsense a materializer would have to special-case.
    expect(f.duration_ms).toBe("0");
  });
});
