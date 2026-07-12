/**
 * The live-tmux probes the monitor domain needs (PRD §15: tmux options stay live
 * UI projections; SQLite is authoritative for durable state, not for what a pane
 * is doing *right now*).
 *
 * Isolated here so the domain logic stays pure and testable — the domains take
 * these as injected callbacks, never importing this module.
 */
import { spawnSync } from "node:child_process";

function tmux(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("tmux", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

/** kill -0: does the process exist and are we allowed to signal it? */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but is not ours — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function paneAlive(paneId: string): boolean {
  return tmux(["display-message", "-p", "-t", paneId, "#{pane_id}"]).ok;
}

/**
 * Canonicalize a raw @agent_state exactly as V1's normalize_agent_state does.
 *
 * This mapping is load-bearing for output compatibility: an operator writes
 * `working`, and V1's monitor-list prints `running`. Returning the raw value here
 * would make V2's monitor-list diverge from V1's on the state column — which is
 * precisely what PRD §20 forbids.
 */
export function normalizeAgentState(raw: string): string {
  switch (raw) {
    case "needs-input":
    case "permission":
    case "waiting":
    case "input":
      return "needs-input";
    case "done":
    case "finished":
    case "stop":
    case "complete":
      return "done";
    case "running":
    case "working":
    case "thinking":
    case "busy":
    case "tool":
      return "running";
    case "idle":
      return "idle";
    // V1 treats these as "no opinion" and falls through to its (opt-in) inference,
    // which is off by default — so the observed state is empty.
    case "":
    case "-":
    case "off":
    case "none":
      return "";
    default:
      return raw;
  }
}

/**
 * The pane's observed state, normalized. `unknown` when the pane advertises no
 * @agent_state at all — V1's answer when its opt-in pane-content inference
 * (TMUX_PICKER_AGENT) is disabled, which is the default.
 */
export function observe(paneId: string): string {
  const r = tmux(["show-options", "-p", "-t", paneId, "-qv", "@agent_state"]);
  const raw = r.ok ? r.out : "";
  if (raw === "") return "unknown";
  return normalizeAgentState(raw);
}

export function signal(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // V1 ignores this too: the process may already be gone.
  }
}

export const liveProbes = { pidAlive, paneAlive, observe, signal };

/**
 * window.pane for a pane id. The audit's V1 stdout carries only `%N`, which tmux
 * recycles across restarts — so a fingerprint keyed on it would re-mint the
 * finding every restart. The index is the stable handle, and the pane is by
 * definition alive at audit time, so this resolves.
 */
export function paneIndex(paneId: string): string {
  const r = tmux(["display-message", "-p", "-t", paneId, "#{window_index}.#{pane_index}"]);
  return r.ok && r.out ? r.out : paneId;
}
