import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";

const HOOK = join(import.meta.dir, "../../hooks/claude/claude-agent-turn-capture.mjs");

test("Claude Stop publishes one idempotent parent FYI and skips root panes", () => {
  const root = mkdtempSync(join(tmpdir(), "xtmux-claude-turn-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const transcript = join(root, "transcript.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n`);
  writeFileSync(join(bin, "tmux"), `#!/usr/bin/env bash
case "\${!#}" in
  '#{pane_id}') printf '%%child\\n' ;;
  '#{session_id}') printf '$child\\n' ;;
  '#S') printf 'child\\n' ;;
  '@agent_bead') printf 'xtmux-msg\\n' ;;
  '@agent_parent_session') printf '%s\\n' "\${MOCK_PARENT:-}" ;;
esac
`);
  writeFileSync(join(bin, "picker"), `#!/bin/sh
[ "$1" = log ] && exit 0
[ "$1" = message-send ] || exit 0
printf '%s\\n' "$*" >> '${join(root, "attempts")}'
key="" previous=""
for arg in "$@"; do [ "$previous" = --message-key ] && key="$arg"; previous="$arg"; done
touch '${join(root, "keys")}'
grep -Fqx "$key" '${join(root, "keys")}' && exit 0
printf '%s\\n' "$key" >> '${join(root, "keys")}'
printf '%s\\n' "$*" >> '${join(root, "messages")}'
`);
  chmodSync(join(bin, "tmux"), 0o755);
  chmodSync(join(bin, "picker"), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: root,
    TMUX: `${root}/tmux.sock,1,0`,
    TMUX_PANE: "%child",
    MOCK_PARENT: "$parent",
    XTMUX_PICKER: join(bin, "picker"),
  };
  const run = (overrides: NodeJS.ProcessEnv = {}) => spawnSync("node", [HOOK], {
    encoding: "utf8", env: { ...env, ...overrides }, input: JSON.stringify({ transcript_path: transcript }),
  });
  try {
    expect(run().status).toBe(0);
    expect(run().status).toBe(0);
    const messages = readFileSync(join(root, "messages"), "utf8").trim().split("\n");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("message-send --from $child --to $parent --bead xtmux-msg --expects-reply=false");
    expect(messages[0]).toContain("--text turn done: done");
    expect(messages[0]).toMatch(/--message-key claude-turn-[a-f0-9]+/);

    expect(run({ MOCK_PARENT: "" }).status).toBe(0);
    expect(readFileSync(join(root, "messages"), "utf8").trim().split("\n")).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
