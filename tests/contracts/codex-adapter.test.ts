// K3-xtmux Codex runtime adapter (xtmux-s96.2).
//
// Covers the evidence required by the KAN-127 K3-xtmux contract:
//   - Codex 0.146.0 Stop/SessionEnd fire through the installed hooks.json;
//   - start/running/done/off/degraded model over the EXISTING lifecycle
//     authority (agent-state.sh pane options + agent_state_transitions);
//   - Stop.last_assistant_message is required but nullable (string | null) and
//     is captured DIRECTLY from the payload (no Claude-style transcript scan);
//   - Core K2 outcomes (xtrm.command-outcome.v1) are consumed as structured
//     data with exact argv next_actions; hostile metadata is rejected;
//   - replay, duplicate delivery, restart reconstruction, identity
//     correlation, turn capture, and recovery participation;
//   - negative proof that no second authority (Codex-specific store/table)
//     was introduced.
//
// Everything runs against a deterministic tmux stub plus a picker wrapper that
// execs the real CLI (bun src/cli.ts) against an isolated SQLite db, so the
// durable assertions exercise the production write path end to end.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const installer = join(root, "scripts/install.mjs");
const turnCaptureHook = join(root, "hooks/codex/codex-agent-turn-capture.mjs");
const codexFixtureRoot = join(root, "tests/fixtures/codex/0.146.0");
const outcomeFixtureRoot = join(root, "tests/fixtures/command-outcome");
const PANE = "%3";
const SESSION = "$7";
const SESSION_NAME = "codex-k3";
const BEAD = "xtmux-s96.2";
const PARENT = "$2";

const homes: string[] = [];

function fixture(path: string): { fixture: Record<string, any>; payload: Record<string, any> } {
  return JSON.parse(readFileSync(path, "utf8"));
}

function codexPayload(name: string, over: Record<string, unknown> = {}): Record<string, any> {
  return { ...fixture(join(codexFixtureRoot, name)).payload, ...over };
}

function outcomePayload(schemaDir: string, name: string): Record<string, any> {
  return fixture(join(outcomeFixtureRoot, schemaDir, name)).payload;
}

interface Env {
  home: string;
  dbPath: string;
  stateFile: string;
  eventLog: string;
  env: NodeJS.ProcessEnv;
}

// Deterministic tmux stub + a picker/xtmux wrapper that execs the real CLI.
// The wrapper maps the space-form verbs hooks use ("log emit") to the kebab
// CLI commands ("log-emit") exactly like bin/tmux-session-picker does.
function setupPane(): Env {
  // Warm the bun TS/module cache once so the per-hook CLI spawns inside the
  // wired sequence stay under agent-state.sh's production 2s emit cap.
  spawnSync("bun", [join(root, "src/cli.ts"), "version"], { encoding: "utf8" });
  const home = mkdtempSync(join(tmpdir(), "xtmux-codex-adapter-"));
  homes.push(home);
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const stateFile = join(home, "pane-state");
  const optionsFile = join(home, "pane-options.json");
  writeFileSync(optionsFile, JSON.stringify({ "@agent_bead": BEAD, "@agent_parent_session": PARENT }));
  const eventLog = join(home, "events.jsonl");
  const dbPath = join(home, "state", "xtmux", "observability.db");

  writeFileSync(join(bin, "tmux"), `#!/usr/bin/env bash
set -euo pipefail
state_file="${stateFile}"
options_file="${optionsFile}"
session_id='${SESSION}'
session_name='${SESSION_NAME}'
pane_id='${PANE}'
args=("$@")
case "\${args[0]}" in
  display-message)
    fmt="\${args[\${#args[@]} - 1]}"
    case "$fmt" in
      '#S') printf '%s\\n' "$session_name" ;;
      '#{session_id}') printf '%s\\n' "$session_id" ;;
      '#{pane_id}') printf '%s\\n' "$pane_id" ;;
      *) printf '\\n' ;;
    esac
    ;;
  show-options)
    opt="\${args[\${#args[@]} - 1]}"
    if [ "$opt" = "@agent_state" ]; then
      [ -f "$state_file" ] && cat "$state_file" || true
    elif [ -f "$options_file" ]; then
      node -e 'const o=require(process.argv[1]);const v=o[process.argv[2]];if(v!==undefined)process.stdout.write(v)' "$options_file" "$opt" 2>/dev/null || true
    fi
    ;;
  set-option)
    opt="\${args[\${#args[@]} - 2]}"
    value="\${args[\${#args[@]} - 1]}"
    if [ "$opt" = "@agent_state" ]; then
      printf '%s\\n' "$value" > "$state_file"
    else
      node -e 'const fs=require("fs");const f=process.argv[1];const o=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{};o[process.argv[2]]=process.argv[3];fs.writeFileSync(f,JSON.stringify(o))' "$options_file" "$opt" "$value" 2>/dev/null || true
    fi
    ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });

  // One wrapper serves both as XTMUX_PICKER (hooks call "log emit",
  // "message-send") and as the `xtmux` binary on PATH (agent-state.sh calls
  // "xtmux log emit"). It forwards env, so XTMUX_OBS_DB_PATH reaches the CLI.
  const wrapper = join(bin, "xtmux-real");
  writeFileSync(wrapper, `#!/usr/bin/env bash
cli="${root}/src/cli.ts"
if [ "$1" = "log" ]; then
  shift
  sub="$1"; shift
  exec bun "$cli" "log-$sub" "$@"
fi
exec bun "$cli" "$@"
`, { mode: 0o755 });
  chmodSync(wrapper, 0o755);
  // symlinks would need ln; plain copies keep the stub self-contained.
  writeFileSync(join(bin, "xtmux"), readFileSync(wrapper), { mode: 0o755 });
  writeFileSync(join(bin, "picker"), readFileSync(wrapper), { mode: 0o755 });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TMUX: `${home}/tmux.sock,1,0`,
    TMUX_PANE: PANE,
    XDG_STATE_HOME: join(home, "state"),
    XTMUX_EVENT_LOG_FILE: eventLog,
    XTMUX_HOST_ID_FILE: join(home, "host-id"),
    XTMUX_OBS_DB_PATH: dbPath,
    XTMUX_OBS_V2: "1",
    XTMUX_PICKER: join(bin, "picker"),
  };
  delete env.CLAUDE_HOOK_EVENT;
  delete env.PI_HOOK_EVENT;
  delete env.CODEX_HOOK_EVENT;
  // Deterministic delegation metadata: the orchestrator launches a Codex agent
  // with exactly these env vars, SessionStart binds them to the pane, and turn
  // capture reads them back. Ambient XTMUX_AGENT_* leaks (e.g. an empty
  // XTMUX_AGENT_PARENT_SESSION) would legitimately overwrite the binding, so
  // the suite controls every one of them.
  env.XTMUX_AGENT_BEAD = BEAD;
  env.XTMUX_AGENT_PARENT_SESSION = PARENT;
  delete env.XTMUX_AGENT_TASK;
  delete env.XTMUX_AGENT_ROLE;
  delete env.XTMUX_AGENT_PROMPT_FILE;
  return { home, dbPath, stateFile, eventLog, env };
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

function installCodexHome(home?: string): { home: string; hooks: Record<string, any[]> } {
  home ??= mkdtempSync(join(tmpdir(), "xtmux-codex-install-"));
  homes.push(home);
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "hooks.json"), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "foreign-stop" }] }] },
  }));
  const result = runInstaller(home);
  expect(result.status).toBe(0);
  const hooks = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8")).hooks;
  return { home, hooks };
}

// Execute every xtmux-owned hook command of one Codex event with the payload
// on stdin, exactly as the Codex CLI would run it. Foreign (untagged) entries
// are out of contract: they execute in production but never belong to this
// adapter's evidence.
function fireCodexEvent(ctx: Env, hooks: Record<string, any[]>, event: string, payload: Record<string, unknown>): void {
  for (const entry of (hooks[event] ?? []).filter((e) => e._source === "xtmux")) {
    for (const hook of entry.hooks ?? []) {
      const result = spawnSync("bash", ["-c", hook.command], {
        cwd: root,
        encoding: "utf8",
        input: `${JSON.stringify(payload)}\n`,
        env: ctx.env,
      });
      // Hooks are fail-open by contract: a lifecycle hook must never fail a
      // Codex turn.
      expect(result.status, `hook failed: ${hook.command}\n${result.stderr}`).toBe(0);
    }
  }
}

function eventLogRows(ctx: Env): any[] {
  if (!existsSync(ctx.eventLog)) return [];
  return readFileSync(ctx.eventLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function sql(ctx: Env): any[] {
  const result = spawnSync("bun", [join(root, "src/cli.ts"), "log-query", "--json", "--limit", "500"], {
    encoding: "utf8",
    env: { ...ctx.env },
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout || "[]");
}

function dbRows(ctx: Env, query: string): any[] {
  // The store is created lazily by the CLI: an absent db file means no writes
  // happened, which is itself an assertion outcome.
  if (!existsSync(ctx.dbPath)) return [];
  // Direct SQLite read through bun:sqlite keeps assertions independent of the
  // CLI surface under test.
  const script = `
import { Database } from "bun:sqlite";
const db = new Database(${JSON.stringify(ctx.dbPath)}, { readonly: true });
console.log(JSON.stringify(db.query(${JSON.stringify(query)}).all()));
`;
  const result = spawnSync("bun", ["-e", script], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim() || "[]");
}

function tableNames(ctx: Env): string[] {
  return dbRows(ctx, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((r) => r.name);
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("Codex turn capture hook (Stop)", () => {
  test("captures last_assistant_message directly; never reads the transcript", () => {
    const ctx = setupPane();
    // Decoy transcript with DIFFERENT text: if the hook ported the Claude
    // tail-scan it would capture "decoy text" instead of the payload message.
    const decoy = join(ctx.home, "decoy-transcript.jsonl");
    writeFileSync(decoy, `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "decoy text" }] } })}\n`);
    const payload = codexPayload("stop-reference.json", {
      last_assistant_message: "verified stop turn text",
      transcript_path: decoy,
    });
    const result = spawnSync("node", [turnCaptureHook], { encoding: "utf8", input: JSON.stringify(payload), env: ctx.env });
    expect(result.status).toBe(0);

    const turns = dbRows(ctx, "SELECT pane_id, session_id, bead_id, parent_session_id, summary, last_message_text FROM agent_turns");
    expect(turns).toHaveLength(1);
    expect(turns[0].pane_id).toBe(PANE);
    expect(turns[0].session_id).toBe(SESSION);
    expect(turns[0].bead_id).toBe(BEAD);
    expect(turns[0].parent_session_id).toBe(PARENT);
    expect(turns[0].summary).toBe("verified stop turn text");
    expect(turns[0].last_message_text).toBe("verified stop turn text");
  });

  test("last_assistant_message is required but nullable: null emits a metadata-only turn", () => {
    const ctx = setupPane();
    const payload = codexPayload("stop-null-message.json");
    expect(payload.last_assistant_message).toBeNull();
    const result = spawnSync("node", [turnCaptureHook], { encoding: "utf8", input: JSON.stringify(payload), env: ctx.env });
    expect(result.status).toBe(0);
    const turns = dbRows(ctx, "SELECT summary, last_message_text FROM agent_turns");
    expect(turns).toHaveLength(1);
    expect(turns[0].last_message_text).toBeNull();
  });

  test("hostile metadata: lying hook_event_name and non-string message are rejected as data", () => {
    const ctx = setupPane();
    const payload = codexPayload("stop-hostile.json");
    const result = spawnSync("node", [turnCaptureHook], { encoding: "utf8", input: JSON.stringify(payload), env: ctx.env });
    expect(result.status).toBe(0); // fail-open, never fail a turn
    const turns = dbRows(ctx, "SELECT COUNT(*) AS n FROM agent_turns");
    expect(turns[0]?.n ?? 0).toBe(0);
    const messages = dbRows(ctx, "SELECT COUNT(*) AS n FROM messages");
    expect(messages[0]?.n ?? 0).toBe(0);
  });

  test("duplicate Stop delivery sends exactly one parent FYI (idempotent message key)", () => {
    const ctx = setupPane();
    const payload = codexPayload("stop-reference.json", { last_assistant_message: "dup turn" });
    for (let i = 0; i < 2; i += 1) {
      const result = spawnSync("node", [turnCaptureHook], { encoding: "utf8", input: JSON.stringify(payload), env: ctx.env });
      expect(result.status).toBe(0);
    }
    const messages = dbRows(ctx, "SELECT message_key, sender_id, recipient_id, summary, expects_reply FROM messages");
    expect(messages).toHaveLength(1);
    expect(messages[0].recipient_id).toBe(PARENT);
    expect(messages[0].expects_reply).toBe(0);
    expect(messages[0].message_key).toMatch(/^codex-turn-[a-f0-9]+$/);
    expect(messages[0].summary).toContain("turn done:");
  });

  test("FYI dedupe key is independent of tmux session identity (tmux restart)", () => {
    const ctx = setupPane();
    const payload = codexPayload("stop-reference.json", {
      last_assistant_message: "restart turn",
      session_id: "0192a17e-c0de-7000-8000-000000000001",
      turn_id: "turn-0001",
    });
    const run = () => {
      const result = spawnSync("node", [turnCaptureHook], { encoding: "utf8", input: JSON.stringify(payload), env: ctx.env });
      expect(result.status).toBe(0);
    };
    run();
    expect(dbRows(ctx, "SELECT COUNT(*) AS n FROM messages")[0].n).toBe(1);
    // Simulate a tmux server restart: the same Codex session resumes under a
    // DIFFERENT tmux session id. The message key derives only from Codex
    // session_id + turn_id + text, so the replayed Stop still dedupes.
    const stub = join(ctx.home, "bin", "tmux");
    writeFileSync(stub, readFileSync(stub, "utf8").replace(`session_id='${SESSION}'`, "session_id='$9'"), { mode: 0o755 });
    run();
    const messages = dbRows(ctx, "SELECT message_key, sender_id FROM messages");
    expect(messages).toHaveLength(1);
    expect(messages[0].message_key).toMatch(/^codex-turn-[a-f0-9]+$/);
  });

  test("no tmux client context: hook exits silently without writes", () => {
    const ctx = setupPane();
    const env = { ...ctx.env };
    delete env.TMUX;
    const payload = codexPayload("stop-reference.json", { last_assistant_message: "no tmux" });
    const result = spawnSync("node", [turnCaptureHook], { encoding: "utf8", input: JSON.stringify(payload), env });
    expect(result.status).toBe(0);
    expect(existsSync(ctx.dbPath)).toBe(false);
  });
});

describe("installed Codex lifecycle wiring (hooks.json -> existing authority)", () => {
  test("installer writes tagged Stop and SessionEnd entries and deploys the turn-capture hook", () => {
    const { home, hooks } = installCodexHome();
    const owned = (event: string) => (hooks[event] ?? []).filter((e) => e._source === "xtmux");
    expect(owned("Stop")).toHaveLength(2);
    expect(owned("SessionEnd")).toHaveLength(1);
    const stopCommands = owned("Stop").flatMap((e) => e.hooks.map((h: any) => h.command));
    expect(stopCommands.some((c: string) => /agent-state\.sh" done$/.test(c))).toBe(true);
    expect(stopCommands.some((c: string) => /codex-agent-turn-capture\.mjs"$/.test(c))).toBe(true);
    expect(owned("SessionEnd").flatMap((e) => e.hooks.map((h: any) => h.command)).join(" ")).toMatch(/agent-state\.sh" off$/);
    // Every state command carries the Codex hook event for durable attribution.
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]) {
      for (const command of owned(event).flatMap((e) => e.hooks.map((h: any) => h.command))) {
        if (command.includes("agent-state.sh")) expect(command).toContain(`CODEX_HOOK_EVENT=${event}`);
      }
    }
    // Foreign entries survive; ownership stays tag-based.
    expect((hooks.Stop ?? []).some((e: any) => e.hooks?.[0]?.command === "foreign-stop")).toBe(true);
    expect(existsSync(join(home, ".codex/hooks/xtmux/agent-state.sh"))).toBe(true);
    expect(existsSync(join(home, ".codex/hooks/xtmux/codex-agent-turn-capture.mjs"))).toBe(true);
    expect(existsSync(join(home, ".codex/hooks/xtmux/claude-agent-turn-capture.mjs"))).toBe(false);
  });

  test("uninstall removes only tagged Codex entries and the managed directory", () => {
    const { home } = installCodexHome();
    const result = runInstaller(home, "--uninstall");
    expect(result.status).toBe(0);
    const hooks = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8")).hooks;
    expect(hooks.SessionStart).toBeUndefined();
    expect(hooks.UserPromptSubmit).toBeUndefined();
    expect(hooks.SessionEnd).toBeUndefined();
    expect(hooks.Stop.map((e: any) => e.hooks[0].command)).toEqual(["foreign-stop"]);
    expect(existsSync(join(home, ".codex/hooks/xtmux"))).toBe(false);
  });

  test("full lifecycle replay: start/running/done/off through one authority, idempotent FYI", () => {
    const ctx = setupPane();
    // Install into the SAME home the hooks execute under: agent-state.sh
    // resolves xtmux-host-id.sh through the ~/.tmux/scripts compatibility
    // links the installer writes.
    const { hooks } = installCodexHome(ctx.home);
    const sequence = [
      ["SessionStart", codexPayload("session-start.json")],
      ["UserPromptSubmit", codexPayload("user-prompt-submit.json")],
      ["Stop", codexPayload("stop-reference.json", { last_assistant_message: "lifecycle turn" })],
      ["SessionEnd", codexPayload("session-end.json")],
    ] as const;

    for (const [event, payload] of sequence) fireCodexEvent(ctx, hooks, event, payload);

    expect(readFileSync(ctx.stateFile, "utf8").trim()).toBe("off");
    // V1 journal carries the Codex hook event attribution end to end.
    const events = eventLogRows(ctx);
    const states = events.filter((e) => e.type === "agent.state").map((e) => [e.state, e.event]);
    expect(states).toEqual([
      ["idle", "SessionStart"],
      ["running", "UserPromptSubmit"],
      ["done", "Stop"],
      ["off", "SessionEnd"],
    ]);

    // Durable lifecycle authority: one instance minted at start, closed at off.
    const instances = dbRows(ctx, "SELECT instance_id, runtime, ended_at_ms, end_reason, last_state FROM agent_instances");
    expect(instances).toHaveLength(1);
    expect(instances[0].runtime).toBe("codex");
    expect(instances[0].end_reason).toBe("state_off");
    expect(instances[0].last_state).toBe("off");

    // Turn capture correlated to the minted instance (identity correlation).
    const turns = dbRows(ctx, "SELECT instance_id, summary, last_message_text FROM agent_turns");
    expect(turns).toHaveLength(1);
    expect(turns[0].instance_id).toBe(instances[0].instance_id);
    expect(turns[0].last_message_text).toBe("lifecycle turn");

    // Exactly one parent FYI despite Stop firing turn capture.
    const messages = dbRows(ctx, "SELECT message_key FROM messages");
    expect(messages).toHaveLength(1);

    // Duplicate delivery: re-fire Stop with the identical payload. The message
    // key dedupes; the turn row repeats exactly like Claude/Pi turn rows do.
    fireCodexEvent(ctx, hooks, "Stop", sequence[2][1]);
    expect(dbRows(ctx, "SELECT COUNT(*) AS n FROM messages")[0].n).toBe(1);

    // Restart reconstruction: pane options vanished with the tmux server; a
    // `resume` SessionStart mints a fresh occupation over the same pane and
    // the durable history stays reconstructable from the journal.
    rmSync(ctx.stateFile, { force: true });
    fireCodexEvent(ctx, hooks, "SessionStart", codexPayload("session-start.json", { source: "resume" }));
    expect(readFileSync(ctx.stateFile, "utf8").trim()).toBe("idle");
    const afterRestart = dbRows(ctx, "SELECT instance_id FROM agent_instances ORDER BY started_at_ms");
    expect(afterRestart).toHaveLength(2);
    expect(afterRestart[1].instance_id).not.toBe(afterRestart[0].instance_id);
    const journal = sql(ctx);
    const ready = journal.filter((r) => r.type === "agent.ready");
    expect(ready.length).toBe(2);
    const types = journal.map((r) => r.type);
    expect(types).toContain("agents.state.done");
    expect(types).toContain("agents.state.off");
    expect(types).toContain("agents.instance.end.state_off");
    expect(types).toContain("agents.turn.done");
  }, 120_000);

  test("hostile Stop payload still transitions done but captures no turn", () => {
    const ctx = setupPane();
    const { hooks } = installCodexHome(ctx.home);
    fireCodexEvent(ctx, hooks, "SessionStart", codexPayload("session-start.json"));
    fireCodexEvent(ctx, hooks, "Stop", codexPayload("stop-hostile.json"));
    expect(readFileSync(ctx.stateFile, "utf8").trim()).toBe("done");
    expect(dbRows(ctx, "SELECT COUNT(*) AS n FROM agent_turns")[0]?.n ?? 0).toBe(0);
    expect(dbRows(ctx, "SELECT COUNT(*) AS n FROM messages")[0]?.n ?? 0).toBe(0);
  }, 120_000);
});

describe("Core K2 outcome consumption (xtrm.command-outcome.v1)", () => {
  function applyOutcome(ctx: Env, payload: unknown): { status: number | null; stdout: string; stderr: string } {
    return spawnSync("bun", [join(root, "src/cli.ts"), "outcome-apply"], {
      encoding: "utf8",
      input: JSON.stringify(payload),
      env: ctx.env,
    });
  }

  test("degraded outcome records one degraded lifecycle fact correlated to the pane", () => {
    const ctx = setupPane();
    // Create+migrate the store once so the before/after table snapshots prove
    // the consumer added no authority of its own.
    expect(spawnSync("bun", [join(root, "src/cli.ts"), "log-tail", "0"], { encoding: "utf8", env: ctx.env }).status).toBe(0);
    const before = tableNames(ctx);
    const payload = outcomePayload("xtrm.command-outcome.v1", "degraded-launch.json");
    const result = applyOutcome(ctx, payload);
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.schemaVersion).toBe("xtrm.command-outcome.v1");
    expect(parsed.status).toBe("degraded");
    expect(parsed.paneId).toBe(PANE);
    expect(parsed.sessionId).toBe(SESSION);
    expect(parsed.appliedState).toBe("degraded");
    expect(parsed.duplicate).toBe(false);
    // Exact argv pass-through: the consumer never rewrites or parses prose.
    expect(parsed.nextActions).toEqual(payload.next_actions);

    const rows = dbRows(ctx, "SELECT pane_id, session_id, state, source_event FROM agent_state_transitions");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      pane_id: PANE,
      session_id: SESSION,
      state: "degraded",
      source_event: "outcome:session_created_metadata_not_persisted",
    });
    // The degraded fact is reconstructable from the shared journal: recovery
    // flows (log query/follow) see it without any Codex-specific store.
    const journal = sql(ctx);
    expect(journal.some((r) => r.type === "agents.state.degraded" && r.paneId === PANE)).toBe(true);
    // Negative proof: no second authority — the table list is unchanged.
    expect(tableNames(ctx)).toEqual(before);
  });

  test("duplicate degraded delivery is idempotent across replay and restart", () => {
    const ctx = setupPane();
    const payload = outcomePayload("xtrm.command-outcome.v1", "degraded-launch.json");
    expect(applyOutcome(ctx, payload).status).toBe(0);
    const second = applyOutcome(ctx, payload);
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout).duplicate).toBe(true);
    expect(dbRows(ctx, "SELECT COUNT(*) AS n FROM agent_state_transitions")[0].n).toBe(1);
  });

  test("ok outcome fabricates no lifecycle state", () => {
    const ctx = setupPane();
    const payload = outcomePayload("xtrm.command-outcome.v1", "ok-launch.json");
    const result = applyOutcome(ctx, payload);
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.appliedState).toBeNull();
    expect(parsed.nextActions).toEqual(payload.next_actions);
    expect(dbRows(ctx, "SELECT COUNT(*) AS n FROM agent_state_transitions")[0].n).toBe(0);
  });

  test("unknown schema version is rejected without writes", () => {
    const ctx = setupPane();
    const payload = outcomePayload("xtrm.command-outcome.v2", "unknown-version.json");
    const result = applyOutcome(ctx, payload);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).code).toBe("XTMUX_UNSUPPORTED_SCHEMA");
    expect(dbRows(ctx, "SELECT COUNT(*) AS n FROM agent_state_transitions")[0]?.n ?? 0).toBe(0);
  });

  test("hostile outcome (hook-trust bypass, escaping pane id, unknown keys) is rejected", () => {
    const ctx = setupPane();
    const payload = outcomePayload("xtrm.command-outcome.v1", "hostile-metadata.json");
    const result = applyOutcome(ctx, payload);
    expect(result.status).toBeGreaterThanOrEqual(2);
    const code = JSON.parse(result.stderr).code;
    expect(["XTMUX_HOOK_TRUST_VIOLATED", "XTMUX_INVALID_ARGUMENT"]).toContain(code);
    expect(dbRows(ctx, "SELECT COUNT(*) AS n FROM agent_state_transitions")[0]?.n ?? 0).toBe(0);
  });

  test("malformed JSON input exits with a structured error", () => {
    const ctx = setupPane();
    const result = spawnSync("bun", [join(root, "src/cli.ts"), "outcome-apply"], {
      encoding: "utf8",
      input: "{not json",
      env: ctx.env,
    });
    expect(result.status).toBe(2);
    const error = JSON.parse(result.stderr);
    expect(error.code).toBe("XTMUX_INVALID_ARGUMENT");
    expect(result.stdout).toBe("");
  });

  // The published schema is additionalProperties:false on EVERY object and
  // validates every field; the consumer enforces the same boundary. Each
  // mutation below starts from the valid Core K3 codex fixture.
  describe("v1 schema boundary enforcement (nested objects)", () => {
    // One shared pane per test: every mutation is refused BEFORE any write, so
    // the store stays empty and the context is reusable across mutations.
    function makeReject(ctx: Env) {
      return (mutate: (payload: Record<string, any>) => void): void => {
        const payload = outcomePayload("xtrm.command-outcome.v1", "ok-launch.json");
        mutate(payload);
        const result = applyOutcome(ctx, payload);
        expect(result.status).toBeGreaterThanOrEqual(2);
        expect(JSON.parse(result.stderr).code).not.toBe("XTMUX_UNSUPPORTED_SCHEMA");
        expect(dbRows(ctx, "SELECT COUNT(*) AS n FROM agent_state_transitions")[0]?.n ?? 0).toBe(0);
      };
    }

    test("unknown nested keys are refused in every closed object", () => {
      const ctx = setupPane();
      const reject = makeReject(ctx);
      reject((p) => { p.identity.extra = "x"; });
      reject((p) => { p.runtime.extra = "x"; });
      reject((p) => { p.worktree.extra = "x"; });
      reject((p) => { p.readiness.extra = "x"; });
      reject((p) => { p.safety_profile.extra = "x"; });
      reject((p) => { p.persistence.extra = "x"; });
      reject((p) => { p.authoritative_mutation.extra = "x"; });
      reject((p) => { p.side_effects[0].extra = "x"; });
      reject((p) => { p.next_actions[0].extra = "x"; });
    }, 120_000);

    test("wrong nested types and enums are refused", () => {
      const ctx = setupPane();
      const reject = makeReject(ctx);
      reject((p) => { p.readiness.status = "maybe"; });
      reject((p) => { p.readiness.source = "guess"; });
      reject((p) => { p.side_effects[0].status = "exploded"; });
      reject((p) => { p.runtime.name = "codex-cli"; });
      reject((p) => { p.runtime.version = "bad\u0007version"; });
      reject((p) => { p.persistence.completed = "yes"; });
      reject((p) => { delete p.persistence.kind; });
      reject((p) => { p.authoritative_mutation.kind = "NOT_A_TOKEN"; });
      reject((p) => { p.worktree.owner = "attacker"; });
      reject((p) => { delete p.worktree.branch; });
      reject((p) => { p.identity.tmux_session_id = "session-seven"; });
      reject((p) => { p.identity.thread_id = "x".repeat(257); });
      reject((p) => { p.next_actions[0].kind = "teleport"; });
      reject((p) => { p.next_actions[0].required = "yes"; });
      reject((p) => { delete p.next_actions[0].why; });
      reject((p) => { p.next_actions[0].argv = []; });
      reject((p) => { p.next_actions[0].display = "bad\u001b[0m"; });
      reject((p) => { p.reason_code = "Not_Snake"; });
      reject((p) => { p.summary = ""; });
      reject((p) => { delete p.side_effects; });
    }, 120_000);
  });
});
