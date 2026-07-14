import { spawnSync } from "node:child_process";
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

function monitorProjection(row: Record<string, unknown>, wait: OutboundWait | undefined, orphan: boolean): Record<string, unknown> {
  return {
    monitorId: row.id,
    ...(wait ? { waitId: wait.waitId } : {}),
    target: row.target,
    requesterSessionId: wait?.requesterSessionId ?? null,
    requesterPaneId: wait?.requesterPaneId ?? null,
    sessionId: row.session_id,
    paneId: row.pane_id,
    state: row.state,
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

function createMonitorAndWait(db: Db, targetName: string, timeoutMs: number, intervalMs: number, nowMs: number): {
  monitorId: string; waitId: string; requester: Identity; target: Target; state: string;
} {
  const requester = requesterIdentity();
  const target = resolveTarget(targetName);
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

function finishIfTerminal(db: Db, monitorId: string, state: string, nowMs: number): void {
  heartbeat(db, monitorId, state, nowMs);
  if (!isWorking(state)) {
    terminate(db, monitorId, "done", nowMs);
    terminalizeOutboundWait(db, monitorId, "done", nowMs);
    replayOutboundWakes(db, nowMs);
    const wait = listAllWaits(db).find((row) => row.monitorId === monitorId);
    if (wait) deliverOutboundWake(db, { waitId: wait.waitId, requesterSessionId: wait.requesterSessionId, requesterPaneId: wait.requesterPaneId, nowMs });
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
    const existing = listAllWaits(db).find((row) => row.requesterSessionId === requester.sessionId && row.requesterPaneId === requester.paneId
      && row.targetSessionId === target.sessionId && row.targetPaneId === target.paneId
      && ["unarmed", "armed", "terminal-unconsumed", "consumed"].includes(row.state));
    const existingAny = listAllWaits(db).find((row) => row.targetSessionId === target.sessionId && row.targetPaneId === target.paneId
      && ["unarmed", "armed", "terminal-unconsumed", "consumed"].includes(row.state));
    if (flags.get("consume") === true && existingAny && !existing) {
      consumeOutboundWake(db, { waitId: existingAny.waitId, requesterSessionId: requester.sessionId, requesterPaneId: requester.paneId, nowMs: Date.now() });
    }
    const created = existing?.monitorId
      ? { monitorId: existing.monitorId, waitId: existing.waitId, requester, target, state: liveProbes.observe(target.paneId) }
      : createMonitorAndWait(db, targetName, timeoutMs, intervalMs, nowMs);
    adopt(db, created.monitorId, process.pid, Date.now());
    let state = created.state;
    const transitionRequired = flags.get("wait-for-transition") === true;
    const startedAtMs = Date.now();
    let observedWorking = !transitionRequired || isWorking(state);
    while (true) {
      if (!observedWorking) {
        if (isWorking(state)) observedWorking = true;
      } else if (!isWorking(state)) {
        finishIfTerminal(db, created.monitorId, state, Date.now());
        break;
      }
      if (!transitionRequired && !isWorking(state)) break;
      if (timeoutMs > 0 && Date.now() - startedAtMs >= timeoutMs) {
        terminate(db, created.monitorId, "timeout", Date.now());
        terminalizeOutboundWait(db, created.monitorId, "timeout", Date.now());
        replayOutboundWakes(db, Date.now());
        break;
      }
      if (intervalMs > 0) spawnSync("sleep", [String(intervalMs / 1000)], { stdio: "ignore" });
      state = liveProbes.observe(created.target.paneId);
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

export function cliMonitorAgent(db: Db, argv: string[], nowMs: number): number {
  const { positional, flags } = parseArgs(argv);
  const json = flags.get("json") === true;
  const targetName = positional[0] ?? "";
  const timeoutMs = duration(flags.get("timeout"), 30 * 60_000);
  const intervalMs = duration(flags.get("interval"), 30_000);
  if (!targetName || Number.isNaN(timeoutMs) || Number.isNaN(intervalMs)) return jsonError("XTMUX_INVALID_ARGUMENT", "monitor-agent: target, timeout, and interval are required", {}, 2);
  try {
    const created = createMonitorAndWait(db, targetName, timeoutMs, intervalMs, nowMs);
    const row = db.raw.query<Record<string, unknown>, [string]>("SELECT id, target, session_id, pane_id, state, started_at_ms, updated_at_ms, timeout_ms, interval_ms, terminal_status, terminal_at_ms FROM monitors WHERE id = ?").get(created.monitorId);
    const wait = listAllWaits(db).find((item) => item.waitId === created.waitId);
    const result = monitorProjection(row ?? {}, wait, false);
    if (json) process.stdout.write(JSON.stringify(result) + "\n"); else process.stdout.write(`monitor\t${created.monitorId}\t${targetName}\t${created.target.paneId}\n`);
    return 0;
  } catch (error) { return operationError(error, "monitor-agent"); }
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
      return monitorProjection(row, wait, row.terminal_status !== null && wait === undefined);
    });
    if (json) process.stdout.write(JSON.stringify(results) + "\n"); else for (const row of results) process.stdout.write(`monitor\t${String(row.monitorId)}\t${String(row.state)}\n`);
    return 0;
  } catch (error) { return operationError(error, "monitor-list"); }
}
