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
    setUnreadFailure(value: boolean) { failUnread = value; },
    setPaneFailure(value: boolean) { failPane = value; },
    async emit(name: string, event: any = {}) {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
  };
}

let oldRuntime = process.env.XDG_RUNTIME_DIR;
let oldTmux = process.env.TMUX;
afterEach(() => {
  if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = oldRuntime;
  if (oldTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = oldTmux;
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
        beadId: "xtmux-42", summary: "do the work", acked: true,
      });
      await h.emit("tool_result", { toolName: "bash", input: { command: "./bin/tmux-session-picker message-ack task-1 --by $me" }, isError: false });
      expect(readObligations()).toHaveLength(1);
      expect(h.widgets.get("xtmux-inbox")).toEqual(["Reply required: $sender (xtmux-42)"]);

      await h.emit("agent_end");
      expect(h.notifications.at(-1)).toContain("Reply required: $sender (xtmux-42)");

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
