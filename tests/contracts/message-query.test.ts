import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { openDb } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/schema.ts";
import { ackMessage } from "../../src/domains/messages/ack.ts";
import { sendMessage } from "../../src/domains/messages/send.ts";

const ROOT = join(import.meta.dir, "../..");
const CLI = join(ROOT, "src/cli.ts");
const PICKER = join(ROOT, "bin/tmux-session-picker");

type Result = { exitCode: number; stdout: string; stderr: string };

function run(dbPath: string, args: string[]): Result {
  const result = spawnSync("bun", [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, XTMUX_OBS_DB_PATH: dbPath, XTMUX_OBS_V2: "1" },
    encoding: "utf8",
  });
  return { exitCode: result.status ?? 1, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

describe("message status and unread-count queries", () => {
  test("status transitions from unacked to acked by durable message key", () => {
    const dir = mkdtempSync(join(tmpdir(), "xtmux-message-query-"));
    const dbPath = join(dir, "observability.db");
    const db = openDb({ dbPath, mode: "on", busyTimeoutMs: 3000 });
    migrate(db);
    try {
      const { messageId } = sendMessage(db, { messageKey: "outbound-1", senderId: "$sender", recipientId: "$recipient", summary: "hello" });
      const unacked = run(dbPath, ["message-status", "outbound-1"]);
      expect(unacked.exitCode).toBe(0);
      expect(JSON.parse(unacked.stdout)).toEqual({
        messageKey: "outbound-1",
        senderId: "$sender",
        recipientId: "$recipient",
        beadId: null,
        summary: "hello",
        expectsReply: false,
        acked: false,
        ackedAtMs: null,
        ackedBy: null,
      });

      ackMessage(db, { messageId, ackedBy: "$recipient" });
      const acked = run(dbPath, ["message-status", "outbound-1"]);
      expect(acked.exitCode).toBe(0);
      expect(JSON.parse(acked.stdout)).toMatchObject({ messageKey: "outbound-1", recipientId: "$recipient", acked: true, ackedBy: "$recipient" });
      expect(JSON.parse(acked.stdout).ackedAtMs).toEqual(expect.any(Number));
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("beaded sends expect replies by default with explicit opt-out", () => {
    const dir = mkdtempSync(join(tmpdir(), "xtmux-reply-expectation-"));
    const dbPath = join(dir, "observability.db");
    const db = openDb({ dbPath, mode: "on", busyTimeoutMs: 3000 });
    migrate(db);
    db.close();
    try {
      expect(run(dbPath, ["message-send", "--to", "$r", "--from", "$s", "--bead", "work-1", "--text", "task", "--message-key", "expected"]).exitCode).toBe(0);
      expect(run(dbPath, ["message-send", "--to", "$r", "--from", "$s", "--bead", "work-1", "--expects-reply", "false", "--text", "fyi", "--message-key", "opt-out"]).exitCode).toBe(0);
      expect(JSON.parse(run(dbPath, ["message-status", "expected"]).stdout).expectsReply).toBe(true);
      expect(JSON.parse(run(dbPath, ["message-status", "opt-out"]).stdout).expectsReply).toBe(false);
      const rows = JSON.parse(run(dbPath, ["message-list", "--for", "$r", "--unacked", "--expects-reply", "--json"]).stdout);
      expect(rows.map((row: { messageKey: string }) => row.messageKey)).toEqual(["expected"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("picker consumes a separated false value for expects-reply", () => {
    const dir = mkdtempSync(join(tmpdir(), "xtmux-picker-boolean-"));
    const dbPath = join(dir, "observability.db");
    const db = openDb({ dbPath, mode: "on", busyTimeoutMs: 3000 });
    migrate(db);
    db.close();
    try {
      const result = spawnSync(PICKER, [
        "message-send", "--to", "parent", "--from", "child", "--bead", "work-1",
        "--expects-reply", "false", "--text", "turn done", "--id", "picker-fyi", "--json",
      ], {
        cwd: ROOT,
        env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined, XTMUX_OBS_DB_PATH: dbPath, XTMUX_OBS_V2: "1" },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(String(result.stdout))).toMatchObject({ messageKey: "picker-fyi", expectsReply: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("picker exposes V2 JSON queries and rejects them in V1 mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "xtmux-picker-query-"));
    const dbPath = join(dir, "observability.db");
    const bin = join(dir, "bin");
    const db = openDb({ dbPath, mode: "on", busyTimeoutMs: 3000 });
    migrate(db);
    try {
      sendMessage(db, { messageKey: "picker-key", senderId: "$sender", recipientId: "$mock", summary: "hello" });
      mkdirSync(bin);
      writeFileSync(join(bin, "tmux"), "#!/bin/sh\nprintf '$mock\\n'\n");
      chmodSync(join(bin, "tmux"), 0o755);
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMUX: "/mock/socket,1,0", XTMUX_OBS_DB_PATH: dbPath, XTMUX_OBS_V2: "1" };
      const status = spawnSync(PICKER, ["message-status", "picker-key"], { cwd: ROOT, env, encoding: "utf8" });
      expect(status.status).toBe(0);
      expect(JSON.parse(String(status.stdout))).toMatchObject({ messageKey: "picker-key", recipientId: "$mock", acked: false });
      const count = spawnSync(PICKER, ["unread-count", "--for", "recipient"], { cwd: ROOT, env, encoding: "utf8" });
      expect(JSON.parse(String(count.stdout))).toMatchObject({ recipientId: "$mock", unreadCount: 1 });
      const v1 = spawnSync(PICKER, ["message-status", "picker-key"], { cwd: ROOT, env: { ...env, XTMUX_OBS_V2: "0" }, encoding: "utf8" });
      expect(v1.status).toBe(2);
      expect(String(v1.stderr)).toContain("requires XTMUX_OBS_V2=1");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unread count is recipient-scoped and unknown status is bounded", () => {
    const dir = mkdtempSync(join(tmpdir(), "xtmux-unread-query-"));
    const dbPath = join(dir, "observability.db");
    const db = openDb({ dbPath, mode: "on", busyTimeoutMs: 3000 });
    migrate(db);
    try {
      sendMessage(db, { messageKey: "for-a", senderId: "$sender", recipientId: "$a", summary: "a" });
      sendMessage(db, { messageKey: "for-b", senderId: "$sender", recipientId: "$b", summary: "b" });
      expect(JSON.parse(run(dbPath, ["unread-count", "--for", "$a"]).stdout)).toMatchObject({ recipientId: "$a", unreadCount: 1 });
      expect(JSON.parse(run(dbPath, ["unread-count", "--for", "$b"]).stdout)).toMatchObject({ recipientId: "$b", unreadCount: 1 });
      expect(JSON.parse(run(dbPath, ["unread-count", "--for", "$none"]).stdout)).toEqual({ recipientId: "$none", unreadCount: 0, oldestUnackedAtMs: null });

      const unknown = run(dbPath, ["message-status", "missing"]);
      expect(unknown.exitCode).toBe(5);
      expect(unknown.stdout).toBe("");
      expect(unknown.stderr).toContain("unknown message key");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
