import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { openDb } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/schema.ts";
import { replyMessage } from "../../src/domains/messages/reply.ts";
import { sendMessage } from "../../src/domains/messages/send.ts";

const ROOT = join(import.meta.dir, "../..");
const CLI = join(ROOT, "src/cli.ts");
const PICKER = join(ROOT, "bin/tmux-session-picker");

type Result = { status: number; stdout: string; stderr: string };

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Result {
  const result = spawnSync(command, args, { cwd: ROOT, env, encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "xtmux-coordination-cli-"));
  const bin = join(root, "bin");
  const dbPath = join(root, "state", "observability.db");
  const calls = join(root, "tmux.calls");
  for (const dir of [bin, join(root, "home"), join(root, "config"), join(root, "cache"), join(root, "state"), join(root, "runtime"), join(root, "tmp"), join(root, "tmux")]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(bin, "tmux"), `#!/bin/bash
set -u
target=""
previous=""
for arg in "$@"; do
  if [ "$previous" = -t ]; then target="$arg"; fi
  previous="$arg"
done
format="\${!#}"
session="\${MOCK_SESSION:-}"
pane="\${MOCK_PANE:-}"
case "$target" in
  *owner*) session='$owner'; pane='%owner' ;;
  *worker*) session='$worker'; pane='%worker' ;;
esac
case "$1" in
  display-message)
    case "$format" in
      *'#{session_id}'*'#{window_id}'*'#{pane_id}'*) printf '%s\\t@window\\t%s\\t\\t\\t\\t1\\n' "$session" "$pane" ;;
      '#{session_id}') printf '%s\\n' "$session" ;;
      '#{pane_id}') printf '%s\\n' "$pane" ;;
      '#{pane_current_command}') printf 'pi\\n' ;;
      '#{pane_pid}') printf '%s\\n' "$$" ;;
      '#S') printf '%s\\n' "\${session#\\$}" ;;
      *) : ;;
    esac
    ;;
  show-options) printf '%s\\n' "\${MOCK_STATE:-done}" ;;
  send-keys)
    printf 'send-keys\\t%s\\n' "$*" >> "$TMUX_CALLS"
    [ "\${TMUX_SEND_FAIL:-0}" != 1 ]
    ;;
  set-option|capture-pane) : ;;
  *) : ;;
esac
`);
  chmodSync(join(bin, "tmux"), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    TMPDIR: join(root, "tmp"),
    TMUX_TMPDIR: join(root, "tmux"),
    TMUX: join(root, "tmux.sock") + ",1,0",
    TMUX_PANE: "%worker",
    MOCK_SESSION: "$worker",
    MOCK_PANE: "%worker",
    TMUX_CALLS: calls,
    XTMUX_HOST_ID: "test-host",
    XTMUX_OBS_V2: "1",
    XTMUX_OBS_V2_REPO: ROOT,
    XTMUX_OBS_DB_PATH: dbPath,
  };
  return {
    root,
    dbPath,
    calls,
    env,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function raw(args: string[], env: NodeJS.ProcessEnv): Result {
  return run("bun", [CLI, ...args], env);
}

function picker(args: string[], env: NodeJS.ProcessEnv): Result {
  return run(PICKER, args, env);
}

function seedRequest(dbPath: string, key: string): void {
  const db = openDb({ dbPath, mode: "on", busyTimeoutMs: 3000 });
  migrate(db);
  sendMessage(db, {
    messageKey: key,
    senderId: "$owner",
    senderPaneId: "%owner",
    recipientId: "$worker",
    targetPaneId: "%worker",
    summary: "private request",
    expectsReply: true,
  });
  db.close();
}

describe("coordination CLI acceptance", () => {
  test("raw and picker reply JSON, text, and error contracts stay equivalent", () => {
    const ctx = setup();
    try {
      for (const key of ["raw-json", "picker-json", "raw-text", "picker-text"]) seedRequest(ctx.dbPath, key);

      const rawJson = raw(["message-reply", "--in-reply-to", "raw-json", "--text", "done", "--message-key", "reply-raw-json", "--json"], ctx.env);
      const pickerJson = picker(["message-reply", "--in-reply-to", "picker-json", "--text", "done", "--message-key", "reply-picker-json", "--json"], ctx.env);
      expect([rawJson.status, pickerJson.status]).toEqual([0, 0]);
      expect(JSON.parse(rawJson.stdout)).toMatchObject({ duplicate: false, fulfilled: true, replyToMessageKey: "raw-json", senderId: "$worker", senderPaneId: "%worker", recipientId: "$owner", targetPaneId: "%owner" });
      expect(JSON.parse(pickerJson.stdout)).toMatchObject({ duplicate: false, fulfilled: true, replyToMessageKey: "picker-json", senderId: "$worker", senderPaneId: "%worker", recipientId: "$owner", targetPaneId: "%owner" });

      const rawText = raw(["message-reply", "--in-reply-to", "raw-text", "--text", "done", "--message-key", "reply-raw-text"], ctx.env);
      const pickerText = picker(["message-reply", "--in-reply-to", "picker-text", "--text", "done", "--message-key", "reply-picker-text"], ctx.env);
      expect(rawText.stdout).toBe("reply\treply-raw-text\traw-text\ttrue\n");
      expect(pickerText.stdout).toBe("reply\treply-picker-text\tpicker-text\ttrue\n");

      const rawMissing = raw(["message-reply", "--in-reply-to", "missing", "--text", "done", "--json"], ctx.env);
      const pickerMissing = picker(["message-reply", "--in-reply-to", "missing", "--text", "done", "--json"], ctx.env);
      expect([rawMissing.status, pickerMissing.status]).toEqual([5, 5]);
      expect(JSON.parse(rawMissing.stderr).code).toBe("XTMUX_MESSAGE_NOT_FOUND");
      expect(JSON.parse(pickerMissing.stderr).code).toBe("XTMUX_MESSAGE_NOT_FOUND");
    } finally {
      ctx.cleanup();
    }
  });

  test("raw and picker message lists expose the same fulfilled correlation projection", () => {
    const ctx = setup();
    try {
      seedRequest(ctx.dbPath, "projection-request");
      const db = openDb({ dbPath: ctx.dbPath, mode: "on", busyTimeoutMs: 3000 });
      replyMessage(db, {
        messageKey: "projection-reply",
        replyToMessageKey: "projection-request",
        senderId: "$worker",
        senderPaneId: "%worker",
        summary: "private reply",
      });
      db.close();

      const rawRows = JSON.parse(raw(["message-list", "--for", "$worker", "--pane", "%worker", "--expects-reply", "--json"], ctx.env).stdout);
      const pickerRows = JSON.parse(picker(["message-list", "--for", "$worker", "--pane", "%worker", "--expects-reply", "--json"], ctx.env).stdout);
      for (const rows of [rawRows, pickerRows]) {
        expect(rows[0]).toMatchObject({
          messageKey: "projection-request",
          replyStatus: "fulfilled",
          fulfilledByMessageKey: "projection-reply",
          correlatedReply: { messageKey: "projection-reply", senderId: "$worker", recipientId: "$owner" },
        });
      }
    } finally {
      ctx.cleanup();
    }
  });

  test("help documents receipt-only ack, durable wake consumption, and correlated safe-send", () => {
    const ctx = setup();
    try {
      const rawHelp = raw(["--help"], ctx.env).stdout;
      const pickerHelp = picker(["--help"], ctx.env).stdout;
      for (const help of [rawHelp, pickerHelp]) {
        expect(help).toContain("message-reply");
        expect(help).toContain("obligations list");
        expect(help).toMatch(/ack[^\n]*receipt[^\n]*not[^\n]*reply/i);
        expect(help).toMatch(/wait-agent[^\n]*--consume/i);
      }
      expect(pickerHelp).toMatch(/safe-send-pointer[^\n]*--reply-to/i);
      expect(pickerHelp).toContain("wakeConsumed");
    } finally {
      ctx.cleanup();
    }
  });

  test("raw and picker expose one durable, requester-owned wake consumption", () => {
    const ctx = setup();
    try {
      const rawWait = raw(["wait-agent", "%target", "--interval", "0", "--timeout", "1", "--json"], ctx.env);
      expect(rawWait.status).toBe(0);
      const pending = JSON.parse(rawWait.stdout);
      expect(pending).toMatchObject({
        target: "%target",
        requesterSessionId: "$worker",
        requesterPaneId: "%worker",
        targetSessionId: "$target",
        targetPaneId: "%target",
        state: "terminal",
        terminalStatus: "done",
        wakeDelivered: true,
        wakeConsumed: false,
      });

      const pickerWait = picker(["wait-agent", "%target", "--interval", "0", "--timeout", "1", "--json"], ctx.env);
      expect(pickerWait.status).toBe(0);
      expect(JSON.parse(pickerWait.stdout)).toMatchObject({ waitId: pending.waitId, wakeDelivered: true, wakeConsumed: false });

      const consumed = raw(["wait-agent", "%target", "--interval", "0", "--timeout", "1", "--consume", "--json"], ctx.env);
      expect(consumed.status).toBe(0);
      expect(JSON.parse(consumed.stdout)).toMatchObject({ waitId: pending.waitId, wakeConsumed: true });

      const foreign = picker(["wait-agent", "%target", "--interval", "0", "--timeout", "1", "--consume", "--json"], {
        ...ctx.env,
        TMUX_PANE: "%other",
        MOCK_SESSION: "$other",
        MOCK_PANE: "%other",
      });
      expect(foreign.status).toBe(4);
      expect(JSON.parse(foreign.stderr)).toMatchObject({ code: "XTMUX_WAIT_NOT_OWNER" });

      const text = raw(["wait-agent", "%target", "--interval", "0", "--timeout", "1"], ctx.env);
      expect(text).toMatchObject({ status: 0, stdout: "wait\t%target\tdone\n" });
    } finally {
      ctx.cleanup();
    }
  });

  test("safe-send fulfils only after successful injection", () => {
    const success = setup();
    try {
      seedRequest(success.dbPath, "safe-success");
      const result = picker([
        "safe-send-pointer", "--yes", "--json", "--reply-to", "safe-success",
        "--message-key", "safe-success-reply", "%owner", "leggi /tmp/reply.txt e seguilo",
      ], success.env);
      expect(result.status).toBe(0);
      expect(readFileSync(success.calls, "utf8")).toContain("send-keys");
      expect(JSON.parse(result.stdout)).toMatchObject({
        injection: { sent: true, target: "%owner" },
        fulfilment: { messageKey: "safe-success-reply", replyToMessageKey: "safe-success", fulfilled: true },
      });
      const db = new Database(success.dbPath, { readonly: true });
      expect(db.query<{ fulfilled: number }, []>("SELECT fulfilled_at_ms IS NOT NULL AS fulfilled FROM messages WHERE message_key = 'safe-success'").get()).toEqual({ fulfilled: 1 });
      db.close();
    } finally {
      success.cleanup();
    }

    const failure = setup();
    try {
      seedRequest(failure.dbPath, "safe-failure");
      const result = picker([
        "safe-send-pointer", "--yes", "--json", "--reply-to", "safe-failure",
        "--message-key", "safe-failure-reply", "%owner", "leggi /tmp/reply.txt e seguilo",
      ], { ...failure.env, TMUX_SEND_FAIL: "1" });
      expect(result.status).not.toBe(0);
      expect(readFileSync(failure.calls, "utf8")).toContain("send-keys");
      const db = new Database(failure.dbPath, { readonly: true });
      expect(db.query("SELECT fulfilled_at_ms FROM messages WHERE message_key = 'safe-failure'").get()).toEqual({ fulfilled_at_ms: null });
      expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE message_key = 'safe-failure-reply'").get()).toEqual({ count: 0 });
      db.close();
    } finally {
      failure.cleanup();
    }
  });
});
