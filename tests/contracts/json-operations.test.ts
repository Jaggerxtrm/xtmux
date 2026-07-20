import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const ROOT = join(import.meta.dir, "../..");
const PICKER = join(ROOT, "bin/tmux-session-picker");

type Result = { exitCode: number; stdout: string; stderr: string };

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Result {
  const result = spawnSync(command, args, { cwd: ROOT, env, encoding: "utf8" });
  return { exitCode: result.status ?? 1, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-json-operations-"));
  const env = { ...process.env, TMUX: undefined, TMUX_PANE: undefined, XDG_RUNTIME_DIR: dir, XTMUX_OBS_V2: "1", XTMUX_OBS_V2_REPO: ROOT, XTMUX_OBS_DB_PATH: join(dir, "obs.db") };
  return { dir, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function cli(args: string[], env: NodeJS.ProcessEnv): Result {
  return run("bun", ["run", "src/cli.ts", ...args], env);
}

describe("operational JSON", () => {
  test("log tail/query return one compact JSON array while no-flag stays NDJSON", () => {
    const ctx = setup();
    try {
      expect(cli(["migrate"], ctx.env).exitCode).toBe(0);
      expect(cli(["log-emit", "query.completed", "command=dashboard", "count=2"], ctx.env).exitCode).toBe(0);

      const tail = cli(["log-tail", "10", "--json"], ctx.env);
      expect(tail.exitCode).toBe(0);
      expect(JSON.parse(tail.stdout)).toContainEqual(expect.objectContaining({ type: "query.completed", command: "dashboard", count: "2" }));
      expect(tail.stdout.trim().split("\n")).toHaveLength(1);

      const query = cli(["log-query", "--type", "query.completed", "--json"], ctx.env);
      expect(JSON.parse(query.stdout)).toEqual([expect.objectContaining({ type: "query.completed", command: "dashboard", count: "2" })]);
      const human = cli(["log-query", "--type", "query.completed"], ctx.env);
      expect(human.stdout.trim()).toStartWith("{");
      expect(human.stdout.trim()).not.toStartWith("[");
    } finally {
      ctx.cleanup();
    }
  });

  test("picker forwards operational JSON to the compiled/source backend", () => {
    const ctx = setup();
    try {
      expect(cli(["migrate"], ctx.env).exitCode).toBe(0);
      expect(cli(["log-emit", "test.event", "outcome=ok", "type=forged", "createdAtMs=0"], ctx.env).exitCode).toBe(0);
      const result = run(PICKER, ["log", "query", "--type", "test.event", "--json"], ctx.env);
      expect(result.exitCode).toBe(0);
      const rows = JSON.parse(result.stdout);
      expect(rows).toEqual([expect.objectContaining({ type: "test.event", outcome: "ok" })]);
      expect(rows[0].createdAtMs).toBeGreaterThan(0);
    } finally {
      ctx.cleanup();
    }
  });

  test("version and obligations add JSON without changing legacy output", () => {
    const ctx = setup();
    try {
      expect(cli(["migrate"], ctx.env).exitCode).toBe(0);
      // P1-07: `version` is now build identity (mirrors `xt version --json`). The
      // journal schema version is retained ADDITIVELY — human output keeps a
      // `schema:` line and the JSON keeps a `schemaVersion` field.
      const version = cli(["version"], ctx.env);
      expect(version.stdout).toContain("@jaggerxtrm/xtmux");
      const schemaMatch = version.stdout.match(/schema:\s*(\d+)/);
      expect(schemaMatch).not.toBeNull();
      const schemaVersion = Number(schemaMatch![1]);

      const info = JSON.parse(cli(["version", "--json"], ctx.env).stdout);
      // toMatchObject, not toEqual: the object is additive over the old {schemaVersion}.
      expect(info).toMatchObject({ package: "@jaggerxtrm/xtmux", source: "local", schemaVersion });
      expect(typeof info.version).toBe("string");
      expect(info.version.length).toBeGreaterThan(0);
      expect(typeof info.runtime.node).toBe("string");
      expect(info.schemaVersion).toBeGreaterThanOrEqual(1);

      const missingPane = cli(["obligations", "list", "--json"], ctx.env);
      expect(missingPane.exitCode).toBe(2);
      expect(missingPane.stdout).toBe("");
      expect(JSON.parse(missingPane.stderr)).toMatchObject({ code: "XTMUX_NOT_IN_TMUX" });
      const arbitraryPane = cli(["obligations", "list", "--pane", "%none", "--json"], ctx.env);
      expect(arbitraryPane.exitCode).toBe(2);
      expect(arbitraryPane.stdout).toBe("");
      expect(JSON.parse(arbitraryPane.stderr)).toMatchObject({ code: "XTMUX_NOT_IN_TMUX" });
    } finally {
      ctx.cleanup();
    }
  });
});
