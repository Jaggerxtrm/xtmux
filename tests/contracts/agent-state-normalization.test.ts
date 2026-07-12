/**
 * V2's monitor-list must print the SAME state column as V1's (PRD §20).
 *
 * V1 canonicalizes the raw @agent_state through normalize_agent_state before
 * printing: an operator writes `working`, and monitor-list prints `running`.
 * Returning the raw option value instead made V2 diverge on exactly this column —
 * caught by a V1-vs-V2 stdout comparison, and pinned here so it cannot come back.
 */
import { describe, expect, test } from "bun:test";
import { normalizeAgentState } from "../../src/tmux.ts";

describe("agent-state normalization (mirrors V1 normalize_agent_state)", () => {
  const cases: Array<[string, string]> = [
    ["working", "running"],
    ["running", "running"],
    ["thinking", "running"],
    ["busy", "running"],
    ["tool", "running"],
    ["needs-input", "needs-input"],
    ["permission", "needs-input"],
    ["waiting", "needs-input"],
    ["input", "needs-input"],
    ["done", "done"],
    ["finished", "done"],
    ["stop", "done"],
    ["complete", "done"],
    ["idle", "idle"],
    // "no opinion" sentinels: V1 falls through to inference, which is off by default
    ["", ""],
    ["-", ""],
    ["off", ""],
    ["none", ""],
    // anything else passes through verbatim
    ["custom-state", "custom-state"],
  ];

  for (const [raw, want] of cases) {
    test(`${JSON.stringify(raw)} -> ${JSON.stringify(want)}`, () => {
      expect(normalizeAgentState(raw)).toBe(want);
    });
  }
});
