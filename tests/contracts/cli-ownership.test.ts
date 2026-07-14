import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { openDb } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/schema.ts";
import { sendMessage } from "../../src/domains/messages/send.ts";

const ROOT = join(import.meta.dir, "../..");
const CLI = join(ROOT, "src/cli.ts");

type Result = { status: number; stdout: string; stderr: string };

function run(args: string[], env: NodeJS.ProcessEnv): Result {
  const result = spawnSync("bun", [CLI, ...args], { cwd: ROOT, env, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

describe("durable message ownership", () => {
  test("rejects foreign reply, reply-to send, cancel, and obligation disclosure without mutation", () => {
    const runtime = mkdtempSync(join(tmpdir(), "xtmux-cli-ownership-"));
    const bin = join(runtime, "bin");
    const dbPath = join(runtime, "obs.db");
    mkdirSync(bin);
    writeFileSync(join(bin, "tmux"), "#!/bin/sh\nprintf '%s\\t@w\\t%s\\t\\t\\t\\t\\n' \"${MOCK_SESSION}\" \"${MOCK_PANE}\"\n");
    chmodSync(join(bin, "tmux"), 0o755);
    const db = openDb({ dbPath, mode: "on", busyTimeoutMs: 3000 });
    migrate(db);
    sendMessage(db, {
      messageKey: "reply-target",
      senderId: "$owner",
      senderPaneId: "%owner",
      recipientId: "$worker",
      targetPaneId: "%worker",
      summary: "private request",
      expectsReply: true,
    });
    sendMessage(db, {
      messageKey: "cancel-target",
      senderId: "$owner",
      senderPaneId: "%owner",
      recipientId: "$worker",
      targetPaneId: "%worker",
      summary: "private cancel",
      expectsReply: true,
    });
    db.close();
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TMUX: "/tmp/private.sock,1,0",
      TMUX_PANE: "%foreign",
      MOCK_SESSION: "$foreign",
      MOCK_PANE: "%foreign",
      XTMUX_OBS_V2: "1",
      XTMUX_OBS_DB_PATH: dbPath,
      XDG_STATE_HOME: join(runtime, "state"),
    };
    try {
      const rejected = [
        run(["message-reply", "--in-reply-to", "reply-target", "--text", "forged", "--json"], env),
        run(["message-send", "--to", "$owner", "--from", "$foreign", "--to-pane", "%owner", "--reply-to", "reply-target", "--message-key", "forged", "--text", "forged", "--json"], env),
        run(["message-cancel", "--message-key", "cancel-target", "--json"], env),
        run(["obligations", "list", "--pane", "%owner", "--json"], env),
      ];
      expect(rejected.map((result) => result.status)).toEqual([4, 4, 4, 2]);
      expect(rejected.map((result) => JSON.parse(result.stderr).code)).toEqual([
        "XTMUX_WRONG_RECIPIENT",
        "XTMUX_WRONG_RECIPIENT",
        "XTMUX_WRONG_RECIPIENT",
        "XTMUX_WRONG_PANE",
      ]);
      expect(rejected.every((result) => !result.stdout.includes("private"))).toBe(true);
      const readonly = new Database(dbPath, { readonly: true });
      expect(readonly.query("SELECT message_key, fulfilled_at_ms, cancelled_at_ms FROM messages ORDER BY id").all()).toEqual([
        { message_key: "reply-target", fulfilled_at_ms: null, cancelled_at_ms: null },
        { message_key: "cancel-target", fulfilled_at_ms: null, cancelled_at_ms: null },
      ]);
      expect(readonly.query("SELECT COUNT(*) AS count FROM messages WHERE message_key = 'forged'").get()).toEqual({ count: 0 });
      readonly.close();
    } finally {
      rmSync(runtime, { recursive: true, force: true });
    }
  });
});
