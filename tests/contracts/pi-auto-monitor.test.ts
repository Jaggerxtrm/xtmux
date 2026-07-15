import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";

test("auto-monitor uses pane-owned SQLite waits and creates no marker directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "xtmux-pi-auto-monitor-"));
  const bin = join(root, "bin");
  for (const dir of [bin, join(root, "home"), join(root, "config"), join(root, "cache"), join(root, "state"), join(root, "runtime"), join(root, "tmp")]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(root, "tmux-calls")}'\nexit 0\n`);
  writeFileSync(join(bin, "picker"), `#!/bin/sh
printf '%s\\n' "$*" >> '${join(root, "calls")}'
case "$1" in
  monitor-list) printf '[{"monitorId":"foreign","waitId":"foreign-wait","target":"peer:1.1","requesterPaneId":"%%other","terminalStatus":null}]\\n' ;;
  monitor-agent) printf '{"monitorId":"monitor-38","waitId":"wait-38","target":"peer:1.1","requesterPaneId":"%%me","terminalStatus":null}\\n' ;;
esac
`);
  chmodSync(join(bin, "tmux"), 0o755);
  chmodSync(join(bin, "picker"), 0o755);
  const old = { ...process.env };
  Object.assign(process.env, {
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    TMPDIR: join(root, "tmp"),
    XTMUX_OBS_DB_PATH: join(root, "state", "observability.db"),
    TMUX: join(root, "tmux.sock") + ",1,0",
    TMUX_PANE: "%me",
    XTMUX_PICKER: join(bin, "picker"),
    XTMUX_TMUX: join(bin, "tmux"),
    XTMUX_AUTO_MONITOR_SKIP_TARGETS: "",
    XTMUX_AUTO_MONITOR_DISABLE: "0",
  });
  try {
    const handlers = new Map<string, Function[]>();
    const pi = {
      on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      exec: async (command: string, args: string[]) => {
        const output = spawnSync(command, args, { encoding: "utf8", env: process.env });
        return { stdout: output.stdout, stderr: output.stderr, code: output.status ?? 1, killed: false };
      },
      sendUserMessage() {},
    };
    const module = await import(`../../extensions/pi-auto-monitor.ts?test=${Date.now()}`);
    module.default(pi as any);
    expect(handlers.get("tool_result")).toHaveLength(2);
    const autoHandler = handlers.get("tool_result")?.at(-1);
    const result = await autoHandler?.({
      type: "tool_result", toolName: "bash", isError: false,
      content: [{ type: "text", text: JSON.stringify({
        messageKey: "m1", duplicate: false, senderId: "$me", recipientId: "peer:1.1",
      }) }],
    });

    expect(readFileSync(join(root, "tmux-calls"), "utf8")).toContain("has-session -t peer:1.1");
    const calls = readFileSync(join(root, "calls"), "utf8");
    expect(calls).toContain("monitor-list --json");
    expect(calls).toContain("monitor-agent peer:1.1 --json --wait-for-transition");
    expect(result.content.at(-1).text).toContain("[auto-monitor] armed on peer:1.1");
    expect(existsSync(join(root, "runtime", "xtmux-outbound-expectations"))).toBe(false);
    expect(existsSync(join(root, "runtime", "xtmux-reply-obligations"))).toBe(false);

    const malformed = await autoHandler?.({
      type: "tool_result", toolName: "bash", isError: false,
      content: [{ type: "text", text: '{"messageKey":"m2","recipientId":"peer:1.1"' }],
    });
    expect(malformed.content.at(-1).text).toContain("[auto-monitor] unavailable: Malformed xtmux JSON result");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
    rmSync(root, { recursive: true, force: true });
  }
});
