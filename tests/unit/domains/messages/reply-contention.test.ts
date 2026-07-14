import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../../../../src/db/connection.ts";
import { migrate } from "../../../../src/db/schema.ts";
import { sendMessage } from "../../../../src/domains/messages/send.ts";
import type { Config } from "../../../../src/config.ts";

const WORKER_SCRIPT = String.raw`
  import { existsSync, readFileSync, writeFileSync } from "node:fs";
  import { openDb } from "./src/db/connection.ts";
  import { MessageError } from "./src/domains/messages/errors.ts";
  import { replyMessage } from "./src/domains/messages/reply.ts";

  const dbPath = process.env["XTMUX_REPLY_DB"];
  const readyPath = process.env["XTMUX_REPLY_READY"];
  const startPath = process.env["XTMUX_REPLY_START"];
  const resultPath = process.env["XTMUX_REPLY_RESULT"];
  const messageKey = process.env["XTMUX_REPLY_KEY"];
  if (!dbPath || !readyPath || !startPath || !resultPath || !messageKey) {
    throw new Error("contention worker missing environment");
  }
  const db = openDb({ dbPath, mode: "off", busyTimeoutMs: 3000 });
  writeFileSync(readyPath, "ready");
  while (!existsSync(startPath)) await Bun.sleep(2);
  try {
    const result = replyMessage(db, {
      messageKey,
      replyToMessageKey: "pending-request",
      senderId: "$target",
      summary: "reply from " + messageKey,
    }, () => 2000);
    writeFileSync(resultPath, JSON.stringify({ ok: true, messageId: result.messageId }));
  } catch (error) {
    writeFileSync(resultPath, JSON.stringify({
      ok: false,
      code: error instanceof MessageError ? error.code : null,
      message: error instanceof Error ? error.message : String(error),
    }));
  } finally {
    db.close();
  }
`;

interface WorkerResult {
  ok: boolean;
  messageId?: number;
  code?: string | null;
  message?: string;
}

async function waitForFiles(paths: readonly string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!paths.every((path) => existsSync(path))) {
    if (Date.now() >= deadline) throw new Error("contention workers did not become ready");
    await Bun.sleep(5);
  }
}

function readWorkerResult(path: string): WorkerResult {
  return JSON.parse(readFileSync(path, "utf8")) as WorkerResult;
}

describe("message reply contention", () => {
  test("one concurrent reply wins and loser re-reads fulfilled state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xtmux-reply-contention-"));
    const dbPath = join(dir, "test.db");
    const startPath = join(dir, "start");
    const readyPaths = [join(dir, "a.ready"), join(dir, "b.ready")];
    const resultPaths = [join(dir, "a.result"), join(dir, "b.result")];
    const cfg: Config = { dbPath, mode: "off", busyTimeoutMs: 3000 };
    let firstDb: ReturnType<typeof openDb> | undefined = openDb(cfg);
    try {
      migrate(firstDb);
      const pending = sendMessage(firstDb, {
        messageKey: "pending-request",
        senderId: "$requester",
        recipientId: "$target",
        summary: "pending request",
        expectsReply: true,
      }, () => 1000);
      expect(pending.messageId).toBeGreaterThan(0);
      firstDb.close();
      firstDb = undefined;

      const workers = readyPaths.map((readyPath, index) => Bun.spawn(
        [process.execPath, "--eval", WORKER_SCRIPT],
        {
          cwd: process.cwd(),
          env: {
            XTMUX_REPLY_DB: dbPath,
            XTMUX_REPLY_READY: readyPath,
            XTMUX_REPLY_START: startPath,
            XTMUX_REPLY_RESULT: resultPaths[index]!,
            XTMUX_REPLY_KEY: `reply-${index}`,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      ));
      await waitForFiles(readyPaths);
      writeFileSync(startPath, "go");
      const exits = await Promise.all(workers.map((worker) => worker.exited));
      expect(exits).toEqual([0, 0]);

      const results = resultPaths.map(readWorkerResult);
      const winners = results.filter((result) => result.ok);
      const losers = results.filter((result) => !result.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]?.code).toBe("XTMUX_ALREADY_FULFILLED");
      expect(losers[0]?.message).not.toMatch(/busy|locked|snapshot/i);

      const checkDb = openDb(cfg);
      try {
        expect(checkDb.raw.query<{ n: number }, [number]>(
          "SELECT COUNT(*) AS n FROM messages WHERE reply_to_message_id = ?",
        ).get(pending.messageId)?.n).toBe(1);
        const linked = checkDb.raw.query<{ payload_json: string }, []>(
          "SELECT payload_json FROM event_journal WHERE type = 'messages.reply.linked'",
        ).all();
        expect(linked).toHaveLength(1);
        const linkedPayload = JSON.parse(linked[0]!.payload_json) as Record<string, unknown>;
        expect(linkedPayload).toMatchObject({
          message_id: winners[0]?.messageId,
          reply_to_message_id: pending.messageId,
          outcome: "fulfilled",
        });
        expect(checkDb.raw.query<{ n: number }, [number]>(
          "SELECT COUNT(*) AS n FROM event_journal WHERE type = 'messages.sent' AND json_extract(payload_json, '$.reply_to_message_id') = ?",
        ).get(pending.messageId)?.n).toBe(1);
        const rejected = checkDb.raw.query<{ payload_json: string }, []>(
          "SELECT payload_json FROM event_journal WHERE type = 'messages.reply.rejected'",
        ).all();
        expect(rejected).toHaveLength(1);
        expect(JSON.parse(rejected[0]!.payload_json)).toEqual({
          outcome: "rejected",
          error_code: "XTMUX_ALREADY_FULFILLED",
          reply_to_message_id: pending.messageId,
        });
      } finally {
        checkDb.close();
      }
    } finally {
      if (firstDb) firstDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
