// xtrm-wiy5n.4.17: safe-send-pointer must never silently hang on a stuck
// coordination-DB call. The DB layer already carries a busy_timeout, but a
// stuck bun subprocess / WAL recovery / disk syscall can still stall the shell
// caller. `safe_pointer_obs_call` bounds every obs subprocess by
// XTMUX_OBS_CALL_TIMEOUT_SEC and, on timeout, emits a diagnostic that names
// the coordination DB path and the fuser-reported holder pids.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { openDb } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/schema.ts";

const ROOT = join(import.meta.dir, "../..");
const REAL_PICKER = join(ROOT, "bin/tmux-session-picker");
const REAL_BUN = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim();

// Route the picker's obs subprocess through a shim we control by copying the
// picker into the test root, then placing an xtmux-obs shim next to it —
// `obs_runtime_argv` resolves `$root/bin/xtmux-obs` from the picker's own
// path, so this deterministically hijacks the write path without touching the
// production binary at repo/bin/xtmux-obs (CI builds it; a local checkout may
// not have it). SHIM_DELAY_SEC gates the sleep so the "fast obs" test can
// reuse the same shim on the happy path.
function installObsShim(root: string): { picker: string } {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const picker = join(bin, "tmux-session-picker");
  copyFileSync(REAL_PICKER, picker);
  chmodSync(picker, 0o755);
  // exec sleep so the outer `timeout` can signal sleep directly. A trap+bash
  // wrapper would swallow SIGTERM until sleep returned on its own.
  const shim = `#!/usr/bin/env bash
if [ -n "\${SHIM_DELAY_SEC:-}" ]; then
  for arg in "$@"; do
    case "$arg" in
      delivery-record|handoff|message-reply) exec sleep "\$SHIM_DELAY_SEC" ;;
    esac
  done
fi
exec ${JSON.stringify(REAL_BUN)} run ${JSON.stringify(join(ROOT, "src/cli.ts"))} "$@"
`;
  writeFileSync(join(bin, "xtmux-obs"), shim);
  chmodSync(join(bin, "xtmux-obs"), 0o755);
  return { picker };
}

function setup(): {
  root: string;
  picker: string;
  dbPath: string;
  calls: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "xtmux-safe-send-timeout-"));
  const dbPath = join(root, "state", "observability.db");
  const calls = join(root, "tmux.calls");
  for (const dir of [join(root, "home"), join(root, "state"), join(root, "runtime"), join(root, "tmp"), join(root, "tmux")]) {
    mkdirSync(dir, { recursive: true });
  }
  const { picker } = installObsShim(root);
  const bin = join(root, "bin");
  writeFileSync(join(bin, "tmux"), `#!/bin/bash
target=""; previous=""
for arg in "$@"; do
  [ "$previous" = -t ] && target="$arg"
  previous="$arg"
done
format="\${!#}"
session="\${MOCK_SESSION:-\\$owner}"; pane="\${MOCK_PANE:-%owner}"
case "$1" in
  display-message)
    case "$format" in
      *'#{session_id}'*'#{window_id}'*'#{pane_id}'*) printf '%s\\t@w\\t%s\\t\\t\\t\\t1\\n' "$session" "$pane" ;;
      '#{session_id}') printf '%s\\n' "$session" ;;
      '#{pane_id}') printf '%s\\n' "$pane" ;;
      '#{pane_current_command}') printf 'pi\\n' ;;
      '#{pane_pid}') printf '%s\\n' "$$" ;;
      '#S') printf '%s\\n' "\${session#\\$}" ;;
      *) : ;;
    esac ;;
  show-options) printf '%s\\n' "\${MOCK_STATE:-done}" ;;
  send-keys) printf 'send-keys\\t%s\\n' "$*" >> "$TMUX_CALLS" ;;
  set-option|capture-pane) : ;;
  *) : ;;
esac
`);
  chmodSync(join(bin, "tmux"), 0o755);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    HOME: join(root, "home"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    TMPDIR: join(root, "tmp"),
    TMUX_TMPDIR: join(root, "tmux"),
    TMUX: join(root, "tmux.sock") + ",1,0",
    TMUX_PANE: "%owner",
    MOCK_SESSION: "$owner",
    MOCK_PANE: "%owner",
    TMUX_CALLS: calls,
    XTMUX_HOST_ID: "test-host",
    XTMUX_OBS_V2: "1",
    XTMUX_OBS_V2_REPO: ROOT,
    XTMUX_OBS_DB_PATH: dbPath,
  };
  return { root, picker, dbPath, calls, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runPicker(pickerPath: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 20_000) {
  return spawnSync(pickerPath, args, { cwd: ROOT, env, encoding: "utf8", timeout: timeoutMs });
}

describe("safe-send-pointer wall-clock timeout on obs subprocess (xtrm-wiy5n.4.17)", () => {
  test("bounded timeout diagnostic names the DB path and wall-clock cap when obs hangs", () => {
    const ctx = setup();
    try {
      // Seed the coordination DB so its file exists and `fuser` has something to
      // report if anyone happens to hold it open. The stall itself is produced
      // by the slow-bun shim, not by real DB contention — the invariant under
      // test is the wrapper's cap-and-diagnose behavior.
      const db = openDb({ dbPath: ctx.dbPath, mode: "on", busyTimeoutMs: 3000 });
      migrate(db);
      db.close();

      const started = Date.now();
      const result = runPicker(ctx.picker,
        ["safe-send-pointer", "--yes", "--force-freeform", "%worker", "/help"],
        { ...ctx.env, SHIM_DELAY_SEC: "8", XTMUX_OBS_CALL_TIMEOUT_SEC: "1" },
        15_000,
      );
      const elapsedMs = Date.now() - started;

      // The send itself must have committed to tmux BEFORE the DB call — a stuck
      // observability write must never gate the injection.
      expect(result.stdout).toContain("sent target=%worker");
      // Silent-hang was the whole bug: the diagnostic MUST appear on stderr and
      // MUST name the coordination DB path plus the fuser holder list.
      expect(result.stderr).toContain("safe-send-pointer:");
      expect(result.stderr).toContain("wall-clock cap");
      expect(result.stderr).toContain("XTMUX_OBS_CALL_TIMEOUT_SEC");
      expect(result.stderr).toContain(ctx.dbPath);
      expect(result.stderr).toContain("holders (pids from fuser):");
      // The wrapper must have cut the call short. Cap is 1s; without it the shim
      // would sleep 8s. 5s is a generous ceiling that still catches a regression.
      expect(elapsedMs).toBeLessThan(5_000);
    } finally {
      ctx.cleanup();
    }
  }, 30_000);

  // Success criterion #3: a long-lived reader (log-follow was the process the
  // task's evidence caught) must not block a coordination-DB write. WAL mode
  // and the openDb busy_timeout already guarantee this, but a regression test
  // pins the behavior — if a future change accidentally opens the writer path
  // outside WAL or drops busy_timeout, the send would start blocking on the
  // reader again and this test would fail before it reaches production.
  test("a real log-follow reader does not block delivery-record on the coordination DB", () => {
    const ctx = setup();
    try {
      // Seed and migrate through openDb so the DB is in the same shape a
      // production install would produce (busy_timeout + WAL).
      const seed = openDb({ dbPath: ctx.dbPath, mode: "on", busyTimeoutMs: 3000 });
      migrate(seed);
      seed.close();

      // Start a REAL log-follow in the background using the vanilla bun (no
      // shim delay): the wrapper's cap must not be what protects us; WAL must.
      const reader = Bun.spawn({
        cmd: ["bun", "run", join(ROOT, "src/cli.ts"), "log-follow", "--after-id", "0", "--interval", "100", "--json"],
        env: { ...process.env, XTMUX_OBS_V2: "1", XTMUX_OBS_DB_PATH: ctx.dbPath },
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        // Give the reader a moment to open the DB and settle on the poll loop
        // so fuser confirms it is actually holding a handle when the writer runs.
        Bun.sleepSync(500);

        const started = Date.now();
        const write = spawnSync("bun", ["run", join(ROOT, "src/cli.ts"),
          "delivery-record", "--kind", "pane_pointer", "--source-session", "$src",
          "--target-session", "$tgt", "--target-pane", "%tgt", "--summary", "regression",
          "--succeeded", "true",
        ], {
          env: { ...process.env, XTMUX_OBS_V2: "1", XTMUX_OBS_DB_PATH: ctx.dbPath },
          encoding: "utf8", timeout: 10_000,
        });
        const elapsedMs = Date.now() - started;

        expect(write.status).toBe(0);
        // WAL + 3s busy_timeout: a passive reader must not add more than a
        // negligible cost. 3s is the ceiling the DB layer would enforce if
        // busy_timeout ever kicked in against a legitimate write lock; well
        // under it means the reader really did stay out of the writer's way.
        expect(elapsedMs).toBeLessThan(3_000);
      } finally {
        reader.kill("SIGTERM");
      }
    } finally {
      ctx.cleanup();
    }
  }, 30_000);

  // Success criterion #2: a bounded busy_timeout on the coordination-DB write
  // path. Locked in with a PRAGMA read against a real openDb handle — if a
  // future change ever drops or zeroes the busy_timeout pragma, this fails and
  // the wall-clock cap becomes the only backstop instead of the belt-and-braces
  // pair the task requires.
  test("openDb sets a positive busy_timeout on the writer connection", () => {
    const ctx = setup();
    try {
      const db = openDb({ dbPath: ctx.dbPath, mode: "on", busyTimeoutMs: 3000 });
      migrate(db);
      // bun:sqlite returns the PRAGMA row under the column name `timeout`, not
      // `busy_timeout` — the pragma reads back through a virtual table.
      const row = db.raw.query<{ timeout: number }, []>("PRAGMA busy_timeout").get();
      db.close();
      expect(row?.timeout ?? 0).toBeGreaterThan(0);
      expect(row?.timeout ?? 0).toBe(3000);
    } finally {
      ctx.cleanup();
    }
  });

  test("a fast obs subprocess is not perturbed by the wrapper (no diagnostic, no slowdown)", () => {
    const ctx = setup();
    try {
      const started = Date.now();
      const result = runPicker(ctx.picker,
        ["safe-send-pointer", "--yes", "--force-freeform", "%worker", "/help"],
        { ...ctx.env, XTMUX_OBS_CALL_TIMEOUT_SEC: "10" },
      );
      const elapsedMs = Date.now() - started;
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("sent target=%worker");
      // A wall-clock timeout that fires on the happy path is a defect: only a
      // real stall may emit the diagnostic.
      expect(result.stderr).not.toContain("wall-clock cap");
      expect(elapsedMs).toBeLessThan(8_000);
    } finally {
      ctx.cleanup();
    }
  });
});
