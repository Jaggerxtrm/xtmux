import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const CLI = join(ROOT, "src/cli.ts");
const PICKER = join(ROOT, "bin/tmux-session-picker");
const ON_SEND = join(ROOT, "hooks/claude/auto-monitor-on-send.mjs");
const CONSUMED = join(ROOT, "hooks/claude/auto-monitor-consumed.mjs");
const STOP = join(ROOT, "hooks/claude/auto-monitor-drain-stop.mjs");
const PREFILTERS = ["auto-monitor-on-send.sh", "auto-monitor-consumed.sh"].map((name) => join(ROOT, "hooks/claude", name));
const TEST_ROOT = mkdtempSync(join(tmpdir(), "xtmux-claude-auto-monitor-"));
const BIN = join(TEST_ROOT, "bin");
const STATE_DIR = join(TEST_ROOT, "pane-state");
const DB = join(TEST_ROOT, "state", "observability.db");

function statePath(pane: string): string {
  return join(STATE_DIR, pane.replace(/[^A-Za-z0-9.-]/g, "_"));
}
function setState(pane: string, state: string): void { writeFileSync(statePath(pane), state); }

function baseEnv(session = "$owner-a", pane = "%owner-a"): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${BIN}:${process.env.PATH ?? ""}`,
    HOME: join(TEST_ROOT, "home"), XDG_CONFIG_HOME: join(TEST_ROOT, "config"),
    XDG_CACHE_HOME: join(TEST_ROOT, "cache"), XDG_STATE_HOME: join(TEST_ROOT, "state"),
    XDG_RUNTIME_DIR: join(TEST_ROOT, "runtime"), TMPDIR: join(TEST_ROOT, "tmp"),
    TMUX_TMPDIR: join(TEST_ROOT, "tmux"), TMUX: join(TEST_ROOT, "tmux.sock") + ",1,0",
    TMUX_PANE: pane, XTMUX_SESSION_ID: session, MOCK_SESSION: session, MOCK_PANE: pane, TMOCK_STATE_DIR: STATE_DIR,
    XTMUX_PICKER: PICKER, XTMUX_OBS_V2: "1", XTMUX_OBS_V2_REPO: ROOT, XTMUX_OBS_DB_PATH: DB,
  };
}

function run(command: string, args: string[], env = baseEnv(), input?: string) {
  const result = spawnSync(command, args, { cwd: ROOT, env, input, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}
function cli(args: string[], env = baseEnv()) { return run("bun", [CLI, ...args], env); }
function hook(file: string, input: object, env = baseEnv()) { return run("node", [file], env, JSON.stringify(input)); }
function stop(active = false, env = baseEnv()) { return hook(STOP, { stop_hook_active: active }, env); }

function sendExpected(key: string, targetSession: string, targetPane: string, env = baseEnv()) {
  const sent = cli(["message-send", "--to", targetSession, "--to-pane", targetPane,
    "--from", env.MOCK_SESSION!, "--from-pane", env.MOCK_PANE!, "--bead", "xtmux-3ua.7",
    "--text", `request ${key}`, "--message-key", key, "--json"], env);
  expect(sent.status).toBe(0);
  return JSON.parse(sent.stdout);
}
function postSend(response: object, command = "xtmux message-send --json", env = baseEnv()) {
  return hook(ON_SEND, { tool_name: "Bash", tool_input: { command }, tool_response: { exitCode: 0, stdout: JSON.stringify(response) } }, env);
}
function monitorRows(env = baseEnv()) {
  const result = cli(["monitor-list", "--json"], env);
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as Array<Record<string, unknown>>;
}
async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (check()) return; await Bun.sleep(20); }
  throw new Error("condition timed out");
}

beforeAll(() => {
  for (const dir of [BIN, STATE_DIR, "home", "config", "cache", "state", "runtime", "tmp", "tmux"].map((dir) => dir.startsWith("/") ? dir : join(TEST_ROOT, dir))) mkdirSync(dir, { recursive: true });
  writeFileSync(join(BIN, "tmux"), `#!/usr/bin/env bash
set -u
target="" previous=""
for arg in "$@"; do [ "$previous" = -t ] && target="$arg"; previous="$arg"; done
pane="\${MOCK_PANE:-%owner-a}"; session="\${MOCK_SESSION:-\$owner-a}"
case "$target" in
  %owner-a|'$owner-a') pane='%owner-a'; session='$owner-a' ;;
  %owner-b|'$owner-b') pane='%owner-b'; session='$owner-b' ;;
  %target-a|'$target-a') pane='%target-a'; session='$target-a' ;;
  %target-b|'$target-b') pane='%target-b'; session='$target-b' ;;
  %isolated-a|'$isolated-a') pane='%isolated-a'; session='$isolated-a' ;;
  %isolated-b|'$isolated-b') pane='%isolated-b'; session='$isolated-b' ;;
  %fyi|'$fyi') pane='%fyi'; session='$fyi' ;;
esac
format="\${!#}"
case "$1" in
  has-session) exit 0 ;;
  display-message) case "$format" in
    *'#{session_id}'*'#{window_id}'*'#{pane_id}'*) printf '%s\t@window\t%s\t\t\t\t1\n' "$session" "$pane" ;;
    '#{session_id}') printf '%s\n' "$session" ;; '#{pane_id}') printf '%s\n' "$pane" ;;
    '#{pane_current_command}') printf 'claude\n' ;; '#{pane_pid}') printf '%s\n' "$$" ;;
    '#S') printf '%s\n' "\${session#\$}" ;; *) : ;; esac ;;
  show-options) file="$TMOCK_STATE_DIR/$(printf '%s' "$pane" | sed 's/[^A-Za-z0-9.-]/_/g')"; [ -f "$file" ] && cat "$file" || printf 'done\n' ;;
  send-keys|set-option|capture-pane) exit 0 ;; *) exit 0 ;;
esac
`);
  chmodSync(join(BIN, "tmux"), 0o755);
  for (const pane of ["%owner-a", "%owner-b", "%target-a", "%target-b", "%isolated-a", "%isolated-b", "%fyi"]) setState(pane, "done");
});
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

describe("Claude SQLite auto-monitor hooks", () => {
  test("expected sends are durable gates; FYI and correlated pointers create no marker", () => {
    expect(postSend(sendExpected("expected-a", "$target-a", "%target-a")).stderr).toContain("durable reply expected");
    const fyi = cli(["message-send", "--to", "$fyi", "--to-pane", "%fyi", "--from", "$owner-a", "--from-pane", "%owner-a",
      "--expects-reply", "false", "--text", "FYI", "--message-key", "fyi-a", "--json"]);
    expect(fyi.status).toBe(0);
    expect(postSend(JSON.parse(fyi.stdout)).stderr).toBe("");
    expect(postSend({ injection: { sent: true, target: "$owner-a", doubleEnter: true }, fulfilment: { messageKey: "reply-a", replyToMessageKey: "request-a", fulfilled: true } }, "xtmux safe-send-pointer --yes --reply-to request-a --json").stderr).toBe("");
    expect(existsSync(join(TEST_ROOT, "runtime", "xtmux-auto-monitor"))).toBe(false);
  });

  test("Stop blocks with exact native Monitor command until this pane has a durable arm", async () => {
    sendExpected("expected-a", "$target-a", "%target-a");
    const payload = JSON.parse(stop().stdout);
    expect(payload.decision).toBe("block");
    expect(payload.reason).toContain("wait-agent %target-a --wait-for-transition --consume --timeout 30m --interval 30s");
    expect(payload.reason).not.toContain("rm -f");

    const child = spawn("bun", [CLI, "wait-agent", "%target-a", "--wait-for-transition", "--consume", "--timeout", "5s", "--interval", "10ms", "--json"], { cwd: ROOT, env: baseEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let childOut = "", childErr = "";
    child.stdout!.on("data", (chunk) => childOut += chunk); child.stderr!.on("data", (chunk) => childErr += chunk);
    await waitUntil(() => monitorRows().some((row) => row.requesterPaneId === "%owner-a" && row.paneId === "%target-a" && row.terminalStatus === null));
    expect(stop().stdout).toBe("");
    setState("%target-a", "working"); await Bun.sleep(80); setState("%target-a", "done");
    expect(await new Promise<number | null>((resolve) => child.on("close", resolve))).toBe(0);
    expect(childErr).toBe("");
    expect(JSON.parse(childOut)).toMatchObject({ terminalStatus: "done", wakeDelivered: true, wakeConsumed: true });
    expect(stop().stdout).toBe("");

    const db = new Database(DB, { readonly: true });
    const events = db.query<{ type: string; count: number }, []>("SELECT type, COUNT(*) AS count FROM event_journal WHERE correlation_id LIKE 'wait:%' GROUP BY type ORDER BY type").all();
    db.close();
    for (const type of ["wait.registered", "wait.monitor.armed", "wait.terminal", "wait.wake.delivered", "wait.wake.consumed"]) expect(events.some((event) => event.type === type && event.count >= 1)).toBe(true);
    expect(existsSync(join(TEST_ROOT, "runtime", "xtmux-auto-monitor"))).toBe(false);
  });

  test("terminal wake consumption is requester-owned and occurs once after restart", async () => {
    const envB = baseEnv("$owner-b", "%owner-b");
    sendExpected("expected-b", "$target-b", "%target-b", envB);
    const child = spawn("bun", [CLI, "wait-agent", "%target-b", "--wait-for-transition", "--timeout", "5s", "--interval", "10ms", "--json"], { cwd: ROOT, env: envB, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout!.on("data", (chunk) => output += chunk);
    await waitUntil(() => monitorRows(envB).some((row) => row.requesterPaneId === "%owner-b" && row.paneId === "%target-b"));
    setState("%target-b", "working"); await Bun.sleep(80); setState("%target-b", "done");
    expect(await new Promise<number | null>((resolve) => child.on("close", resolve))).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ wakeDelivered: true, wakeConsumed: false });
    const input = { tool_name: "Bash", tool_input: { command: "xtmux wait-agent %target-b --wait-for-transition" }, tool_response: { exitCode: 0, stdout: output } };
    expect(hook(CONSUMED, input, envB).status).toBe(0);
    expect(hook(CONSUMED, input, envB).status).toBe(0);
    expect(monitorRows(envB).filter((row) => row.requesterPaneId === "%owner-b" && row.paneId === "%target-b").at(-1)).toMatchObject({ wakeConsumed: true });
    const db = new Database(DB, { readonly: true });
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM event_journal WHERE type = 'wait.wake.consumed' AND pane_id = '%owner-b'").get()).toEqual({ count: 1 });
    db.close();
  });

  test("Stop is pane-isolated and loop-safe across stale sessions", () => {
    const envA = baseEnv("$owner-a", "%owner-a"), envB = baseEnv("$owner-b", "%owner-b");
    sendExpected("isolated-a", "$isolated-a", "%isolated-a", envA);
    sendExpected("isolated-b", "$isolated-b", "%isolated-b", envB);
    const a = stop(false, envA).stdout;
    const b = stop(false, envB).stdout;
    expect(a).toContain("%isolated-a"); expect(a).not.toContain("%isolated-b");
    expect(b).toContain("%isolated-b"); expect(b).not.toContain("%isolated-a");
    expect(stop(true).stdout).toBe("");
    expect(stop(false, baseEnv("$stale", "%stale")).stdout).toBe("");
  });

  test("CLI absence and corrupt DB produce bounded actionable diagnostics without a Stop loop", () => {
    const missingEnv = { ...baseEnv(), XTMUX_PICKER: join(TEST_ROOT, "missing-xtmux") };
    const missing = stop(false, missingEnv);
    expect(JSON.parse(missing.stdout).reason).toMatch(/unavailable|failed/i);
    expect(missing.stdout.length).toBeLessThan(1200);
    expect(stop(true, missingEnv).stdout).toBe("");
    const corruptDb = join(TEST_ROOT, "state", "corrupt.db"); writeFileSync(corruptDb, "not sqlite");
    const corrupt = stop(false, { ...baseEnv(), XTMUX_OBS_DB_PATH: corruptDb });
    expect(JSON.parse(corrupt.stdout).reason).toMatch(/obligations list|database|failed/i);
    expect(corrupt.stdout.length).toBeLessThan(1200);
  });

  test("irrelevant shell prefilters stay below no-cold-start latency", () => {
    const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "printf hello" }, tool_response: { exitCode: 0, stdout: "hello" } });
    for (const file of PREFILTERS) {
      for (let i = 0; i < 5; i++) run("bash", [file], baseEnv(), input);
      const started = performance.now();
      for (let i = 0; i < 30; i++) expect(run("bash", [file], baseEnv(), input).status).toBe(0);
      expect((performance.now() - started) / 30).toBeLessThan(30);
    }
  });
});
