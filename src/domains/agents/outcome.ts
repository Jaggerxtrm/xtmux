/**
 * Core K2 launch-outcome consumption (xtmux-s96.2, KAN-127 K3-xtmux).
 *
 * Consumes `xtrm.command-outcome.v1` (Core commit
 * 1ed512a49efaf75f3e84c128f9d82958ece09d3a) as STRUCTURED DATA and maps it onto
 * the existing lifecycle authority (agent_state_transitions + event_journal).
 * No prose parsing, no private state, no Codex-specific store:
 *
 *  - `status: degraded` with a correlatable pane records exactly one `degraded`
 *    lifecycle fact (idempotent across replay and restart);
 *  - every other status fabricates nothing — hooks own runtime lifecycle, and
 *    an outcome never fabricates an authoritative mutation;
 *  - `next_actions` argv is passed through verbatim for the caller to execute.
 *
 * Experimental until GATE-IFACE (K5).
 */
import type { Db } from "../../db/connection.ts";
import { recordTransition } from "./transition.ts";

export const OUTCOME_SCHEMA_V1 = "xtrm.command-outcome.v1";

const STATUSES = ["ok", "degraded", "noop", "rejected", "failed"] as const;
const ACTION_KINDS = ["attach", "resume", "repair", "end", "wait", "inspect"] as const;
const RUNTIMES = ["pi", "claude", "codex"] as const;
const TOP_LEVEL_KEYS = new Set([
  "schema_version", "status", "reason_code", "summary", "runtime", "identity",
  "worktree", "readiness", "safety_profile", "persistence",
  "authoritative_mutation", "side_effects", "next_actions",
]);
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/;

export type OutcomeStatus = (typeof STATUSES)[number];

export interface OutcomeAction {
  kind: (typeof ACTION_KINDS)[number];
  required: boolean;
  argv: string[];
  display: string;
  cwd?: string | undefined;
  why: string;
}

export interface CommandOutcomeV1 {
  status: OutcomeStatus;
  reasonCode: string;
  summary: string;
  runtime: { name: (typeof RUNTIMES)[number]; version: string | null } | null;
  paneId: string | null;
  sessionId: string | null;
  nextActions: OutcomeAction[];
}

export type OutcomeErrorCode =
  | "XTMUX_UNSUPPORTED_SCHEMA"
  | "XTMUX_INVALID_ARGUMENT"
  | "XTMUX_HOOK_TRUST_VIOLATED";

export class OutcomeError extends Error {
  constructor(
    public readonly code: OutcomeErrorCode,
    message: string,
    public readonly detail: Record<string, string> = {},
  ) {
    super(message);
  }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OutcomeError("XTMUX_INVALID_ARGUMENT", `outcome ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedText(label: string, value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || CONTROL_CHARACTER.test(value)) {
    throw new OutcomeError("XTMUX_INVALID_ARGUMENT", `outcome ${label} is missing or out of bounds`);
  }
  return value;
}

function token(label: string, value: unknown, pattern: RegExp, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !pattern.test(value)) {
    throw new OutcomeError("XTMUX_INVALID_ARGUMENT", `outcome ${label} is not a valid token`);
  }
  return value;
}

/**
 * Parse and validate an untrusted outcome payload. Rejects unknown schema
 * versions (payload-version awareness), unknown top-level keys, hostile
 * identities, hook-trust bypass claims, and non-string argv elements. Throws
 * OutcomeError with a stable code; never writes on failure.
 */
export function parseCommandOutcomeV1(raw: unknown): CommandOutcomeV1 {
  const o = asObject(raw, "payload");

  const version = o["schema_version"];
  if (version !== OUTCOME_SCHEMA_V1) {
    throw new OutcomeError(
      "XTMUX_UNSUPPORTED_SCHEMA",
      `unsupported outcome schema_version: ${typeof version === "string" ? version : "(absent)"}`,
      { schema_version: typeof version === "string" ? version.slice(0, 64) : "" },
    );
  }
  for (const key of Object.keys(o)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new OutcomeError("XTMUX_INVALID_ARGUMENT", `unknown outcome field: ${key}`, { field: key.slice(0, 64) });
    }
  }

  const status = o["status"];
  if (!STATUSES.includes(status as OutcomeStatus)) {
    throw new OutcomeError("XTMUX_INVALID_ARGUMENT", `unknown outcome status: ${String(status).slice(0, 32)}`);
  }
  const reasonCode = token("reason_code", o["reason_code"], /^[a-z][a-z0-9_]*$/, 64);
  const summary = boundedText("summary", o["summary"], 240);

  const mutation = asObject(o["authoritative_mutation"], "authoritative_mutation");
  if (typeof mutation["completed"] !== "boolean") {
    throw new OutcomeError("XTMUX_INVALID_ARGUMENT", "outcome authoritative_mutation.completed must be a boolean");
  }
  token("authoritative_mutation.kind", mutation["kind"], /^[a-z][a-z0-9.-]*$/, 96);

  if (!Array.isArray(o["side_effects"]) || o["side_effects"].length > 32) {
    throw new OutcomeError("XTMUX_INVALID_ARGUMENT", "outcome side_effects must be an array (max 32)");
  }

  // Hook trust is a hard gate: an outcome claiming a bypass is rejected
  // instead of applied. The managed profile never bypasses hook trust.
  if (o["safety_profile"] !== undefined) {
    const profile = asObject(o["safety_profile"], "safety_profile");
    if (profile["hook_trust"] !== "preserved") {
      throw new OutcomeError(
        "XTMUX_HOOK_TRUST_VIOLATED",
        "outcome safety_profile.hook_trust must be 'preserved'; bypass claims are rejected",
      );
    }
  }

  if (o["worktree"] !== undefined) {
    const worktree = asObject(o["worktree"], "worktree");
    if (worktree["owner"] !== "core") {
      throw new OutcomeError("XTMUX_INVALID_ARGUMENT", "outcome worktree.owner must be 'core'");
    }
  }

  let runtime: CommandOutcomeV1["runtime"] = null;
  if (o["runtime"] !== undefined) {
    const r = asObject(o["runtime"], "runtime");
    if (!RUNTIMES.includes(r["name"] as (typeof RUNTIMES)[number])) {
      throw new OutcomeError("XTMUX_INVALID_ARGUMENT", `unknown outcome runtime: ${String(r["name"]).slice(0, 32)}`);
    }
    const versionRaw = r["version"];
    runtime = {
      name: r["name"] as (typeof RUNTIMES)[number],
      version: versionRaw === null ? null : boundedText("runtime.version", versionRaw, 128),
    };
  }

  let paneId: string | null = null;
  let sessionId: string | null = null;
  if (o["identity"] !== undefined) {
    const identity = asObject(o["identity"], "identity");
    for (const key of ["thread_id", "session_name", "tmux_session_id", "pane_id"]) {
      if (!(key in identity)) {
        throw new OutcomeError("XTMUX_INVALID_ARGUMENT", `outcome identity.${key} is required when identity is present`);
      }
    }
    const pane = identity["pane_id"];
    if (pane !== null && !/^%[0-9]{1,31}$/.test(String(pane))) {
      throw new OutcomeError("XTMUX_INVALID_ARGUMENT", "outcome identity.pane_id must be null or %N");
    }
    const session = identity["tmux_session_id"];
    if (session !== null && !/^\$[0-9]{1,31}$/.test(String(session))) {
      throw new OutcomeError("XTMUX_INVALID_ARGUMENT", "outcome identity.tmux_session_id must be null or $N");
    }
    for (const key of ["thread_id", "session_name"]) {
      const value = identity[key];
      if (value !== null) boundedText(`identity.${key}`, value, 256);
    }
    paneId = pane as string | null;
    sessionId = session as string | null;
  }

  const rawActions = o["next_actions"];
  if (!Array.isArray(rawActions) || rawActions.length > 16) {
    throw new OutcomeError("XTMUX_INVALID_ARGUMENT", "outcome next_actions must be an array (max 16)");
  }
  const nextActions: OutcomeAction[] = rawActions.map((rawAction, index) => {
    const action = asObject(rawAction, `next_actions[${index}]`);
    if (!ACTION_KINDS.includes(action["kind"] as (typeof ACTION_KINDS)[number])) {
      throw new OutcomeError("XTMUX_INVALID_ARGUMENT", `outcome next_actions[${index}].kind is invalid`);
    }
    if (typeof action["required"] !== "boolean") {
      throw new OutcomeError("XTMUX_INVALID_ARGUMENT", `outcome next_actions[${index}].required must be a boolean`);
    }
    const argv = action["argv"];
    if (!Array.isArray(argv) || argv.length === 0 || argv.length > 32 || argv.some((arg) => typeof arg !== "string" || arg.length > 4096 || CONTROL_CHARACTER.test(arg))) {
      throw new OutcomeError("XTMUX_INVALID_ARGUMENT", `outcome next_actions[${index}].argv must be 1-32 bounded strings`);
    }
    const parsed: OutcomeAction = {
      kind: action["kind"] as (typeof ACTION_KINDS)[number],
      required: action["required"],
      argv: argv as string[],
      display: boundedText(`next_actions[${index}].display`, action["display"], 8192),
      why: boundedText(`next_actions[${index}].why`, action["why"], 240),
    };
    if (action["cwd"] !== undefined) parsed.cwd = boundedText(`next_actions[${index}].cwd`, action["cwd"], 4096);
    return parsed;
  });

  return {
    status: status as OutcomeStatus,
    reasonCode,
    summary,
    runtime,
    paneId,
    sessionId,
    nextActions,
  };
}

export interface ApplyOutcomeResult {
  schemaVersion: string;
  status: OutcomeStatus;
  reasonCode: string;
  paneId: string | null;
  sessionId: string | null;
  appliedState: "degraded" | null;
  duplicate: boolean;
  nextActions: OutcomeAction[];
}

/**
 * Map a validated outcome onto the existing lifecycle authority.
 *
 * Only `status: degraded` writes: one pane-scoped transition
 * (`state=degraded`, `source_event=outcome:<reason_code>`) plus its journal
 * envelope. The dedupe key is (pane, session, source_event), so a replayed or
 * restart-redelivered outcome stays idempotent; the worst case across a tmux
 * server restart is a suppressed duplicate, never a duplicated fact.
 *
 * ponytail: identity-scoped dedupe would need the instance_id, which does not
 * exist yet at launch (SessionStart mints it); pane+session is exact within a
 * tmux server lifetime.
 */
export function applyCommandOutcome(
  db: Db,
  outcome: CommandOutcomeV1,
  now: () => number = Date.now,
): ApplyOutcomeResult {
  let appliedState: "degraded" | null = null;
  let duplicate = false;

  if (outcome.status === "degraded" && outcome.paneId) {
    const sourceEvent = `outcome:${outcome.reasonCode}`;
    const existing = db.raw
      .query<{ id: number }, [string, string, string]>(
        `SELECT id FROM agent_state_transitions
          WHERE pane_id = ? AND state = 'degraded' AND source_event = ?
            AND COALESCE(session_id, '') = ?
          LIMIT 1`,
      )
      .get(outcome.paneId, sourceEvent, outcome.sessionId ?? "");
    if (existing) {
      duplicate = true;
      appliedState = "degraded";
    } else {
      recordTransition(
        db,
        {
          paneId: outcome.paneId,
          sessionId: outcome.sessionId ?? undefined,
          state: "degraded",
          sourceEvent,
        },
        now,
      );
      appliedState = "degraded";
    }
  }

  return {
    schemaVersion: OUTCOME_SCHEMA_V1,
    status: outcome.status,
    reasonCode: outcome.reasonCode,
    paneId: outcome.paneId,
    sessionId: outcome.sessionId,
    appliedState,
    duplicate,
    nextActions: outcome.nextActions,
  };
}
