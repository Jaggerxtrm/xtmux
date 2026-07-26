// xtrm-wiy5n.4.24: message-list / unread-count may be called without --for
// when running under tmux. A Claude Stop / PostToolUse hook only carries
// TMUX_PANE and previously had to look up its own session_id first; the fix
// lets the hook query its pane-scoped inbox in one call:
//
//   xtmux message-list --pane "$TMUX_PANE" --unacked --expects-reply --json
//
// Locked-in invariants:
//   1. --for omitted + live tmux -> resolved from liveTmuxRequester (same
//      helper message-reply / ack / cancel already use, so parity holds).
//   2. --for omitted + no tmux -> a clear structured error, not a stack.
//   3. Explicit --for still works — no behavior change for Pi or any caller
//      that already passes it.
//   4. --pane still filters explicitly; nothing here auto-scopes the query
//      without --pane, so a caller that forgets --pane still gets the
//      full-session projection they used to get.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { openDb } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/schema.ts";
import { sendMessage } from "../../src/domains/messages/send.ts";

const ROOT = join(import.meta.dir, "../..");
const CLI = join(ROOT, "src/cli.ts");

interface Ctx {
  root: string;
  dbPath: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

function setup(): Ctx {
  const root = mkdtempSync(join(tmpdir(), "xtmux-live-for-"));
  const bin = join(root, "bin");
  const dbPath = join(root, "state", "observability.db");
  for (const dir of [bin, join(root, "state"), join(root, "runtime"), join(root, "tmp"), join(root, "tmux")]) {
    mkdirSync(dir, { recursive: true });
  }
  // Minimal tmux mock — captureRuntimeContext reads $TMUX + display-message
  // for #{session_id}/#{pane_id}; the CLI's own live-tmux resolver then
  // validates result.origin.tmux_pane_id === process.env.TMUX_PANE.
  writeFileSync(join(bin, "tmux"), `#!/bin/bash
set -u
target=""; previous=""
for arg in "$@"; do [ "$previous" = -t ] && target="$arg"; previous="$arg"; done
format="\${!#}"
session="\${MOCK_SESSION:-\\$owner}"; pane="\${MOCK_PANE:-%me}"
case "$target" in
  %me|'$owner') pane='%me'; session='$owner' ;;
  %other|'$other') pane='%other'; session='$other' ;;
esac
case "$1" in
  display-message)
    case "$format" in
      *'#{session_id}'*'#{window_id}'*'#{pane_id}'*) printf '%s\\t@w\\t%s\\t\\t\\t\\t1\\n' "$session" "$pane" ;;
      '#{session_id}') printf '%s\\n' "$session" ;;
      '#{pane_id}') printf '%s\\n' "$pane" ;;
      '#{pane_current_command}') printf 'claude\\n' ;;
      '#{pane_pid}') printf '%s\\n' "$$" ;;
      '#S') printf '%s\\n' "\${session#\\$}" ;;
      *) : ;;
    esac ;;
  show-options) printf '%s\\n' "\${MOCK_STATE:-done}" ;;
  send-keys|set-option|capture-pane) : ;;
  *) : ;;
esac
`);
  chmodSync(join(bin, "tmux"), 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    HOME: join(root, "home"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    TMPDIR: join(root, "tmp"),
    TMUX_TMPDIR: join(root, "tmux"),
    TMUX: join(root, "tmux.sock") + ",1,0",
    TMUX_PANE: "%me",
    MOCK_SESSION: "$owner",
    MOCK_PANE: "%me",
    XTMUX_HOST_ID: "test-host",
    XTMUX_OBS_V2: "1",
    XTMUX_OBS_V2_REPO: ROOT,
    XTMUX_OBS_DB_PATH: dbPath,
  };
  return { root, dbPath, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function seedInboundReplyRequest(dbPath: string, key: string, targetPane: string | null): void {
  const db = openDb({ dbPath, mode: "on", busyTimeoutMs: 3000 });
  migrate(db);
  sendMessage(db, {
    messageKey: key,
    senderId: "$peer",
    senderPaneId: "%peer",
    recipientId: "$owner",
    targetPaneId: targetPane ?? undefined,
    summary: `pending ${key}`,
    expectsReply: true,
  });
  db.close();
}

function run(args: string[], env: NodeJS.ProcessEnv) {
  const r = spawnSync("bun", ["run", CLI, ...args], { cwd: ROOT, env, encoding: "utf8", timeout: 15_000 });
  return { status: r.status ?? 1, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
}

describe("message-list / unread-count derive --for from live tmux (xtrm-wiy5n.4.24)", () => {
  test("message-list --pane $TMUX_PANE --unacked --expects-reply --json works without --for", () => {
    const ctx = setup();
    try {
      seedInboundReplyRequest(ctx.dbPath, "hook-target", "%me");
      // A stray reply request to a different pane must not appear when --pane
      // scopes the query to %me.
      seedInboundReplyRequest(ctx.dbPath, "other-pane", "%other");
      // A pane-agnostic (target_pane_id IS NULL) reply request must still
      // surface via --pane %me because the SQL fallback matches NULL.
      seedInboundReplyRequest(ctx.dbPath, "unpaned", null);

      const r = run(["message-list", "--pane", "%me", "--unacked", "--expects-reply", "--json"], ctx.env);
      expect(r.status).toBe(0);
      const rows: Array<Record<string, unknown>> = JSON.parse(r.stdout);
      const keys = new Set(rows.map((row) => String(row["messageKey"])));
      expect(keys.has("hook-target")).toBe(true);
      expect(keys.has("unpaned")).toBe(true);
      expect(keys.has("other-pane")).toBe(false);
      // Sanity: the projection carries the fields a reminder hook needs.
      const first = rows.find((row) => row["messageKey"] === "hook-target")!;
      expect(first).toMatchObject({ recipientId: "$owner", expectsReply: true, replyStatus: "pending" });
    } finally {
      ctx.cleanup();
    }
  }, 30_000);

  test("unread-count --pane %me works without --for", () => {
    const ctx = setup();
    try {
      seedInboundReplyRequest(ctx.dbPath, "u-a", "%me");
      seedInboundReplyRequest(ctx.dbPath, "u-b", "%me");
      seedInboundReplyRequest(ctx.dbPath, "u-c", "%other");

      const r = run(["unread-count", "--pane", "%me"], ctx.env);
      expect(r.status).toBe(0);
      const stats = JSON.parse(r.stdout);
      expect(stats).toMatchObject({ recipientId: "$owner", unreadCount: 2 });
      expect(stats.oldestUnackedAtMs).toBeGreaterThan(0);
    } finally {
      ctx.cleanup();
    }
  }, 30_000);

  test("explicit --for still works and is unchanged", () => {
    // Regression guard: Pi passes --for and MUST keep the same behavior.
    const ctx = setup();
    try {
      seedInboundReplyRequest(ctx.dbPath, "pi-shape", "%me");
      const explicit = run(["message-list", "--for", "$owner", "--pane", "%me", "--unacked", "--expects-reply", "--json"], ctx.env);
      const implicit = run(["message-list",                        "--pane", "%me", "--unacked", "--expects-reply", "--json"], ctx.env);
      expect(explicit.status).toBe(0);
      expect(implicit.status).toBe(0);
      const explicitKeys = JSON.parse(explicit.stdout).map((r: Record<string, unknown>) => r["messageKey"]);
      const implicitKeys = JSON.parse(implicit.stdout).map((r: Record<string, unknown>) => r["messageKey"]);
      expect(implicitKeys).toEqual(explicitKeys);
    } finally {
      ctx.cleanup();
    }
  }, 30_000);

  test("--for omitted without tmux fails with a structured error, not a stack", () => {
    const ctx = setup();
    try {
      // Strip TMUX + TMUX_PANE so liveTmuxRequester cannot resolve — the
      // fallback error path is the only thing under test here.
      const { TMUX: _tmux, TMUX_PANE: _pane, ...rest } = ctx.env;
      void _tmux; void _pane;
      const r = run(["message-list", "--pane", "%me", "--unacked", "--json"], rest);
      expect(r.status).not.toBe(0);
      // The error is a single JSON object so callers can parse it, not a
      // stack trace. Same shape liveTmuxRequester emits elsewhere.
      const err = JSON.parse(r.stderr);
      expect(String(err.code)).toMatch(/^XTMUX_/);
      expect(String(err.message)).toContain("message-list");

      const rc = run(["unread-count", "--pane", "%me"], rest);
      expect(rc.status).not.toBe(0);
      const errc = JSON.parse(rc.stderr);
      expect(String(errc.code)).toMatch(/^XTMUX_/);
      expect(String(errc.message)).toContain("unread-count");
    } finally {
      ctx.cleanup();
    }
  }, 30_000);
});
