import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";
import xtmuxAgentState, { lastAssistantTextFromEntries } from "../../extensions/pi-agent-state.ts";
import xtmuxAutoMonitor from "../../extensions/pi-auto-monitor.ts";

const root = join(import.meta.dir, "../..");

test("pinned Pi API loads the two package entrypoints", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-pi-home-"));
  const agentDir = join(home, "pi-agent");
  const marker = join(home, "ambient-extension-loaded");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(join(agentDir, "extensions/ambient.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "leaked"); export default function () {}`);

  const extensions = [
    "extensions/pi-agent-state.ts",
    "extensions/pi-auto-monitor.ts",
  ];
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir };
  delete env.NODE_PATH;

  // Without this, a missing binary makes spawnSync return `status: undefined` and
  // the whole failure reads `Expected: 0 / Received: undefined` — which names
  // neither `pi` nor node_modules, and looks exactly like a merge regression.
  // That cost a real false regression scare: CI runs `bun install --frozen-lockfile`
  // and stays green, so only stale local checkouts see it (xtmux-d0a.20).
  //
  // Fail, do not skip. This test is the only thing pinning the Pi extension API,
  // and a skip would hide it on CI too — if `pi` ever fell out of the lockfile,
  // the pin would silently evaporate instead of going red.
  const piBin = join(root, "node_modules/.bin/pi");
  if (!existsSync(piBin)) {
    throw new Error(
      `pi binary not found: ${piBin}\n` +
      `This test pins the Pi extension API and cannot run without it.\n` +
      `Your node_modules is stale — \`pi\` (@earendil-works/pi-coding-agent) is a devDependency.\n` +
      `Fix: run \`bun install\` (CI runs \`bun install --frozen-lockfile\`).`,
    );
  }

  try {
    const result = spawnSync(piBin, [
      "--no-extensions",
      ...extensions.flatMap((path) => ["-e", join(root, path)]),
      "--list-models",
    ], { cwd: root, env, encoding: "utf8" });

    // spawn itself can fail for reasons the exit-status assertion cannot express
    // (EACCES on a non-executable shim, ENOEXEC on a broken install): those also
    // surface as `status: undefined`, so name them here rather than downstream.
    if (result.error) {
      throw new Error(
        `failed to spawn ${piBin}: ${result.error.message}\n` +
        `The binary exists but could not run — try \`bun install\` to repair node_modules.`,
      );
    }

    expect(result.status, result.stderr).toBe(0);
    expect(extensions).toHaveLength(2);
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);


test("settle-time transcript read tolerates entry shapes and skips non-assistant entries", () => {
  // pi's session entries are version-shaped: message may sit on the entry, in
  // entry.message, or be the entry itself. agent_settled carries no message
  // payload, so this read is what replaces agent_end's event.messages.
  expect(lastAssistantTextFromEntries(undefined)).toBe("");
  expect(lastAssistantTextFromEntries([])).toBe("");
  expect(lastAssistantTextFromEntries([
    { role: "user", content: "prompt" },
    { role: "assistant", content: [{ type: "text", text: "first" }] },
  ])).toBe("first");
  // A trailing non-assistant entry must not shadow the assistant turn.
  expect(lastAssistantTextFromEntries([
    { role: "assistant", message: { role: "assistant", content: "from entry.message" } },
    { role: "toolResult", content: "noise" },
  ])).toBe("from entry.message");
  expect(lastAssistantTextFromEntries(["bare string entry"])).toBe("bare string entry");
});

test("pi-auto-monitor initializes inbox exactly once", () => {
  const events: string[] = [];
  const pi = { on(event: string) { events.push(event); } };
  xtmuxAutoMonitor(pi as any);

  // Inbox contributes one session_start and agent lifecycle handlers; auto-monitor
  // adds only its own tool_result listener. Loading pi-inbox-reply as a third package
  // entrypoint would duplicate these registrations and its idle polling timer.
  expect(events.filter((event) => event === "session_start")).toHaveLength(1);
  expect(events.filter((event) => event === "session_shutdown")).toHaveLength(1);
  expect(events.filter((event) => event === "tool_result")).toHaveLength(2);
});

test("pi-agent-state registers only settled-based state events", () => {
  const events: string[] = [];
  xtmuxAgentState({ on(event: string) { events.push(event); }, async exec() { return { stdout: "" }; } } as any);

  expect(events).toEqual([
    "session_start",
    "agent_start",
    "ui_prompt_start",
    "ui_prompt_end",
    "agent_settled",
    "session_shutdown",
  ]);

  // hot-path events must never come back: pi awaits extension handlers, and this
  // extension awaits a subprocess in each, so these cost agent-execution time.
  // Registering any one of them again is a regression, not a feature.
  for (const hot of ["before_agent_start", "tool_execution_start", "tool_execution_end", "turn_start", "turn_end", "message_update", "agent_end"]) {
    expect(events).not.toContain(hot);
  }
});

test("one settled turn costs three subprocess calls, independent of tool count", async () => {
  const previousTmux = process.env.TMUX;
  process.env.TMUX = "/mock/tmux.sock,1,0";

  const handlers = new Map<string, Function>();
  const calls: Array<{ command: string; args: string[] }> = [];
  xtmuxAgentState({
    on(event: string, handler: Function) { handlers.set(event, handler); },
    async exec(command: string, args: string[]) {
      calls.push({ command, args });
      if (command === "tmux") {
        // Include a configured parent: the deprecated pi->parent message-send must
        // stay gone even when a distinct orchestrator parent is present.
        return { stdout: ["%me", "$me", "root", "xtmux-cq2", "$parent"].join("\t") };
      }
      return { stdout: "" };
    },
  } as any);

  const ctx = { sessionManager: { getEntries: () => [{ role: "assistant", content: [{ type: "text", text: "settled" }] }] } };
  try {
    await handlers.get("session_start")?.({});
    await handlers.get("agent_start")?.({});
    await handlers.get("agent_settled")?.({}, ctx);

    // The state script and the picker are invoked by resolved path (env override or
    // $HOME default), so classify by suffix rather than by bare name.
    const stateWrites = calls.filter((call) => call.command.endsWith("agent-state.sh"));
    const tmuxReads = calls.filter((call) => call.command === "tmux");
    const pickerCalls = calls.filter((call) => call.command.endsWith("tmux-session-picker"));

    // idle (new instance) + running + done, and nothing per tool call: the
    // extension no longer sees tool or streamed-chunk events at all.
    expect(stateWrites.map((call) => call.args[0])).toEqual(["idle", "running", "done"]);
    expect(tmuxReads).toHaveLength(1);
    expect(pickerCalls).toHaveLength(1);
    expect(calls).toHaveLength(5);

    // The deprecated pi->parent messaging must not return with it, even though
    // this settle carries a distinct parent session.
    expect(calls.some((call) => call.args[0] === "message-send")).toBe(false);
    expect(pickerCalls[0]!.args.slice(0, 3)).toEqual(["log", "emit", "agent.turn.done"]);
    expect(pickerCalls[0]!.args).toContain("parent=$parent");
  } finally {
    if (previousTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = previousTmux;
  }
});

test("an unset bead/parent never emits the string 'undefined'", async () => {
  const previousTmux = process.env.TMUX;
  process.env.TMUX = "/mock/tmux.sock,1,0";

  const handles: string[][] = [];
  const handlers = new Map<string, Function>();
  xtmuxAgentState({
    on(event: string, handler: Function) { handlers.set(event, handler); },
    async exec(command: string, args: string[]) {
      if (command.endsWith("tmux-session-picker")) handles.push(args);
      // Exactly what the real call returns when neither user option is set:
      // tmux emits trailing tabs and tmuxValue trims them away.
      if (command === "tmux") return { stdout: "%me\t$me\troot" };
      return { stdout: "" };
    },
  } as any);

  const ctx = { sessionManager: { getEntries: () => [{ role: "assistant", content: "ok" }] } };
  try {
    await handlers.get("agent_settled")?.({}, ctx);
    expect(handles).toHaveLength(1);
    expect(handles[0]).toContain("bead=");
    expect(handles[0]).toContain("parent=");
    expect(handles[0]!.join(" ")).not.toContain("undefined");
    expect(handles[0]).toContain("last_message=ok");
  } finally {
    if (previousTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = previousTmux;
  }
});

test("a prompt open before session_start keeps needs-input and dismisses to idle", async () => {
  // Measured ordering (xtmux-cq2.5): a dialog opened by another extension during
  // session start emits ui_prompt_start BEFORE this extension's session_start
  // handler, so an unconditional idle write there clobbered needs-input.
  const handlers = new Map<string, Function>();
  const writes: string[][] = [];
  xtmuxAgentState({
    on(event: string, handler: Function) { handlers.set(event, handler); },
    async exec(command: string, args: string[]) {
      if (command.endsWith("agent-state.sh")) writes.push(args);
      return { stdout: "" };
    },
  } as any);

  await handlers.get("ui_prompt_start")?.({});
  await handlers.get("session_start")?.({});
  await handlers.get("ui_prompt_end")?.({});

  expect(writes).toEqual([
    ["needs-input"],
    // the new-instance stamp must still land, but it must not downgrade the state
    ["needs-input", "--new-instance"],
    ["idle"],
  ]);
});

test("a prompt after settle restores done, not running", async () => {
  const handlers = new Map<string, Function>();
  const states: string[] = [];
  xtmuxAgentState({
    on(event: string, handler: Function) { handlers.set(event, handler); },
    async exec(command: string, args: string[]) {
      if (command.endsWith("agent-state.sh")) states.push(args[0]!);
      return { stdout: "" };
    },
  } as any);

  const ctx = { sessionManager: { getEntries: () => [] } };
  await handlers.get("session_start")?.({});
  await handlers.get("agent_start")?.({});
  await handlers.get("agent_settled")?.({}, ctx);
  await handlers.get("ui_prompt_start")?.({});
  await handlers.get("ui_prompt_end")?.({});

  expect(states).toEqual(["idle", "running", "done", "needs-input", "done"]);
});

test("needs-input is reported while a UI prompt is open, then restored", async () => {
  const handlers = new Map<string, Function>();
  const states: string[] = [];
  xtmuxAgentState({
    on(event: string, handler: Function) { handlers.set(event, handler); },
    async exec(command: string, args: string[]) {
      if (command !== "tmux") states.push(args[0]!);
      return { stdout: "" };
    },
  } as any);

  await handlers.get("agent_start")?.({});
  await handlers.get("ui_prompt_start")?.({ kind: "confirm" });
  await handlers.get("ui_prompt_end")?.({});

  expect(states).toEqual(["running", "needs-input", "running"]);
});
