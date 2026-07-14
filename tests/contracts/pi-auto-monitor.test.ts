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
  monitor-list) printf '[]\\n' ;;
  monitor-agent) printf '{"monitorId":"monitor-38","target":"peer:1.1"}\\n' ;;
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
      exec: async (command: string, args: string[]) => {
        const output = spawnSync(command, args, { encoding: "utf8" });
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
      input: { command: "xtmux send --format changed --recipient differently-quoted" },
      content: [{ type: "text", text: JSON.stringify({
        messageKey: "m1", duplicate: false, senderId: "$me", recipientId: "peer:1.1",
        targetPaneId: "%peer", beadId: "work", expectsReply: true, createdAtMs: Date.now(),
      }) }],
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
    await expect(autoHandler?.({
      type: "tool_result", toolName: "bash", isError: false,
      input: { command: "another reworded send" },
      content: [{ type: "text", text: JSON.stringify({ messageKey: "m2", status: "acked", acked: "invalid" }) }],
    })).rejects.toThrow("Incompatible xtmux message-ack JSON result");
  } finally {
    for (const key of ["TMUX", "TMUX_PANE", "XDG_RUNTIME_DIR", "XTMUX_PICKER", "XTMUX_TMUX", "XTMUX_AUTO_MONITOR_SKIP_TARGETS", "XTMUX_AUTO_MONITOR_DISABLE"] as const) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
