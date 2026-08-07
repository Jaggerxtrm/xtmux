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
  const r = tmux(["display-message", "-p", "-t", paneId, "#{pane_id}"]);
  // The status alone is not the answer: asked about a pane that no longer
  // exists, tmux exits 0 and prints an EMPTY line (verified against tmux 3.x
  // with $TMUX set — it resolves the server, finds no such pane, and formats
  // nothing). Reading `ok` only, this reported every destroyed pane as alive, so
  // reconcile's `target_gone` branch could never fire and a monitor on a killed
  // pane stayed active until its lease or timeout invented some other reason.
  // A live pane always formats its own id, so a non-empty answer is the test.
  return r.ok && r.out !== "";
}

/**
 * Is the tmux server answering at all?
 *
 * `paneAlive` returns false both for "that pane died" and for "there is no tmux
 * server to ask", and K4's agent-instance reconciliation must treat those
 * opposite: the first ends one occupation, the second must end none. This asks
 * a question with no pane in it, so only the server's reachability decides.
 */
export function serverAlive(): boolean {
  return tmux(["display-message", "-p", "#{pid}"]).ok;
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
 * Liveness threshold for @agent_state (xtmux-dvs defect 2).
 *
 * @agent_state is a last-write-wins pane option: when a pane dies mid-turn the
 * last value written persists forever, so a corpse keeps advertising `running`.
 * On 2026-08-05 five panes reported `running` with @agent_last_transition frozen
 * for over eight hours after a usage limit killed them mid-request, and every
 * consumer that read state alone concluded the lanes were healthy.
 *
 * Only `running` is falsifiable by age. `needs-input`, `done` and `idle` are
 * legitimately durable — a pane can sit at a permission prompt for a day and the
 * state is still true. `running` is the only value that asserts ongoing activity,
 * so it is the only one an old transition timestamp contradicts.
 *
 * 45 minutes, chosen against the two bounds that matter:
 *   - lower: it must exceed the longest legitimately silent working stretch. The
 *     default monitor/wait timeout is 30m (src/cli-monitors.ts), so a genuinely
 *     long-running monitored turn reaches its own `timeout` first and is reported
 *     as a timeout rather than mislabelled stale.
 *   - upper: it must catch a corpse inside the first hour. The incident ran eight.
 * Tune with XTMUX_AGENT_STALE_AFTER (e.g. `20m`, `90s`, or raw ms); 0 disables.
 */
export const AGENT_STALE_AFTER_MS = staleAfterMs();

function staleAfterMs(): number {
  const raw = process.env.XTMUX_AGENT_STALE_AFTER;
  if (raw === undefined || raw === "") return 45 * 60_000;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(raw.trim());
  if (!m) return 45 * 60_000;
  const mult = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[m[2] ?? "ms"] ?? 1;
  return Math.max(0, Math.floor(Number(m[1]) * mult));
}

/**
 * Overlay the liveness rule on a normalized state.
 *
 * Fails OPEN: a pane with no @agent_last_transition, or one whose value does not
 * parse, is never called stale. The option is genuinely unset on some panes and
 * an aggressive default there would flip every such pane to stale — the mirror
 * image of the bug, and just as untrue.
 *
 * Pure, so the rule is testable without tmux.
 */
export function applyStaleness(state: string, lastTransition: string | undefined, nowMs: number): string {
  if (state !== "running" || AGENT_STALE_AFTER_MS <= 0) return state;
  if (!lastTransition || lastTransition === "-") return state;
  const atMs = Date.parse(lastTransition);
  if (Number.isNaN(atMs)) return state;
  return nowMs - atMs > AGENT_STALE_AFTER_MS ? "stale" : state;
}

/**
 * The pane's observed state, normalized. `unknown` when the pane advertises no
 * @agent_state at all — V1's answer when its opt-in pane-content inference
 * (TMUX_PICKER_AGENT) is disabled, which is the default. `stale` when the pane
 * claims `running` but has not transitioned inside AGENT_STALE_AFTER_MS.
 */
export function observe(paneId: string): string {
  const r = tmux(["show-options", "-p", "-t", paneId, "-qv", "@agent_state"]);
  const raw = r.ok ? r.out : "";
  if (raw === "") return "unknown";
  const state = normalizeAgentState(raw);
  if (state !== "running") return state;
  const t = tmux(["show-options", "-p", "-t", paneId, "-qv", "@agent_last_transition"]);
  return applyStaleness(state, t.ok ? t.out : undefined, Date.now());
}

export function signal(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // V1 ignores this too: the process may already be gone.
  }
}

export const liveProbes = { pidAlive, paneAlive, observe, signal, serverAlive };

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
