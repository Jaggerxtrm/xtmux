/**
 * `xtmux outcome-apply` — consume one Core K2 launch outcome
 * (xtrm.command-outcome.v1) from stdin and map it onto the existing lifecycle
 * authority (xtmux-s96.2, KAN-127 K3-xtmux). Structured JSON in, structured
 * JSON out; no prose parsing anywhere on this path.
 */
import { readFileSync } from "node:fs";
import type { Db } from "./db/connection.ts";
import { applyCommandOutcome, OutcomeError, parseCommandOutcomeV1 } from "./domains/agents/outcome.ts";

export function cliOutcomeApply(db: Db, _argv: string[]): number {
  let raw: string;
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    raw = "";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(JSON.stringify({
      code: "XTMUX_INVALID_ARGUMENT",
      message: "outcome-apply: stdin is not valid JSON",
      detail: {},
    }) + "\n");
    return 2;
  }

  try {
    const outcome = parseCommandOutcomeV1(parsed);
    const result = applyCommandOutcome(db, outcome);
    process.stdout.write(JSON.stringify({
      schemaVersion: result.schemaVersion,
      status: result.status,
      reasonCode: result.reasonCode,
      paneId: result.paneId,
      sessionId: result.sessionId,
      appliedState: result.appliedState,
      duplicate: result.duplicate,
      nextActions: result.nextActions,
    }) + "\n");
    return 0;
  } catch (err) {
    if (err instanceof OutcomeError) {
      // Authority/conflict rejection (hook-trust bypass) keeps its own status;
      // shape and version problems are invalid input.
      const status = err.code === "XTMUX_HOOK_TRUST_VIOLATED" ? 4 : 2;
      process.stderr.write(JSON.stringify({ code: err.code, message: err.message, detail: err.detail }) + "\n");
      return status;
    }
    throw err;
  }
}
