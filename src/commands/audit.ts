import type { Db } from "../db/connection.ts";
import { completeRun, record, startRun, type Finding } from "../domains/audit/store.ts";
import { isKind, type Kind } from "../domains/audit/fingerprint.ts";
import { paneIndex } from "../tmux.ts";
import { parseArgs } from "./monitors.ts";

/**
 * CLI surface for audit persistence (xtmux-3xs.8).
 *
 * The picker keeps emitting its human TSV to stdout untouched (PRD §20) and pipes
 * a copy here. Persistence is purely additive — this command never writes to
 * stdout, so V1's output cannot drift by accident.
 *
 * `--partial` marks a run whose walk did not finish. A partial run records what it
 * saw but never resolves what it did not: a crash halfway through the session list
 * must not mass-resolve every finding it simply had not reached.
 */

/** `k=v` tokens after the fixed columns, e.g. `dirty=3`, `state=running`. */
function kvs(fields: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const eq = f.indexOf("=");
    if (eq > 0) out[f.slice(0, eq)] = f.slice(eq + 1);
  }
  return out;
}

/**
 * Parse one V1 audit line into a Finding.
 *
 * V1 shapes (severity, kind, session_id, session_name, then kind-specific):
 *   cleanup missing-path            $sid name path
 *   cleanup stale-specialist        $sid name state=X
 *   warning dirty-worktree          $sid name dirty=N repo=R path=P
 *   warning shared-worktree         $sid name repo=R path=P
 *   warning working-do-not-kill     $sid name state=X
 *   warning naming-convention       $sid name
 *   warning agent-pane-without-bead $sid name %pane state=X cmd=Y
 */
export function parseLine(line: string): Finding | null {
  const f = line.split("\t");
  const [severity, kind, sessionId, sessionName, ...rest] = f;
  if (severity !== "warning" && severity !== "cleanup") return null; // header row
  if (!kind || !isKind(kind) || !sessionName) return null;

  const kv = kvs(rest);
  const base = { kind: kind as Kind, sessionName, sessionId };

  switch (kind) {
    case "missing-path":
      // path is positional here, and V1 may append " (deleted)" from /proc
      return { ...base, path: rest[0] };
    case "stale-specialist":
    case "working-do-not-kill":
      return { ...base, detail: { state: kv["state"] ?? "" } };
    case "naming-convention":
      return base;
    case "dirty-worktree":
      return {
        ...base,
        path: kv["path"],
        repo: kv["repo"],
        detail: { dirty_count: Number(kv["dirty"] ?? 0), repo: kv["repo"] ?? "" },
      };
    case "shared-worktree":
      return {
        ...base,
        path: kv["path"],
        repo: kv["repo"],
        detail: { repo: kv["repo"] ?? "" },
      };
    case "agent-pane-without-bead": {
      const paneId = rest[0] ?? "";
      return {
        ...base,
        paneId,
        // %N is recycled across tmux restarts; the index is the stable identity
        paneIndex: paneId ? paneIndex(paneId) : undefined,
        detail: { state: kv["state"] ?? "", cmd: kv["cmd"] ?? "" },
      };
    }
    default:
      return null;
  }
}

export async function auditCommand(db: Db, sub: string, argv: string[], now: number): Promise<number> {
  if (sub !== "ingest") {
    process.stderr.write(`unknown audit subcommand: ${sub}\n`);
    return 2;
  }
  const a = parseArgs(argv);
  const partial = argv.includes("--partial");

  const text = await Bun.stdin.text();
  const runId = `ar${now}-${process.pid}`;
  startRun(db, runId, a["session"], now);

  let warnings = 0;
  let cleanups = 0;

  for (const line of text.split("\n")) {
    const finding = parseLine(line);
    if (!finding) continue;
    if (line.startsWith("cleanup\t")) cleanups++;
    else warnings++;
    record(db, runId, finding, now);
  }

  // A partial run leaves completed_at_ms NULL, which is what keeps resolveAbsent
  // away from it.
  if (!partial) completeRun(db, runId, { warnings, cleanups }, now);
  return 0;
}
