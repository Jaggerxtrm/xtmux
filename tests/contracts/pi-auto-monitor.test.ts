import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";

test("outbound send records pane-owned monitor expectation (.38)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-pi-auto-monitor-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(dir, "tmux-calls")}'\nexit 0\n`);
  writeFileSync(join(bin, "picker"), `#!/bin/sh
printf '%s\\n' "$*" >> '${join(dir, "calls")}'
case "$1" in
  monitor-list) exit 0 ;;
  monitor-agent) printf 'monitor\\tmonitor-38\\t123\\tpeer:1.1\\t%%peer\\tidle\\t1\\t99\\t1\\t1\\n' ;;
esac
`);
  chmodSync(join(bin, "tmux"), 0o755);
  chmodSync(join(bin, "picker"), 0o755);
  const old = { ...process.env };
  Object.assign(process.env, {
    TMUX: "/tmp/mock,1,0",
    TMUX_PANE: "%me",
    XDG_RUNTIME_DIR: dir,
    XTMUX_PICKER: join(bin, "picker"),
    XTMUX_TMUX: join(bin, "tmux"),
    XTMUX_AUTO_MONITOR_SKIP_TARGETS: "",
    XTMUX_AUTO_MONITOR_DISABLE: "0",
  });
  try {
    expect(spawnSync(join(bin, "tmux"), ["has-session", "-t", "peer:1.1"]).status).toBe(0);
    const handlers = new Map<string, Function[]>();
    const pi = {
      on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      exec: async () => ({ stdout: "" }),
      sendUserMessage() {},
    };
    const module = await import(`../../extensions/pi-auto-monitor.ts?test=${Date.now()}`);
    expect(module.extractTarget("tmux-session-picker message-send --to peer:1.1 --bead work --text done")).toBe("peer:1.1");
    module.default(pi as any);
    expect(handlers.get("tool_result")).toHaveLength(2);
    const autoHandler = handlers.get("tool_result")?.at(-1);
    const result = await autoHandler?.({
      type: "tool_result", toolName: "bash", isError: false,
      input: { command: "tmux-session-picker message-send --to peer:1.1 --bead work --text done" },
      content: [],
    });
    expect(readFileSync(join(dir, "tmux-calls"), "utf8")).toContain("has-session -t peer:1.1");
    const calls = readFileSync(join(dir, "calls"), "utf8");
    expect(calls).toContain("monitor-agent peer:1.1");
    expect(result).toBeDefined();
    const state = join(dir, "xtmux-outbound-expectations");
    const names = readdirSync(state);
    expect(names).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(state, names[0]!), "utf8"))).toMatchObject({
      target: "peer:1.1", monitorId: "monitor-38", paneId: "%me",
    });
    expect(result.content.at(-1).text).toContain("[auto-monitor] armed on peer:1.1");
  } finally {
    for (const key of ["TMUX", "TMUX_PANE", "XDG_RUNTIME_DIR", "XTMUX_PICKER", "XTMUX_TMUX", "XTMUX_AUTO_MONITOR_SKIP_TARGETS", "XTMUX_AUTO_MONITOR_DISABLE"] as const) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
