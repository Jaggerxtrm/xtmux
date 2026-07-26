// xtrm-wiy5n.4.40: `xtmux log-follow` must not outlive the shell that started
// it. The evidence caught an orphaned `bun.exe … log-follow --after-id …
// --json` process alive 1h38m after its parent shell was killed. That parent
// was `scripts/test-session-events.sh --json`; the shell was killed with
// SIGKILL, so its `trap cleanup` never fired, and the bun subprocess kept
// polling the coordination DB forever.
//
// Two defenses are locked in here:
//   1. `xtmux log-follow` self-reaps when its parent goes away — PPID
//      polling per poll tick. This is the primary defense that works even
//      when the shell dies with SIGKILL (no traps run at all).
//   2. `scripts/test-session-events.sh` now traps SIGHUP alongside INT/TERM,
//      so a terminal-close / pane-detach signal reaches the teardown path
//      instead of silently leaving followers behind.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { openDb } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/schema.ts";

const ROOT = join(import.meta.dir, "../..");
const CLI = join(ROOT, "src/cli.ts");

function scratch(): { root: string; dbPath: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "xtmux-log-follow-reap-"));
  const dbPath = join(root, "state", "observability.db");
  for (const dir of [join(root, "state"), join(root, "runtime"), join(root, "tmp")]) {
    mkdirSync(dir, { recursive: true });
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XTMUX_OBS_V2: "1",
    XTMUX_OBS_DB_PATH: dbPath,
    XDG_STATE_HOME: join(root, "state"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    TMPDIR: join(root, "tmp"),
  };
  return { root, dbPath, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await Bun.sleep(50);
  }
  return false;
}

describe("log-follow parent-reap (xtrm-wiy5n.4.40)", () => {
  // The parent-shell-dies-with-SIGKILL case: the shell's traps never fire, so
  // the primary defense MUST be the child's own PPID poll. The child sees its
  // PPID become 1 (init) or 0 (unknown) and exits from its next poll tick,
  // regardless of any supervisor logic.
  test("log-follow exits when its parent shell dies without teardown (SIGKILL parent)", async () => {
    const ctx = scratch();
    try {
      // Seed and migrate so the follower has a real DB to poll.
      const db = openDb({ dbPath: ctx.dbPath, mode: "on", busyTimeoutMs: 3000 });
      migrate(db);
      db.close();

      // Spawn a parent shell that spawns log-follow and prints its child PID.
      // The parent then blocks on a sleep so we can SIGKILL it cleanly.
      const parent = spawn("bash", ["-c",
        `bun run "${CLI}" log-follow --after-id 0 --interval 100 --json > /dev/null 2>&1 &
         printf '%s\\n' "$!"
         wait $!`,
      ], { env: ctx.env, stdio: ["ignore", "pipe", "pipe"] });
      let childPidStr = "";
      const readOnce = new Promise<void>((resolve) => {
        parent.stdout.once("data", (chunk) => { childPidStr += String(chunk); resolve(); });
      });
      await readOnce;
      const childPid = Number(childPidStr.trim());
      expect(Number.isInteger(childPid) && childPid > 0).toBe(true);

      // Give the child a real poll tick or two so it captures its initial PPID.
      await Bun.sleep(400);
      expect(pidAlive(childPid)).toBe(true);

      // SIGKILL the parent shell — no trap, no teardown, no cleanup callback.
      // Only the child's own PPID-based self-reap can save us.
      process.kill(parent.pid!, "SIGKILL");

      // Bound: poll interval is 100ms, PPID reparent + next tick + bun teardown
      // fits well inside 5s on any reasonable runner.
      const exited = await waitForExit(childPid, 5_000);
      if (!exited) {
        // Best-effort cleanup for the test runner if the invariant regresses.
        try { process.kill(childPid, "SIGKILL"); } catch { /* ignore */ }
      }
      expect(exited).toBe(true);
    } finally {
      ctx.cleanup();
    }
  }, 30_000);

  // The other half of the story — the shell script's trap list. When the
  // parent gets SIGHUP (terminal close / pane detach), the trap MUST run so
  // pipeline children die cleanly, not just when SIGINT/SIGTERM arrive.
  test("test-session-events.sh traps SIGHUP alongside INT/TERM", () => {
    const script = join(ROOT, "scripts/test-session-events.sh");
    // A grep-shaped assertion: the trap statement must list HUP. A brittle
    // AST-level check is not warranted for a one-liner shell contract, and
    // the negative side (drop HUP -> this fails) is what the invariant needs.
    const result = spawnSync("grep", ["-cE", "^trap cleanup EXIT INT TERM HUP\\b", script], { encoding: "utf8" });
    expect(result.stdout.trim()).toBe("1");
  });
});
