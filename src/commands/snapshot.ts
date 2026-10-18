/**
 * Durable tmux session snapshot (XTMUX-491).
 *
 * tmux keeps no on-disk inventory: sessions, panes, their cwd and the worktree
 * they belong to vanish with the server (OOM, reboot, kill-server). The picker
 * survives that, but recovery does not — nobody remembers which agents were
 * open in which worktrees.
 *
 * `snapshot-sessions` captures the live inventory to XDG_STATE/xtmux/sessions/:
 *   - snapshot.json                 canonical latest (atomic tmp+rename)
 *   - history/snapshot-<ts>.json    timestamped history, capped to 20 files
 * `sessions` prints the ordered inventory — live tmux, or the last snapshot
 * with `--snapshot <path>` — with `xt attach` / `tmux attach` recovery hints.
 *
 * tmux and git are injectable so the logic is testable without either.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

type TmuxRunner = (args: string[]) => { ok: boolean; out: string };
type GitRunner = (args: string[]) => { ok: boolean; out: string };

export const realTmux: TmuxRunner = (args) => {
  const r = spawnSync("tmux", args, { encoding: "utf8" });
  return { ok: (r.status ?? 0) === 0, out: (r.stdout ?? "").trim() };
};

export const realGit: GitRunner = (args) => {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return { ok: (r.status ?? 0) === 0, out: (r.stdout ?? "").trim() };
};

/** One pane row of the snapshot, ordered. */
export interface SessionPane {
  session: string;
  windowIndex: number;
  windowName: string;
  paneId: string;
  currentCommand: string;
  cwd: string;
  /** repo top-level; null outside a git tree */
  repo: string | null;
  /** branch — for a linked worktree, the branch it carries; null when detached/unknown */
  branch: string | null;
  /** xt attach slug: worktree dir basename (or repo dir name) */
  attachSlug: string | null;
  /** raw @agent_state pane option; "" when unset (tmux.ts semantics) */
  agentStateRaw: string;
}

export interface SessionSnapshot {
  schema: "xtmux.session-snapshot.v1";
  capturedAtMs: number;
  serverAlive: boolean;
  /** tmux server pid (#{pid}); null when no server runs */
  serverPid?: number | null;
  /** tmux server start time (#{start_time}, epoch seconds); null when no server runs */
  serverStartTime?: number | null;
  panes: SessionPane[];
}

export function snapshotDir(): string {
  const xdg = process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state");
  return join(xdg, "xtmux", "sessions");
}

export function snapshotPath(): string {
  return join(snapshotDir(), "snapshot.json");
}

const HISTORY_KEEP = 20;
// tmux escapes control characters in format output when rendering, so the
// row separator must be a printable string neither tmux nor paths will emit.
const SEP = "~|~XTSEP~|~";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const a: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const nxt = argv[i + 1];
      const isValue = nxt !== undefined && !nxt.startsWith("--");
      a[key] = isValue ? nxt! : true;
      if (isValue) i++;
    } else {
      a[t] = true;
    }
  }
  return a;
}

/**
 * git probe for one cwd: repo root + branch in two calls (no libgit2, no
 * submodule walking). Detached HEAD records "HEAD" verbatim — it is honest
 * and tells recovery the tree was hot.
 */
export function gitProbeFor(cwd: string, git: GitRunner): { repo: string | null; branch: string | null } {
  if (!cwd) return { repo: null, branch: null };
  const top = git(["-C", cwd, "rev-parse", "--show-toplevel"]);
  const br = git(["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
  const repo = top.ok && top.out ? top.out.split("\n")[0] : null;
  const branch = br.ok && br.out ? br.out.split("\n")[0] : null;
  return { repo, branch };
}

export function collectPanes(tmux: TmuxRunner, git: GitRunner): SessionPane[] {
  const fmt = [
    "#{session_name}",
    "#{window_index}",
    "#{window_name}",
    "#{pane_id}",
    "#{pane_current_command}",
    "#{pane_current_path}",
  ].join(SEP);
  const server = tmux(["list-panes", "-a", "-F", fmt]);
  const panes: SessionPane[] = [];
  if (!server.ok) return panes;
  const stateCache = new Map<string, string>();
  for (const line of server.out.split("\n")) {
    const [session, windowIndex, windowName, paneId, currentCommand, cwd] = line.split(SEP);
    if (!session || !paneId) continue;
    // One state probe per pane, cached on the id — raw @agent_state only; the
    // timestamped staleness rule lives in tmux.ts where consumers need it.
    let state = stateCache.get(paneId);
    if (state === undefined) {
      const s = tmux(["show-options", "-p", "-t", paneId, "-qv", "@agent_state"]);
      state = s.ok ? s.out : "";
      stateCache.set(paneId, state);
    }
    const { repo, branch } = gitProbeFor(cwd ?? "", git);
    panes.push({
      session,
      windowIndex: Number(windowIndex),
      windowName: windowName ?? "",
      paneId,
      currentCommand: currentCommand ?? "",
      cwd: cwd ?? "",
      repo,
      branch,
      attachSlug: cwd ? basename(cwd) : null,
      agentStateRaw: state,
    });
  }
  panes.sort((a, b) => a.session.localeCompare(b.session) || a.windowIndex - b.windowIndex);
  return panes;
}

function numOrNull(r: { ok: boolean; out: string }): number | null {
  if (!r.ok || !r.out) return null;
  const n = Number(r.out.split("\n")[0]);
  return Number.isFinite(n) ? n : null;
}

export function buildSnapshot(tmux: TmuxRunner, git: GitRunner, nowMs: number): SessionSnapshot {
  const panes = collectPanes(tmux, git);
  const pid = tmux(["display-message", "-p", "#{pid}"]);
  const started = tmux(["display-message", "-p", "#{start_time}"]);
  return {
    schema: "xtmux.session-snapshot.v1",
    capturedAtMs: nowMs,
    serverAlive: pid.ok,
    serverPid: numOrNull(pid),
    serverStartTime: numOrNull(started),
    panes,
  };
}

/** This machine's boot time in ms. /proc/stat btime first, `uptime -s` fallback. */
export function getBootTimeMs(): number | null {
  try {
    const m = readFileSync("/proc/stat", "utf8").match(/^btime\s+(\d+)/m);
    if (m) return Number(m[1]) * 1000;
  } catch {
    // non-Linux or unreadable — try uptime below
  }
  try {
    const r = spawnSync("uptime", ["-s"], { encoding: "utf8" });
    const out = (r.stdout ?? "").trim();
    if ((r.status ?? 1) === 0 && out) {
      const t = Date.parse(out.replace(" ", "T"));
      if (Number.isFinite(t)) return t;
    }
  } catch {
    // no uptime either — caller treats null as "unknown, skip the boot check"
  }
  return null;
}

export const PINNED_KEEP = 5;

export function pinnedDir(dir: string = snapshotDir()): string {
  return join(dir, "pinned");
}

function fileStamp(tsMs: number): string {
  return new Date(tsMs).toISOString().replace(/[:.]/g, "-");
}

/** True when the previous latest snapshot predates a server loss: identity
 * changed, liveness flipped true->false, or it was captured before boot. */
export function shouldPinPrev(prev: SessionSnapshot, next: SessionSnapshot, bootTimeMs: number | null): boolean {
  if (prev.serverAlive === true && next.serverAlive === false) return true;
  if ((prev.serverPid ?? null) !== (next.serverPid ?? null)) return true;
  if ((prev.serverStartTime ?? null) !== (next.serverStartTime ?? null)) return true;
  if (bootTimeMs !== null && prev.capturedAtMs < bootTimeMs) return true;
  return false;
}

/** Newest pinned pre-loss snapshot path, or null when nothing is pinned. */
export function newestPinnedPath(dir: string = snapshotDir()): string | null {
  let files: string[];
  try {
    files = readdirSync(pinnedDir(dir))
      .filter((f) => f.startsWith("pre-loss-") && f.endsWith(".json"))
      .sort();
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  return join(pinnedDir(dir), files[files.length - 1]!);
}

export function writeSnapshot(
  snap: SessionSnapshot,
  dir: string = snapshotDir(),
  bootTimeMs: number | null = getBootTimeMs(),
): string[] {
  mkdirSync(dir, { recursive: true });
  const latest = join(dir, "snapshot.json");
  // Read the previous latest BEFORE overwriting: when it predates a server
  // loss it is the exact inventory recovery needs, and cron would otherwise
  // rotate it out of history/ within 20 minutes.
  let prevRaw: string | null = null;
  let prev: SessionSnapshot | null = null;
  try {
    prevRaw = readFileSync(latest, "utf8");
    prev = JSON.parse(prevRaw) as SessionSnapshot;
  } catch {
    prevRaw = null;
    prev = null;
  }
  const tmp = join(dir, ".snapshot.json.tmp");
  writeFileSync(tmp, JSON.stringify(snap, null, 1) + "\n");
  renameSync(tmp, latest);

  if (prev && prevRaw && shouldPinPrev(prev, snap, bootTimeMs)) {
    const pinDir = pinnedDir(dir);
    mkdirSync(pinDir, { recursive: true });
    writeFileSync(join(pinDir, `pre-loss-${fileStamp(prev.capturedAtMs)}.json`), prevRaw);
    const pins = readdirSync(pinDir)
      .filter((f) => f.startsWith("pre-loss-") && f.endsWith(".json"))
      .sort();
    for (const old of pins.slice(0, Math.max(0, pins.length - PINNED_KEEP))) {
      try {
        unlinkSync(join(pinDir, old));
      } catch {
        // concurrent cron may have removed it first — nothing to recover
      }
    }
  }

  const historyDir = join(dir, "history");
  mkdirSync(historyDir, { recursive: true });
  const name = `snapshot-${fileStamp(snap.capturedAtMs)}.json`;
  writeFileSync(join(historyDir, name), JSON.stringify(snap) + "\n");
  const kept = readdirSync(historyDir).filter((f) => f.endsWith(".json")).sort();
  for (const old of kept.slice(0, Math.max(0, kept.length - HISTORY_KEEP))) {
    try {
      unlinkSync(join(historyDir, old));
    } catch {
      // concurrent cron may have removed it first — nothing to recover
    }
  }
  return [latest, join(historyDir, name)];
}

/** Ordered recovery table with xt attach hints. */
export function formatSnapshotRows(snap: SessionSnapshot): string[] {
  const lines: string[] = [];
  lines.push(`xtmux session snapshot — schema ${snap.schema}`);
  lines.push(
    `captured: ${new Date(snap.capturedAtMs).toISOString()} · serverAlive=${snap.serverAlive} · panes=${snap.panes.length}`,
  );
  if (snap.panes.length === 0) return lines;
  lines.push("");
  lines.push("session            win  pane    state   cmd        repo@branch                                      attach with");
  lines.push("─".repeat(118));
  for (const p of snap.panes) {
    const sess = p.session.slice(0, 18).padEnd(18);
    const win = String(p.windowIndex).padEnd(4);
    const pane = p.paneId.padEnd(7);
    const state = (p.agentStateRaw || "-").slice(0, 7).padEnd(8);
    const cmd = p.currentCommand.slice(0, 10).padEnd(11);
    const repoShort = p.repo ? p.repo.split("/").slice(-1)[0] : null;
    const rb = (repoShort !== null ? `${repoShort!}@${p.branch ?? "(detached)"}` : p.cwd || "-").slice(0, 49).padEnd(49);
    const xtHint = p.attachSlug ? `xt attach ${p.attachSlug}` : "—";
    lines.push(`${sess}${win}${pane}${state}${cmd}${rb}${xtHint}  ·  tmux attach -t ${p.session}:${p.windowIndex}`);
  }
  return lines;
}

export async function snapshotSessions(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  const snap = buildSnapshot(realTmux, realGit, Date.now());
  const files = writeSnapshot(snap);
  if (a["json"]) {
    process.stdout.write(JSON.stringify({ summary: true, panes: snap.panes.length, files }) + "\n");
  } else {
    for (const line of formatSnapshotRows(snap)) process.stdout.write(line + "\n");
    process.stdout.write(`\nwritten: ${files[0]}\n         ${files[1]}\n`);
  }
  return 0;
}

export async function sessionsList(argv: string[], dir: string = snapshotDir()): Promise<number> {
  const a = parseArgs(argv);
  let snap: SessionSnapshot;
  if (a["pre-loss"]) {
    const pinned = newestPinnedPath(dir);
    if (!pinned) {
      process.stdout.write("no pinned pre-loss snapshot\n");
      return 0;
    }
    snap = JSON.parse(readFileSync(pinned, "utf8")) as SessionSnapshot;
  } else if (a["snapshot"] !== undefined && a["snapshot"] !== false) {
    const path = typeof a["snapshot"] === "string" ? a["snapshot"] : join(dir, "snapshot.json");
    if (!existsSync(path)) {
      process.stderr.write(`no snapshot at ${path} — run 'xtmux-obs snapshot-sessions' while tmux is alive\n`);
      return 2;
    }
    snap = JSON.parse(readFileSync(path, "utf8")) as SessionSnapshot;
  } else {
    snap = buildSnapshot(realTmux, realGit, Date.now());
  }
  if (a["json"]) {
    process.stdout.write(JSON.stringify(snap, null, 1) + "\n");
    return 0;
  }
  for (const line of formatSnapshotRows(snap)) process.stdout.write(line + "\n");
  const live = realTmux(["display-message", "-p", "#{pid}"]);
  if (!live.ok && snap.serverAlive) {
    process.stdout.write("\n(live tmux unreachable — this is the last durable snapshot)\n");
  }
  return 0;
}
