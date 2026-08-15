import { appendFileSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { expect, test } from "bun:test";

const HOOK = join(import.meta.dir, "../../hooks/claude/claude-agent-turn-capture.mjs");
const PROMPT_HOOK = join(import.meta.dir, "../../hooks/claude/claude-user-prompt-episode.mjs");

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
for arg in "$@"; do [ "$previous" = --id ] && key="$arg"; previous="$arg"; done
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
    expect(messages[0]).toMatch(/--id claude-turn-[a-f0-9]+/);

    expect(run({ MOCK_PARENT: "" }).status).toBe(0);
    expect(readFileSync(join(root, "messages"), "utf8").trim().split("\n")).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stop fired mid-flush still captures the final assistant line", async () => {
  const root = mkdtempSync(join(tmpdir(), "xtmux-claude-turn-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const transcript = join(root, "transcript.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "older turn" }] } })}\n`);
  writeFileSync(join(bin, "tmux"), `#!/usr/bin/env bash
case "\${!#}" in
  '#{pane_id}') printf '%%child\\n' ;;
  '#{session_id}') printf '$child\\n' ;;
  '#S') printf 'child\\n' ;;
  '@agent_bead') printf '\\n' ;;
  '@agent_parent_session') printf '\\n' ;;
esac
`);
  writeFileSync(join(bin, "picker"), `#!/bin/sh
printf '%s\\n' "$*" >> '${join(root, "calls")}'
`);
  chmodSync(join(bin, "tmux"), 0o755);
  chmodSync(join(bin, "picker"), 0o755);
  const finalLine = `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "final answer" }] } })}\n`;
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: root,
    TMUX: `${root}/tmux.sock,1,0`,
    TMUX_PANE: "%child",
    XTMUX_PICKER: join(bin, "picker"),
    TRANSCRIPT: transcript,
    FINAL_LINE: finalLine,
  };
  // Stream the final line in 8-byte fragments every 10ms so the file keeps
  // growing across the hook's 25ms polls: the size-settled check cannot fire
  // early, and the assistant text advances once the line completes.
  const appender = spawn("node", ["-e", `
const fs = require("fs");
for (let i = 0; i < process.env.FINAL_LINE.length; i += 8) {
  fs.appendFileSync(process.env.TRANSCRIPT, process.env.FINAL_LINE.slice(i, i + 8));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
`], { env });
  try {
    // Let the first fragment land before the hook reads, so the file is
    // genuinely mid-flush when the hook starts polling.
    const seedSize = statSync(transcript).size;
    await new Promise<void>((resolve) => {
      const watch = setInterval(() => {
        if (statSync(transcript).size > seedSize || appender.exitCode !== null) {
          clearInterval(watch);
          resolve();
        }
      }, 5);
    });
    const run = spawnSync("node", [HOOK], { encoding: "utf8", env, input: JSON.stringify({ transcript_path: transcript }) });
    expect(run.status).toBe(0);
    await new Promise((resolve) => appender.on("close", resolve));
    const calls = readFileSync(join(root, "calls"), "utf8");
    const emit = calls.split("\n").find((l) => l.startsWith("log emit agent.turn.done"));
    expect(emit).toBeDefined();
    expect(emit).toContain("last_message=final answer");
    expect(emit).not.toContain("older turn");
  } finally {
    if (appender.exitCode === null) appender.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

// Stateful tmux mock: set-option appends name=value lines to a state file;
// show-options reads pending/cursor back from it. Everything else mirrors the
// plain mock above.
function statefulFixture(root: string): { bin: string; state: string } {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const state = join(root, "tmux-state");
  writeFileSync(join(bin, "tmux"), `#!/usr/bin/env bash
state="${state}"
case "$1" in
  set-option)
    printf '%s\\n' "$4=$5" >> "$state"
    exit 0
    ;;
esac
case "\${!#}" in
  '#{pane_id}') printf '%%child\\n' ;;
  '#{session_id}') printf '$child\\n' ;;
  '#S') printf 'child\\n' ;;
  '@agent_bead') printf 'xtmux-msg\\n' ;;
  '@agent_parent_session') printf '%s\\n' "\${MOCK_PARENT:-}" ;;
  '@agent_episode_pending') grep -Fqx '@agent_episode_pending=1' "$state" && printf '1\\n' ;;
  '@agent_episode_cursor') v="$(grep -F '@agent_episode_cursor=' "$state" | tail -1)"; printf '%s\\n' "\${v#*=}" ;;
  *) : ;;
esac
`);
  chmodSync(join(bin, "tmux"), 0o755);
  return { bin, state };
}

function recordingPicker(root: string): string {
  const picker = join(root, "bin", "picker");
  writeFileSync(picker, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(root, "calls")}'\n`);
  chmodSync(picker, 0o755);
  return picker;
}

test("Stop payload last_assistant_message wins over a missing transcript", () => {
  const root = mkdtempSync(join(tmpdir(), "xtmux-claude-turn-"));
  try {
    const { bin } = statefulFixture(root);
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: root,
      TMUX: `${root}/tmux.sock,1,0`,
      TMUX_PANE: "%child",
      XTMUX_PICKER: recordingPicker(root),
    };
    const run = spawnSync("node", [HOOK], {
      encoding: "utf8", env,
      input: JSON.stringify({ transcript_path: join(root, "missing.jsonl"), last_assistant_message: "fresh answer" }),
    });
    expect(run.status).toBe(0);
    const calls = readFileSync(join(root, "calls"), "utf8");
    const emit = calls.split("\n").find((l) => l.startsWith("log emit agent.turn.done"));
    expect(emit).toBeDefined();
    expect(emit).toContain("last_message=fresh answer");
    expect(emit).toContain("episode_open=1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stop hook reports episode_open: continuation and prompt-armed stops attach, plain stops open", () => {
  const root = mkdtempSync(join(tmpdir(), "xtmux-claude-turn-"));
  try {
    const { bin, state } = statefulFixture(root);
    const transcript = join(root, "transcript.jsonl");
    writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } })}\n`);
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: root,
      TMUX: `${root}/tmux.sock,1,0`,
      TMUX_PANE: "%child",
      XTMUX_PICKER: recordingPicker(root),
    };
    const run = (input: Record<string, unknown>) => spawnSync("node", [HOOK], {
      encoding: "utf8", env, input: JSON.stringify({ transcript_path: transcript, ...input }),
    });

    // Plain stop with no armed prompt: opens a fresh episode.
    expect(run({}).status).toBe(0);
    // stop_hook_active continuation: attaches.
    expect(run({ stop_hook_active: true }).status).toBe(0);
    // Prompt armed by UserPromptSubmit hook: the episode is already open.
    writeFileSync(state, "@agent_episode_pending=1\n");
    expect(run({}).status).toBe(0);

    const emits = readFileSync(join(root, "calls"), "utf8")
      .split("\n")
      .filter((l) => l.startsWith("log emit agent.turn.done"));
    expect(emits.map((l) => /episode_open=(\d)/.exec(l)?.[1])).toEqual(["1", "0", "0"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("UserPromptSubmit hook opens an episode, records the settled cursor, and arms pending", () => {
  const root = mkdtempSync(join(tmpdir(), "xtmux-claude-turn-"));
  try {
    const { bin, state } = statefulFixture(root);
    const transcript = join(root, "transcript.jsonl");
    const seed = `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "do the thing" }] } })}\n`;
    writeFileSync(transcript, seed);
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: root,
      TMUX: `${root}/tmux.sock,1,0`,
      TMUX_PANE: "%child",
      XTMUX_PICKER: recordingPicker(root),
    };
    const run = spawnSync("node", [PROMPT_HOOK], {
      encoding: "utf8", env, input: JSON.stringify({ transcript_path: transcript }),
    });
    expect(run.status).toBe(0);
    const calls = readFileSync(join(root, "calls"), "utf8");
    const emit = calls.split("\n").find((l) => l.startsWith("log emit agent.episode.open"));
    expect(emit).toBeDefined();
    expect(emit).toContain(`pane=%child session=$child session_name=child bead=xtmux-msg`);
    expect(emit).toContain(`cursor=${Buffer.byteLength(seed)}`);
    const stateLines = readFileSync(state, "utf8");
    expect(stateLines).toContain(`@agent_episode_pending=1`);
    expect(stateLines).toContain(`@agent_episode_cursor=${Buffer.byteLength(seed)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fallback read correlates only source after the episode cursor", () => {
  const root = mkdtempSync(join(tmpdir(), "xtmux-claude-turn-"));
  try {
    const { bin, state } = statefulFixture(root);
    const oldLine = `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "previous episode" }] } })}\n`;
    const transcript = join(root, "transcript.jsonl");
    writeFileSync(transcript, oldLine);
    // The cursor sits at the END of the previous episode's line: the fallback
    // must not report it as this stop's text.
    writeFileSync(state, `@agent_episode_cursor=${Buffer.byteLength(oldLine)}\n`);
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: root,
      TMUX: `${root}/tmux.sock,1,0`,
      TMUX_PANE: "%child",
      XTMUX_PICKER: recordingPicker(root),
    };
    const run = (input: Record<string, unknown>) => spawnSync("node", [HOOK], {
      encoding: "utf8", env, input: JSON.stringify({ transcript_path: transcript, ...input }),
    });

    expect(run({}).status).toBe(0);
    const newLine = `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "this episode" }] } })}\n`;
    appendFileSync(transcript, newLine);
    expect(run({}).status).toBe(0);

    const emits = readFileSync(join(root, "calls"), "utf8")
      .split("\n")
      .filter((l) => l.startsWith("log emit agent.turn.done"));
    expect(emits).toHaveLength(2);
    // First stop: nothing after the cursor → metadata-only row (no stale text).
    expect(emits[0]).toContain("last_message= last_message_file=");
    expect(emits[0]).not.toContain("previous episode");
    // Second stop: the new line is after the cursor → captured.
    expect(emits[1]).toContain("last_message=this episode");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
