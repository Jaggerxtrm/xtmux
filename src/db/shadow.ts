import type { Db } from "./connection.ts";

export type DiffKind =
  | "content"
  | "ordering"
  | "count"
  | "recipient_normalization"
  | "unread_count"
  | "state_snapshot"
  | "missing_row";

export interface DivergenceInput {
  domain: string;                    // messages | monitors | agents | telemetry | audit | handoffs
  command: string;                   // message-list | monitor-list | audit | ...
  diffKind: DiffKind;
  v1Snippet?: string | undefined;
  v2Snippet?: string | undefined;
  detail?: Record<string, unknown> | undefined;
}

/**
 * Record a divergence between V1 and V2 output/state observed under
 * XTMUX_OBS_V2=shadow. Never mutates authoritative state; only appends.
 * Consumers query `shadow_divergences` grouped by (domain, command) to gate
 * the V2 cutover.
 */
export function recordDivergence(
  db: Db,
  input: DivergenceInput,
  now: () => number = Date.now,
): number {
  const stmt = db.raw.prepare<
    { id: number },
    [string, string, string, string | null, string | null, string | null, number]
  >(
    `INSERT INTO shadow_divergences
       (domain, command, diff_kind, v1_snippet, v2_snippet, detail_json, detected_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  );
  const row = stmt.get(
    input.domain,
    input.command,
    input.diffKind,
    input.v1Snippet ?? null,
    input.v2Snippet ?? null,
    input.detail ? JSON.stringify(input.detail) : null,
    now(),
  );
  return row?.id ?? 0;
}

export interface DivergenceSummary {
  domain: string;
  command: string;
  count: number;
  latestAtMs: number;
}

export function summarizeDivergences(db: Db): DivergenceSummary[] {
  return db.raw
    .query<DivergenceSummary, []>(
      `SELECT domain, command,
              COUNT(*) AS count,
              MAX(detected_at_ms) AS latestAtMs
         FROM shadow_divergences
        GROUP BY domain, command
        ORDER BY count DESC`,
    )
    .all();
}
