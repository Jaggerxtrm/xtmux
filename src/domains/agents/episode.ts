import type { Db } from "../../db/connection.ts";

// xtmux-gdk: durable response episodes. One episode = one user prompt plus all
// Claude continuations caused before control genuinely returns to the operator
// (Stop-hook block follow-ups). agent_turns rows are *candidates* inside an
// episode; the latest row is never the response — the episode is.
//
// Episode lifecycle is driven by the agents' own signals:
//   - `agent.episode.open` (Claude UserPromptSubmit hook, pi run start) closes
//     the pane's open episode and opens a fresh one;
//   - `agent.turn.done ... episode_open=1` (a Stop that is not a continuation)
//     closes + opens, then attaches;
//   - `agent.turn.done ... episode_open=0` (stop_hook_active continuation, or
//     pi/codex which send no flag) attaches to the open episode;
//   - no open episode at all → lazy-open (fail-open: a turn always lands).

export interface EpisodeOpenInput {
  paneId: string;
  sessionId: string;
  instanceId?: string | undefined;
  beadId?: string | undefined;
  parentSessionId?: string | undefined;
  sourceCursor?: number | undefined;
}

export interface EpisodeRow {
  id: number;
  paneId: string;
  sessionId: string;
  instanceId: string | null;
  beadId: string | null;
  parentSessionId: string | null;
  sourceCursor: number | null;
  openedAtMs: number;
  closedAtMs: number | null;
}

// Close the pane's open episode (if any), then insert a fresh open episode.
// The "next real UserPromptSubmit closes E / opens E+1" transition. Returns
// the new episode id.
export function openEpisode(db: Db, input: EpisodeOpenInput, now: () => number = Date.now): number {
  let id = 0;
  const tx = db.raw.transaction(() => {
    db.raw
      .prepare("UPDATE agent_episodes SET closed_at_ms = ? WHERE pane_id = ? AND closed_at_ms IS NULL")
      .run(now(), input.paneId);
    const row = db.raw
      .prepare<
        { id: number },
        [
          string | null, string, string, string | null, string | null,
          number | null, number,
        ]
      >(
        `INSERT INTO agent_episodes
           (instance_id, session_id, pane_id, bead_id, parent_session_id,
            source_cursor, opened_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .get(
        input.instanceId ?? null,
        input.sessionId,
        input.paneId,
        input.beadId ?? null,
        input.parentSessionId ?? null,
        input.sourceCursor ?? null,
        now(),
      );
    id = row?.id ?? 0;
  });
  tx();
  return id;
}

/**
 * Decide which episode a completed turn attaches to.
 *
 * - `openNew` (episode_open=1): a non-continuation Stop — close any open
 *   episode and start a fresh one.
 * - otherwise: attach to the pane's open episode when it belongs to the same
 *   agent instance (an episode opened for a previous occupant must not absorb
 *   the new occupant's turn); lazy-open when none matches.
 *
 * Must be called inside a write transaction: it both reads and writes.
 */
export function resolveEpisodeForTurn(
  db: Db,
  paneId: string,
  sessionId: string,
  instanceId: string | null,
  openNew: boolean,
  now: () => number,
): number {
  if (openNew) return openEpisode(db, { paneId, sessionId, instanceId: instanceId ?? undefined }, now);
  const open = db.raw
    .prepare<{ id: number }, [string, string | null]>(
      `SELECT id FROM agent_episodes
        WHERE pane_id = ? AND closed_at_ms IS NULL AND (instance_id = ? OR instance_id IS NULL)
        ORDER BY id DESC LIMIT 1`,
    )
    .get(paneId, instanceId);
  if (open?.id) return open.id;
  return openEpisode(db, { paneId, sessionId, instanceId: instanceId ?? undefined }, now);
}

// A candidate is "substantive" when its text clears this bar; shorter rows are
// hook acknowledgements ("Acknowledged.", "I'll wait for the monitor.") and
// are collapsed by the projection instead of replacing the primary response.
// Length alone is not the rule: a short Mermaid/table/code block is still a
// real response, and a later short acknowledgement must never displace it.
export const SUBSTANTIVE_MIN = 200;

/**
 * Substantive iff: long enough, OR short but structurally a real response
 * (fenced code/Mermaid block, or a multi-line markdown table). A hook
 * acknowledgement is a plain short sentence — no fence, no table rows.
 * Mirrored in packages/xtmux-view/src/core.mjs — keep in lockstep.
 */
export function isSubstantiveText(text: string): boolean {
  const t = String(text ?? "");
  if (t.length >= SUBSTANTIVE_MIN) return true;
  if (t.includes("```") || t.includes("~~~")) return true;
  if (t.includes("\n") && /^\s*\|/m.test(t)) return true;
  return false;
}

export interface EpisodeCandidate {
  turnId: number;
  turnIndex: number | null;
  summary: string | null;
  lastMessageText: string | null;
  completedAtMs: number;
  substantive: boolean;
}

export interface EpisodeProjection {
  episodeId: number;
  paneId: string;
  sessionId: string;
  instanceId: string | null;
  beadId: string | null;
  openedAtMs: number;
  closedAtMs: number | null;
  /** First substantive candidate; the response the episode is about. */
  primary: EpisodeCandidate | null;
  /** Later substantive candidates; the continuation follow-ups. */
  followUps: EpisodeCandidate[];
  /** Short candidates (hook acknowledgements) — rendered collapsed, never primary. */
  collapsed: EpisodeCandidate[];
}

function candidateText(row: { last_message_text: string | null; summary: string | null }): string {
  return row.last_message_text ?? row.summary ?? "";
}

/**
 * The viewer-facing projection: the pane's (or session's) latest episode with
 * its candidate turns in order. Conservative by contract — a short hook
 * acknowledgement is collapsed, never allowed to replace the substantive
 * primary response (the Mermaid case: response A holds the diagram, a later
 * "acknowledged" Stop candidate must not displace it).
 */
export function findLatestEpisode(db: Db, target: string): EpisodeProjection | null {
  if (!target) return null;
  const byPane = target.startsWith("%");
  const where = byPane ? "e.pane_id = ?" : "e.session_id = ?";
  const ep = db.raw
    .prepare<
      {
        id: number;
        pane_id: string;
        session_id: string;
        instance_id: string | null;
        bead_id: string | null;
        opened_at_ms: number;
        closed_at_ms: number | null;
      },
      [string]
    >(
      `SELECT e.id, e.pane_id, e.session_id, e.instance_id, e.bead_id,
              e.opened_at_ms, e.closed_at_ms
         FROM agent_episodes e
        WHERE ${where}
        ORDER BY e.id DESC
        LIMIT 1`,
    )
    .get(target);
  if (!ep) return null;

  const rows = db.raw
    .prepare<
      {
        id: number;
        turn_index: number | null;
        summary: string | null;
        last_message_text: string | null;
        completed_at_ms: number;
      },
      [number]
    >(
      `SELECT t.id, t.turn_index, t.summary, t.last_message_text, t.completed_at_ms
         FROM agent_turns t
        WHERE t.episode_id = ?
        ORDER BY t.id`,
    )
    .all(ep.id);

  const candidates: EpisodeCandidate[] = rows.map((r) => ({
    turnId: r.id,
    turnIndex: r.turn_index,
    summary: r.summary,
    lastMessageText: r.last_message_text,
    completedAtMs: r.completed_at_ms,
    substantive: isSubstantiveText(candidateText(r)),
  }));

  const substantive = candidates.filter((c) => c.substantive);
  const primary = substantive[0] ?? [...candidates].reverse().find((c) => c.lastMessageText || c.summary) ?? null;
  const followUps = substantive.slice(1);
  const collapsed = candidates.filter((c) => !c.substantive && c !== primary);

  return {
    episodeId: ep.id,
    paneId: ep.pane_id,
    sessionId: ep.session_id,
    instanceId: ep.instance_id,
    beadId: ep.bead_id,
    openedAtMs: ep.opened_at_ms,
    closedAtMs: ep.closed_at_ms,
    primary,
    followUps,
    collapsed,
  };
}
