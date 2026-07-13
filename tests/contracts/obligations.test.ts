import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const ROOT = join(import.meta.dir, "../..");
const CLI = join(ROOT, "src/cli.ts");

describe("obligations list (.35)", () => {
  test("lists only the selected pane without opening the database", () => {
    const runtime = mkdtempSync(join(tmpdir(), "xtmux-obligations-"));
    const dir = join(runtime, "xtmux-reply-obligations");
    mkdirSync(dir);
    const marker = (paneId: string, messageKey: string) => JSON.stringify({
      senderId: "$sender", messageKey, beadId: "work-35", summary: "reply", acceptedAtMs: 1000, paneId,
    });
    writeFileSync(join(dir, "reply-to-$sender-for-%1_pending"), marker("%1", "mine"));
    writeFileSync(join(dir, "reply-to-$sender-for-%2_pending"), marker("%2", "other"));
    try {
      const result = spawnSync("bun", [CLI, "obligations", "list", "--pane", "%1"], {
        cwd: ROOT,
        env: { ...process.env, XDG_RUNTIME_DIR: runtime, XTMUX_REPLY_OBLIGATION_TTL_MS: "9999999999999" },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([{
        sender: "$sender", beadId: "work-35", messageKey: "mine", summary: "reply",
        createdAtMs: 1000, expiresAtMs: 10000000000999,
      }]);
    } finally {
      rmSync(runtime, { recursive: true, force: true });
    }
  });
});
