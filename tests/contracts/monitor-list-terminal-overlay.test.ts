// xtrm-wiy5n.4.16: monitor-list must overlay `terminal_status` onto the
// projected `state`. The DB row's `state` column is the target pane's observed
// agent state — it churns every poll and still reads "running" on a monitor
// that has already reached a terminal status (timeout / process_gone /
// killed / done / target_gone / error). Consumers (humans reading the plain
// list, hygiene checks reading --json, and the /multiplexing operator
// guidance) filter on `state` to decide "is this monitor live"; without the
// terminal overlay a terminal monitor lies.
//
// Locked-in invariants:
//   1. `state` reflects `terminal_status` when set (JSON + plain output).
//   2. A terminal monitor NEVER renders as running.
//   3. --json and the plain `monitor` row agree — hygiene checks see the same
//      truth as the human view.
//   4. `terminalStatus` stays in its own field so callers keep the raw split.
//   5. Active monitors (terminal_status IS NULL) still see the pane state.
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { openDb } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/schema.ts";
import { monitorProjection } from "../../src/cli-monitors.ts";

const ROOT = join(import.meta.dir, "../..");
const CLI = join(ROOT, "src/cli.ts");

function scratch(): { root: string; dbPath: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "xtmux-monitor-terminal-"));
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

// A monitor row's `state` column is the observed pane state and stays "running"
// until a poll writes a new observation. Terminal status is set on a separate
// column via the domain state machine; nothing rewrites `state` on transition.
// The projection is the only place the two are joined.
function insertMonitor(dbPath: string, args: {
  id: string;
  state: string;
  terminalStatus: string | null;
}): void {
  // Started NOW and with a live owner_pid so reconcileAll doesn't retroactively
  // trip the row to `timeout` / `process_gone` before the projection runs. The
  // fix under test is about the projection layer's terminal-status overlay,
  // not the reconciler's decision path.
  const nowMs = Date.now();
  const raw = new Database(dbPath);
  try {
    raw.exec(`INSERT INTO monitors
      (id, target, session_id, pane_id, state, owner_pid, started_at_ms, updated_at_ms, timeout_ms, interval_ms, terminal_status, terminal_at_ms, lease_expires_at_ms)
      VALUES (?, '%tgt', '$tgt', '%tgt', ?, ?, ?, ?, 3600000, 1000, ?, ?, ?)`,
      [
        args.id,
        args.state,
        process.pid,
        nowMs,
        nowMs,
        args.terminalStatus,
        args.terminalStatus === null ? null : nowMs,
        nowMs + 3_600_000,
      ],
    );
  } finally {
    raw.close();
  }
}

function monitorList(env: NodeJS.ProcessEnv, args: string[] = []): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("bun", ["run", CLI, "monitor-list", ...args], { cwd: ROOT, env, encoding: "utf8", timeout: 20_000 });
  return { status: res.status ?? 1, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

describe("monitor-list terminal-status overlay (xtrm-wiy5n.4.16)", () => {
  test("a terminal monitor renders its terminal_status as the state, in JSON and plain output", () => {
    const ctx = scratch();
    try {
      const db = openDb({ dbPath: ctx.dbPath, mode: "on", busyTimeoutMs: 3000 });
      migrate(db);
      db.close();
      insertMonitor(ctx.dbPath, { id: "m-timeout", state: "running", terminalStatus: "timeout" });
      insertMonitor(ctx.dbPath, { id: "m-gone", state: "running", terminalStatus: "process_gone" });
      insertMonitor(ctx.dbPath, { id: "m-killed", state: "running", terminalStatus: "killed" });

      const jsonRes = monitorList(ctx.env, ["--json"]);
      expect(jsonRes.status).toBe(0);
      const rows: Array<Record<string, unknown>> = JSON.parse(jsonRes.stdout);
      const byId = Object.fromEntries(rows.map((row) => [row.monitorId, row]));
      // Invariant 1: state reflects terminal_status when set.
      expect(byId["m-timeout"]).toMatchObject({ state: "timeout", terminalStatus: "timeout" });
      expect(byId["m-gone"]).toMatchObject({ state: "process_gone", terminalStatus: "process_gone" });
      expect(byId["m-killed"]).toMatchObject({ state: "killed", terminalStatus: "killed" });
      // Invariant 2: a terminal monitor is never rendered as running.
      for (const row of rows) {
        if (row.terminalStatus !== null) expect(row.state).not.toBe("running");
      }
      // Invariant 4: the raw pane state stays available in its own field so
      // callers that want the pre-overlay value still have it. Losing this
      // split would collapse the diagnostic that led to writing the bead.
      expect(byId["m-timeout"]).toMatchObject({ paneState: "running" });

      // Invariant 3: --json and the plain output agree — a hygiene check that
      // greps `monitor\t<id>\t<state>` sees the same truth as a JSON consumer.
      const plainRes = monitorList(ctx.env);
      expect(plainRes.status).toBe(0);
      const plainStates = new Map<string, string>();
      for (const line of plainRes.stdout.split("\n")) {
        const [, id, state] = line.split("\t");
        if (id && state) plainStates.set(id, state);
      }
      expect(plainStates.get("m-timeout")).toBe("timeout");
      expect(plainStates.get("m-gone")).toBe("process_gone");
      expect(plainStates.get("m-killed")).toBe("killed");
      for (const [id, state] of plainStates) {
        if (id.startsWith("m-")) expect(state).not.toBe("running");
      }
    } finally {
      ctx.cleanup();
    }
  }, 30_000);

  // Invariant 5: an active monitor (terminal_status IS NULL) MUST still show
  // its raw pane state. Otherwise a naive "row.terminal_status" replacement
  // would blank out the state column for live monitors.
  //
  // Direct call to `monitorProjection` here: the CLI form runs `reconcileAll`
  // first, which polls real tmux for pane liveness. In a CI runner without a
  // tmux server (or with a synthetic pane id like `%tgt`), `paneAlive` is
  // false, reconcile flips the row to `target_gone` before the projection
  // sees it, and no CLI-level fixture can express the "genuinely active"
  // case. Unit-testing the projection function isolates the layer under test.
  test("monitorProjection leaves state as the pane state when terminal_status is null", () => {
    for (const [paneState, expected] of [["running", "running"], ["idle", "idle"], ["needs-input", "needs-input"], ["done", "done"]]) {
      const projected = monitorProjection(
        { id: "m-active", target: "%tgt", session_id: "$tgt", pane_id: "%tgt",
          state: paneState, started_at_ms: 1, updated_at_ms: 1,
          timeout_ms: 60000, interval_ms: 1000,
          terminal_status: null, terminal_at_ms: null,
        },
        undefined,
        false,
      );
      expect(projected).toMatchObject({ state: expected, paneState, terminalStatus: null });
    }
  });

  // Invariant 5 (mirror): the same layer overlays terminal_status for every
  // TerminalStatus value the state machine can produce (src/domains/monitors/
  // terminal.ts TERMINAL_STATUSES). A future terminal_status added there but
  // missing from the projection's overlay would go unnoticed without this.
  test("monitorProjection overlays every terminal_status the state machine can produce", () => {
    for (const status of ["done", "timeout", "killed", "target_gone", "process_gone", "error"] as const) {
      const projected = monitorProjection(
        { id: `m-${status}`, target: "%tgt", session_id: "$tgt", pane_id: "%tgt",
          state: "running", started_at_ms: 1, updated_at_ms: 1,
          timeout_ms: 60000, interval_ms: 1000,
          terminal_status: status, terminal_at_ms: 2,
        },
        undefined,
        false,
      );
      expect(projected).toMatchObject({ state: status, paneState: "running", terminalStatus: status });
    }
  });
});
