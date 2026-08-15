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
const PROMPT_HOOK = join(ROOT, "hooks/claude/claude-user-prompt-episode.mjs");
const PICKER = join(ROOT, "bin/tmux-session-picker");
const dirs: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xtmux-turn-context-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  dirs.push(root);
  const state = join(root, "tmux-state");
  writeFileSync(join(bin, "tmux"), `#!/bin/bash
state="${state}"
case "$1" in
  set-option)
    printf '%s\\n' "$4=$5" >> "$state"
    exit 0
    ;;
esac
case "\${!#}" in
  *session_id*window_id*pane_id*) printf '$42\\t@7\\t%%9\\t\\tbead-1\\t\\t123\\n' ;;
  '#{session_id}') printf '$42\\n' ;;
  '#S') printf 'contract\\n' ;;
  '@agent_bead') printf 'bead-1\\n' ;;
  '@agent_episode_pending') grep -Fqx '@agent_episode_pending=1' "$state" && printf '1\\n' ;;
  '@agent_episode_cursor') v="$(grep -F '@agent_episode_cursor=' "$state" | tail -1)"; printf '%s\\n' "\${v#*=}" ;;
  *) : ;;
esac
`);
  writeFileSync(join(bin, "picker"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "tmux"), 0o755);
  chmodSync(join(bin, "picker"), 0o755);
  return {
    root,
    bin,
    state,
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

  test("stop continuations share one episode; a new prompt opens the next", () => {
    const ctx = fixture();
    const transcript = join(ctx.root, "transcript.jsonl");
    const db = join(ctx.root, "observability.db");
    const long = (text: string) => `${text} ${"z".repeat(230)}`;
    const line = (text: string) => `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;
    writeFileSync(transcript, line(long("response A")));
    const env = {
      ...ctx.env,
      XTMUX_PICKER: PICKER,
      XTMUX_OBS_V2: "1",
      XTMUX_OBS_V2_REPO: ROOT,
      XTMUX_OBS_DB_PATH: db,
    };
    const stopRun = (input: Record<string, unknown>) =>
      run(process.execPath, [HOOK], env, JSON.stringify({ transcript_path: transcript, ...input }));
    const episodeJson = () => {
      const result = run(PICKER, ["agent-episode", "%9", "--json"], env);
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout);
    };
    const episodeRows = () => {
      const result = run("bun", ["-e", `import { Database } from "bun:sqlite";
const db = new Database(process.env.XTMUX_OBS_DB_PATH);
console.log(JSON.stringify(db.query("SELECT id, closed_at_ms FROM agent_episodes ORDER BY id").all()));`], env);
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout);
    };

    // Turn 1: plain stop → episode 1.
    expect(stopRun({}).status).toBe(0);
    // Continuation (Stop hook block): same episode, appended as follow-up.
    appendFileSync(transcript, line(long("follow-up B")));
    expect(stopRun({ stop_hook_active: true }).status).toBe(0);

    let ep = episodeJson();
    // Continuation appended follow-up B to the same episode.
    expect(ep.primary.lastMessageText).toBe(long("response A"));
    expect(ep.followUps.map((c: { lastMessageText: string }) => c.lastMessageText)).toEqual([long("follow-up B")]);

    // Real user prompt: the UserPromptSubmit hook closes episode 1, opens 2.
    expect(run(process.execPath, [PROMPT_HOOK], env, JSON.stringify({ transcript_path: transcript })).status).toBe(0);
    appendFileSync(transcript, line(long("response C")));
    expect(stopRun({}).status).toBe(0);

    ep = episodeJson();
    expect(ep.primary.lastMessageText).toBe(long("response C"));
    expect(ep.followUps).toHaveLength(0);

    const rows = episodeRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.closed_at_ms).not.toBeNull(); // closed by the new prompt
    expect(rows[1]!.closed_at_ms).toBeNull(); // open: the current episode
  });
});
