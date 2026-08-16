import type { Migration } from "../schema.ts";

// xtmux-gdk review P2: replay idempotence for agent_turns candidates. The
// parent-FYI message key already dedupes the notification, but each
// `agent.turn.done` delivery inserted its own candidate row. The Claude Stop
// hook now emits `source_key` = sha256(session_id\0transcript_path\0
// transcript_size\0text): an exact Stop replay reproduces the identical key
// (one candidate), while identical text at a distinct source position — a
// larger settled transcript — produces a different key (two legitimate
// candidates). Rows without a key (pi/codex adapters, pre-0015 rows) are not
// constrained.
export const migration: Migration = {
  version: 15,
  name: "agent_turns.source_key (replay dedupe)",
  up: `
    ALTER TABLE agent_turns ADD COLUMN source_key TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS at_source_key
      ON agent_turns(source_key) WHERE source_key IS NOT NULL;
  `,
};
