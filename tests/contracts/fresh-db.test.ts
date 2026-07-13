import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Regression guard for xtmux-d0a.21: on a virgin XDG_STATE_HOME the monitor /
// telemetry / audit commands skipped migrate(), so the first `monitor-list` on a
// fresh machine hit "no such table: monitors" and printed a raw SQLiteError stack
// — violating the --json error contract, which allows only a {code,message,detail}
// envelope on stderr. The message-* commands always migrated; these did not.
//
// Table-driven on purpose: the three share one dispatch arm, and the next command
// added there would inherit the same gap silently.

const ROOT = join(import.meta.dir, "../..");
const PICKER = join(ROOT, "bin/tmux-session-picker");

let stateHome: string;

beforeEach(() => {
  stateHome = mkdtempSync(join(tmpdir(), "xtmux-freshdb-"));
});

afterEach(() => {
  rmSync(stateHome, { recursive: true, force: true });
});

function runOnFreshDb(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(PICKER, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, XDG_STATE_HOME: stateHome, XTMUX_OBS_V2: "1" },
  });
  if (result.error) throw result.error;
  return {
    exitCode: result.status ?? 1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

describe("V2 commands on a virgin observability DB", () => {
  test("monitor-list --json returns an empty list, not a SQLite stack trace", () => {
    const { exitCode, stdout, stderr } = runOnFreshDb(["monitor-list", "--json"]);
    expect(stderr).not.toContain("SQLiteError");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
  });

  // The whole dispatch arm shares the migrate() gap, so assert the class, not just
  // the one command that happened to be reported.
  for (const args of [["monitor-list", "--json"], ["audit", "--json"]]) {
    test(`${args[0]} never leaks a raw SQLite error`, () => {
      const { stdout, stderr } = runOnFreshDb(args);
      for (const stream of [stdout, stderr]) {
        expect(stream).not.toContain("SQLiteError");
        expect(stream).not.toContain("no such table");
      }
    });
  }
});
