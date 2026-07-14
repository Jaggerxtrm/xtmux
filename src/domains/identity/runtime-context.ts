import { spawnSync } from "node:child_process";
import { hostId } from "./host-id.ts";

/**
 * The DTO Specialists reads to answer "which pane/agent spawned this job?".
 *
 * Field names and schema_version are a CROSS-REPO CONTRACT (docs/xtmux-gaps.md
 * §11, §12.2): xtrm-dev/specialists validates them field-by-field and embeds the
 * result in an immutable `xtrm.forensic.v1` `job.started` event. A rename here
 * silently corrupts another repository's permanent history. Do not reshape
 * within v1 — add fields, never repurpose them.
 */
export interface RuntimeOriginV1 {
  schema_version: "xtrm.runtime-origin.v1";
  kind: "xtmux.agent_instance";
  host_id: string;
  tmux_server_id?: string;
  tmux_session_id: string;
  tmux_window_id: string;
  tmux_pane_id: string;
  agent_instance_id?: string;
  bead_id?: string;
  parent_session_id?: string;
  captured_at_ms: number;
  capture_source: "xtmux-context";
  verified: boolean;
}

export interface RuntimeContextError {
  code: "XTMUX_NOT_IN_TMUX" | "XTMUX_PANE_UNRESOLVED";
  message: string;
  detail: Record<string, string>;
}

export type RuntimeContextResult =
  | { ok: true; origin: RuntimeOriginV1 }
  | { ok: false; error: RuntimeContextError };

const FORMAT = [
  "#{session_id}",
  "#{window_id}",
  "#{pane_id}",
  "#{@agent_instance_id}",
  "#{@agent_bead}",
  "#{@agent_parent_session}",
  "#{pid}",
].join("\t");

/**
 * Resolve the pane this process is running in.
 *
 * Requires BOTH $TMUX and $TMUX_PANE. $TMUX_PANE alone is not enough: without
 * the client socket from $TMUX, tmux resolves `-t %17` against whichever server
 * it defaults to, and a bystander server's %17 is a different pane entirely.
 * Binding the origin to that pane would be a fabricated, *verified-looking*
 * lie — worse than returning nothing, because Specialists persists it forever.
 */
export function captureRuntimeContext(
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
): RuntimeContextResult {
  const tmuxEnv = env["TMUX"];
  const pane = env["TMUX_PANE"];
  if (!tmuxEnv || !pane) {
    return {
      ok: false,
      error: {
        code: "XTMUX_NOT_IN_TMUX",
        message: "xtmux context requires a tmux pane: both TMUX and TMUX_PANE must be set",
        detail: { tmux: tmuxEnv ? "set" : "unset", tmux_pane: pane ? "set" : "unset" },
      },
    };
  }

  const r = spawnSync("tmux", ["display-message", "-p", "-t", pane, FORMAT], { encoding: "utf8" });
  const raw = (r.stdout ?? "").trim();
  if (r.status !== 0 || !raw) {
    return {
      ok: false,
      error: {
        code: "XTMUX_PANE_UNRESOLVED",
        message: `xtmux context could not resolve pane ${pane} against the active tmux server`,
        detail: { pane },
      },
    };
  }

  const [sessionId, windowId, paneId, instanceId, bead, parentSession] = raw.split("\t");
  // A resolved pane must yield tmux's own stable ids. Anything else means we are
  // reading a format tmux did not fill — never guess an id from a name or index.
  if (!sessionId?.startsWith("$") || !windowId?.startsWith("@") || !paneId?.startsWith("%")) {
    return {
      ok: false,
      error: {
        code: "XTMUX_PANE_UNRESOLVED",
        message: `xtmux context got malformed tmux ids for pane ${pane}`,
        detail: { pane, resolved: raw },
      },
    };
  }

  return {
    ok: true,
    origin: {
      schema_version: "xtrm.runtime-origin.v1",
      kind: "xtmux.agent_instance",
      host_id: hostId(env),
      tmux_session_id: sessionId,
      tmux_window_id: windowId,
      tmux_pane_id: paneId,
      // Absent metadata serializes as absent, never as "" or a fabricated value:
      // Specialists treats a missing agent_instance_id as pane-level precision,
      // which is a weaker but honest binding. An empty string would look present.
      ...(instanceId ? { agent_instance_id: instanceId } : {}),
      ...(bead ? { bead_id: bead } : {}),
      ...(parentSession ? { parent_session_id: parentSession } : {}),
      captured_at_ms: now(),
      capture_source: "xtmux-context",
      // We resolved this pane against the live socket in $TMUX, just now.
      verified: true,
    },
  };
}
