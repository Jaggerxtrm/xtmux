import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function normalize(output: string): string {
  return output
    .replace(/\d{4}-\d\d-\d\dT[^\t\n]+(?=\t)/g, "<TIMESTAMP>")
    .replace(/\t\d+[smhd]\t/g, "\t<AGE>\t");
}

function setupMockTmux(): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-differential-"));
  const bin = join(dir, "mock-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
case "$*" in
  *'#{pane_id}'*) printf '%%mock\\n' ;;
  *'#{session_id}'*) printf '$mock\\n' ;;
esac
`);
  chmodSync(join(bin, "tmux"), 0o755);
  return { dir, bin };
}

function modeEnv(dir: string, bin: string, mode: "0" | "1"): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TMUX: "/mock/tmux.sock,99999,0",
    XDG_STATE_HOME: join(dir, `state-${mode}`),
    XTMUX_EVENT_LOG_FILE: join(dir, `events-${mode}.jsonl`),
    XTMUX_OBS_DB_PATH: join(dir, `observability-${mode}.db`),
    XTMUX_OBS_V2: mode,
    XTMUX_OBS_V2_REPO: ROOT,
  };
}

function send(dir: string, bin: string, mode: "0" | "1"): Result {
  return run(PICKER, ["message-send", "--id", "message-1", "--to", "recipient", "--from", "sender", "--bead", "bead-1", "--text", "hello"], modeEnv(dir, bin, mode));
}

describe("V1/V2 picker differential", () => {
  test("message-send and message-list agree after volatile timestamp normalization", () => {
    const { dir, bin } = setupMockTmux();
    try {
      expect(send(dir, bin, "1")).toEqual(send(dir, bin, "0"));
      const v1 = run(PICKER, ["message-list", "--for", "recipient"], modeEnv(dir, bin, "0"));
      const v2 = run(PICKER, ["message-list", "--for", "recipient"], modeEnv(dir, bin, "1"));
      expect({ ...v2, stdout: normalize(v2.stdout) }).toEqual({ ...v1, stdout: normalize(v1.stdout) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // xtmux-3xs.27: V2 message-list must emit local-tz ISO with a colon
  // offset (matches `date -Is`), not UTC-Z. Previously fmtTsIso used
  // toISOString() → UTC-Z, which recorded a false divergence on every
  // message-list under XTMUX_OBS_V2=shadow. Byte-parity on the timestamp
  // column is required for cutover.
  test("message-list timestamp column is local-tz ISO with colon offset (matches V1)", () => {
    const { dir, bin } = setupMockTmux();
    try {
      send(dir, bin, "0");
      send(dir, bin, "1");
      const v1 = run(PICKER, ["message-list", "--for", "recipient", "--unacked"], modeEnv(dir, bin, "0"));
      const v2 = run(PICKER, ["message-list", "--for", "recipient", "--unacked"], modeEnv(dir, bin, "1"));
      // Column 3 (1-indexed) of each row is the ISO timestamp.
      const tsCol = (out: string): string => {
        const line = out.trim().split("\n")[0] ?? "";
        return line.split("\t")[2] ?? "";
      };
      const v1Ts = tsCol(v1.stdout);
      const v2Ts = tsCol(v2.stdout);
      // Both must match a local-tz ISO with a colon-separated offset.
      const localTzIsoColon = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/;
      expect(v1Ts).toMatch(localTzIsoColon);
      expect(v2Ts).toMatch(localTzIsoColon);
      // Neither may be UTC-Z.
      expect(v1Ts).not.toContain("Z");
      expect(v2Ts).not.toContain("Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unacked list and successful ack preserve V1 rows and keys", () => {
    const { dir, bin } = setupMockTmux();
    try {
      send(dir, bin, "0");
      send(dir, bin, "1");
      const v1List = run(PICKER, ["message-list", "--for", "recipient", "--unacked"], modeEnv(dir, bin, "0"));
      const v2List = run(PICKER, ["message-list", "--for", "recipient", "--unacked"], modeEnv(dir, bin, "1"));
      expect({ ...v2List, stdout: normalize(v2List.stdout) }).toEqual({ ...v1List, stdout: normalize(v1List.stdout) });
      const ack = ["message-ack", "message-1", "--by", "recipient"];
      expect(run(PICKER, ack, modeEnv(dir, bin, "1"))).toEqual(run(PICKER, ack, modeEnv(dir, bin, "0")));
      expect(run(PICKER, ack, modeEnv(dir, bin, "1"))).toEqual(run(PICKER, ack, modeEnv(dir, bin, "0")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("audit stable output matches V1 after the same deterministic sort", () => {
    const header = "audit\tread-only\twarnings-and-cleanup-candidates";
    const rowsA = `${header}\nwarning\tz-kind\t$2\tzeta\tpath=/z\ncleanup\ta-kind\t$1\talpha\tpath=/a`;
    const rowsB = `${header}\ncleanup\ta-kind\t$1\talpha\tpath=/a\nwarning\tz-kind\t$2\tzeta\tpath=/z`;
    const invoke = (mode: "off" | "on", rows: string): Result => run("bash", ["-c", `
      source <(awk '/^case "\\$\\{1:-\\}" in/{exit} {print}' "$1")
      MODE="$2"; ROWS="$3"
      obs_v2_mode() { REPLY="$MODE"; }
      obs_available() { return 0; }
      obs_call() { :; }
      current_tmux_session_id() { REPLY='$mock'; }
      audit_walk() { printf '%s\\n' "$ROWS"; }
      audit ${mode === "on" ? "--stable" : ""}
    `, "bash", PICKER, mode, rows], process.env);
    const v1 = invoke("off", rowsA);
    const v2A = invoke("on", rowsA);
    const v2B = invoke("on", rowsB);
    const normalizeAudit = (output: string): string => {
      const [first, ...rest] = output.trim().split("\n");
      return [first, ...rest.sort()].join("\n") + "\n";
    };
    expect(v1.exitCode).toBe(0);
    expect(v2A).toEqual(v2B);
    expect(v2A.stdout).toBe(normalizeAudit(v1.stdout));
  });
});
