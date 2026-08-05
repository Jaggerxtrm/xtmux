import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Db } from "./db/connection.ts";
import {
  armOutboundWait,
  deliverOutboundWake,
  registerOutboundWait,
  replayOutboundWakes,
  consumeOutboundWake,
  terminalizeOutboundWait,
  type OutboundWait,
} from "./domains/monitors/outbound-wake.ts";
import { adopt, heartbeat, reconcileAll, register, terminate } from "./domains/monitors/store.ts";
import { liveProbes } from "./tmux.ts";
import type { TerminalStatus } from "./domains/monitors/terminal.ts";

interface ParsedArgs { positional: string[]; flags: Map<string, string | boolean>; }

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags.set(arg.slice(2), next); i++; }
    else flags.set(arg.slice(2), true);
  }
  return { positional, flags };
}

function duration(value: string | boolean | undefined, fallbackMs: number): number {
  if (typeof value !== "string") return fallbackMs;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value);
  if (!match) return Number.NaN;
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] ?? "ms"] ?? 1;
  return Math.max(0, Math.floor(Number(match[1]) * multiplier));
}

function tmuxValue(target: string | undefined, format: string): string | undefined {
  if (!process.env.TMUX) return undefined;
  const args = ["display-message", "-p"];
  if (target) args.push("-t", target);
  args.push(format);
  const result = spawnSync("tmux", args, { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const value = String(result.stdout ?? "").trim();
  return value || undefined;
}

interface Identity { sessionId: string; paneId: string; }
function requesterIdentity(): Identity {
  const paneId = process.env.TMUX_PANE ?? tmuxValue(undefined, "#{pane_id}") ?? "%requester";
  return {
    paneId,
    sessionId: process.env.XTMUX_SESSION_ID ?? tmuxValue(paneId, "#{session_id}") ?? "$requester",
  };
}

interface Target { sessionId: string; paneId: string; }
function resolveTarget(target: string): Target {
  const paneId = tmuxValue(target, "#{pane_id}");
  const sessionId = paneId && tmuxValue(paneId, "#{session_id}");
  if (!paneId || !sessionId) throw Object.assign(new Error(`target not found: ${target}`), { code: "XTMUX_TARGET_NOT_FOUND" });
  return { sessionId, paneId };
}

function jsonError(code: string, message: string, detail: Record<string, unknown> = {}, status = 2): number {
  process.stderr.write(JSON.stringify({ code, error_code: code, message, detail }) + "\n");
  return status;
}

function waitProjection(wait: OutboundWait, target: string, replayed = false): Record<string, unknown> {
  const terminal = wait.terminalStatus !== null;
  return {
    waitId: wait.waitId,
    target,
    requesterSessionId: wait.requesterSessionId,
    requesterPaneId: wait.requesterPaneId,
    targetSessionId: wait.targetSessionId,
    targetPaneId: wait.targetPaneId,
    state: terminal ? "terminal" : wait.state,
    monitorId: wait.monitorId,
    terminalStatus: wait.terminalStatus,
    wakeDelivered: wait.wakeDelivered,
    wakeConsumed: wait.wakeConsumed,
    replayed,
    startedAtMs: wait.createdAtMs,
    completedAtMs: wait.terminalAtMs,
    timeoutMs: wait.expiresAtMs === null ? null : Math.max(0, wait.expiresAtMs - wait.createdAtMs),
    intervalMs: null,
  };
}

export function monitorProjection(row: Record<string, unknown>, wait: OutboundWait | undefined, orphan: boolean): Record<string, unknown> {
  return {
    monitorId: row.id,
    ...(wait ? { waitId: wait.waitId } : {}),
    target: row.target,
    requesterSessionId: wait?.requesterSessionId ?? null,
    requesterPaneId: wait?.requesterPaneId ?? null,
    sessionId: row.session_id,
    paneId: row.pane_id,
    // xtrm-wiy5n.4.16: the projected `state` MUST reflect terminal_status when
    // it is set. `row.state` is the target pane's observed agent state and
    // churns every poll — it still reads "running" on a monitor that timed out,
    // was killed, or lost its target. Consumers (humans, hygiene checks, the
    // /multiplexing operator guidance, `monitors` pretty view) filter on this
    // field to decide "is this monitor live"; without the terminal overlay a
    // terminal monitor lies. terminalStatus stays in its own field for callers
    // that want the raw pane state (they read `paneState` — added alongside so
    // the split is explicit, not lost).
    state: (row.terminal_status as string | null) ?? row.state,
    paneState: row.state,
    startedAtMs: row.started_at_ms,
    updatedAtMs: row.updated_at_ms,
    timeoutMs: row.timeout_ms,
    intervalMs: row.interval_ms,
    terminalStatus: row.terminal_status,
    terminalAtMs: row.terminal_at_ms,
    wakeDelivered: wait?.wakeDelivered ?? false,
    wakeConsumed: wait?.wakeConsumed ?? false,
    orphan,
  };
}

function operationError(error: unknown, command: string): number {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "XTMUX_INVALID_ARGUMENT";
  const mapped = code === "wait.not_owner" ? "XTMUX_WAIT_NOT_OWNER"
    : code === "wait.not_found" ? "XTMUX_WAIT_NOT_FOUND"
      : code === "wait.target_mismatch" ? "XTMUX_WAIT_TARGET_MISMATCH" : code;
  const message = error instanceof Error ? error.message : String(error);
  const detail: Record<string, unknown> = { command };
  for (const key of ["waitId", "monitorId", "expectedSessionId", "expectedPaneId", "actualSessionId", "actualPaneId"]) {
    if (typeof error === "object" && error !== null && key in error) detail[key] = (error as Record<string, unknown>)[key];
  }
  return jsonError(mapped, message, detail, mapped === "XTMUX_WAIT_NOT_FOUND" ? 5 : mapped === "XTMUX_WAIT_NOT_OWNER" ? 4 : mapped === "XTMUX_TARGET_NOT_FOUND" ? 1 : 2);
}

function rejectSelfTarget(requester: Identity, target: Target): void {
  if (requester.sessionId === target.sessionId && requester.paneId === target.paneId) {
    throw Object.assign(new Error("monitor target resolves to the requester"), { code: "XTMUX_SELF_TARGET" });
  }
}

function createMonitorAndWait(db: Db, targetName: string, timeoutMs: number, intervalMs: number, nowMs: number): {
  monitorId: string; waitId: string; requester: Identity; target: Target; state: string;
} {
  const requester = requesterIdentity();
  const target = resolveTarget(targetName);
  rejectSelfTarget(requester, target);
  const suffix = `${nowMs}-${Math.floor(Math.random() * 1_000_000)}`;
  const monitorId = `monitor-${suffix}`;
  const waitId = `wait-${suffix}`;
  const state = liveProbes.observe(target.paneId);
  register(db, { id: monitorId, target: targetName, paneId: target.paneId, sessionId: target.sessionId, state, timeoutMs, intervalMs, nowMs });
  registerOutboundWait(db, {
    waitId, requesterSessionId: requester.sessionId, requesterPaneId: requester.paneId,
    targetSessionId: target.sessionId, targetPaneId: target.paneId, nowMs,
    expiresAtMs: timeoutMs > 0 ? nowMs + timeoutMs : undefined,
  });
  armOutboundWait(db, { waitId, monitorId, requesterSessionId: requester.sessionId, requesterPaneId: requester.paneId, nowMs });
  return { monitorId, waitId, requester, target, state };
}

function isWorking(state: string): boolean {
  return ["running", "working", "busy", "thinking", "tool"].includes(state);
}

/** Terminate the monitor, terminalize its wait, and wake the requester. */
function deliverTerminal(db: Db, monitorId: string, status: TerminalStatus, nowMs: number, detail?: string): void {
  terminate(db, monitorId, status, nowMs, detail);
  terminalizeOutboundWait(db, monitorId, status, nowMs);
  replayOutboundWakes(db, nowMs);
  const wait = listAllWaits(db).find((row) => row.monitorId === monitorId);
  if (wait) deliverOutboundWake(db, { waitId: wait.waitId, requesterSessionId: wait.requesterSessionId, requesterPaneId: wait.requesterPaneId, nowMs });
}

interface PollParams {
  monitorId: string;
  paneId: string;
  timeoutMs: number;
  intervalMs: number;
  transitionRequired: boolean;
  initialState: string;
}

/**
 * The monitor poll loop. Shared by `wait-agent` (runs it in the foreground) and
 * `monitor-run` (the detached poller `monitor-agent` forks).
 *
 * `stale` terminates as `error`, not `done` (xtmux-dvs defect 2): the pane
 * stopped transitioning, which is not the same fact as the agent finishing its
 * turn, and reporting it as `done` would hand the requester a completion that
 * never happened. The requester is still woken — being woken is the point.
 */
function pollMonitor(db: Db, p: PollParams): void {
  let state = p.initialState;
  const startedAtMs = Date.now();
  let observedWorking = !p.transitionRequired || isWorking(state);
  while (true) {
    // Every tick heartbeats — that is what refreshes the lease (V1's poll loop
    // did the same via `obs_call monitor heartbeat`). Without it a monitor whose
    // poller is alive and ticking still lease-expires after max(3*interval, 30s),
    // and the next reconcile calls it `process_gone`. The store writes a journal
    // envelope only when the observed state actually changed, so this is one row
    // update per tick, not one historical event per tick.
    heartbeat(db, p.monitorId, state, Date.now());
    if (state === "stale") {
      deliverTerminal(db, p.monitorId, "error", Date.now(), "agent state stale: no @agent_last_transition inside the liveness window");
      break;
    }
    if (!observedWorking) {
      if (isWorking(state)) observedWorking = true;
    } else if (!isWorking(state)) {
      deliverTerminal(db, p.monitorId, "done", Date.now());
      break;
    }
    if (!p.transitionRequired && !isWorking(state)) break;
    if (p.timeoutMs > 0 && Date.now() - startedAtMs >= p.timeoutMs) {
      terminate(db, p.monitorId, "timeout", Date.now());
      terminalizeOutboundWait(db, p.monitorId, "timeout", Date.now());
      replayOutboundWakes(db, Date.now());
      break;
    }
    if (p.intervalMs > 0) spawnSync("sleep", [String(p.intervalMs / 1000)], { stdio: "ignore" });
    state = liveProbes.observe(p.paneId);
  }
}

function listAllWaits(db: Db): OutboundWait[] {
  const rows = db.raw.query<{
    id: string; requester_session_id: string; requester_pane_id: string; target_session_id: string; target_pane_id: string;
    related_message_id: number | null; monitor_id: string | null; state: OutboundWait["state"]; terminal_status: TerminalStatus | null;
    terminal_at_ms: number | null; wake_delivered_at_ms: number | null; wake_consumed_at_ms: number | null; created_at_ms: number; updated_at_ms: number; expires_at_ms: number | null;
  }, []>("SELECT id, requester_session_id, requester_pane_id, target_session_id, target_pane_id, related_message_id, monitor_id, state, terminal_status, terminal_at_ms, wake_delivered_at_ms, wake_consumed_at_ms, created_at_ms, updated_at_ms, expires_at_ms FROM outbound_waits").all();
  return rows.map((row) => ({
    waitId: row.id, requesterSessionId: row.requester_session_id, requesterPaneId: row.requester_pane_id,
    targetSessionId: row.target_session_id, targetPaneId: row.target_pane_id, relatedMessageId: row.related_message_id,
    monitorId: row.monitor_id, state: row.state, terminalStatus: row.terminal_status, terminalAtMs: row.terminal_at_ms,
    wakeDeliveredAtMs: row.wake_delivered_at_ms, wakeConsumedAtMs: row.wake_consumed_at_ms,
    wakeDelivered: row.wake_delivered_at_ms !== null, wakeConsumed: row.wake_consumed_at_ms !== null,
    createdAtMs: row.created_at_ms, updatedAtMs: row.updated_at_ms, expiresAtMs: row.expires_at_ms,
  }));
}

export function cliWaitAgent(db: Db, argv: string[], nowMs: number): number {
  const { positional, flags } = parseArgs(argv);
  const json = flags.get("json") === true;
  const targetName = positional[0] ?? "";
  const timeoutMs = duration(flags.get("timeout"), 30 * 60_000);
  const intervalMs = duration(flags.get("interval"), 30_000);
  if (!targetName || Number.isNaN(timeoutMs) || Number.isNaN(intervalMs)) return jsonError("XTMUX_INVALID_ARGUMENT", "wait-agent: target, timeout, and interval are required", {}, 2);
  try {
    const requester = requesterIdentity();
    const target = resolveTarget(targetName);
    rejectSelfTarget(requester, target);
    const transitionRequired = flags.get("wait-for-transition") === true;
    // A terminal wait is replayable only while the target is idle. Replaying a stale
    // `done` against a pane that is working again is the premature-done bug: the bare
    // form returned done in 0s on a confirmed-running target, and an orchestrator that
    // trusts it sends into a working pane (xtrm-wiy5n.4.14).
    const liveState = liveProbes.observe(target.paneId);
    const existing = listAllWaits(db).find((row) => row.requesterSessionId === requester.sessionId && row.requesterPaneId === requester.paneId
      && row.targetSessionId === target.sessionId && row.targetPaneId === target.paneId
      && (["unarmed", "armed"].includes(row.state)
        || (!transitionRequired && !isWorking(liveState) && ["terminal-unconsumed", "consumed"].includes(row.state))));
    // Consumption is requester-owned, so the fallback lookup prefers this requester's
    // own row: with a working target its terminal row is no longer `existing`, and
    // picking a stranger's row instead would fail as not-owner rather than claiming
    // the stale wake it does own. A foreign row is still selected when the requester
    // owns none — that path is what enforces ownership.
    const targetWaits = listAllWaits(db).filter((row) => row.targetSessionId === target.sessionId && row.targetPaneId === target.paneId
      && ["unarmed", "armed", "terminal-unconsumed", "consumed"].includes(row.state));
    const existingAny = targetWaits.find((row) => row.requesterSessionId === requester.sessionId && row.requesterPaneId === requester.paneId)
      ?? targetWaits[0];
    if (flags.get("consume") === true && existingAny && !existing) {
      consumeOutboundWake(db, { waitId: existingAny.waitId, requesterSessionId: requester.sessionId, requesterPaneId: requester.paneId, nowMs: Date.now() });
    }
    const created = existing?.monitorId
      ? { monitorId: existing.monitorId, waitId: existing.waitId, requester, target, state: liveState }
      : createMonitorAndWait(db, targetName, timeoutMs, intervalMs, nowMs);
    if (!existing || existing.terminalStatus === null) {
      adopt(db, created.monitorId, process.pid, Date.now());
      pollMonitor(db, {
        monitorId: created.monitorId, paneId: created.target.paneId,
        timeoutMs, intervalMs, transitionRequired, initialState: created.state,
      });
    }
    let wait = listAllWaits(db).find((row) => row.waitId === created.waitId);
    if (!wait) throw new Error("wait registration disappeared");
    if (wait.state === "terminal-unconsumed" && !wait.wakeDelivered) {
      deliverOutboundWake(db, { waitId: wait.waitId, requesterSessionId: created.requester.sessionId, requesterPaneId: created.requester.paneId, nowMs: Date.now() });
      wait = listAllWaits(db).find((row) => row.waitId === created.waitId) ?? wait;
    }
    if (flags.get("consume") === true && !wait.wakeDelivered && wait.terminalStatus !== null) {
      deliverOutboundWake(db, { waitId: wait.waitId, requesterSessionId: created.requester.sessionId, requesterPaneId: created.requester.paneId, nowMs: Date.now() });
      wait = listAllWaits(db).find((row) => row.waitId === wait?.waitId) ?? wait;
    }
    if (flags.get("consume") === true && wait.wakeDelivered) {
      wait = consumeOutboundWake(db, { waitId: wait.waitId, requesterSessionId: created.requester.sessionId, requesterPaneId: created.requester.paneId, nowMs: Date.now() }).wait;
    }
    if (wait.terminalStatus === "timeout") {
      if (json) return jsonError("XTMUX_WAIT_TIMEOUT", `wait-agent: timeout target=${targetName}`, { command: "wait-agent", waitId: wait.waitId, monitorId: wait.monitorId }, 124);
      process.stderr.write(`wait-agent: timeout target=${targetName}\n`);
      return 124;
    }
    const result = waitProjection(wait, targetName);
    result.intervalMs = intervalMs;
    if (json) process.stdout.write(JSON.stringify(result) + "\n"); else process.stdout.write(`wait\t${targetName}\t${wait.terminalStatus ?? wait.state}\n`);
    return 0;
  } catch (error) { return operationError(error, "wait-agent"); }
}

/**
 * How long `monitor-agent` waits for its forked poller to prove it reached the
 * DB before declaring the arm failed. Generous enough for a cold Bun start on a
 * loaded host; a false "did not arm" is loud and retryable, which is the failure
 * direction this bead exists to enforce. Tune with XTMUX_MONITOR_ARM_TIMEOUT_MS;
 * 0 means "do not wait at all", so every arm fails — that is a test lever, not a
 * production setting. Zero must survive the parse, hence the explicit finite
 * check rather than `|| 3000`.
 */
const ARM_TIMEOUT_MS = armTimeoutMs();

function armTimeoutMs(): number {
  const raw = Number(process.env.XTMUX_MONITOR_ARM_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 3000;
}

/**
 * Bun bakes a standalone executable's entry module into a virtual filesystem
 * rooted here, and its own `fs` shims report those paths as existing — so
 * `existsSync` alone cannot tell a real entry file from a baked one.
 */
const BUN_VIRTUAL_ROOTS = ["/$bunfs/", "B:\\~BUN\\", "/~BUN/"];

/**
 * Argv prefix that re-invokes this same CLI. Two install shapes:
 *   checkout          `bun src/cli.ts` — argv[1] is a real file, pass it on.
 *   compiled binary   `bin/xtmux-obs`  — argv[1] is `/$bunfs/root/xtmux-obs`.
 *                     Bun re-inserts that entry in the child's argv itself, so
 *                     passing it explicitly shifts the command one slot right.
 *
 * Both traps here are Bun-specific and were invisible from a checkout run:
 *   - `process.argv[0]` is the literal string "bun" in a compiled binary, not a
 *     path. Only `process.execPath` names the real executable.
 *   - `existsSync("/$bunfs/root/xtmux-obs")` is TRUE from inside that binary.
 * Together they made the child start as `<exe> /$bunfs/root/xtmux-obs
 * monitor-run <id>`, which the child read as the command `/$bunfs/root/…`,
 * printed usage, and exited without adopting — so every arm through the
 * compiled install failed loudly while a checkout install stayed green.
 */
function selfArgv(): string[] {
  const entry = process.argv[1] ?? "";
  const baked = BUN_VIRTUAL_ROOTS.some((root) => entry.includes(root));
  return entry && !baked && existsSync(entry) ? [process.execPath, entry] : [process.execPath];
}

function ownerPidOf(db: Db, monitorId: string): number | null {
  return db.raw.query<{ owner_pid: number | null }, [string]>("SELECT owner_pid FROM monitors WHERE id = ?").get(monitorId)?.owner_pid ?? null;
}

export function cliMonitorAgent(db: Db, argv: string[], nowMs: number): number {
  const { positional, flags } = parseArgs(argv);
  const json = flags.get("json") === true;
  const targetName = positional[0] ?? "";
  const timeoutMs = duration(flags.get("timeout"), 30 * 60_000);
  const intervalMs = duration(flags.get("interval"), 30_000);
  if (!targetName || Number.isNaN(timeoutMs) || Number.isNaN(intervalMs)) return jsonError("XTMUX_INVALID_ARGUMENT", "monitor-agent: target, timeout, and interval are required", {}, 2);
  try {
    const created = createMonitorAndWait(db, targetName, timeoutMs, intervalMs, nowMs);

    // xtmux-dvs defect 1. Until now this command registered a monitor row and
    // returned — nothing ever polled it. Its lease (max(3*interval, 30s), set at
    // registration and refreshed only by a heartbeat that never came) therefore
    // expired by construction, and the next `monitor-list` reconcile stamped
    // `process_gone` on a pane that was demonstrably alive, replayed the wait and
    // delivered a wake. The caller had already been handed a normal monitorId and
    // exit 0, so it saw an armed monitor. Fork the poller, and refuse to report
    // success unless it proves it started.
    const runArgs = ["monitor-run", created.monitorId, "--timeout", `${timeoutMs}ms`, "--interval", `${intervalMs}ms`];
    if (flags.get("wait-for-transition") === true) runArgs.push("--wait-for-transition");
    const [exec, ...prefix] = selfArgv();
    // ponytail: one detached Bun poller per armed monitor (~40MB RSS), matching
    // V1's one-forked-poller-per-monitor shape. If armed-monitor counts ever grow
    // past a handful per host, the upgrade path is a single poller process that
    // ticks every active row, not a lighter per-monitor process.
    const child = spawn(exec!, [...prefix, ...runArgs], { detached: true, stdio: "ignore", env: process.env });
    child.unref();

    const armFailed = (reason: string, detail: Record<string, unknown> = {}): number => {
      const at = Date.now();
      terminate(db, created.monitorId, "error", at, reason);
      terminalizeOutboundWait(db, created.monitorId, "error", at);
      return jsonError("XTMUX_MONITOR_ARM_FAILED", `monitor-agent: poller did not arm: ${reason}`,
        { command: "monitor-agent", monitorId: created.monitorId, waitId: created.waitId, target: targetName, terminalStatus: "error", ...detail }, 3);
    };
    if (child.pid === undefined) return armFailed("poller process could not be spawned");
    // The poller adopts the row as its first act, so a non-null owner_pid is
    // proof it reached the DB. Nothing cheaper proves that; a spawned pid that
    // dies on a missing module would otherwise look identical to a live monitor.
    // Clock first: with an arm window of 0 this must perform zero waits, so the
    // gate is exercisable without racing a Bun cold start against a 1ms deadline.
    const deadline = Date.now() + ARM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (ownerPidOf(db, created.monitorId) !== null) break;
      spawnSync("sleep", ["0.05"], { stdio: "ignore" });
    }
    if (ownerPidOf(db, created.monitorId) === null) {
      try { process.kill(child.pid, "SIGTERM"); } catch { /* already gone */ }
      return armFailed("poller did not register inside the arm window", { armTimeoutMs: ARM_TIMEOUT_MS, pollerPid: child.pid });
    }

    const row = db.raw.query<Record<string, unknown>, [string]>("SELECT id, target, session_id, pane_id, state, started_at_ms, updated_at_ms, timeout_ms, interval_ms, terminal_status, terminal_at_ms FROM monitors WHERE id = ?").get(created.monitorId);
    const wait = listAllWaits(db).find((item) => item.waitId === created.waitId);
    const result = monitorProjection(row ?? {}, wait, false);
    if (json) process.stdout.write(JSON.stringify(result) + "\n"); else process.stdout.write(`monitor\t${created.monitorId}\t${targetName}\t${created.target.paneId}\n`);
    return 0;
  } catch (error) { return operationError(error, "monitor-agent"); }
}

/**
 * The detached poller `monitor-agent` forks. Not an operator-facing command: it
 * polls an already-registered monitor row until it reaches a terminal status.
 */
export function cliMonitorRun(db: Db, argv: string[], _nowMs: number): number {
  const { positional, flags } = parseArgs(argv);
  const monitorId = positional[0] ?? "";
  const timeoutMs = duration(flags.get("timeout"), 30 * 60_000);
  const intervalMs = duration(flags.get("interval"), 30_000);
  if (!monitorId || Number.isNaN(timeoutMs) || Number.isNaN(intervalMs)) return jsonError("XTMUX_INVALID_ARGUMENT", "monitor-run: monitor id, timeout, and interval are required", {}, 2);
  const row = db.raw.query<{ pane_id: string; state: string; terminal_status: string | null }, [string]>(
    "SELECT pane_id, state, terminal_status FROM monitors WHERE id = ?").get(monitorId);
  if (!row) return jsonError("XTMUX_MONITOR_NOT_FOUND", `monitor-run: monitor not found: ${monitorId}`, { command: "monitor-run", monitorId }, 1);
  if (row.terminal_status !== null) return 0;
  adopt(db, monitorId, process.pid, Date.now());
  try {
    pollMonitor(db, {
      monitorId, paneId: row.pane_id, timeoutMs, intervalMs,
      transitionRequired: flags.get("wait-for-transition") === true, initialState: row.state,
    });
    return 0;
  } catch (error) {
    // A poller that dies mid-loop must leave a terminal row behind, not an
    // active one that only the lease will eventually (and misleadingly) reap.
    deliverTerminal(db, monitorId, "error", Date.now(), (error instanceof Error ? error.message : String(error)).slice(0, 200));
    return operationError(error, "monitor-run");
  }
}

export function cliMonitorList(db: Db, argv: string[], nowMs: number): number {
  const json = argv.includes("--json");
  try {
    reconcileAll(db, liveProbes, nowMs);
    replayOutboundWakes(db, nowMs);
    for (const wait of listAllWaits(db)) {
      if (wait.state === "terminal-unconsumed" && !wait.wakeDelivered) {
        deliverOutboundWake(db, { waitId: wait.waitId, requesterSessionId: wait.requesterSessionId, requesterPaneId: wait.requesterPaneId, nowMs });
      }
    }
    const monitors = db.raw.query<Record<string, unknown>, []>("SELECT id, target, session_id, pane_id, state, started_at_ms, updated_at_ms, timeout_ms, interval_ms, terminal_status, terminal_at_ms FROM monitors ORDER BY started_at_ms, id").all();
    const waits = listAllWaits(db);
    const results = monitors.map((row) => {
      const wait = waits.find((item) => item.monitorId === row.id);
      // Re-observe active rows (V1's "mutate on read": _monitor_list_v1_body does
      // the same). The stored `state` is only as fresh as the last poll tick, so
      // without this a pane that went stale between ticks still reads `running`
      // here — the exact blindness of xtmux-dvs defect 2. `unknown` means the
      // pane advertises nothing, which is not a reason to discard what we knew.
      if (row.terminal_status === null) {
        const observed = liveProbes.observe(String(row.pane_id));
        if (observed !== "unknown") row.state = observed;
      }
      return monitorProjection(row, wait, row.terminal_status !== null && wait === undefined);
    });
    if (json) process.stdout.write(JSON.stringify(results) + "\n"); else for (const row of results) process.stdout.write(`monitor\t${String(row.monitorId)}\t${String(row.state)}\n`);
    return 0;
  } catch (error) { return operationError(error, "monitor-list"); }
}
