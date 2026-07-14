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

describe("obligations list ownership", () => {
  test("requires live pane context and never discloses another pane summary", () => {
    const runtime = mkdtempSync(join(tmpdir(), "xtmux-obligations-"));
    const bin = join(runtime, "bin");
    const dbPath = join(runtime, "obs.db");
    mkdirSync(bin);
    writeFileSync(join(bin, "tmux"), "#!/bin/sh\nprintf '%s\\t@w\\t%s\\t\\t\\t\\t\\n' \"${MOCK_SESSION}\" \"${MOCK_PANE}\"\n");
    chmodSync(join(bin, "tmux"), 0o755);
    const db = openDb({ dbPath, mode: "on", busyTimeoutMs: 3000 });
    migrate(db);
    sendMessage(db, {
      messageKey: "private-owner",
      senderId: "$owner",
      senderPaneId: "%owner",
      recipientId: "$worker",
      targetPaneId: "%worker",
      summary: "private summary",
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
      const result = spawnSync("bun", [CLI, "obligations", "list", "--pane", "%owner", "--json"], {
        cwd: ROOT,
        env,
        encoding: "utf8",
      });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({ code: "XTMUX_WRONG_PANE" });
      expect(result.stderr).not.toContain("private summary");
    } finally {
      rmSync(runtime, { recursive: true, force: true });
    }
  });
});
