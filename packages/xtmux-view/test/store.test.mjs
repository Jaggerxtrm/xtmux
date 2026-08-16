import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLatestEpisode, EPISODE_SELECT, episodeWhere, mapEpisode } from "../src/store.mjs";

// The store reads via bun:sqlite (the xtmux observability backend), so the
// end-to-end cases run under Bun and skip under plain node. The fixture DDL
// mirrors xtmux migrations 0004/0013/0014 (response episodes) — deliberately
// inline so this standalone package's tests never depend on core's migrations.
let Database = null;
try {
  ({ Database } = await import("bun:sqlite"));
} catch { /* plain node: skip the DB-backed cases */ }

const DDL = `
CREATE TABLE agent_instances (
  instance_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  pane_id TEXT NOT NULL,
  runtime TEXT
);
CREATE TABLE agent_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT,
  session_id TEXT NOT NULL,
  pane_id TEXT NOT NULL,
  bead_id TEXT,
  turn_index INTEGER,
  summary TEXT,
  completed_at_ms INTEGER NOT NULL,
  last_message_text TEXT,
  episode_id INTEGER
);
CREATE TABLE agent_episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT,
  session_id TEXT NOT NULL,
  pane_id TEXT NOT NULL,
  bead_id TEXT,
  source_cursor INTEGER,
  opened_at_ms INTEGER NOT NULL,
  closed_at_ms INTEGER
);
`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-view-"));
  const dbPath = join(dir, "observability.db");
  const db = new Database(dbPath);
  db.exec(DDL);
  db.exec(`
    INSERT INTO agent_instances (instance_id, session_id, pane_id, runtime)
      VALUES ('inst-1', '$1', '%9', 'claude');
    INSERT INTO agent_episodes (id, instance_id, session_id, pane_id, source_cursor, opened_at_ms, closed_at_ms)
      VALUES (1, 'inst-1', '$1', '%9', 10, 100, 200),
             (2, 'inst-1', '$1', '%9', 99, 300, NULL);
    INSERT INTO agent_turns (instance_id, session_id, pane_id, summary, completed_at_ms, last_message_text, episode_id)
      VALUES ('inst-1', '$1', '%9', 'old', 101, 'old answer', 1),
             ('inst-1', '$1', '%9', 'old 2', 102, 'old follow-up', 1),
             ('inst-1', '$1', '%9', 'ack', 301, 'Acknowledged.', 2),
             ('inst-1', '$1', '%9', 'main', 302, 'the diagram answer', 2);
  `);
  db.close();
  return { dir, dbPath };
}

test("EPISODE_SELECT targets panes and sessions, ordered newest first", () => {
  assert.match(EPISODE_SELECT, /FROM agent_episodes e/);
  assert.match(EPISODE_SELECT, /ORDER BY e\.id DESC/);
  assert.equal(episodeWhere("%9"), "e.pane_id = ?");
  assert.equal(episodeWhere("$1"), "e.session_id = ?");
});

test("mapEpisode normalizes rows into the episode.v1 record", () => {
  const mapped = mapEpisode(
    { episode_id: 2, pane_id: "%9", session_id: "$1", instance_id: "inst-1", bead_id: null, source_cursor: 99, opened_at_ms: 300, closed_at_ms: null },
    [{ turn_id: 3, turn_index: null, summary: "ack", last_message_text: "Acknowledged.", completed_at_ms: 301, runtime: "claude" }],
  );
  assert.equal(mapped.schemaVersion, "xtmux.view.episode.v1");
  assert.equal(mapped.episodeId, 2);
  assert.equal(mapped.sourceCursor, 99);
  assert.equal(mapped.closedAtMs, null);
  assert.deepEqual(mapped.candidates, [{
    turnId: 3, turnIndex: null, summary: "ack", lastMessageText: "Acknowledged.", completedAtMs: 301, runtime: "claude",
  }]);
});

test("readLatestEpisode returns the newest episode with its candidates in order", { skip: !Database }, async () => {
  const { dir, dbPath } = fixture();
  try {
    const episode = await readLatestEpisode("%9", { XTMUX_OBS_DB_PATH: dbPath });
    assert.ok(episode);
    assert.equal(episode.episodeId, 2);
    assert.equal(episode.closedAtMs, null);
    assert.deepEqual(episode.candidates.map((c) => c.summary), ["ack", "main"]);
    assert.equal(episode.candidates[0].runtime, "claude");
    // Session targets resolve the same episode.
    assert.equal((await readLatestEpisode("$1", { XTMUX_OBS_DB_PATH: dbPath })).episodeId, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readLatestEpisode returns null when the target has no episode", { skip: !Database }, async () => {
  const { dir, dbPath } = fixture();
  try {
    assert.equal(await readLatestEpisode("%999", { XTMUX_OBS_DB_PATH: dbPath }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readLatestEpisode degrades to the legacy latest row on a pre-episode schema", { skip: !Database }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-view-"));
  try {
    const dbPath = join(dir, "legacy.db");
    const db = new Database(dbPath);
    db.exec(DDL.replace(/CREATE TABLE agent_episodes[\s\S]*?\n\);\n/, ""));
    db.exec(`
      INSERT INTO agent_instances (instance_id, session_id, pane_id, runtime)
        VALUES ('inst-1', '$1', '%9', 'claude');
      INSERT INTO agent_turns (instance_id, session_id, pane_id, summary, completed_at_ms, last_message_text)
        VALUES ('inst-1', '$1', '%9', 'newer', 500, 'the newest answer'),
               ('inst-1', '$1', '%9', 'older', 400, 'an older answer');
    `);
    db.close();
    const episode = await readLatestEpisode("%9", { XTMUX_OBS_DB_PATH: dbPath });
    assert.ok(episode);
    assert.equal(episode.episodeId, null);
    assert.equal(episode.candidates.length, 1);
    assert.equal(episode.candidates[0].lastMessageText, "the newest answer");
    assert.equal(episode.schemaVersion, "xtmux.view.episode.v1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
