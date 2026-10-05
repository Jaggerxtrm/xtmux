import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSnapshot,
  collectPanes,
  formatSnapshotRows,
  gitProbeFor,
  writeSnapshot,
  type SessionSnapshot,
} from "../../src/commands/snapshot.ts";

/** Fakes: tmux answers only what the probes ask; git answers only rev-parse. */
function fakeTmux(
  panes: Array<[string, string, string, string, string, string]>,
  opts: Record<string, string> = {},
  serverAlive = true,
) {
  const SEP = "~|~XTSEP~|~";
  return (args: string[]) => {
    if (args[0] === "list-panes") {
      return { ok: serverAlive, out: panes.map((p) => p.join(SEP)).join("\n") };
    }
    if (args[0] === "display-message") {
      return { ok: serverAlive, out: serverAlive ? "999" : "" };
    }
    if (args[0] === "show-options") {
      const pane = args[args.indexOf("-t") + 1]!;
      return { ok: true, out: opts[pane] ?? "" };
    }
    return { ok: false, out: "" };
  };
}

const fakeGit = (args: string[]) => {
  if (args.includes("rev-parse")) {
    if (args.includes("--show-toplevel")) return { ok: true, out: "/home/me/mercury/market-data" };
    if (args.includes("--abbrev-ref")) return { ok: true, out: "xt/some-branch" };
  }
  return { ok: false, out: "" };
};

describe("collectPanes", () => {
  test("captures ordered panes with repo/branch/agent state", () => {
    const tmux = fakeTmux(
      [
        ["zeta", "1", "claude", "%11", "claude", "/home/me/projects/mercury/market-data/.xtrm/worktrees/market-data-xt-claude-8qox"],
        ["alpha", "2", "shell", "%22", "zsh", "/home/me/second-mind"],
        ["alpha", "0", "claude", "%33", "claude", "/home/me/projects/mercury/economic-data/.xtrm/worktrees/economic-data-xt-claude-econ"],
      ],
      { "%11": "running" },
    );
    const panes = collectPanes(tmux, fakeGit);
    // session order first (alpha before zeta), then window index (0 before 2)
    expect(panes.map((p) => p.paneId)).toEqual(["%33", "%22", "%11"]);
    const zeta = panes.find((p) => p.paneId === "%11")!;
    expect(zeta.agentStateRaw).toBe("running");
    expect(zeta.attachSlug).toBe("market-data-xt-claude-8qox");
    expect(zeta.branch).toBe("xt/some-branch");
    const plain = panes.find((p) => p.paneId === "%22")!;
    expect(plain.agentStateRaw).toBe("");
  });

  test("server gone = empty pane list, not an error", () => {
    const panes = collectPanes(fakeTmux([], {}, false), fakeGit);
    expect(panes).toEqual([]);
  });
});

describe("gitProbeFor", () => {
  test("missing cwd is repo:null/branch:null, not a throw", () => {
    // a git that fails exactly like real git on a nonexistent -C path
    const gitFailsOnMissing = (args: string[]) =>
      existsSync(args[1]!) ? fakeGit(args) : { ok: false, out: "" };
    expect(gitProbeFor("/definitely/not/here", gitFailsOnMissing)).toEqual({ repo: null, branch: null });
  });

  test("detached HEAD is recorded verbatim as HEAD", () => {
    const detached = (args: string[]) =>
      args.includes("--abbrev-ref") ? { ok: true, out: "HEAD" } : fakeGit(args);
    expect(gitProbeFor(tmpdir(), detached)).toEqual({ repo: "/home/me/mercury/market-data", branch: "HEAD" });
  });
});

describe("writeSnapshot + roundtrip", () => {
  test("writes latest + history, caps history, renders attach hints", () => {
    const dir = mkdtempSync(join(tmpdir(), "xtmux-snap-"));
    try {
      const tmux = fakeTmux([["s", "1", "win", "%1", "claude", "/home/me/repo"]], {}, true);
      const snap: SessionSnapshot = buildSnapshot(tmux, fakeGit, 1_700_000_000_000);
      const files = writeSnapshot(snap, dir);
      expect(files[0]!.endsWith("snapshot.json")).toBe(true);
      const onDisk = JSON.parse(readFileSync(files[0]!, "utf8"));
      expect(onDisk.schema).toBe("xtmux.session-snapshot.v1");
      expect(onDisk.panes[0]!.currentCommand).toBe("claude");

      // history caps at 20, newest kept
      for (let i = 1; i <= 25; i++) {
        writeSnapshot({ ...snap, capturedAtMs: 1_700_000_000_000 + i * 1000 }, dir);
      }
      const hist = readdirSync(join(dir, "history")).filter((f) => f.endsWith(".json"));
      expect(hist.length).toBe(20);

      const lines = formatSnapshotRows(snap);
      expect(lines.some((l) => l.includes("xt attach repo"))).toBe(true);
      expect(lines.some((l) => l.includes("tmux attach -t s:1"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty snapshot says panes=0 without a table crash", () => {
    const snap = buildSnapshot(fakeTmux([], {}, false), fakeGit, 1_700_000_000_000);
    const lines = formatSnapshotRows(snap);
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain("panes=0");
  });
});
