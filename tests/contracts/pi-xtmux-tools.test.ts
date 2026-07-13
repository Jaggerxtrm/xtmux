import { join } from "node:path";
import { expect, test } from "bun:test";
import xtmuxTools, { XtmuxCliError, runXtmuxJson } from "../../extensions/pi-xtmux-tools.ts";

const root = join(import.meta.dir, "../..");
const sendResult = {
  messageKey: "m1", messageId: 1, duplicate: false, senderId: "$sender", senderPaneId: "%sender",
  senderKind: "pane", recipientId: "$1732", recipientKind: "session", targetPaneId: "%target",
  beadId: "b1", expectsReply: true, createdAtMs: 1,
};

test("pilot registers only nine message/monitor tools and preserves literal identities", async () => {
  expect(await Bun.file(join(root, ".pi/settings.json")).json()).toEqual({ extensions: ["extensions/pi-xtmux-tools.ts"] });
  const tools: any[] = [];
  const calls: Array<{ command: string; args: string[]; signal?: AbortSignal }> = [];
  const pi = {
    registerTool(tool: unknown) { tools.push(tool); },
    async exec(command: string, args: string[], options?: { signal?: AbortSignal }) {
      calls.push({ command, args, ...(options?.signal ? { signal: options.signal } : {}) });
      return { stdout: JSON.stringify(sendResult), stderr: "", code: 0, killed: false };
    },
  };
  xtmuxTools(pi as any);
  expect(tools.map((tool) => tool.name)).toEqual([
    "xtmux_message_send", "xtmux_message_list", "xtmux_message_status", "xtmux_message_ack", "xtmux_unread_count",
    "xtmux_monitor_list", "xtmux_monitor_agent", "xtmux_wait_agent", "xtmux_monitor_kill",
  ]);

  const controller = new AbortController();
  const result = await tools[0].execute("call-1", { to: "$1732", text: "hello", bead: "b1", expectsReply: false }, controller.signal);
  expect(calls).toEqual([{
    command: "xtmux",
    args: ["message-send", "--to", "$1732", "--text", "hello", "--bead", "b1", "--expects-reply", "false", "--json"],
    signal: controller.signal,
  }]);
  expect(result.details).toEqual({ exitCode: 0, result: sendResult });
  expect(JSON.parse(result.content[0].text)).toEqual(sendResult);
});

test("tool layer preserves CLI exit 75 and 124 and rejects malformed JSON", async () => {
  for (const exitCode of [75, 124]) {
    const tools: any[] = [];
    const pi = {
      registerTool(tool: unknown) { tools.push(tool); },
      exec: async () => ({
        stdout: "", stderr: JSON.stringify({ code: `EXIT_${exitCode}`, message: "preserved", detail: {} }),
        code: exitCode, killed: false,
      }),
    };
    xtmuxTools(pi as any);
    try {
      await tools.find((tool) => tool.name === "xtmux_wait_agent").execute("wait", { target: "%target" });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(XtmuxCliError);
      expect((error as XtmuxCliError).exitCode).toBe(exitCode);
    }
  }

  await expect(runXtmuxJson({ exec: async () => ({ stdout: "not-json", stderr: "", code: 0, killed: false }) } as any, ["monitor-list"]))
    .rejects.toThrow("Malformed xtmux result JSON");
});
