import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const ROOT = join(import.meta.dir, "../..");
const PICKER = join(ROOT, "bin/tmux-session-picker");

type Result = { exitCode: number; stdout: string; stderr: string };

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Result {
  const result = spawnSync(command, args, { cwd: ROOT, env, encoding: "utf8" });
  return { exitCode: result.status ?? 1, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-json-coordination-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
case "$*" in
  *'show-options'*) printf '%s\\n' "\${MOCK_STATE:-done}" ;;
  *'#{pane_id}'*) printf '%%mock\\n' ;;
  *'#{session_id}'*) printf '$mock\\n' ;;
  *'#{pane_current_command}'*) printf 'pi\\n' ;;
esac
`);
  chmodSync(join(bin, "tmux"), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TMUX: "/mock/tmux.sock,1,0",
    TMUX_PANE: "%mock",
    XTMUX_OBS_V2: "1",
    XTMUX_OBS_V2_REPO: ROOT,
    XTMUX_OBS_DB_PATH: join(dir, "observability.db"),
  };
  return { dir, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function cli(args: string[], env: NodeJS.ProcessEnv): Result {
  return run("bun", ["run", "src/cli.ts", ...args], env);
}

describe("coordination JSON", () => {
  test("message send/list/ack expose durable structured results and idempotency", () => {
    const ctx = setup();
    try {
      const sendArgs = ["message-send", "--json", "--message-key", "m1", "--from", "$sender", "--to", "$recipient", "--from-pane", "%sender", "--to-pane", "%recipient", "--bead", "b1", "--text", "hello"];
      const sent = cli(sendArgs, ctx.env);
      expect(sent.exitCode).toBe(0);
      expect(JSON.parse(sent.stdout)).toMatchObject({ messageKey: "m1", duplicate: false, senderId: "$sender", recipientId: "$recipient", targetPaneId: "%recipient", beadId: "b1", expectsReply: true });
      expect(JSON.parse(cli(sendArgs, ctx.env).stdout).duplicate).toBe(true);

      const conflict = cli([...sendArgs.slice(0, -1), "different"], ctx.env);
      expect(conflict.exitCode).toBe(3);
      expect(conflict.stdout).toBe("");
      expect(JSON.parse(conflict.stderr)).toMatchObject({
        code: "XTMUX_MESSAGE_KEY_CONFLICT",
        detail: { messageKey: "m1" },
      });
      expect(conflict.stderr).not.toContain("MessageError:");

      const listed = JSON.parse(cli(["message-list", "--json", "--for", "$recipient"], ctx.env).stdout);
      expect(listed).toEqual([expect.objectContaining({ messageKey: "m1", senderPaneId: "%sender", senderKind: "pane", recipientKind: "pane", ackedAtMs: null, ackedBy: null })]);

      const journal = new Database(ctx.env.XTMUX_OBS_DB_PATH as string, { readonly: true });
      const payload = journal.query<{ payload_json: string }, []>("SELECT payload_json FROM event_journal WHERE type = 'messages.sent' LIMIT 1").get()?.payload_json ?? "";
      journal.close();
      expect(payload).not.toContain("hello");

      expect(JSON.parse(cli(["message-ack", "m1", "--by", "$recipient", "--json"], ctx.env).stdout)).toMatchObject({ messageKey: "m1", status: "acked", acked: true, ackedBy: "$recipient" });
      expect(JSON.parse(cli(["message-ack", "m1", "--by", "$recipient", "--json"], ctx.env).stdout).status).toBe("already-acked");
    } finally {
      ctx.cleanup();
    }
  });

  test("picker forwards message JSON without exposing payloads in mutation results", () => {
    const ctx = setup();
    try {
      const sent = run(PICKER, ["message-send", "--json", "--id", "picker-m1", "--from", "$mock", "--to", "%mock", "--bead", "b1", "--text", "private body"], ctx.env);
      expect(sent.exitCode).toBe(0);
      expect(sent.stdout).not.toContain("private body");
      expect(JSON.parse(sent.stdout)).toMatchObject({ messageKey: "picker-m1", recipientId: "$mock", targetPaneId: "%mock" });
      expect(JSON.parse(run(PICKER, ["message-list", "--json", "--for", "$mock"], ctx.env).stdout)[0].messageKey).toBe("picker-m1");
      expect(JSON.parse(run(PICKER, ["message-ack", "picker-m1", "--by", "$mock", "--json"], ctx.env).stdout).status).toBe("acked");
    } finally {
      ctx.cleanup();
    }
  });

  test("monitor list and missing kill have bounded JSON shapes", () => {
    const ctx = setup();
    try {
      expect(cli(["migrate"], ctx.env).exitCode).toBe(0);
      expect(JSON.parse(cli(["monitor", "list", "--json"], ctx.env).stdout)).toEqual([]);
      const missing = cli(["monitor", "kill", "--id", "missing", "--json"], ctx.env);
      expect(missing.exitCode).toBe(1);
      expect(missing.stdout).toBe("");
      expect(JSON.parse(missing.stderr)).toEqual({ code: "XTMUX_MONITOR_NOT_FOUND", message: "monitor not found: missing", detail: { monitorId: "missing" } });

      expect(cli(["monitor", "register", "--id", "done", "--target", "target", "--pane", "%mock", "--state", "done", "--interval", "1"], ctx.env).exitCode).toBe(0);
      expect(cli(["monitor", "terminate", "--id", "done", "--status", "done"], ctx.env).exitCode).toBe(0);
      const terminal = cli(["monitor", "kill", "--id", "done", "--json"], ctx.env);
      expect(terminal.exitCode).toBe(4);
      expect(JSON.parse(terminal.stderr)).toMatchObject({ code: "XTMUX_MONITOR_TERMINAL", detail: { monitorId: "done", terminalStatus: "done" } });
    } finally {
      ctx.cleanup();
    }
  });

  test("picker wait-agent emits epoch-ms JSON without changing completion semantics", () => {
    const ctx = setup();
    try {
      const result = run(PICKER, ["wait-agent", "%mock", "--json", "--interval", "1"], ctx.env);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ target: "%mock", paneId: "%mock", state: "done", status: "done", intervalMs: 1000 });
      expect(typeof JSON.parse(result.stdout).startedAtMs).toBe("number");
      expect(typeof JSON.parse(result.stdout).completedAtMs).toBe("number");
    } finally {
      ctx.cleanup();
    }
  });

  test("picker guarded coordination returns one JSON object and preserves refusal codes", () => {
    const ctx = setup();
    try {
      const dryRun = run(PICKER, ["safe-send-pointer", "--json", "%mock", "/tmp/task.txt"], ctx.env);
      expect(JSON.parse(dryRun.stdout)).toMatchObject({ target: "%mock", paneId: "%mock", state: "done", sent: false });

      const handoff = run(PICKER, ["handoff", "--json", "--target", "%mock", "--bead", "xtmux-d0a.2", "--file", join(ctx.dir, "handoff.txt")], ctx.env);
      expect(JSON.parse(handoff.stdout)).toMatchObject({ target: "%mock", paneId: "%mock", beadId: "xtmux-d0a.2", sent: false });

      const refused = run(PICKER, ["safe-send-pointer", "--json", "%mock", "/tmp/task.txt"], { ...ctx.env, MOCK_STATE: "working" });
      expect(refused.exitCode).toBe(75);
      expect(refused.stdout).toBe("");
      expect(JSON.parse(refused.stderr).code).toBe("XTMUX_TARGET_WORKING");
    } finally {
      ctx.cleanup();
    }
  });

  test("wait timeout preserves rc 124 with structured stderr", () => {
    const ctx = setup();
    try {
      const result = run(PICKER, ["wait-agent", "%mock", "--json", "--timeout", "1", "--interval", "1"], { ...ctx.env, MOCK_STATE: "working" });
      expect(result.exitCode).toBe(124);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({ code: "XTMUX_WAIT_TIMEOUT", detail: { command: "wait-agent" } });
    } finally {
      ctx.cleanup();
    }
  });

  test("cancelling a wait leaves no coordination state", async () => {
    const ctx = setup();
    try {
      const proc = Bun.spawn([PICKER, "wait-agent", "%mock", "--json", "--interval", "5"], {
        cwd: ROOT,
        env: { ...ctx.env, MOCK_STATE: "working" },
        stdout: "pipe",
        stderr: "pipe",
      });
      await Bun.sleep(100);
      proc.kill("SIGTERM");
      expect(await proc.exited).not.toBe(0);
      expect(existsSync(ctx.env.XTMUX_OBS_DB_PATH as string)).toBe(false);
    } finally {
      ctx.cleanup();
    }
  });
});
