#!/usr/bin/env node
// xtrm-logger.mjs — shared event logger for xtrm hooks
//
// Writes to .xtrm/debug.db (SQLite WAL) in the project root.
// Self-initializing: creates the DB and table on first write.
// Fails completely silently — logging NEVER affects hook behavior.
//
// Usage (from any hook):
//   import { logEvent } from './xtrm-logger.mjs';
//   logEvent({ cwd, sessionId, kind: 'gate.edit.allow', outcome: 'allow', toolName, issueId });

import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// ── Schema ────────────────────────────────────────────────────────────────────

const INIT_SQL = `
PRAGMA busy_timeout=5000;
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  session_id  TEXT    NOT NULL,
  runtime     TEXT    NOT NULL,
  worktree    TEXT,
  kind        TEXT    NOT NULL,
  tool_name   TEXT,
  outcome     TEXT,
  issue_id    TEXT,
  duration_ms INTEGER,
  data        TEXT
);
CREATE INDEX IF NOT EXISTS idx_ts      ON events(ts);
CREATE INDEX IF NOT EXISTS idx_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_kind    ON events(kind);
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function findDbPath(cwd) {
  let dir = cwd;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, '.beads'))) {
      return join(dir, '.xtrm', 'debug.db');
    }
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null; // No beads project found — silently skip logging
}

function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(INIT_SQL);
  return db;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Log an xtrm event to .xtrm/debug.db.
 *
 * @param {object}  params
 * @param {string}  params.cwd         Project working directory (required)
 * @param {string}  params.sessionId   Session UUID or Pi PID string (required)
 * @param {string}  params.kind        Dot-separated kind: 'gate.edit.allow', 'tool.call', 'bd.claimed', etc. (required)
 * @param {string}  [params.runtime]   'claude' | 'pi'  (default: 'claude')
 * @param {string}  [params.outcome]   'allow' | 'block' | 'ok' | 'error'
 * @param {string}  [params.toolName]  Tool name for gate / tool.call events
 * @param {string}  [params.issueId]   Linked beads issue ID
 * @param {number}  [params.durationMs] Tool call duration
 * @param {object}  [params.data]      Structured context (file, cmd, reason, etc.)
 * @param {string}  [params.message]   Legacy: message string (merged into data.msg)
 * @param {object}  [params.extra]     Legacy: extra object (merged into data)
 */
export function logEvent(params) {
  let db;
  try {
    const { cwd, sessionId, kind } = params;
    if (!cwd || !sessionId || !kind) return;

    const { runtime = 'claude', outcome, toolName, issueId, durationMs, message, extra, data } = params;

    const dbPath = findDbPath(cwd);
    if (!dbPath) return;

    const worktreeMatch = cwd.match(/\.xtrm\/worktrees\/([^/]+)/);
    const worktree = worktreeMatch ? worktreeMatch[1] : null;

    // Merge message/extra/data into a single JSON string
    let dataStr = null;
    if (data !== null && data !== undefined) {
      dataStr = typeof data === 'string' ? data : JSON.stringify(data);
    } else if (message || extra) {
      const merged = { ...(message ? { msg: message } : {}), ...(extra || {}) };
      if (Object.keys(merged).length > 0) dataStr = JSON.stringify(merged);
    }

    db = openDb(dbPath);
    db.prepare(`
      INSERT INTO events
        (ts, session_id, runtime, worktree, kind, tool_name, outcome, issue_id, duration_ms, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Date.now(), sessionId, runtime, worktree, kind, toolName ?? null,
      outcome ?? null, issueId ?? null, durationMs ?? null, dataStr,
    );
  } catch {
    // Silently swallow all errors — logging never affects hook behavior
  } finally {
    try { db?.close(); } catch { /* fail-open */ }
  }
}
