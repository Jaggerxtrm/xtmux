import { existsSync } from "node:fs";
import { defaultDbPath, ViewError } from "./core.mjs";

// xtmux-it6: the viewer consumes the response EPISODE, never the latest row.
// One episode = one user prompt + all continuations until control returns to
// the operator; rows inside it are candidates. The schema (agent_episodes +
// agent_turns.episode_id) ships in xtmux migration 0014; a database that
// predates it degrades to the previous single-row read so the viewer keeps
// working against old installs.

export const EPISODE_SELECT = `
SELECT
  e.id AS episode_id,
  e.pane_id AS pane_id,
  e.session_id AS session_id,
  e.instance_id AS instance_id,
  e.bead_id AS bead_id,
  e.source_cursor AS source_cursor,
  e.opened_at_ms AS opened_at_ms,
  e.closed_at_ms AS closed_at_ms
FROM agent_episodes e
WHERE __WHERE__
ORDER BY e.id DESC
LIMIT 1`;

export const CANDIDATE_SELECT = `
SELECT
  t.id AS turn_id,
  t.turn_index AS turn_index,
  t.summary AS summary,
  t.last_message_text AS last_message_text,
  t.completed_at_ms AS completed_at_ms,
  i.runtime AS runtime
FROM agent_turns t
LEFT JOIN agent_instances i ON i.instance_id = t.instance_id
WHERE t.episode_id = ?
ORDER BY t.id`;

// The pre-episode fallback: the old latest-row read, wrapped as a single
// candidate so every downstream consumer sees one uniform episode shape.
const LEGACY_TURN_SELECT = `
SELECT
  t.id AS turn_id,
  t.pane_id AS pane_id,
  t.session_id AS session_id,
  t.instance_id AS instance_id,
  t.bead_id AS bead_id,
  t.summary AS summary,
  t.last_message_text AS last_message_text,
  t.completed_at_ms AS completed_at_ms,
  i.runtime AS runtime
FROM agent_turns t
LEFT JOIN agent_instances i ON i.instance_id = t.instance_id
WHERE __WHERE__
ORDER BY t.completed_at_ms DESC, t.id DESC
LIMIT 1`;

export function episodeWhere(target) {
  return target.startsWith("%") ? "e.pane_id = ?" : "e.session_id = ?";
}

export function mapEpisode(episodeRow, candidateRows) {
  return {
    schemaVersion: "xtmux.view.episode.v1",
    episodeId: episodeRow.episode_id === null ? null : Number(episodeRow.episode_id),
    paneId: String(episodeRow.pane_id),
    sessionId: String(episodeRow.session_id),
    instanceId: episodeRow.instance_id === null ? null : String(episodeRow.instance_id),
    beadId: episodeRow.bead_id === null ? null : String(episodeRow.bead_id),
    sourceCursor: episodeRow.source_cursor === null ? null : Number(episodeRow.source_cursor),
    openedAtMs: episodeRow.opened_at_ms === null ? null : Number(episodeRow.opened_at_ms),
    closedAtMs: episodeRow.closed_at_ms === null ? null : Number(episodeRow.closed_at_ms),
    candidates: candidateRows.map((row) => ({
      turnId: Number(row.turn_id),
      turnIndex: row.turn_index === null ? null : Number(row.turn_index),
      summary: row.summary === null ? null : String(row.summary),
      lastMessageText: row.last_message_text === null ? null : String(row.last_message_text),
      completedAtMs: Number(row.completed_at_ms),
      runtime: row.runtime === null ? null : String(row.runtime),
    })),
  };
}

function mapLegacyTurn(row) {
  const candidate = {
    turnId: Number(row.turn_id),
    turnIndex: null,
    summary: row.summary === null ? null : String(row.summary),
    lastMessageText: row.last_message_text === null ? null : String(row.last_message_text),
    completedAtMs: Number(row.completed_at_ms),
    runtime: row.runtime === null ? null : String(row.runtime),
  };
  return {
    schemaVersion: "xtmux.view.episode.v1",
    episodeId: null,
    paneId: String(row.pane_id),
    sessionId: String(row.session_id),
    instanceId: row.instance_id === null ? null : String(row.instance_id),
    beadId: row.bead_id === null ? null : String(row.bead_id),
    sourceCursor: null,
    openedAtMs: candidate.completedAtMs,
    closedAtMs: null,
    candidates: [candidate],
  };
}

function isMissingEpisodeSchema(error) {
  return error instanceof Error && /no such table: agent_episodes/.test(error.message);
}

export async function readLatestEpisode(target, env = process.env) {
  const dbPath = defaultDbPath(env);
  if (!existsSync(dbPath)) {
    throw new ViewError(
      "XTMUX_VIEW_DB_NOT_FOUND",
      `xtmux observability database not found: ${dbPath}`,
      { dbPath },
    );
  }

  let Database;
  try {
    ({ Database } = await import("bun:sqlite"));
  } catch (error) {
    throw new ViewError(
      "XTMUX_VIEW_BUN_REQUIRED",
      "xtmux-view requires Bun because xtmux observability uses bun:sqlite",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }

  let db;
  try {
    db = new Database(dbPath, { readonly: true });
    const timeout = Number(env.XTMUX_OBS_BUSY_TIMEOUT_MS || 3000);
    db.exec(`PRAGMA busy_timeout = ${Number.isFinite(timeout) ? Math.max(0, timeout) : 3000};`);
    const where = episodeWhere(target);
    const episodeRow = db.query(EPISODE_SELECT.replace("__WHERE__", where)).get(target);
    if (!episodeRow) return null;
    const candidateRows = db.query(CANDIDATE_SELECT).all(episodeRow.episode_id);
    return { ...mapEpisode(episodeRow, candidateRows), dbPath };
  } catch (error) {
    if (error instanceof ViewError) throw error;
    // Pre-0014 schema: degrade to the legacy single-row read instead of
    // failing the view. The response-episode model needs migration 0014.
    if (isMissingEpisodeSchema(error)) {
      try {
        const legacyWhere = target.startsWith("%") ? "t.pane_id = ?" : "t.session_id = ?";
        const row = db.query(LEGACY_TURN_SELECT.replace("__WHERE__", legacyWhere)).get(target);
        if (!row) return null;
        return { ...mapLegacyTurn(row), dbPath };
      } catch (legacyError) {
        throw new ViewError(
          "XTMUX_VIEW_QUERY_FAILED",
          "failed to read the latest agent turn; the installed xtmux schema may be too old",
          { dbPath, cause: legacyError instanceof Error ? legacyError.message : String(legacyError) },
        );
      }
    }
    throw new ViewError(
      "XTMUX_VIEW_QUERY_FAILED",
      "failed to read the latest response episode; the installed xtmux schema may be too old",
      { dbPath, cause: error instanceof Error ? error.message : String(error) },
    );
  } finally {
    try { db?.close(); } catch { /* read-only cleanup */ }
  }
}
