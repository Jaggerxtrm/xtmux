import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { openDb } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/schema.ts";

const ROOT = join(import.meta.dir, "../..");
const PICKER = join(ROOT, "bin/tmux-session-picker");

type Result = { exitCode: number; stdout: string; stderr: string };

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Result {
  const result = spawnSync(command, args, { cwd: ROOT, env, encoding: "utf8" });
  return { exitCode: result.status ?? 1, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function setup(): { dir: string; dbPath: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-hostile-"));
  const dbPath = join(dir, "observability.db");
  const db = openDb({ dbPath, mode: "on", busyTimeoutMs: 3000 });
  migrate(db);
  db.close();
  const bin = join(dir, "mock-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
[ "\${MOCK_TMUX_MISSING:-}" = 1 ] && exit 1
case "$*" in
  *'show-options'*) printf '%s\\n' "\${MOCK_TMUX_STATE:-}" ;;
  *'#{pane_id}'*) printf '%%mock\\n' ;;
  *'#{session_id}'*) printf '$mock\\n' ;;
esac
`);
  chmodSync(join(bin, "tmux"), 0o755);
  return {
    dir,
    dbPath,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      XDG_STATE_HOME: join(dir, "state"),
      XTMUX_EVENT_LOG_FILE: join(dir, "events.jsonl"),
      XTMUX_OBS_DB_PATH: dbPath,
      XTMUX_OBS_V2: "1",
      XTMUX_OBS_V2_REPO: ROOT,
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function rowCount(dbPath: string, table: string): number {
  const db = new Database(dbPath, { readonly: true });
  const row = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get();
  db.close();
  return row?.n ?? 0;
}

describe("hostile invocation environments", () => {
  test("a valid pane without @agent_bead keeps the bead NULL", () => {
    const ctx = setup();
    try {
      const result = run(PICKER, ["telemetry", "git", "--", "rev-parse", "--show-toplevel"], {
        ...ctx.env,
        TMUX: "/mock/tmux.sock,99999,0",
        TMUX_PANE: "%mock",
      });
      expect(result.exitCode).toBe(0);

      const db = new Database(ctx.dbPath, { readonly: true });
      const row = db
        .query<{ session_id: string | null; pane_id: string | null; bead_id: string | null }, []>(
          "SELECT session_id, pane_id, bead_id FROM command_runs ORDER BY started_at_ms DESC LIMIT 1",
        )
        .get();
      db.close();
      expect(row).toEqual({ session_id: "$mock", pane_id: "%mock", bead_id: null });
    } finally {
      ctx.cleanup();
    }
  });

  test("a pane without @agent_state is stored as unknown, never empty", async () => {
    const ctx = setup();
    try {
      const result = run(PICKER, ["monitor-agent", "contract", "--timeout", "1s", "--interval", "1s"], {
        ...ctx.env,
        TMUX: "/mock/tmux.sock,99999,0",
      });
      expect(result.exitCode).toBe(0);
      await Bun.sleep(50);

      const db = new Database(ctx.dbPath, { readonly: true });
      const row = db.query<{ state: string }, []>("SELECT state FROM monitors ORDER BY started_at_ms DESC LIMIT 1").get();
      db.close();
      expect(row?.state).toBe("unknown");
    } finally {
      ctx.cleanup();
    }
  });

  test("a gone target rejects monitor registration without a partial row", () => {
    const ctx = setup();
    try {
      const result = run(PICKER, ["monitor-agent", "contract"], { ...ctx.env, MOCK_TMUX_MISSING: "1" });
      expect(result.exitCode).toBe(1);
      expect(rowCount(ctx.dbPath, "monitors")).toBe(0);
    } finally {
      ctx.cleanup();
    }
  });

  test("missing tmux binary rejects monitor registration without a partial row", () => {
    const ctx = setup();
    const bin = join(ctx.dir, "no-tmux-bin");
    try {
      mkdirSync(bin);
      for (const command of ["basename", "dirname"]) symlinkSync(`/usr/bin/${command}`, join(bin, command));
      const result = run("/bin/bash", [PICKER, "monitor-agent", "contract"], {
        ...ctx.env,
        PATH: bin,
        TMUX: undefined,
        TMUX_PANE: undefined,
      });
      expect(result.exitCode).not.toBe(0);
      expect(rowCount(ctx.dbPath, "monitors")).toBe(0);
    } finally {
      ctx.cleanup();
    }
  });
});
