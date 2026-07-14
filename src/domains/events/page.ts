import type { Db } from "../../db/connection.ts";
import { hostId as readHostId } from "../identity/host-id.ts";
import type { JournalRow } from "./query.ts";

/**
 * Cursor-paged journal reads (docs/xtmux-gaps.md §6).
 *
 * A consumer that reconnects and asks "what have I not seen?" cannot use a
 * timestamp (two events can share a millisecond, and clocks move) and cannot use
 * event_key (it is optional and domain-specific). The committed SQLite rowid is
 * the only monotonic, gap-free-on-commit cursor we have — it already exists, it
 * just was never exposed.
 */
export interface JournalPageItemV1 {
  journal_id: number;
  event_key?: string;
  event_type: string;
  occurred_at_ms: number;
  recorded_at_ms: number;
  host_id: string;
  session_id?: string;
  pane_id?: string;
  agent_instance_id?: string;
  bead_id?: string;
  correlation_id?: string;
  payload: unknown;
}

export interface JournalPageV1 {
  schema_version: "xtrm.xtmux.journal-page.v1";
  items: JournalPageItemV1[];
  next_after_id: number;
  oldest_available_id: number | null;
  latest_available_id: number | null;
  has_more: boolean;
}

export interface CursorExpiredV1 {
  code: "XTMUX_CURSOR_EXPIRED";
  message: string;
  detail: {
    requested_after_id: string;
    oldest_available_id: string;
    latest_available_id: string;
  };
}

export type JournalPageResult =
  | { ok: true; page: JournalPageV1 }
  | { ok: false; error: CursorExpiredV1 };

export interface JournalPageInput {
  afterId: number;
  limit?: number | undefined;
  type?: string | undefined;
  sessionId?: string | undefined;
  paneId?: string | undefined;
  beadId?: string | undefined;
}

export const MAX_PAGE = 1000;
const DEFAULT_PAGE = 200;

/** Absent optional fields are OMITTED, never emitted as "" — an empty string reads
 *  as a real binding to a consumer, where absence honestly says "not known". */
function put(o: Record<string, unknown>, k: string, v: string | null): void {
  if (v !== null && v !== "") o[k] = v;
}

function toItem(row: JournalRow, hostId: string): JournalPageItemV1 {
  let payload: unknown = {};
  try {
    payload = JSON.parse(row.payload_json) as unknown;
  } catch {
    // A row we cannot parse is still a row the consumer must be able to page
    // PAST: throwing here would wedge the cursor forever on one bad payload.
    payload = { unparsed: row.payload_json };
  }
  const item: Record<string, unknown> = {
    journal_id: row.id,
    event_type: row.type,
    // We record at emit time, so these coincide for every locally-produced event.
    // They are separate fields because an event that arrives over the bridge
    // carries its own origin timestamp, and collapsing the two would make a
    // relayed event look like it happened when we happened to write it down.
    occurred_at_ms: occurredAt(payload, row.created_at_ms),
    recorded_at_ms: row.created_at_ms,
    host_id: hostId,
    payload,
  };
  put(item, "event_key", row.event_key);
  put(item, "session_id", row.session_id);
  put(item, "pane_id", row.pane_id);
  put(item, "agent_instance_id", row.instance_id);
  put(item, "bead_id", row.bead_id);
  put(item, "correlation_id", row.correlation_id);
  return item as unknown as JournalPageItemV1;
}

function occurredAt(payload: unknown, fallback: number): number {
  if (payload && typeof payload === "object") {
    const raw = (payload as Record<string, unknown>)["occurred_at_ms"] ?? (payload as Record<string, unknown>)["ts_epoch"];
    const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

export function journalPage(db: Db, input: JournalPageInput): JournalPageResult {
  const watermarks = db.raw
    .prepare<{ oldest: number | null; latest: number | null }, []>(
      "SELECT MIN(id) AS oldest, MAX(id) AS latest FROM event_journal",
    )
    .get();
  const oldest = watermarks?.oldest ?? null;
  const latest = watermarks?.latest ?? null;

  // Retention deletes from the OLD end. A cursor whose next expected row (after+1)
  // sits below the oldest surviving row means rows were dropped while the consumer
  // was away: it has a hole it can never fill, and must be told so explicitly
  // rather than silently handed the next surviving page as if nothing was lost.
  if (oldest !== null && input.afterId > 0 && input.afterId + 1 < oldest) {
    return {
      ok: false,
      error: {
        code: "XTMUX_CURSOR_EXPIRED",
        message: `cursor ${input.afterId} predates retained history; re-anchor at oldest_available_id`,
        detail: {
          requested_after_id: String(input.afterId),
          oldest_available_id: String(oldest),
          latest_available_id: String(latest ?? oldest),
        },
      },
    };
  }

  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_PAGE, MAX_PAGE));
  const clauses = ["id > ?"];
  const params: (string | number)[] = [input.afterId];
  if (input.type !== undefined) { clauses.push("type = ?"); params.push(input.type); }
  if (input.sessionId !== undefined) { clauses.push("session_id = ?"); params.push(input.sessionId); }
  if (input.paneId !== undefined) { clauses.push("pane_id = ?"); params.push(input.paneId); }
  if (input.beadId !== undefined) { clauses.push("bead_id = ?"); params.push(input.beadId); }

  // Ascending, always. A DESC page would hand a consumer rows it must reverse
  // before it can advance its cursor, and a partial DESC page skips the middle.
  // Fetch one extra row to answer has_more without a second COUNT query.
  const rows = db.raw
    .prepare<JournalRow, (string | number)[]>(
      `SELECT * FROM event_journal WHERE ${clauses.join(" AND ")} ORDER BY id ASC LIMIT ${limit + 1}`,
    )
    .all(...params);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const hostId = readHostId();

  return {
    ok: true,
    page: {
      schema_version: "xtrm.xtmux.journal-page.v1",
      items: page.map((r) => toItem(r, hostId)),
      // An empty page must return the cursor the caller SENT, not 0: returning 0
      // would rewind a caught-up consumer to the start of the journal on its next
      // poll and replay everything it has already handled.
      next_after_id: page.length > 0 ? (page[page.length - 1] as JournalRow).id : input.afterId,
      oldest_available_id: oldest,
      latest_available_id: latest,
      has_more: hasMore,
    },
  };
}
