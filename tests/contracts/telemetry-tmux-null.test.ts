import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { openDb } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/schema.ts";

const ROOT = join(import.meta.dir, "../..");
const PICKER = join(ROOT, "bin/tmux-session-picker");

type IdentityRow = {
  session_id: string | null;
  pane_id: string | null;
  bead_id: string | null;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function run(command: string, args: string[], overrides: Record<string, string | undefined> = {}): CommandResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync(command, args, { cwd: ROOT, env, encoding: "utf8" });
  if (result.error) throw result.error;
  return {
    exitCode: result.status ?? 1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function createDb(dir: string): string {
  const dbPath = join(dir, "observability.db");
  const db = openDb({ dbPath, mode: "on", busyTimeoutMs: 3000 });
  migrate(db);
  db.close();
  return dbPath;
}

function telemetryEnv(dir: string, dbPath: string): Record<string, string> {
  return {
    XDG_STATE_HOME: join(dir, "state"),
    XTMUX_EVENT_LOG_FILE: join(dir, "events.jsonl"),
    XTMUX_OBS_DB_PATH: dbPath,
    XTMUX_OBS_V2: "1",
    XTMUX_OBS_V2_REPO: ROOT,
  };
}

function runTelemetry(dir: string, tmux: string | undefined, pane: string | undefined): IdentityRow {
  const dbPath = createDb(dir);
  const result = run(
    PICKER,
    ["telemetry", "git", "--", "rev-parse", "--show-toplevel"],
    { ...telemetryEnv(dir, dbPath), TMUX: tmux, TMUX_PANE: pane },
  );
  expect(result.exitCode).toBe(0);

  const db = new Database(dbPath, { readonly: true });
  const row = db
    .query<IdentityRow, []>(
      "SELECT session_id, pane_id, bead_id FROM command_runs ORDER BY started_at_ms DESC LIMIT 1",
    )
    .get();
  db.close();
  expect(row).toBeDefined();
  return row!;
}

describe("telemetry tmux identity boundary", () => {
  test("TMUX unset stores NULL session, pane, and bead", () => {
    const dir = mkdtempSync(join(tmpdir(), "xtmux-telemetry-null-"));
    try {
      const row = runTelemetry(dir, undefined, process.env.TMUX_PANE);
      expect(row).toEqual({ session_id: null, pane_id: null, bead_id: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stale TMUX does not fall back to a bystander", () => {
    const dir = mkdtempSync(join(tmpdir(), "xtmux-telemetry-stale-"));
    try {
      const row = runTelemetry(dir, "/nonexistent/xtmux.sock,99999,0", process.env.TMUX_PANE);
      expect(row).toEqual({ session_id: null, pane_id: null, bead_id: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("valid TMUX keeps current session, pane, and bead attribution", () => {
    const dir = mkdtempSync(join(tmpdir(), "xtmux-telemetry-valid-"));
    const socket = join(dir, "tmux.sock");
    const tmuxOverrides = { TMUX: undefined, TMUX_PANE: undefined };
    try {
      const started = run("tmux", ["-S", socket, "new-session", "-d", "-s", "contract"], tmuxOverrides);
      expect(started.exitCode).toBe(0);
      const option = run(
        "tmux",
        ["-S", socket, "set-option", "-p", "-t", "%0", "@agent_bead", "contract-bead"],
        tmuxOverrides,
      );
      expect(option.exitCode).toBe(0);
      const identity = run(
        "tmux",
        ["-S", socket, "display-message", "-p", "#{session_id}\t#{pane_id}"],
        tmuxOverrides,
      );
      expect(identity.exitCode).toBe(0);
      const [session, pane] = identity.stdout.trim().split("\t");

      const row = runTelemetry(dir, `${socket},99999,0`, "%0");
      expect(row).toEqual({ session_id: session, pane_id: pane, bead_id: "contract-bead" });
    } finally {
      run("tmux", ["-S", socket, "kill-server"], tmuxOverrides);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
