/**
 * Core K2 launch-outcome consumption (xtmux-s96.2, KAN-127 K3-xtmux).
 *
 * Consumes `xtrm.command-outcome.v1` (schema pinned at Core commit
 * 1ed512a49efaf75f3e84c128f9d82958ece09d3a; Codex outcome shape at Core K3
 * commit 9b59fa5a7eed86b68f18f929ea3d37b072ae0891) as STRUCTURED DATA and maps
 * it onto the existing lifecycle authority (agent_state_transitions +
 * event_journal). No prose parsing, no private state, no Codex-specific store:
 *
 *  - `status: degraded` with a correlatable pane records exactly one `degraded`
 *    lifecycle fact (idempotent across replay and restart);
 *  - every other status fabricates nothing — hooks own runtime lifecycle, and
 *    an outcome never fabricates an authoritative mutation;
 *  - `next_actions` argv is passed through verbatim for the caller to execute.
 *
 * K3 is experimental until K5 (the programme GATE-IFACE has already passed);
 * promotion/release follow K4/K5.
 */
import type { Db } from "../../db/connection.ts";
import { recordTransition } from "./transition.ts";

export const OUTCOME_SCHEMA_V1 = "xtrm.command-outcome.v1";

const STATUSES = ["ok", "degraded", "noop", "rejected", "failed"] as const;
const ACTION_KINDS = ["attach", "resume", "repair", "end", "wait", "inspect"] as const;
const RUNTIMES = ["pi", "claude", "codex"] as const;
const READINESS_STATUSES = ["ready", "unverified", "not_ready"] as const;
const READINESS_SOURCES = ["agent.ready", "tmux-pane", "none"] as const;
const SIDE_EFFECT_STATUSES = ["ok", "degraded", "failed", "skipped"] as const;

const TOP_LEVEL_KEYS = new Set([
  "schema_version", "status", "reason_code", "summary", "runtime", "identity",
  "worktree", "readiness", "safety_profile", "persistence",
  "authoritative_mutation", "side_effects", "next_actions",
]);

// The published schema is `additionalProperties: false` on every object and
// validates every field. The consumer enforces the same boundary: a payload
// that @xtrm/contracts would reject is never silently accepted here.
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/;
const REASON_PATTERN = /^[a-z][a-z0-9_]*$/;
const TOKEN_PATTERN = /^[a-z][a-z0-9-]*$/;
const DOTTED_PATTERN = /^[a-z][a-z0-9.-]*$/;
const TMUX_SESSION_PATTERN = /^\$[0-9]+$/;
const TMUX_PANE_PATTERN = /^%[0-9]+$/;

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

function invalid(message: string, detailKey?: string, detailValue?: string): OutcomeError {
  return new OutcomeError("XTMUX_INVALID_ARGUMENT", message, detailKey && detailValue !== undefined ? { [detailKey]: detailValue } : {});
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`outcome ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

// Schema `additionalProperties: false` at every level.
function noUnknownKeys(o: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(o)) {
    if (!allowed.has(key)) {
      throw invalid(`unknown outcome field: ${label}.${key}`, "field", `${label}.${key}`.slice(0, 96));
    }
  }
}

function requireKeys(o: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of keys) {
    if (!(key in o)) throw invalid(`outcome ${label}.${key} is required`);
  }
}

function boundedText(label: string, value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || CONTROL_CHARACTER.test(value)) {
    throw invalid(`outcome ${label} is missing or out of bounds`);
  }
  return value;
}

function nullableBoundedText(label: string, value: unknown, maxLength: number): string | null {
  if (value === null) return null;
  return boundedText(label, value, maxLength);
}

function token(label: string, value: unknown, pattern: RegExp, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !pattern.test(value)) {
    throw invalid(`outcome ${label} is not a valid token`);
  }
  return value;
}

function enumValue<T extends string>(label: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw invalid(`outcome ${label} is not one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function booleanValue(label: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw invalid(`outcome ${label} must be a boolean`);
  return value;
}

// schema `persistence` / `authoritative_mutation`: { completed, kind }.
function mutationObject(value: unknown, label: string): { completed: boolean; kind: string } {
  const o = asObject(value, label);
  noUnknownKeys(o, new Set(["completed", "kind"]), label);
  requireKeys(o, ["completed", "kind"], label);
  return {
    completed: booleanValue(`${label}.completed`, o["completed"]),
    kind: token(`${label}.kind`, o["kind"], DOTTED_PATTERN, 96),
  };
}

/**
 * Parse and validate an untrusted outcome payload against the FULL published
 * v1 schema boundary: every object is closed (`additionalProperties: false`
 * semantics), every field is type- and pattern-checked, unknown schema
 * versions are rejected (payload-version awareness), and hook-trust bypass
 * claims are refused. Throws OutcomeError with a stable code; never writes on
 * failure.
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
  noUnknownKeys(o, TOP_LEVEL_KEYS, "payload");
  requireKeys(o, ["schema_version", "status", "reason_code", "summary", "authoritative_mutation", "side_effects", "next_actions"], "payload");

  const status = enumValue("status", o["status"], STATUSES);
  const reasonCode = token("reason_code", o["reason_code"], REASON_PATTERN, 64);
  const summary = boundedText("summary", o["summary"], 240);

  const mutation = mutationObject(o["authoritative_mutation"], "authoritative_mutation");

  // side_effects: array (max 32) of { kind, status, id? } — all closed.
  const rawSideEffects = o["side_effects"];
  if (!Array.isArray(rawSideEffects) || rawSideEffects.length > 32) {
    throw invalid("outcome side_effects must be an array (max 32)");
  }
  rawSideEffects.forEach((rawEffect, index) => {
    const label = `side_effects[${index}]`;
    const effect = asObject(rawEffect, label);
    noUnknownKeys(effect, new Set(["kind", "status", "id"]), label);
    requireKeys(effect, ["kind", "status"], label);
    token(`${label}.kind`, effect["kind"], DOTTED_PATTERN, 96);
    enumValue(`${label}.status`, effect["status"], SIDE_EFFECT_STATUSES);
    if ("id" in effect) nullableBoundedText(`${label}.id`, effect["id"], 256);
  });

  // Hook trust is a hard gate: an outcome claiming a bypass is rejected
  // instead of applied. The managed profile never bypasses hook trust.
  if (o["safety_profile"] !== undefined) {
    const label = "safety_profile";
    const profile = asObject(o[label], label);
    noUnknownKeys(profile, new Set(["name", "sandbox", "approvals", "hook_trust"]), label);
    requireKeys(profile, ["name", "sandbox", "approvals", "hook_trust"], label);
    token(`${label}.name`, profile["name"], TOKEN_PATTERN, 64);
    token(`${label}.sandbox`, profile["sandbox"], TOKEN_PATTERN, 64);
    token(`${label}.approvals`, profile["approvals"], TOKEN_PATTERN, 64);
    if (profile["hook_trust"] !== "preserved") {
      throw new OutcomeError(
        "XTMUX_HOOK_TRUST_VIOLATED",
        "outcome safety_profile.hook_trust must be 'preserved'; bypass claims are rejected",
      );
    }
  }

  let runtime: CommandOutcomeV1["runtime"] = null;
  if (o["runtime"] !== undefined) {
    const label = "runtime";
    const r = asObject(o[label], label);
    noUnknownKeys(r, new Set(["name", "version"]), label);
    requireKeys(r, ["name", "version"], label);
    const name = enumValue(`${label}.name`, r["name"], RUNTIMES);
    const versionValue = nullableBoundedText(`${label}.version`, r["version"], 128);
    runtime = { name, version: versionValue };
  }

  let paneId: string | null = null;
  let sessionId: string | null = null;
  if (o["identity"] !== undefined) {
    const label = "identity";
    const identity = asObject(o[label], label);
    noUnknownKeys(identity, new Set(["thread_id", "session_name", "tmux_session_id", "pane_id"]), label);
    requireKeys(identity, ["thread_id", "session_name", "tmux_session_id", "pane_id"], label);
    nullableBoundedText(`${label}.thread_id`, identity["thread_id"], 256);
    nullableBoundedText(`${label}.session_name`, identity["session_name"], 256);
    const session = identity["tmux_session_id"];
    if (session !== null && (typeof session !== "string" || session.length > 32 || !TMUX_SESSION_PATTERN.test(session))) {
      throw invalid(`outcome ${label}.tmux_session_id must be null or $N`);
    }
    const pane = identity["pane_id"];
    if (pane !== null && (typeof pane !== "string" || pane.length > 32 || !TMUX_PANE_PATTERN.test(pane))) {
      throw invalid(`outcome ${label}.pane_id must be null or %N`);
    }
    paneId = pane as string | null;
    sessionId = session as string | null;
  }

  if (o["worktree"] !== undefined) {
    const label = "worktree";
    const worktree = asObject(o[label], label);
    noUnknownKeys(worktree, new Set(["path", "branch", "owner"]), label);
    requireKeys(worktree, ["path", "branch", "owner"], label);
    boundedText(`${label}.path`, worktree["path"], 4096);
    boundedText(`${label}.branch`, worktree["branch"], 4096);
    if (worktree["owner"] !== "core") throw invalid(`outcome ${label}.owner must be 'core'`);
  }

  if (o["readiness"] !== undefined) {
    const label = "readiness";
    const readiness = asObject(o[label], label);
    noUnknownKeys(readiness, new Set(["status", "source"]), label);
    requireKeys(readiness, ["status", "source"], label);
    enumValue(`${label}.status`, readiness["status"], READINESS_STATUSES);
    enumValue(`${label}.source`, readiness["source"], READINESS_SOURCES);
  }

  if (o["persistence"] !== undefined) {
    mutationObject(o["persistence"], "persistence");
  }

  const rawActions = o["next_actions"];
  if (!Array.isArray(rawActions) || rawActions.length > 16) {
    throw invalid("outcome next_actions must be an array (max 16)");
  }
  const nextActions: OutcomeAction[] = rawActions.map((rawAction, index) => {
    const label = `next_actions[${index}]`;
    const action = asObject(rawAction, label);
    noUnknownKeys(action, new Set(["kind", "required", "argv", "display", "cwd", "why"]), label);
    requireKeys(action, ["kind", "required", "argv", "display", "why"], label);
    const kind = enumValue(`${label}.kind`, action["kind"], ACTION_KINDS);
    const required = booleanValue(`${label}.required`, action["required"]);
    const argv = action["argv"];
    if (!Array.isArray(argv) || argv.length === 0 || argv.length > 32 || argv.some((arg) => typeof arg !== "string" || arg.length > 4096 || CONTROL_CHARACTER.test(arg))) {
      throw invalid(`outcome ${label}.argv must be 1-32 bounded strings`);
    }
    const parsed: OutcomeAction = {
      kind,
      required,
      argv: argv as string[],
      display: boundedText(`${label}.display`, action["display"], 8192),
      why: boundedText(`${label}.why`, action["why"], 240),
    };
    if ("cwd" in action) parsed.cwd = boundedText(`${label}.cwd`, action["cwd"], 4096);
    return parsed;
  });

  void mutation; // validated for schema closure; not consumed by the adapter

  return {
    status,
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
