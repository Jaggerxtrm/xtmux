import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// API classification contract for the nav command family (xtmux-rib.23/.25).
// Mirrors the source-slice style of json-command-matrix.test.ts: the picker
// source is the tested artifact, because the shell-level truth lives in
// json_command_state() and the top-level dispatch table. RED while nav is
// unimplemented; green once the nav dispatcher lands and remains outside the
// JSON-ready allowlist.

const ROOT = join(import.meta.dir, "../..");
const PICKER = join(ROOT, "bin/tmux-session-picker");

describe("nav API classification", () => {
  test("nav is a real dispatcher command, never a JSON-ready command", () => {
    const source = readFileSync(PICKER, "utf8");

    // The dispatch table must have a nav arm (next|prev|attention-next|
    // attention-prev|back resolve there, not to "unknown command").
    expect(source.includes("  nav)") || /^  nav\|/m.test(source)).toBe(true);

    // nav --json must be refused, so nav must never be listed among the
    // JSON-ready commands in json_command_state().
    const stateStart = source.indexOf("json_command_state()");
    const stateEnd = source.indexOf("json_request_preflight", stateStart);
    const stateBlock = source.slice(stateStart, stateEnd);
    const readyLine = source.split("\n").find((line) => line.includes("REPLY='ready'")) ?? "";
    expect(readyLine).not.toContain("nav");

    // Like other interactive-only commands, nav remains outside the ready
    // allowlist and receives the standard XTMUX_JSON_UNSUPPORTED refusal.
    expect(stateBlock).toContain("XTMUX_JSON_UNSUPPORTED");
  });
});
