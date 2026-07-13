import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const ROOT = join(import.meta.dir, "../..");
const PICKER = join(ROOT, "bin/tmux-session-picker");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-json-sessions-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
case "$*" in
  *'list-sessions'*) printf '$1\\talpha\\t%%1\\t/tmp\\t1000\\n$2\\tbeta\\t%%2\\t/tmp\\t900\\n' ;;
  *'list-panes'*'pane_current_command'*) printf '$1\\talpha\\t%%1\\tpi\\t/tmp\\tdone\\t101\\tbead-1\\ttask one\\t-\\n$2\\tbeta\\t%%2\\tbash\\t/tmp\\t-\\t102\\t-\\t-\\t-\\n' ;;
  *'list-panes'*) printf '$1\\talpha\\t%%1\\t/tmp\\n$2\\tbeta\\t%%2\\t/tmp\\n' ;;
  *'#{session_id}'*) printf '$1\\n' ;;
  *'#{pane_id}'*) printf '%%1\\n' ;;
  *'show-options'*) printf 'done\\n' ;;
esac
`);
  writeFileSync(join(bin, "git"), `#!/bin/sh
case "$*" in
  *'rev-parse --show-toplevel'*) printf '/repo\\n' ;;
  *'rev-parse --abbrev-ref HEAD'*) printf 'main\\n' ;;
  *'status --short'*) printf ' M file\\n' ;;
esac
`);
  chmodSync(join(bin, "tmux"), 0o755);
  chmodSync(join(bin, "git"), 0o755);
  return {
    dir,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, TMUX: "/mock,1,0", XTMUX_OBS_V2: "1", XTMUX_OBS_V2_REPO: ROOT, XTMUX_OBS_DB_PATH: join(dir, "obs.db") },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function run(args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(PICKER, args, { cwd: ROOT, env, encoding: "utf8" });
  return { exitCode: result.status ?? 1, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

describe("session query JSON", () => {
  test("dashboard emits deterministic identity rows without ANSI", () => {
    const ctx = setup();
    try {
      const result = run(["dashboard", "expanded", "--json"], ctx.env);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("\u001b[");
      expect(JSON.parse(result.stdout)).toMatchObject({
        mode: "expanded",
        sessions: [
          { sessionId: "$1", sessionName: "alpha", state: "done", beadId: "bead-1", repo: "repo", branch: "main", dirtyCount: 1, sharedWorktree: true, path: "/tmp" },
          { sessionId: "$2", sessionName: "beta", repo: "repo", sharedWorktree: true },
        ],
        panes: [
          { sessionId: "$1", sessionName: "alpha", paneId: "%1", state: "done", beadId: "bead-1", command: "pi", path: "/tmp" },
          { sessionId: "$2", sessionName: "beta", paneId: "%2", state: null, beadId: null },
        ],
      });
    } finally {
      ctx.cleanup();
    }
  });

  test("collisions and audit emit arrays with typed findings", () => {
    const ctx = setup();
    try {
      const collisions = run(["worktree-collisions", "--json"], ctx.env);
      expect(JSON.parse(collisions.stdout)).toEqual([{ path: "/repo", sessionCount: 2, paneCount: 2, sessionNames: ["alpha", "beta"] }]);

      const audit = run(["audit", "--stable", "--json"], ctx.env);
      expect(audit.exitCode).toBe(0);
      const findings = JSON.parse(audit.stdout);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings).toContainEqual(expect.objectContaining({ severity: "warning", kind: "shared-worktree", repo: "repo", path: "/tmp" }));
      expect(audit.stdout).not.toContain("\u001b[");

      const events = run(["log", "query", "--type", "query.completed"], ctx.env).stdout.trim().split("\n").map((line) => JSON.parse(line));
      expect(events.map((event) => event.command)).toEqual(expect.arrayContaining(["worktree-collisions", "audit"]));
      expect(events.every((event) => event.outcome === "ok" && Number(event.duration_ms) >= 0)).toBe(true);
    } finally {
      ctx.cleanup();
    }
  });
});
