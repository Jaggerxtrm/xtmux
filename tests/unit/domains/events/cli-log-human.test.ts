import { describe, expect, test } from "bun:test";
import { renderHuman, type HumanParts } from "../../../../src/cli-log.ts";

// Fixed epoch. The stamp is rendered in the machine's LOCAL zone, so tests
// assert the stamp FORMAT, never its exact value — keeps the suite portable.
const TS = 1753142400000;
const STAMP = String.raw`\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{4}`;

function base(over: Partial<HumanParts> = {}): HumanParts {
  return { type: "custom.event", tsMs: TS, rest: {}, ...over };
}

describe("renderHuman (xtmux-obs --format human)", () => {
  test("header: default level INFO, local timestamp, type", () => {
    const header = renderHuman(base()).split("\n")[0]!;
    expect(header).toMatch(new RegExp(`^INFO  \\[${STAMP}\\]: custom\\.event$`));
  });

  test("header: level is uppercased; ERROR is already 5 wide", () => {
    expect(renderHuman(base({ level: "error" })).split("\n")[0]).toMatch(/^ERROR \[/);
    expect(renderHuman(base({ level: "warn" })).split("\n")[0]).toMatch(/^WARN  \[/);
  });

  test("header: duration_ms renders inline, s above 1000 else ms", () => {
    expect(renderHuman(base({ durationMs: 1500 })).split("\n")[0]).toContain("]: custom.event  (1.5s)");
    expect(renderHuman(base({ durationMs: 850 })).split("\n")[0]).toContain("]: custom.event  (850ms)");
  });

  test("fields: promoted keys render in canonical order, rest last", () => {
    const out = renderHuman(base({
      module: "telemetry", runId: "run-1", session: "$1", pane: "%2",
      instance: "agent-9", bead: "xtmux-x", rest: { extra: "y" },
    }));
    const keys = out.split("\n").slice(1).map((l) => l.trim().split(/\s+/)[0]);
    expect(keys).toEqual(["module", "runId", "session", "pane", "instance", "bead", "extra"]);
  });

  test("fields: values are JSON-encoded (numbers bare, strings quoted)", () => {
    const out = renderHuman(base({ rest: { n: 42, s: "x" } }));
    expect(out).toContain("n  42");
    expect(out).toContain('s  "x"');
  });

  test("fields: keys are padded so values align to the widest key", () => {
    const lines = renderHuman(base({ module: "agents", rest: { a: 1 } })).split("\n").slice(1);
    const moduleLine = lines.find((l) => l.includes("module"))!;
    const aLine = lines.find((l) => l.trim().startsWith("a"))!;
    expect(moduleLine.indexOf('"agents"')).toBe(aLine.indexOf("1"));
  });

  test("empty: no promoted keys and empty rest -> header line only", () => {
    expect(renderHuman(base()).split("\n")).toHaveLength(1);
  });
});
