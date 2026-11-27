import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// XTMUX-493: the tmux kill-server guard is the one installed name that shadows a
// command the user depends on. The installer must place it as `tmux`, adopt the
// hand-installed interim guard it replaces, refuse a foreign file, be idempotent,
// and remove only what it owns.
const root = resolve(import.meta.dirname, "../..");
const installer = join(root, "scripts", "install.mjs");
const guardSource = join(root, "bin", "tmux-guard");

const isolatedEnv = (home) => ({
  ...process.env,
  HOME: home,
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_RUNTIME_DIR: join(home, "runtime"),
  TMPDIR: join(home, "tmp"),
  XTMUX_OBS_DB_PATH: join(home, ".local", "state", "xtmux", "observability.db"),
});

const run = (home, ...args) => {
  mkdirSync(join(home, "runtime"), { recursive: true });
  mkdirSync(join(home, "tmp"), { recursive: true });
  return spawnSync(process.execPath, [installer, "--home", home, ...args], {
    cwd: root, encoding: "utf8", env: isolatedEnv(home),
  });
};

const guardPath = (home) => join(home, ".local", "bin", "tmux");

// The interim guard the lead installed by hand on 2026-11-26: a small shell
// wrapper that mentions the override and the guarded command. The installer
// recognises it by those markers, not by a path or a checksum.
const handInstalledGuard = (path, extra = "") => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n# interim kill-server guard\n${extra}if [ "$1" = kill-server ] && [ -z "$TMUX_ALLOW_KILL_SERVER" ]; then exit 1; fi\nexec /usr/bin/tmux "$@"\n`);
  chmodSync(path, 0o755);
};

test("a clean install places the guard as tmux, idempotently, and uninstall removes it", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-guard-install-"));
  const dst = guardPath(home);

  const dry = run(home, "--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry-run: tmux guard plan/);
  assert.match(dry.stdout, new RegExp(`link\\s+${dst.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} -> `));
  assert.match(dry.stdout, /path\s+first tmux on PATH is/);
  assert.match(dry.stdout, /dry-run: no changes were made/);
  assert.equal(existsSync(dst), false, "a dry run writes nothing");

  const first = run(home);
  assert.equal(first.status, 0, first.stderr);
  // readlinkSync succeeds only on a symlink, and names the guard: one read, no
  // stat-then-read pair (CodeQL js/file-system-race).
  assert.equal(readlinkSync(dst), guardSource);
  assert.notEqual(statSync(guardSource).mode & 0o111, 0, "the guard is executable");
  assert.equal(existsSync(`${dst}.pre-xtmux`), false, "nothing to preserve on a clean install");

  const second = run(home);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readlinkSync(dst), guardSource);
  assert.doesNotMatch(second.stdout, /adopted/, "re-running adopts nothing");
  assert.equal(existsSync(`${dst}.pre-xtmux`), false);

  const dryAgain = run(home, "--dry-run");
  assert.match(dryAgain.stdout, new RegExp(`relink\\s+${dst.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} -> `));

  const removed = run(home, "--uninstall");
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(dst), false, "uninstall removes the guard");

  const packaged = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(packaged.files.includes("bin/tmux-guard"), "the npm package ships the guard");
  rmSync(home, { recursive: true, force: true });
});

test("a hand-installed interim guard is adopted and preserved beside the link", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-guard-adopt-"));
  const dst = guardPath(home);
  handInstalledGuard(dst, "# interim\n");
  const original = readFileSync(dst, "utf8");

  const installed = run(home);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /adopted hand-installed tmux guard/);
  assert.equal(readlinkSync(dst), guardSource);
  assert.equal(readFileSync(`${dst}.pre-xtmux`, "utf8"), original);

  const second = run(home);
  assert.equal(second.status, 0, second.stderr);
  assert.doesNotMatch(second.stdout, /adopted/);
  assert.equal(readFileSync(`${dst}.pre-xtmux`, "utf8"), original, "the preserved copy is never overwritten");

  const removed = run(home, "--uninstall");
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(dst), false);
  assert.match(removed.stdout, /kept pre-install tmux at .*tmux\.pre-xtmux/);
  rmSync(home, { recursive: true, force: true });
});

test("a foreign tmux on PATH is refused and left untouched", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-guard-refuse-"));
  const dst = guardPath(home);
  const foreign = "#!/bin/sh\nexec /usr/bin/tmux \"$@\"\n";
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(dst, foreign);
  chmodSync(dst, 0o755);

  const dry = run(home, "--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /refuse\s+.*\/\.local\/bin\/tmux/);

  const refused = run(home);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /refusing to replace existing file/);
  // Read once: content equality proves the file was neither replaced nor linked.
  assert.equal(readFileSync(dst, "utf8"), foreign);
  assert.equal(existsSync(join(home, ".local", "bin", "xtmux")), false, "preflight writes nothing before it refuses");

  // A symlink to the real tmux is also not ours to replace.
  rmSync(dst, { force: true });
  symlinkSync("/usr/bin/tmux", dst);
  const refusedLink = run(home);
  assert.notEqual(refusedLink.status, 0);
  assert.match(refusedLink.stderr, /refusing to replace existing file/);
  assert.equal(readlinkSync(dst), "/usr/bin/tmux");
  rmSync(home, { recursive: true, force: true });
});
