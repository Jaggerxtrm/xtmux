import type { Migration } from "../schema.ts";

// xtmux-avz: store the full (uncompacted) last assistant message alongside the
// compact `summary` (which stays capped for badges/previews). Nullable on
// purpose: old rows and turns whose capture failed have no full text, and
// `summary` remains the always-present fallback for preview consumers.
export const migration: Migration = {
  version: 13,
  name: "agent_turns.last_message_text",
  up: `
    ALTER TABLE agent_turns ADD COLUMN last_message_text TEXT;
  `,
};
