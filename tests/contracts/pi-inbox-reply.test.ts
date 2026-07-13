import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import xtmuxInboxReply, { commandAction, readObligations } from "../../extensions/pi-inbox-reply.ts";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

function harness() {
  const handlers = new Map<string, Handler[]>();
  const widgets = new Map<string, string[]>();
  const notifications: string[] = [];
  let unread = 0;
  let failUnread = false;
  const statuses = new Map<string, object>();
  let expectedReplies: Array<Record<string, unknown>> = [];
  const pickerCalls: string[][] = [];
  let failPane = false;
  const ui = {
    setWidget(key: string, lines: string[] | undefined) {
      if (lines) widgets.set(key, lines);
      else widgets.delete(key);
    },
    notify(message: string) { notifications.push(message); },
  };
  const ctx = { ui, hasUI: true };
  const pi = {
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    async exec(command: string, args: string[]) {
      if (command === "tmux") {
        if (args.at(-1) === "#{pane_id}") {
          if (failPane) throw new Error("pane unavailable");
          return { stdout: "%me\n", code: 0 };
        }
        const target = args[args.indexOf("-t") + 1];
        return { stdout: target && target !== "display-message" ? `${target}\n` : "$me\n", code: 0 };
      }
      pickerCalls.push(args);
      if (args[0] === "message-list") return { stdout: JSON.stringify(expectedReplies) };
      if (args[0] === "message-ack") {
        expectedReplies = expectedReplies.filter((message) => message.messageKey !== args[1]);
        return { stdout: `ack\t${args[1]}\t$me\n` };
      }
      if (args[0] === "unread-count") {
        if (failUnread) throw new Error("db unavailable");
        return { stdout: JSON.stringify({ recipientId: "$me", unreadCount: unread, oldestUnackedAtMs: null }) };
      }
      if (args[0] === "message-status") return { stdout: JSON.stringify(statuses.get(args[1]!) ?? {}) };
      throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
    },
  };
  xtmuxInboxReply(pi as any);
  return {
    widgets,
    notifications,
    statuses,
    pickerCalls,
    setUnread(value: number) { unread = value; },
    setExpectedReplies(messages: Array<Record<string, unknown>>) { expectedReplies = messages; },
    setUnreadFailure(value: boolean) { failUnread = value; },
    setPaneFailure(value: boolean) { failPane = value; },
    async emit(name: string, event: any = {}) {
      let result: unknown;
      for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
      return result;
    },
  };
}

let oldRuntime = process.env.XDG_RUNTIME_DIR;
let oldTmux = process.env.TMUX;
let oldPollInterval = process.env.XTMUX_INBOX_POLL_INTERVAL_S;
afterEach(() => {
  if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = oldRuntime;
  if (oldTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = oldTmux;
  if (oldPollInterval === undefined) delete process.env.XTMUX_INBOX_POLL_INTERVAL_S;
  else process.env.XTMUX_INBOX_POLL_INTERVAL_S = oldPollInterval;
});

describe("Pi inbox widget (.22)", () => {
  test("shows unread count, clears after ack refresh, and fails closed without TMUX", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xtmux-pi-inbox-"));
    process.env.XDG_RUNTIME_DIR = dir;
    process.env.TMUX = "/tmp/mock,1,0";
    try {
      const h = harness();
      h.setUnread(2);
      await h.emit("session_start");
      expect(h.widgets.get("xtmux-inbox")).toEqual(["Inbox: 2 unread"]);
      expect(h.pickerCalls.find((args) => args[0] === "unread-count")).toEqual([
        "unread-count", "--for", "$me", "--pane", "%me",
      ]);

      h.setUnread(0);
      await h.emit("tool_result", { toolName: "bash", input: { command: "tmux-session-picker message-ack m1 --by $me" }, isError: false });
      expect(h.widgets.has("xtmux-inbox")).toBe(false);

      h.setUnread(3);
      h.setUnreadFailure(true);
      await h.emit("agent_start");
      expect(h.widgets.has("xtmux-inbox")).toBe(false);

      h.setUnreadFailure(false);
      h.setPaneFailure(true);
      await h.emit("session_start");
      expect(h.pickerCalls.at(-1)).toEqual(["unread-count", "--for", "$me"]);

      delete process.env.TMUX;
      await h.emit("agent_start");
      expect(h.widgets.has("xtmux-inbox")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Pi reply obligations (.26)", () => {
  test("actionable ack records and reminds; only matching outbound send clears", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xtmux-pi-reply-"));
    process.env.XDG_RUNTIME_DIR = dir;
    process.env.TMUX = "/tmp/mock,1,0";
    try {
      const h = harness();
      h.statuses.set("task-1", {
        messageKey: "task-1", senderId: "$sender", recipientId: "$me",
        beadId: "xtmux-42", summary: "do the work", expectsReply: true, acked: true,
      });
      await h.emit("tool_result", { toolName: "bash", input: { command: "./bin/tmux-session-picker message-ack task-1 --by $me" }, isError: false });
      expect(readObligations()).toHaveLength(1);
      expect(h.widgets.get("xtmux-inbox")).toEqual(["Reply required: $sender (xtmux-42)"]);

      await h.emit("agent_end");
      expect(h.notifications.at(-1)).toContain("Reply required: $sender (xtmux-42)");
      expect(await h.emit("before_agent_start", { systemPrompt: "base" })).toEqual({
        systemPrompt: expect.stringContaining("Before ending this turn, author and send the required coordination reply to: $sender (xtmux-42)"),
      });

      await h.emit("tool_result", { toolName: "bash", input: { command: "tmux-session-picker message-send --to $other --text done" }, isError: false });
      expect(readObligations()).toHaveLength(1);

      await h.emit("tool_result", { toolName: "bash", input: { command: "tmux-session-picker message-send --to $sender --text done" }, isError: false });
      expect(readObligations()).toHaveLength(0);
      expect(h.widgets.has("xtmux-inbox")).toBe(false);

      expect(commandAction("echo 'message-send --to $sender'").relevant).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Pi mid-idle inbox scan (.36)", () => {
  test("poll records actionable work without another turn and stops on shutdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xtmux-pi-idle-poll-"));
    process.env.XDG_RUNTIME_DIR = dir;
    process.env.TMUX = "/tmp/mock,1,0";
    process.env.XTMUX_INBOX_POLL_INTERVAL_S = "0.01";
    try {
      const h = harness();
      await h.emit("session_start");
      h.setExpectedReplies([{
        messageKey: "idle", senderId: "$sender", recipientId: "$me", targetPaneId: "%me",
        beadId: "work-idle", summary: "arrived while idle", expectsReply: true, acked: false,
      }]);
      await Bun.sleep(35);
      expect(readObligations().map((item) => item.messageKey)).toEqual(["idle"]);
      expect(h.widgets.get("xtmux-inbox")).toEqual(["Reply required: $sender (work-idle)"]);

      await h.emit("session_shutdown");
      const calls = h.pickerCalls.length;
      await Bun.sleep(25);
      expect(h.pickerCalls).toHaveLength(calls);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Pi sender-declared reply expectations (.33)", () => {
  test("agent end records expected work without manual ack and restart preserves it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xtmux-pi-expected-reply-"));
    process.env.XDG_RUNTIME_DIR = dir;
    process.env.TMUX = "/tmp/mock,1,0";
    try {
      const h = harness();
      await h.emit("session_start");
      h.setExpectedReplies([
        { messageKey: "new", senderId: "$sender", recipientId: "$me", targetPaneId: "%me",
          beadId: "work-new", summary: "newest", expectsReply: true, acked: false },
        { messageKey: "old", senderId: "$sender", recipientId: "$me", targetPaneId: "%me",
          beadId: "work-old", summary: "older", expectsReply: true, acked: false },
        { messageKey: "other", senderId: "$other", recipientId: "$me", targetPaneId: "%me",
          beadId: "work-other", summary: "other", expectsReply: true, acked: false },
      ]);

      await h.emit("agent_end");
      expect(readObligations().map((item) => [item.senderId, item.messageKey])).toEqual([
        ["$other", "other"], ["$sender", "new"],
      ]);
      expect(h.notifications.at(-1)).toContain("Reply required:");
      expect(h.pickerCalls.filter((args) => args[0] === "message-ack")).toHaveLength(3);

      const restarted = harness();
      await restarted.emit("session_start");
      expect(restarted.widgets.get("xtmux-inbox")).toEqual([
        "Reply required: $other (work-other)",
        "Reply required: $sender (work-new)",
      ]);
      expect(readObligations(Date.now() + 3_600_001)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
