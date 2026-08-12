// xtmux-dvs: the monitor/state machinery let an orchestrator run a five-lane
// programme blind for a day. Two defects, both reporting success.
//
// Defect 1 — `monitor-agent` registered a monitor row and returned. Nothing ever
//   polled it, so its lease (max(3*interval, 30s), set at registration and
//   refreshed only by a heartbeat that never came) expired by construction, and
//   the next `monitor-list` reconcile stamped `process_gone` on a pane that was
//   demonstrably alive, then replayed the wait and delivered a wake. The caller
//   had already been handed a normal monitorId and exit 0.
//   The same omission sat in the poll loop itself: it never heartbeat, so even a
//   live foreground `wait-agent` monitor lease-expired after 30s.
//
// Defect 2 — @agent_state is last-write-wins, so a pane that died mid-turn keeps
//   advertising `running` forever. Five panes reported running with
//   @agent_last_transition frozen for over eight hours.
//
// These tests drive the real CLI against a real (isolated) tmux server. They are
// timing-bound by the 30s lease floor (src/domains/monitors/terminal.ts), so the
// lease test runs with a 1s interval and waits it out once.
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/schema.ts";
import { applyStaleness, AGENT_STALE_AFTER_MS } from "../../src/tmux.ts";
import { register, terminate } from "../../src/domains/monitors/store.ts";
import { armOutboundWait, registerOutboundWait } from "../../src/domains/monitors/outbound-wake.ts";

const ROOT = join(import.meta.dir, "../..");
const CLI = join(ROOT, "src/cli.ts");
const SOCKET = `xtmux-dvs-${process.pid}`;

function tmux(args: string[]): string {
  const r = spawnSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf8" });
  return String(r.stdout ?? "").trim();
}

interface Ctx {
  dbPath: string;
  env: NodeJS.ProcessEnv;
  target: string;
  targetSession: string;
  cleanup: () => void;
}

// Every scratch gets its own tmux sessions: they share one server, and reusing a
// session name would silently hand two tests the same pane.
let seq = 0;

function scratch(): Ctx {
  const n = ++seq;
  const root = mkdtempSync(join(tmpdir(), "xtmux-dvs-"));
  const dbPath = join(root, "state", "observability.db");
  for (const dir of ["state", "runtime", "tmp"]) mkdirSync(join(root, dir), { recursive: true });
  const db = openDb({ dbPath, mode: "on", busyTimeoutMs: 3000 });
  migrate(db);
  db.close();

  const targetSession = `tgt${n}`;
  tmux(["new-session", "-d", "-s", targetSession, "sleep 600"]);
  tmux(["new-session", "-d", "-s", `req${n}`, "sleep 600"]);
  const target = tmux(["list-panes", "-t", targetSession, "-F", "#{pane_id}"]);
  const requester = tmux(["list-panes", "-t", `req${n}`, "-F", "#{pane_id}"]);
  tmux(["set-option", "-p", "-t", target, "@agent_state", "running"]);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XTMUX_OBS_V2: "1",
    XTMUX_OBS_DB_PATH: dbPath,
    XDG_STATE_HOME: join(root, "state"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    TMPDIR: join(root, "tmp"),
    TMUX: `${tmux(["display-message", "-p", "-t", requester, "#{socket_path}"])},0,0`,
    TMUX_PANE: requester,
  };
  return {
    dbPath, env, target, targetSession,
    cleanup: () => {
      // Kill the detached pollers first: they hold the DB this scratch owns.
      for (const pid of pollerPids(dbPath)) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
      tmux(["kill-session", "-t", targetSession]);
      tmux(["kill-session", "-t", `req${n}`]);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function pollerPids(dbPath: string): number[] {
  try {
    const raw = new Database(dbPath, { readonly: true });
    try {
      return raw.query<{ owner_pid: number | null }, []>("SELECT owner_pid FROM monitors").all()
        .map((r) => r.owner_pid).filter((p): p is number => typeof p === "number");
    } finally { raw.close(); }
  } catch { return []; }
}

function cli(env: NodeJS.ProcessEnv, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bun", ["run", CLI, ...args], { cwd: ROOT, env, encoding: "utf8", timeout: 30_000 });
  return { status: r.status ?? 1, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
}

function monitorRows(env: NodeJS.ProcessEnv): Array<Record<string, unknown>> {
  const res = cli(env, ["monitor-list", "--json"]);
  expect(res.status).toBe(0);
  return JSON.parse(res.stdout) as Array<Record<string, unknown>>;
}

afterAll(() => { tmux(["kill-server"]); });

describe("xtmux-dvs defect 1: monitor-agent must arm a real poller", () => {
  // The exact reproduction from the bead: arm against a live pane, wait past the
  // lease, and assert the monitor is still active and the pane is still alive.
  // Against pre-fix code this row is `process_gone` with wakeDelivered=true.
  test("an armed monitor survives its lease while the target pane is alive", () => {
    const ctx = scratch();
    try {
      const armed = cli(ctx.env, ["monitor-agent", ctx.target, "--wait-for-transition", "--timeout", "30m", "--interval", "1s", "--json"]);
      expect(armed.status).toBe(0);
      const result = JSON.parse(armed.stdout) as Record<string, unknown>;
      expect(result.terminalStatus).toBeNull();

      // A monitor reported as armed must have a poller behind it. Registration
      // alone is what made the failure silent.
      const pids = pollerPids(ctx.dbPath);
      expect(pids.length).toBe(1);
      expect(() => process.kill(pids[0]!, 0)).not.toThrow();

      // Lease = max(3 * interval, 30s) = 30s here. Past it, pre-fix code has
      // already reconciled the row to process_gone.
      spawnSync("sleep", ["33"]);
      expect(tmux(["display-message", "-p", "-t", ctx.target, "#{pane_id}"])).toBe(ctx.target);
      expect(tmux(["show-options", "-p", "-t", ctx.target, "-qv", "@agent_state"])).toBe("running");

      const [row] = monitorRows(ctx.env);
      expect(row).toBeDefined();
      expect(row!.terminalStatus).toBeNull();
      expect(row!.state).toBe("running");
      expect(row!.wakeDelivered).toBe(false);
    } finally { ctx.cleanup(); }
  }, 90_000);

  // The part that cost the day: a monitor that cannot arm returned a normal
  // monitorId and exit 0. It must now error, and leave a terminal row a caller
  // cannot mistake for an armed monitor.
  test("monitor-agent errors loudly when the poller cannot start", () => {
    const ctx = scratch();
    try {
      // An arm window of 0 performs zero waits, so the gate fires deterministically:
      // the only elapsed time between the spawn and the adoption check is one
      // SQLite read, which no Bun cold start can beat. A 1ms window was NOT
      // equivalent — it can still admit one 50ms sleep when the deadline lands
      // inside the same millisecond, which is long enough for the poller to adopt.
      // That is what made this test green locally and red on CI.
      const armed = cli(
        { ...ctx.env, XTMUX_MONITOR_ARM_TIMEOUT_MS: "0" },
        ["monitor-agent", ctx.target, "--timeout", "30m", "--interval", "1s", "--json"],
      );
      expect(armed.status).not.toBe(0);
      expect(armed.stdout).toBe("");
      const err = JSON.parse(armed.stderr.trim().split("\n").pop()!) as Record<string, unknown>;
      expect(err.code).toBe("XTMUX_MONITOR_ARM_FAILED");
      const detail = err.detail as Record<string, unknown>;
      expect(detail.terminalStatus).toBe("error");

      // ...and the row it leaves behind is terminal, not a dangling active one.
      const rows = monitorRows(ctx.env);
      expect(rows.length).toBe(1);
      expect(rows[0]!.terminalStatus).toBe("error");
      expect(rows[0]!.state).toBe("error");
    } finally { ctx.cleanup(); }
  }, 60_000);

  // Terminal status is absorbing (src/domains/monitors/terminal.ts), and the
  // poller is not its only writer: a `monitor-list` reconcile stamps target_gone
  // the moment the pane disappears. Once the poll loop heartbeats every tick —
  // which is what keeps the lease alive — a live poller meets that absorbing rule
  // on its very next tick and `assertHeartbeat` throws. The handler then tried to
  // stamp `error` over the existing terminal status, which throws a SECOND time,
  // out of the handler: a handled failure became an uncaught crash.
  //
  // The poller runs in the FOREGROUND here on purpose. `monitor-agent` detaches
  // its poller with stdio ignored, so the crash this pins is invisible from
  // there — an earlier version of this test watched a detached poller and passed
  // against the unguarded code. `monitor-kill` is not the trigger either: it
  // SIGTERMs owner_pid, so the poller dies by signal before reaching the rule.
  //
  // The same guard covers `wait-agent`, which runs this loop in-process: a
  // concurrent reconcile stamping `timeout` used to surface there as
  // XTMUX_INVALID_ARGUMENT exit 2 instead of the wait's real outcome.
  test("a monitor terminated underneath a live poller stands down instead of crashing", async () => {
    const ctx = scratch();
    try {
      expect(cli(ctx.env, ["monitor", "register", "--id", "m-standdown", "--target", ctx.target,
        "--pane", ctx.target, "--state", "running", "--timeout", "1800", "--interval", "1"]).status).toBe(0);
      // A 5s interval parks the poller in its sleep for the whole setup below, so
      // the reconcile deterministically wins the race to conclude the row. With a
      // 1s interval the poller gets there first and concludes target_gone itself,
      // which is correct behaviour but exercises a different branch.
      const poller = Bun.spawn(["bun", "run", CLI, "monitor-run", "m-standdown", "--wait-for-transition", "--timeout", "30m", "--interval", "5s"],
        { cwd: ROOT, env: ctx.env, stdout: "pipe", stderr: "pipe" });
      await Bun.sleep(1500); // adopt, tick once, then park in the interval sleep

      // The other writer: the target pane vanishes, and a reconcile concludes it.
      tmux(["kill-session", "-t", ctx.targetSession]);
      expect(cli(ctx.env, ["monitor-list", "--json"]).status).toBe(0);

      const exitCode = await poller.exited;
      const stderr = await new Response(poller.stderr).text();
      expect(stderr).not.toContain("IllegalTransitionError");
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);

      // ...and the reconcile's conclusion survives, unoverwritten.
      const row = monitorRows(ctx.env).find((r) => r.monitorId === "m-standdown");
      expect(row!.terminalStatus).toBe("target_gone");
    } finally { ctx.cleanup(); }
  }, 60_000);

  test("--wait-for-transition reaches the poller instead of being parsed and dropped", () => {
    const ctx = scratch();
    try {
      // The pane is NOT working; with --wait-for-transition the monitor must stay
      // active waiting for the transition rather than concluding `done`.
      tmux(["set-option", "-p", "-t", ctx.target, "@agent_state", "needs-input"]);
      const armed = cli(ctx.env, ["monitor-agent", ctx.target, "--wait-for-transition", "--timeout", "30m", "--interval", "1s", "--json"]);
      expect(armed.status).toBe(0);
      spawnSync("sleep", ["3"]);
      expect(monitorRows(ctx.env)[0]!.terminalStatus).toBeNull();

      // Without the flag the same non-working pane terminates as `done` at once.
      const ctx2 = scratch();
      try {
        tmux(["set-option", "-p", "-t", ctx2.target, "@agent_state", "needs-input"]);
        expect(cli(ctx2.env, ["monitor-agent", ctx2.target, "--timeout", "30m", "--interval", "1s", "--json"]).status).toBe(0);
        spawnSync("sleep", ["3"]);
        expect(monitorRows(ctx2.env)[0]!.terminalStatus).toBe("done");
      } finally { ctx2.cleanup(); }
    } finally { ctx.cleanup(); }
  }, 60_000);
});

describe("xtmux-dvs defect 2: @agent_state liveness", () => {
  // The rule itself, without tmux. `running` is the only state an old transition
  // timestamp can contradict.
  test("only running is falsifiable by age, and the rule fails open", () => {
    const now = Date.parse("2026-08-05T12:00:00Z");
    const old = new Date(now - AGENT_STALE_AFTER_MS - 60_000).toISOString();
    const fresh = new Date(now - 1_000).toISOString();

    expect(applyStaleness("running", old, now)).toBe("stale");
    expect(applyStaleness("running", fresh, now)).toBe("running");
    // Durable states are not lies just because they are old.
    for (const state of ["needs-input", "done", "idle", "unknown"]) {
      expect(applyStaleness(state, old, now)).toBe(state);
    }
    // Fail open: @agent_pid-style unset options must not flip every pane stale.
    for (const missing of [undefined, "", "-", "not-a-date"]) {
      expect(applyStaleness("running", missing, now)).toBe("running");
    }
  });

  test("monitor-list reports a pane with an aged @agent_last_transition as stale", () => {
    const ctx = scratch();
    try {
      const env = { ...ctx.env, XTMUX_AGENT_STALE_AFTER: "60s" };
      tmux(["set-option", "-p", "-t", ctx.target, "@agent_last_transition", new Date().toISOString()]);
      expect(cli(env, ["monitor-agent", ctx.target, "--wait-for-transition", "--timeout", "30m", "--interval", "1s", "--json"]).status).toBe(0);
      // Fresh transition: still running.
      expect(monitorRows(env)[0]!.state).toBe("running");

      // Age the transition by eight hours, as the incident did. @agent_state is
      // untouched and still says running — that is the whole point.
      tmux(["set-option", "-p", "-t", ctx.target, "@agent_last_transition", new Date(Date.now() - 8 * 3_600_000).toISOString()]);
      expect(tmux(["show-options", "-p", "-t", ctx.target, "-qv", "@agent_state"])).toBe("running");

      const rows = monitorRows(env);
      expect(rows[0]!.paneState).toBe("stale");

      // The poller reaches the same conclusion and terminates as `error`, not
      // `done`: the pane stopped transitioning, which is not the agent finishing.
      spawnSync("sleep", ["3"]);
      const after = monitorRows(env);
      expect(after[0]!.terminalStatus).toBe("error");
      expect(after[0]!.state).toBe("error");
    } finally { ctx.cleanup(); }
  }, 60_000);

  test("the dashboard reports an aged pane as stale, and the session rollup surfaces it", () => {
    const ctx = scratch();
    try {
      tmux(["set-option", "-p", "-t", ctx.target, "@agent_last_transition", new Date(Date.now() - 8 * 3_600_000).toISOString()]);
      const env = {
        ...ctx.env,
        XTMUX_AGENT_STALE_AFTER: "60s",
        TMUX: `${tmux(["display-message", "-p", "-t", ctx.target, "#{socket_path}"])},0,0`,
      };
      const res = spawnSync("bash", [join(ROOT, "bin/tmux-session-picker"), "dashboard", "expanded"], {
        cwd: ROOT, env, encoding: "utf8", timeout: 30_000,
      });
      const lines = String(res.stdout ?? "").split("\n");
      const paneLine = lines.find((l) => l.startsWith("pane\t") && l.split("\t")[3] === ctx.target);
      expect(paneLine).toBeDefined();
      expect(paneLine!.split("\t")[4]).toBe("stale");
      // Session rollup must not let a healthy sibling hide it.
      const sessionLine = lines.find((l) => l.startsWith("session\t") && l.includes(`\t${ctx.targetSession}\t`));
      expect(sessionLine).toBeDefined();
      expect(sessionLine).toContain("stale");
    } finally { ctx.cleanup(); }
  }, 60_000);
});

describe("xtmux-dw5: monitor-list prunes terminal rows on every read", () => {
  test("terminal rows beyond keep are deleted; a wait-pinned row survives", () => {
    const ctx = scratch();
    try {
      const db = openDb({ dbPath: ctx.dbPath, mode: "on", busyTimeoutMs: 3000 });
      const now = Date.now();
      for (let i = 0; i < 12; i++) {
        register(db, {
          id: `mon-${i}`, target: ctx.target, paneId: ctx.target, sessionId: ctx.targetSession,
          state: "running", intervalMs: 1000, nowMs: now - (12 - i) * 1000,
        });
        terminate(db, `mon-${i}`, "done", now - (12 - i) * 1000 + 1);
      }
      // mon-6 sits outside the keep window; its armed wait pins it.
      registerOutboundWait(db, {
        waitId: "wait-pin", requesterSessionId: "$req", requesterPaneId: ctx.target,
        targetSessionId: ctx.targetSession, targetPaneId: ctx.target, nowMs: now,
      });
      armOutboundWait(db, {
        waitId: "wait-pin", monitorId: "mon-6", requesterSessionId: "$req", requesterPaneId: ctx.target, nowMs: now,
      });
      db.close();

      const res = cli({ ...ctx.env, XTMUX_OBS_MONITOR_KEEP: "5" }, ["monitor-list", "--json"]);
      expect(res.status).toBe(0);
      const rows = JSON.parse(res.stdout) as Array<{ monitorId: string }>;
      expect(rows.length).toBe(6);
      expect(rows.map((row) => row.monitorId)).toEqual(expect.arrayContaining(["mon-6", "mon-11"]));
      expect(rows.map((row) => row.monitorId)).not.toContain("mon-0");

      const raw = new Database(ctx.dbPath, { readonly: true });
      try {
        const n = raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM monitors").get();
        expect(n?.n).toBe(6);
        const pruned = raw.query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM event_journal WHERE type = 'monitors.pruned'",
        ).get();
        expect(pruned?.n).toBe(1);
      } finally { raw.close(); }
    } finally { ctx.cleanup(); }
  }, 60_000);
});
