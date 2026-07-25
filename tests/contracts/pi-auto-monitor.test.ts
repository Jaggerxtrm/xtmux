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
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
printf '%s\\n' "$*" >> '${join(root, "tmux-calls")}'
case "$*" in
  *'#{pane_id}') printf '%%me\\n' ;;
  *'#{session_id}') printf '$me\\n' ;;
esac
exit 0
`);
  writeFileSync(join(bin, "picker"), `#!/bin/sh
printf '%s\\n' "$*" >> '${join(root, "calls")}'
case "$1" in
  obligations) [ -f '${join(root, "obligations")}' ] && cat '${join(root, "obligations")}' || printf '[]\\n' ;;
  message-list) printf '[]\\n' ;;
  unread-count) printf '{"unreadCount":0}\\n' ;;
  monitor-list)
    printf '[{"monitorId":"foreign","waitId":"foreign-wait","target":"peer:1.1","requesterPaneId":"%%other","terminalStatus":null}'
    for target in 'peer:1.1' 'peer:2.1'; do
      [ -f '${root}/monitor-'"$target" ] && printf ',{"monitorId":"monitor-%s","waitId":"wait-%s","target":"%s","sessionId":"%s","paneId":null,"requesterSessionId":"$me","requesterPaneId":"%%me","startedAtMs":200,"terminalStatus":null,"wakeConsumed":false}' "$target" "$target" "$target" "$target"
    done
    printf ']\\n' ;;
  monitor-agent)
    touch '${root}/monitor-'"$2"
    printf '{"monitorId":"monitor-%s","waitId":"wait-%s","target":"%s","requesterPaneId":"%%me","terminalStatus":null}\\n' "$2" "$2" "$2" ;;
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
    XTMUX_INBOX_POLL_INTERVAL_S: "0.01",
    PATH: `${bin}:${old.PATH || ""}`,
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
        messageKey: "m1", duplicate: false, senderId: "$me", recipientId: "peer:1.1", expectsReply: true,
      }) }],
    });

    expect(readFileSync(join(root, "tmux-calls"), "utf8")).toContain("has-session -t peer:1.1");
    const calls = readFileSync(join(root, "calls"), "utf8");
    expect(calls).toContain("monitor-list --json");
    expect(calls).toContain("monitor-agent peer:1.1 --json --wait-for-transition");
    expect(result.content.at(-1).text).toContain("[auto-monitor] armed on peer:1.1");

    for (const value of [{
      messageKey: "fyi", duplicate: false, senderId: "$me", recipientId: "peer:1.1", expectsReply: false,
    }, {
      messageKey: "reply", duplicate: false, replyToMessageKey: "m1", fulfilled: true,
      senderId: "$me", recipientId: "peer:1.1",
    }]) {
      expect(await autoHandler?.({
        type: "tool_result", toolName: "bash", isError: false,
        content: [{ type: "text", text: JSON.stringify(value) }],
      })).toBeUndefined();
    }
    expect(readFileSync(join(root, "calls"), "utf8").match(/^monitor-agent /gm)).toHaveLength(1);

    writeFileSync(join(root, "obligations"), JSON.stringify([{
      messageKey: "missed-1", senderId: "$me", senderPaneId: "%me", recipientId: "peer:2.1", targetPaneId: null,
      summary: "private", replyStatus: "pending", createdAtMs: 100,
    }, {
      messageKey: "missed-2", senderId: "$me", senderPaneId: "%me", recipientId: "peer:2.1", targetPaneId: null,
      summary: "private", replyStatus: "pending", createdAtMs: 110,
    }]));
    for (const handler of handlers.get("session_start") ?? []) await handler({}, {
      hasPendingMessages: () => false,
      ui: { setWidget() {} },
    });
    await Bun.sleep(30);
    const reconciledCalls = readFileSync(join(root, "calls"), "utf8");
    expect(reconciledCalls).toContain("monitor-agent peer:2.1 --json --wait-for-transition");
    expect(reconciledCalls.match(/^monitor-agent peer:2\.1 /gm)).toHaveLength(1);
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, { ui: { setWidget() {} } });

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
