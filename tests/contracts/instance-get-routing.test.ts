// K4 (xtmux-s96.4): `instance-get` must be reachable through the name
// agent-state.sh actually calls.
//
// On a real install `xtmux` on PATH is bin/tmux-session-picker, an explicit
// dispatcher — NOT the observability CLI. A subcommand the dispatcher does not
// route falls through to the interactive picker, so the restart-rehydration
// path would exit non-zero (or worse, try to open fzf), silently no-op, and
// still pass every test whose harness stubs `xtmux` with a direct wrapper.
// This test spawns the real dispatcher.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { openDb } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/schema.ts";
import { openInstance } from "../../src/domains/agents/instance.ts";

const ROOT = join(import.meta.dir, "../..");
const PICKER = join(ROOT, "bin/tmux-session-picker");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seed(): string {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-instance-get-"));
  dirs.push(dir);
  const dbPath = join(dir, "observability.db");
  const db = openDb({ dbPath, mode: "on", busyTimeoutMs: 3000 });
  migrate(db);
  openInstance(db, {
    instanceId: "inst-k4",
    sessionId: "$7",
    sessionName: "codex-k4",
    paneId: "%3",
    runtime: "codex",
    role: "implementer",
    beadId: "xtmux-s96.4",
    task: "restart recovery",
    parentSessionId: "$2",
    sourceEvent: "test",
  }, () => 1_000);
  db.close();
  return dbPath;
}

function picker(dbPath: string, args: string[]) {
  const result = spawnSync("bash", [PICKER, ...args], {
    cwd: ROOT,
    env: { ...process.env, XTMUX_OBS_DB_PATH: dbPath, XTMUX_OBS_V2: "1" },
    encoding: "utf8",
  });
  return { exitCode: result.status ?? 1, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

describe("instance-get routing through the picker dispatcher", () => {
  test("plain output is field<TAB>value, parseable by a bash read loop", () => {
    const dbPath = seed();
    const result = picker(dbPath, ["instance-get", "inst-k4"]);
    expect(result.exitCode, result.stderr).toBe(0);
    const fields = Object.fromEntries(
      result.stdout.split("\n").filter(Boolean).map((line) => line.split("\t")),
    );
    expect(fields.beadId).toBe("xtmux-s96.4");
    expect(fields.parentSessionId).toBe("$2");
    expect(fields.task).toBe("restart recovery");
    expect(fields.role).toBe("implementer");
    expect(fields.runtime).toBe("codex");
    expect(fields.paneId).toBe("%3");
    // Every line is exactly one record: a value carrying a tab or newline
    // could otherwise forge a second field.
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      expect(line.split("\t")).toHaveLength(2);
    }
  });

  test("--json returns the object", () => {
    const dbPath = seed();
    const result = picker(dbPath, ["instance-get", "inst-k4", "--json"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      instanceId: "inst-k4",
      paneId: "%3",
      beadId: "xtmux-s96.4",
      endedAtMs: null,
    });
  });

  test("an unknown instance is a clean XTMUX_NOT_FOUND, never a picker launch", () => {
    const dbPath = seed();
    const result = picker(dbPath, ["instance-get", "nope"]);
    expect(result.exitCode).toBe(5);
    expect(JSON.parse(result.stderr).code).toBe("XTMUX_NOT_FOUND");
    expect(result.stdout).toBe("");
  });

  test("a missing argument is a usage error, not an interactive session", () => {
    const dbPath = seed();
    const result = picker(dbPath, ["instance-get"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: instance-get");
  });
});
