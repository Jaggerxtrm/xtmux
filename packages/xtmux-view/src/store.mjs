import { existsSync } from "node:fs";
import { defaultDbPath, ViewError } from "./core.mjs";

const TURN_SELECT = `
SELECT
  t.id AS turn_id,
  t.pane_id AS pane_id,
  t.session_id AS session_id,
  t.instance_id AS instance_id,
  t.bead_id AS bead_id,
  t.turn_index AS turn_index,
  t.summary AS summary,
  t.last_message_text AS last_message_text,
  t.completed_at_ms AS completed_at_ms,
  i.runtime AS runtime
FROM agent_turns t
LEFT JOIN agent_instances i ON i.instance_id = t.instance_id
WHERE __WHERE__
ORDER BY t.completed_at_ms DESC, t.id DESC
LIMIT 1`;

export async function readLatestTurn(target, env = process.env) {
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
    const where = target.startsWith("%") ? "t.pane_id = ?" : "t.session_id = ?";
    const row = db.query(TURN_SELECT.replace("__WHERE__", where)).get(target);
    if (!row) return null;
    return {
      schemaVersion: "xtmux.view.turn.v1",
      turnId: Number(row.turn_id),
      paneId: String(row.pane_id),
      sessionId: String(row.session_id),
      instanceId: row.instance_id === null ? null : String(row.instance_id),
      beadId: row.bead_id === null ? null : String(row.bead_id),
      turnIndex: row.turn_index === null ? null : Number(row.turn_index),
      summary: row.summary === null ? null : String(row.summary),
      lastMessageText: row.last_message_text === null ? null : String(row.last_message_text),
      completedAtMs: Number(row.completed_at_ms),
      runtime: row.runtime === null ? null : String(row.runtime),
      dbPath,
    };
  } catch (error) {
    if (error instanceof ViewError) throw error;
    throw new ViewError(
      "XTMUX_VIEW_QUERY_FAILED",
      "failed to read the latest agent turn; the installed xtmux schema may be too old",
      { dbPath, cause: error instanceof Error ? error.message : String(error) },
    );
  } finally {
    try { db?.close(); } catch { /* read-only cleanup */ }
  }
}
