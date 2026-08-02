import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("current Codex state adapter replays captured startup and prompt payloads fail-open", () => {
    for (const file of ["session-start.json", "user-prompt-submit.json"]) {
      const { payload } = fixture(file);
      const state = file === "session-start.json" ? "idle" : "running";
      const result = spawnSync("bash", [stateScript, state], {
        cwd: root,
        encoding: "utf8",
        input: `${JSON.stringify(payload)}\n`,
        env: { ...process.env, TMUX: "", TMUX_PANE: "" },
      });
      expect(result.status).toBe(0);
    }
  });

  test("installer owns only its tagged Codex entries and leaves current gaps visible", () => {
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
    expect(owned("Stop")).toHaveLength(0);
    expect(owned("SessionEnd")).toHaveLength(0);
    expect(commands(installed.Stop)).toContain("foreign-stop");
    expect(existsSync(join(home, ".codex/hooks/xtmux/agent-state.sh"))).toBe(true);
    expect(existsSync(join(home, ".codex/hooks/xtmux/claude-agent-turn-capture.mjs"))).toBe(false);
  });
});
