import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSnapshot,
  collectPanes,
  formatSnapshotRows,
  gitProbeFor,
  sessionsList,
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

describe("server identity", () => {
  test("buildSnapshot records serverPid + serverStartTime, null when server down", () => {
    const alive = buildSnapshot(fakeTmux([], {}, true), fakeGit, 1_700_000_000_000);
    expect(alive.serverAlive).toBe(true);
    expect(alive.serverPid).toBe(999);
    expect(alive.serverStartTime).toBe(999);
    const dead = buildSnapshot(fakeTmux([], {}, false), fakeGit, 1_700_000_000_000);
    expect(dead.serverAlive).toBe(false);
    expect(dead.serverPid).toBeNull();
    expect(dead.serverStartTime).toBeNull();
  });
});

describe("pre-loss pinning", () => {
  const T0 = 1_700_000_000_000;
  const stamp = (ts: number) =>
    `pre-loss-${new Date(ts).toISOString().replace(/[:.]/g, "-")}.json`;
  const snapAt = (ts: number, over: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
    schema: "xtmux.session-snapshot.v1",
    capturedAtMs: ts,
    serverAlive: true,
    serverPid: 100,
    serverStartTime: 500,
    panes: [],
    ...over,
  });
  const pinnedNames = (dir: string): string[] => {
    try {
      return readdirSync(join(dir, "pinned")).filter((f) => f.endsWith(".json")).sort();
    } catch {
      return [];
    }
  };

  test("identity change pins the previous snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "xtmux-pin-"));
    try {
      writeSnapshot(snapAt(T0), dir, T0);
      writeSnapshot(snapAt(T0 + 60_000, { serverPid: 200, serverStartTime: 600 }), dir, T0);
      const names = pinnedNames(dir);
      expect(names).toEqual([stamp(T0)]);
      const pinned = JSON.parse(readFileSync(join(dir, "pinned", names[0]!), "utf8"));
      expect(pinned.serverPid).toBe(100);
      expect(pinned.capturedAtMs).toBe(T0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("live -> dead -> restarted keeps the live inventory as the newest pin", () => {
    const dir = mkdtempSync(join(tmpdir(), "xtmux-pin-"));
    try {
      const dead = { serverAlive: false, serverPid: null, serverStartTime: null };
      writeSnapshot(snapAt(T0), dir, T0);
      writeSnapshot(snapAt(T0 + 60_000, dead), dir, T0);
      writeSnapshot(snapAt(T0 + 120_000, dead), dir, T0);
      writeSnapshot(snapAt(T0 + 180_000, { serverPid: 200, serverStartTime: 900 }), dir, T0);
      expect(pinnedNames(dir)).toEqual([stamp(T0)]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("serverAlive true->false pins even when the recorded pid is unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "xtmux-pin-"));
    try {
      writeSnapshot(snapAt(T0), dir, T0);
      writeSnapshot(snapAt(T0 + 60_000, { serverAlive: false }), dir, T0);
      expect(pinnedNames(dir)).toEqual([stamp(T0)]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pre-boot snapshot pins even with identical identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "xtmux-pin-"));
    try {
      writeSnapshot(snapAt(T0), dir, null);
      writeSnapshot(snapAt(T0 + 60_000), dir, T0 + 30_000);
      expect(pinnedNames(dir)).toEqual([stamp(T0)]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("same identity does not pin", () => {
    const dir = mkdtempSync(join(tmpdir(), "xtmux-pin-"));
    try {
      writeSnapshot(snapAt(T0), dir, T0);
      writeSnapshot(snapAt(T0 + 60_000), dir, T0);
      expect(pinnedNames(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pinned files cap at the newest 5", () => {
    const dir = mkdtempSync(join(tmpdir(), "xtmux-pin-"));
    try {
      for (let i = 0; i < 7; i++) {
        writeSnapshot(snapAt(T0 + i * 60_000, { serverPid: 100 + i, serverStartTime: 500 + i }), dir, null);
      }
      // every write after the first pins its predecessor: snaps 0..5 pinned, oldest evicted
      const names = pinnedNames(dir);
      expect(names.length).toBe(5);
      expect(names).toEqual([1, 2, 3, 4, 5].map((i) => stamp(T0 + i * 60_000)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sessions --pre-loss", () => {
  const T0 = 1_700_000_000_000;
  async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
    const orig = process.stdout.write.bind(process.stdout);
    let buf = "";
    // deno-lint-ignore no-explicit-any
    (process.stdout as any).write = (chunk: any) => {
      buf += String(chunk);
      return true;
    };
    try {
      const code = await fn();
      return { code, out: buf };
    } finally {
      (process.stdout as any).write = orig;
    }
  }

  test("no pinned file: one line, exit 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xtmux-preloss-"));
    try {
      const { code, out } = await captureStdout(() => sessionsList(["--pre-loss"], dir));
      expect(code).toBe(0);
      expect(out.trim().split("\n").length).toBe(1);
      expect(out).toContain("no pinned pre-loss snapshot");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("renders the newest pinned snapshot, row format and --json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xtmux-preloss-"));
    try {
      const tmux = fakeTmux([["s", "1", "win", "%1", "claude", "/home/me/repo"]], {}, true);
      const oldSnap = buildSnapshot(tmux, fakeGit, T0);
      writeSnapshot(oldSnap, dir, T0);
      const newSnap = buildSnapshot(tmux, fakeGit, T0 + 60_000);
      (newSnap as SessionSnapshot).serverPid = 4242;
      writeSnapshot(newSnap, dir, T0);

      const text = await captureStdout(() => sessionsList(["--pre-loss"], dir));
      expect(text.code).toBe(0);
      expect(text.out).toContain("xt attach repo");
      expect(text.out).toContain("tmux attach -t s:1");

      const json = await captureStdout(() => sessionsList(["--pre-loss", "--json"], dir));
      expect(json.code).toBe(0);
      const parsed = JSON.parse(json.out);
      expect(parsed.schema).toBe("xtmux.session-snapshot.v1");
      expect(parsed.capturedAtMs).toBe(T0);
      expect(parsed.panes.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
