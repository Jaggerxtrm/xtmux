import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const installer = join(root, "scripts/install.mjs");
const stateScript = join(root, "scripts/agent-state.sh");
const fixtureRoot = join(root, "tests/fixtures/codex/0.146.0");
const homes: string[] = [];

function fixture(name: string): { fixture: Record<string, unknown>; payload: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(fixtureRoot, name), "utf8"));
}

function runInstaller(home: string, ...args: string[]) {
  return spawnSync(process.execPath, [installer, "--home", home, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_RUNTIME_DIR: join(home, "runtime"),
      TMPDIR: join(home, "tmp"),
    },
  });
}

function hooks(home: string): Record<string, any[]> {
  return JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8")).hooks;
}

function commands(entries: any[] = []): string[] {
  return entries.flatMap((entry) => entry.hooks?.map((hook: any) => hook.command) ?? []);
}

function tmuxStub(home: string): string {
  const dir = join(home, "bin");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "tmux");
  writeFileSync(script, `#!/usr/bin/env bash
set -euo pipefail
state_file="${"${XTMUX_TEST_TMUX_STATE}"}"
args=("$@")
case "${"${args[0]}"}" in
  display-message)
    [ "${"${args[${#args[@]} - 1]}"}" = "#S" ] && printf 'fixture-session\\n' || printf '%%1\\n'
    ;;
  show-options)
    case "${"${args[${#args[@]} - 1]}"}" in
      @agent_state) [ -f "$state_file" ] && cat "$state_file" || true ;;
      *) true ;;
    esac
    ;;
  set-option)
    option="${"${args[${#args[@]} - 2]}"}"
    value="${"${args[${#args[@]} - 1]}"}"
    [ "$option" = "@agent_state" ] && printf '%s\\n' "$value" > "$state_file"
    ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
  chmodSync(script, 0o700);
  return dir;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("Codex 0.146.0 characterization fixtures", () => {
  test("fixtures are versioned, redacted, and preserve captured event shapes", () => {
    const files = ["session-start.json", "user-prompt-submit.json", "session-end.json", "stop-reference.json"];
    for (const file of files) {
      const { fixture: metadata, payload } = fixture(file);
      expect(metadata.codex_version).toBe("0.146.0");
      expect(metadata.capture_provenance).toBeDefined();
      expect(metadata.redactions).toBeInstanceOf(Array);
      expect(payload.hook_event_name).toBe(metadata.event);
      expect(payload.session_id).toBe("<SESSION_ID>");
      expect(payload.cwd).toBe("<WORKTREE>");
      expect([null, "<TRANSCRIPT_PATH>"]).toContain(payload.transcript_path as string | null);
    }

    const prompt = fixture("user-prompt-submit.json").payload;
    expect(prompt.prompt).toBe("<REDACTED_PROMPT>");
    expect(prompt.turn_id).toBe("<TURN_ID>");

    const stop = fixture("stop-reference.json").payload;
    expect(stop.stop_hook_active).toBe(false);
    expect(stop.last_assistant_message).toBe("<REDACTED_MESSAGE>");
  });

  test("current Codex state commands execute with captured payload fixtures in a stubbed tmux context", () => {
    const home = mkdtempSync(join(tmpdir(), "xtmux-codex-state-replay-"));
    homes.push(home);
    const stateFile = join(home, "state");
    const eventLog = join(home, "events.jsonl");
    const stubPath = tmuxStub(home);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      PATH: `${stubPath}:${process.env.PATH ?? ""}`,
      TMUX: "fixture-socket",
      TMUX_PANE: "%1",
      XDG_STATE_HOME: join(home, ".local", "state"),
      XTMUX_EVENT_LOG_FILE: eventLog,
      XTMUX_HOST_ID_FILE: join(home, "host-id"),
      XTMUX_OBS_V2: "0",
      XTMUX_TEST_TMUX_STATE: stateFile,
    };
    delete env.CLAUDE_HOOK_EVENT;
    delete env.PI_HOOK_EVENT;
    expect(env.CLAUDE_HOOK_EVENT).toBeUndefined();
    expect(env.PI_HOOK_EVENT).toBeUndefined();

    for (const [file, args, state] of [
      ["session-start.json", ["idle", "--new-instance"], "idle"],
      ["user-prompt-submit.json", ["running"], "running"],
    ] as const) {
      const { payload } = fixture(file);
      const result = spawnSync("bash", [stateScript, ...args], {
        cwd: root,
        encoding: "utf8",
        input: `${JSON.stringify(payload)}\n`,
        env,
      });
      expect(result.status).toBe(0);
      expect(readFileSync(stateFile, "utf8").trim()).toBe(state);
      const events = readFileSync(eventLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(events.at(-1).state).toBe(state);
      // The current Codex commands pass state via argv and do not propagate
      // hook_event_name into the script environment.
      expect(events.at(-1).event).toBe("");
    }
  });

  test("installer owns only its tagged Codex entries and preserves foreign ones", () => {
    const home = mkdtempSync(join(tmpdir(), "xtmux-codex-characterization-"));
    homes.push(home);
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "hooks.json"), JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "foreign-start" }] }],
        Stop: [{ hooks: [{ type: "command", command: "foreign-stop" }] }],
      },
    }));

    const result = runInstaller(home);
    expect(result.status).toBe(0);
    const installed = hooks(home);
    const owned = (event: string) => (installed[event] ?? []).filter((entry) => entry._source === "xtmux");

    expect(owned("SessionStart")).toHaveLength(1);
    expect(owned("SessionStart")[0].matcher).toBe("startup|resume|clear");
    expect(commands(owned("SessionStart"))[0]).toMatch(/agent-state\.sh" idle --new-instance$/);
    expect(owned("UserPromptSubmit")).toHaveLength(1);
    expect(commands(owned("UserPromptSubmit"))[0]).toMatch(/agent-state\.sh" running$/);
    // K3 (xtmux-s96.2) closed the Stop/SessionEnd gaps: the installer now owns
    // done + turn capture on Stop and off on SessionEnd. K4 (xtmux-s96.4)
    // appended the inbox/obligation entry, so Stop carries three.
    expect(owned("Stop")).toHaveLength(3);
    expect(commands(owned("Stop")).some((command) => /agent-state\.sh" done$/.test(command))).toBe(true);
    expect(commands(owned("Stop")).some((command) => /codex-agent-turn-capture\.mjs"$/.test(command))).toBe(true);
    expect(commands(owned("Stop")).some((command) => /codex-inbox-reply-stop\.mjs"$/.test(command))).toBe(true);
    expect(owned("SessionEnd")).toHaveLength(1);
    expect(commands(owned("SessionEnd"))[0]).toMatch(/agent-state\.sh" off$/);
    expect(commands(installed.Stop)).toContain("foreign-stop");
    expect(existsSync(join(home, ".codex/hooks/xtmux/agent-state.sh"))).toBe(true);
    expect(existsSync(join(home, ".codex/hooks/xtmux/codex-agent-turn-capture.mjs"))).toBe(true);
    expect(existsSync(join(home, ".codex/hooks/xtmux/codex-inbox-reply-stop.mjs"))).toBe(true);
    expect(existsSync(join(home, ".codex/hooks/xtmux/claude-agent-turn-capture.mjs"))).toBe(false);
  });
});
