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

function baseEnv(session = "$owner-a", pane = "%100"): NodeJS.ProcessEnv {
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
pane="\${MOCK_PANE:-%100}"; session="\${MOCK_SESSION:-\$owner-a}"
case "$target" in
  %100|'$owner-a') pane='%100'; session='$owner-a' ;;
  %200|'$owner-b') pane='%200'; session='$owner-b' ;;
  %101|'$101') pane='%101'; session='$101' ;;
  %201|'$201') pane='%201'; session='$201' ;;
  %102|'$102') pane='%102'; session='$102' ;;
  %202|'$202') pane='%202'; session='$202' ;;
  %103|'$103') pane='%103'; session='$103' ;;
esac
format="\${!#}"
case "$1" in
  has-session) case "$target" in %*) exit 1 ;; *) exit 0 ;; esac ;;
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
  for (const pane of ["%100", "%200", "%101", "%201", "%102", "%202", "%103"]) setState(pane, "done");
});
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

describe("Claude SQLite auto-monitor hooks", () => {
  test("expected sends are durable gates; FYI and correlated pointers create no marker", () => {
    expect(postSend(sendExpected("expected-a", "$101", "%101")).stderr).toContain("durable reply expected");
    const fyi = cli(["message-send", "--to", "$103", "--to-pane", "%103", "--from", "$owner-a", "--from-pane", "%100",
      "--expects-reply", "false", "--text", "FYI", "--message-key", "fyi-a", "--json"]);
    expect(fyi.status).toBe(0);
    expect(postSend(JSON.parse(fyi.stdout)).stderr).toBe("");
    expect(postSend({ injection: { sent: true, target: "$owner-a", doubleEnter: true }, fulfilment: { messageKey: "reply-a", replyToMessageKey: "request-a", fulfilled: true } }, "xtmux safe-send-pointer --yes --reply-to request-a --json").stderr).toBe("");
    expect(existsSync(join(TEST_ROOT, "runtime", "xtmux-auto-monitor"))).toBe(false);
  });

  test("Stop blocks with exact native Monitor command until this pane has a durable arm", async () => {
    sendExpected("expected-a", "$101", "%101");
    const payload = JSON.parse(stop().stdout);
    expect(payload.decision).toBe("block");
    expect(payload.reason).toContain("wait-agent %101 --wait-for-transition --consume --timeout 30m --interval 30s");
    expect(payload.reason).not.toContain("rm -f");

    const child = spawn("bun", [CLI, "wait-agent", "%101", "--wait-for-transition", "--consume", "--timeout", "5s", "--interval", "10ms", "--json"], { cwd: ROOT, env: baseEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let childOut = "", childErr = "";
    child.stdout!.on("data", (chunk) => childOut += chunk); child.stderr!.on("data", (chunk) => childErr += chunk);
    await waitUntil(() => monitorRows().some((row) => row.requesterPaneId === "%100" && row.paneId === "%101" && row.terminalStatus === null));
    expect(stop().stdout).toBe("");
    setState("%101", "working"); await Bun.sleep(80); setState("%101", "done");
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
    const envB = baseEnv("$owner-b", "%200");
    sendExpected("expected-b", "$201", "%201", envB);
    const child = spawn("bun", [CLI, "wait-agent", "%201", "--wait-for-transition", "--timeout", "5s", "--interval", "10ms", "--json"], { cwd: ROOT, env: envB, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout!.on("data", (chunk) => output += chunk);
    await waitUntil(() => monitorRows(envB).some((row) => row.requesterPaneId === "%200" && row.paneId === "%201"));
    setState("%201", "working"); await Bun.sleep(80); setState("%201", "done");
    expect(await new Promise<number | null>((resolve) => child.on("close", resolve))).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ wakeDelivered: true, wakeConsumed: false });
    const input = { tool_name: "Bash", tool_input: { command: "xtmux wait-agent %201 --wait-for-transition" }, tool_response: { exitCode: 0, stdout: output } };
    expect(hook(CONSUMED, input, envB).status).toBe(0);
    expect(hook(CONSUMED, input, envB).status).toBe(0);
    expect(monitorRows(envB).filter((row) => row.requesterPaneId === "%200" && row.paneId === "%201").at(-1)).toMatchObject({ wakeConsumed: true });
    const db = new Database(DB, { readonly: true });
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM event_journal WHERE type = 'wait.wake.consumed' AND pane_id = '%200'").get()).toEqual({ count: 1 });
    db.close();
  });

  test("Stop is pane-isolated and loop-safe across stale sessions", () => {
    const envA = baseEnv("$owner-a", "%100"), envB = baseEnv("$owner-b", "%200");
    sendExpected("isolated-a", "$102", "%102", envA);
    sendExpected("isolated-b", "$202", "%202", envB);
    const a = stop(false, envA).stdout;
    const b = stop(false, envB).stdout;
    expect(a).toContain("%102"); expect(a).not.toContain("%202");
    expect(b).toContain("%202"); expect(b).not.toContain("%102");
    expect(stop(true).stdout).toBe("");
    expect(stop(false, baseEnv("$stale", "%stale")).stdout).toBe("");
  });

  test("hostile persisted targets are rejected without reflection or command execution", () => {
    const sentinel = join(TEST_ROOT, "injected-sentinel");
    const hostile = [
      `%1\" touch ${sentinel}`,
      `%1' touch ${sentinel}`,
      `%1$(touch ${sentinel})`,
      `%1\`touch ${sentinel}\``,
      `%1;touch ${sentinel}`,
      `%1\ntouch ${sentinel}`,
    ];
    hostile.forEach((target, index) => sendExpected(`hostile-${index}`, "$999", target));

    const payload = JSON.parse(stop().stdout);
    expect(payload.decision).toBe("block");
    expect(payload.reason).toMatch(/rejected.*noncanonical target/i);
    expect(payload.reason).not.toContain("Monitor(command");
    for (const target of hostile) expect(payload.reason).not.toContain(target);
    const generatedReason = join(TEST_ROOT, "generated-stop-reason.sh");
    writeFileSync(generatedReason, payload.reason);
    run("sh", [generatedReason], baseEnv());
    expect(existsSync(sentinel)).toBe(false);
    expect(JSON.stringify(payload).length).toBeLessThan(1200);
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
