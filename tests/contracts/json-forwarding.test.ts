import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const ROOT = join(import.meta.dir, "../..");
const PICKER = join(ROOT, "bin/tmux-session-picker");

function run(args: string[], mode = "1", picker = PICKER) {
  const result = spawnSync(picker, args, {
    cwd: ROOT,
    env: { ...process.env, XTMUX_OBS_V2: mode, XTMUX_OBS_V2_REPO: ROOT },
    encoding: "utf8",
  });
  return { exitCode: result.status ?? 1, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function errorOf(stderr: string): { code: string; message: string; detail: Record<string, unknown> } {
  return JSON.parse(stderr) as { code: string; message: string; detail: Record<string, unknown> };
}

describe("picker JSON forwarding guard", () => {
  test("interactive commands reject --json before rendering", () => {
    const result = run(["preview", "--json", "session", "$missing", "missing", ""]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(errorOf(result.stderr)).toEqual({
      code: "XTMUX_JSON_UNSUPPORTED",
      message: "preview does not support --json",
      detail: { command: "preview" },
    });
  });

  test("transparent telemetry rejects --json before running a wrapped command", () => {
    const result = run(["telemetry", "--json", "git", "--", "status"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(errorOf(result.stderr).code).toBe("XTMUX_JSON_UNSUPPORTED");
  });

  test("explicit V1 rejects supported JSON instead of returning TSV", () => {
    const result = run(["message-list", "--for", "nobody", "--json"], "0");
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(errorOf(result.stderr)).toEqual({
      code: "XTMUX_JSON_REQUIRES_V2",
      message: "message-list --json requires the V2 runtime",
      detail: { command: "message-list" },
    });
  });

  test("ready commands forward JSON", () => {
    const ready = run(["message-list", "--for", "nobody", "--json"]);
    expect(ready.exitCode).toBe(0);
    expect(JSON.parse(ready.stdout)).toEqual([]);
  });

  test("ready commands report an unavailable backend without falling back", () => {
    const dir = mkdtempSync(join(tmpdir(), "xtmux-json-forwarding-"));
    const bin = join(dir, "bin");
    const picker = join(bin, "tmux-session-picker");
    try {
      mkdirSync(bin);
      copyFileSync(PICKER, picker);
      chmodSync(picker, 0o755);
      const result = run(["message-list", "--for", "nobody", "--json"], "1", picker);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorOf(result.stderr).code).toBe("XTMUX_JSON_BACKEND_UNAVAILABLE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
