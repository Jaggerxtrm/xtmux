import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, existsSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const installer = join(root, "scripts", "install.mjs");
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
  return spawnSync(process.execPath, [installer, "--home", home, ...args], { cwd: root, encoding: "utf8", env: isolatedEnv(home) });
};
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

test("clean install, idempotent update, xtrm coexistence, and uninstall", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-installer-"));
  const claude = join(home, ".claude", "settings.json");
  const pi = join(home, ".pi", "agent", "settings.json");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(claude, JSON.stringify({
    theme: "dark",
    hooks: {
      Stop: [
        { _source: "xtrm-global", hooks: [{ type: "command", command: "node /x/.xtrm/hooks/auto-monitor-stop.mjs" }] },
        { hooks: [{ type: "command", command: "user-stop" }] },
      ],
    },
  }));
  writeFileSync(pi, JSON.stringify({ packages: [
    "npm:foreign",
    "npm:@jaggerxtrm/xtmux",
    "npm:@jaggerxtrm/xtmux@1.2.3",
    { source: "npm:@jaggerxtrm/xtmux" },
    { source: "npm:@jaggerxtrm/xtmux@2.0.0" },
    { source: "npm:@jaggerxtrm/other" },
    "npm:@jaggerxtrm/xtmux-extra",
  ] }));

  const first = run(home);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^1\/5 Installing command links/m);
  assert.doesNotMatch(first.stdout, /chrome|browser/i);
  const firstClaude = readFileSync(claude, "utf8");
  const firstPi = readFileSync(pi, "utf8");

  const second = run(home);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(claude, "utf8"), firstClaude);
  assert.equal(readFileSync(pi, "utf8"), firstPi);

  const settings = json(claude);
  assert.equal(settings.theme, "dark");
  assert.equal(settings.hooks.Stop.filter((entry) => entry._source === "xtmux").length, 2);
  assert.equal(settings.hooks.Stop.filter((entry) => entry._source === "xtrm-global").length, 1);
  assert.equal(settings.hooks.Stop.filter((entry) => entry.hooks?.[0]?.command === "user-stop").length, 1);
  const commands = Object.values(settings.hooks).flat().flatMap((entry) => entry.hooks?.map((hook) => hook.command) || []);
  assert.ok(commands.some((command) => command.includes('bash "') && command.includes("auto-monitor-on-send.sh")));
  assert.ok(commands.some((command) => command.includes('bash "') && command.includes("auto-monitor-consumed.sh")));
  assert.equal(commands.some((command) => command.includes('node "') && command.includes("auto-monitor-on-send.mjs")), false);
  assert.deepEqual(readdirSync(join(home, ".claude", "hooks", "xtmux")).sort(), [
    "agent-state.sh", "auto-monitor-consumed.mjs", "auto-monitor-consumed.sh", "auto-monitor-drain-stop.mjs", "auto-monitor-on-send.mjs", "auto-monitor-on-send.sh",
  ]);
  assert.equal(
    readFileSync(join(home, ".claude", "hooks", "xtmux", "agent-state.sh"), "utf8"),
    readFileSync(join(root, "scripts", "agent-state.sh"), "utf8"),
  );
  assert.ok(json(join(root, "package.json")).files.includes("scripts/agent-state.sh"));
  const installedPackages = json(pi).packages;
  assert.deepEqual(installedPackages.slice(0, 3), ["npm:foreign", { source: "npm:@jaggerxtrm/other" }, "npm:@jaggerxtrm/xtmux-extra"]);
  assert.equal(installedPackages.filter((entry) => {
    const packageSource = typeof entry === "string" ? entry : entry?.source;
    return packageSource === "npm:@jaggerxtrm/xtmux" || packageSource?.startsWith("npm:@jaggerxtrm/xtmux@");
  }).length, 0);
  assert.equal(installedPackages.filter((entry) => typeof entry === "string" && entry.endsWith("/.pi/agent/packages/xtmux")).length, 1);
  assert.deepEqual(json(join(home, ".pi", "agent", "packages", "xtmux", "package.json")).pi.extensions, ["./extensions/pi-agent-state.ts", "./extensions/pi-auto-monitor.ts"]);
  for (const name of ["xtmux", "tmux-session-picker", "xtmux-obs", "xtmux-monitor", "xtmux-changelog"]) assert.ok(existsSync(join(home, ".local", "bin", name)));
  for (const name of ["agent-state.sh", "git-pane-status.sh"]) assert.ok(existsSync(join(home, ".tmux", "scripts", name)));

  const removed = run(home, "--uninstall");
  assert.equal(removed.status, 0, removed.stderr);
  const after = json(claude);
  assert.equal(after.theme, "dark");
  assert.equal(after.hooks.Stop.some((entry) => entry._source === "xtmux"), false);
  assert.equal(after.hooks.Stop.some((entry) => entry._source === "xtrm-global"), true);
  assert.deepEqual(json(pi).packages, ["npm:foreign", { source: "npm:@jaggerxtrm/other" }, "npm:@jaggerxtrm/xtmux-extra"]);
  rmSync(home, { recursive: true, force: true });
});

test("refuses to overwrite a foreign command", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-conflict-"));
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(join(home, ".local", "bin", "xtmux"), "foreign");
  const result = run(home);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to replace existing file/);
  rmSync(home, { recursive: true, force: true });
});


test("adopts legacy xtmux hooks without duplicating them", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-legacy-"));
  const claude = join(home, ".claude", "settings.json");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(claude, JSON.stringify({ hooks: { Stop: [
    { hooks: [{ type: "command", command: "CLAUDE_HOOK_EVENT=Stop ~/.tmux/scripts/agent-state.sh done" }] },
    { hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.xtrm/hooks/auto-monitor-drain-stop.mjs"' }] },
  ] } }));

  const result = run(home);
  assert.equal(result.status, 0, result.stderr);
  const commands = Object.values(json(claude).hooks).flat().flatMap((entry) => entry.hooks?.map((hook) => hook.command) || []);
  assert.equal(commands.some((command) => command.includes("~/.tmux/scripts/agent-state.sh")), false);
  assert.equal(commands.some((command) => command.includes("$CLAUDE_PROJECT_DIR")), false);
  assert.equal(commands.filter((command) => command.includes("auto-monitor-drain-stop.mjs")).length, 1);
  rmSync(home, { recursive: true, force: true });
});

test("leaves corrupt Claude settings untouched", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-corrupt-"));
  const claude = join(home, ".claude", "settings.json");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(claude, "{ this is not json");
  const result = run(home);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(claude, "utf8"), "{ this is not json");
  rmSync(home, { recursive: true, force: true });
});

test("xtmux-obs uses vendored Bun when system Bun is absent", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-bunless-"));
  const result = run(home);
  assert.equal(result.status, 0, result.stderr);

  const nodePath = spawnSync("sh", ["-c", "command -v node"], { encoding: "utf8" }).stdout.trim();
  assert.ok(nodePath, "node must be available for the public shim");
  const nodeDir = resolve(nodePath, "..");
  const runtime = spawnSync(join(home, ".local/bin/xtmux-obs"), ["monitor", "list", "--json"], {
    encoding: "utf8",
    env: {
      HOME: home,
      PATH: `${nodeDir}:/usr/bin:/bin`,
      XDG_STATE_HOME: join(home, ".local/state"),
    },
  });
  assert.equal(runtime.status, 0, runtime.stderr);
  assert.deepEqual(JSON.parse(runtime.stdout), []);
  rmSync(home, { recursive: true, force: true });
});

test("merges hooks for existing Codex without installing Codex CLI", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-codex-"));
  const hooks = join(home, ".codex", "hooks.json");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(hooks, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "foreign-codex-hook" }] }] } }));

  const first = run(home);
  assert.equal(first.status, 0, first.stderr);
  const once = readFileSync(hooks, "utf8");
  const installed = json(hooks);
  assert.equal(installed.hooks.SessionStart.some((entry) => entry.hooks?.[0]?.command === "foreign-codex-hook"), true);
  assert.equal(installed.hooks.SessionStart.some((entry) => entry.hooks?.[0]?.command.includes("/.codex/hooks/xtmux/agent-state.sh")), true);
  assert.equal(installed.hooks.UserPromptSubmit.some((entry) => entry.hooks?.[0]?.command.includes("/.codex/hooks/xtmux/agent-state.sh")), true);
  assert.ok(existsSync(join(home, ".codex/hooks/xtmux/agent-state.sh")));

  assert.equal(run(home).status, 0);
  assert.equal(readFileSync(hooks, "utf8"), once);
  assert.equal(run(home, "--uninstall").status, 0);
  assert.deepEqual(json(hooks).hooks, { SessionStart: [{ hooks: [{ type: "command", command: "foreign-codex-hook" }] }] });
  assert.equal(existsSync(join(home, ".codex/hooks/xtmux")), false);
  rmSync(home, { recursive: true, force: true });
});

test("upgrade reconciles a valid legacy reply marker without leaking its summary", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-upgrade-marker-"));
  const env = isolatedEnv(home);
  mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true });
  mkdirSync(env.TMPDIR, { recursive: true });
  const seed = spawnSync(process.execPath, [join(root, "scripts", "xtmux-obs.mjs"),
    "message-send", "--to", "$recipient", "--from", "$sender", "--to-pane", "%recipient", "--from-pane", "%sender",
    "--text", "installer secret", "--bead", "xtmux-3ua.8", "--expects-reply", "true", "--message-key", "installer-pending", "--json",
  ], { cwd: root, encoding: "utf8", env });
  assert.equal(seed.status, 0, seed.stderr);
  const dir = join(env.XDG_RUNTIME_DIR, "xtmux-reply-obligations");
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  const legacyMarker = join(dir, "reply-to-$sender-for-%recipient_pending");
  writeFileSync(legacyMarker, JSON.stringify({
    senderId: "$sender", messageKey: "installer-pending", beadId: "xtmux-3ua.8",
    summary: "installer secret", acceptedAtMs: Date.now(), paneId: "%recipient",
  }), { mode: 0o600 });
  chmodSync(legacyMarker, 0o600);

  const first = run(home);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(existsSync(dir), false);
  const status = spawnSync(join(home, ".local", "bin", "xtmux-obs"), ["obs-migrate", "--status"], {
    cwd: root, encoding: "utf8", env,
  });
  assert.equal(status.status, 0, status.stderr);
  const rows = JSON.parse(status.stdout);
  const counts = JSON.parse(rows[0].counts_json);
  assert.equal(counts.legacyMarkers.imported, 1);
  assert.equal(rows[0].counts_json.includes("installer secret"), false);

  assert.equal(run(home).status, 0);
  const rerun = spawnSync(join(home, ".local", "bin", "xtmux-obs"), ["obs-migrate", "--status"], {
    cwd: root, encoding: "utf8", env,
  });
  const rerunRows = JSON.parse(rerun.stdout);
  assert.equal(JSON.parse(rerunRows[0].counts_json).legacyMarkers.scanned, 0);
  rmSync(home, { recursive: true, force: true });
});

test("refuses foreign product directories and uninstall preserves later user-owned changes", () => {
  const foreignHome = mkdtempSync(join(tmpdir(), "xtmux-foreign-package-"));
  const foreignPackage = join(foreignHome, ".pi", "agent", "packages", "xtmux");
  mkdirSync(foreignPackage, { recursive: true });
  writeFileSync(join(foreignPackage, "user.txt"), "foreign");
  const refused = run(foreignHome);
  assert.notEqual(refused.status, 0);
  assert.equal(readFileSync(join(foreignPackage, "user.txt"), "utf8"), "foreign");
  rmSync(foreignHome, { recursive: true, force: true });

  const changedHome = mkdtempSync(join(tmpdir(), "xtmux-user-change-"));
  assert.equal(run(changedHome).status, 0);
  const hooks = join(changedHome, ".claude", "hooks", "xtmux");
  writeFileSync(join(hooks, "agent-state.sh"), "user-modified\n");
  const update = run(changedHome);
  assert.notEqual(update.status, 0);
  assert.equal(readFileSync(join(hooks, "agent-state.sh"), "utf8"), "user-modified\n");
  const removed = run(changedHome, "--uninstall");
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(readFileSync(join(hooks, "agent-state.sh"), "utf8"), "user-modified\n");
  rmSync(changedHome, { recursive: true, force: true });
});
