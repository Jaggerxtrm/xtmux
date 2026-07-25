import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const CLI = join(ROOT, "src/cli.ts");
const HOOK = join(ROOT, "hooks/claude/claude-agent-turn-capture.mjs");
const PICKER = join(ROOT, "bin/tmux-session-picker");
const dirs: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xtmux-turn-context-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  dirs.push(root);
  writeFileSync(join(bin, "tmux"), `#!/bin/bash
case "\${!#}" in
  *session_id*window_id*pane_id*) printf '$42\\t@7\\t%%9\\t\\tbead-1\\t\\t123\\n' ;;
  '#{session_id}') printf '$42\\n' ;;
  '#S') printf 'contract\\n' ;;
  '@agent_bead') printf 'bead-1\\n' ;;
  *) : ;;
esac
`);
  writeFileSync(join(bin, "picker"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "tmux"), 0o755);
  chmodSync(join(bin, "picker"), 0o755);
  return {
    root,
    bin,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TMUX: "/tmp/tmux-1000/default,1234,0",
      TMUX_PANE: "%9",
      XTMUX_HOST_ID: "contract-host",
    },
  };
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, input?: string) {
  return spawnSync(command, args, { cwd: ROOT, env, input, encoding: "utf8" });
}

async function peakRssKib(transcript: string, env: NodeJS.ProcessEnv): Promise<number> {
  const child = spawn(process.execPath, [HOOK], { cwd: ROOT, env, stdio: ["pipe", "ignore", "ignore"] });
  child.stdin.end(JSON.stringify({ transcript_path: transcript }));
  const exited = new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
  let peak = 0;
  while (child.exitCode === null) {
    try {
      const match = readFileSync(`/proc/${child.pid}/status`, "utf8").match(/^VmRSS:\s+(\d+) kB$/m);
      peak = Math.max(peak, Number(match?.[1] ?? 0));
    } catch {
      // The process exited between the liveness check and the proc read.
    }
    await Bun.sleep(1);
  }
  await exited;
  return peak;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("P2 turn capture and runtime context contracts", () => {
  test("context reports the TMUX socket path as tmux_server_id", () => {
    const ctx = fixture();
    const result = run("bun", [CLI, "context", "--current", "--json"], ctx.env);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).tmux_server_id).toBe("/tmp/tmux-1000/default");
  });

  test("empty transcripts still create an agent-last row", () => {
    const ctx = fixture();
    const transcript = join(ctx.root, "empty.jsonl");
    const db = join(ctx.root, "observability.db");
    writeFileSync(transcript, "");
    const env = {
      ...ctx.env,
      XTMUX_PICKER: PICKER,
      XTMUX_OBS_V2: "1",
      XTMUX_OBS_V2_REPO: ROOT,
      XTMUX_OBS_DB_PATH: db,
    };

    expect(run(process.execPath, [HOOK], env, JSON.stringify({ transcript_path: transcript })).status).toBe(0);
    const result = run(PICKER, ["agent-last", "%9", "--json"], env);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ paneId: "%9", summary: "", lastMessageText: null });
  });

  test("a 100 MB transcript adds less than 5 MB peak RSS", async () => {
    if (process.platform !== "linux") return;
    const ctx = fixture();
    const line = `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "done" } })}\n`;
    const small = join(ctx.root, "small.jsonl");
    const large = join(ctx.root, "large.jsonl");
    writeFileSync(small, line);
    writeFileSync(large, "");
    truncateSync(large, 100 * 1024 * 1024);
    appendFileSync(large, `\n${line}`);
    const env = { ...ctx.env, XTMUX_PICKER: join(ctx.bin, "picker") };

    const baseline = await peakRssKib(small, env);
    const largePeak = await peakRssKib(large, env);
    expect(largePeak - baseline).toBeLessThan(5 * 1024);
  });
});
