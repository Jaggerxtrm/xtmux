import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const installer = join(root, "scripts", "install.mjs");
const run = (home, ...args) => spawnSync(process.execPath, [installer, "--home", home, ...args], { cwd: root, encoding: "utf8" });
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
        { _source: "xtrm-global", hooks: [{ type: "command", command: "node /x/.xtrm/hooks/stop.mjs" }] },
        { hooks: [{ type: "command", command: "user-stop" }] },
      ],
    },
  }));
  writeFileSync(pi, JSON.stringify({ packages: ["npm:foreign"] }));

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
  assert.equal(json(pi).packages[0], "npm:foreign");
  assert.equal(json(pi).packages.filter((entry) => typeof entry === "string" && entry.endsWith("/.pi/agent/packages/xtmux")).length, 1);
  assert.deepEqual(json(join(home, ".pi", "agent", "packages", "xtmux", "package.json")).pi.extensions, ["./extensions/pi-agent-state.ts", "./extensions/pi-auto-monitor.ts"]);
  for (const name of ["xtmux", "tmux-session-picker", "xtmux-obs", "xtmux-monitor", "xtmux-changelog"]) assert.ok(existsSync(join(home, ".local", "bin", name)));
  for (const name of ["agent-state.sh", "git-pane-status.sh"]) assert.ok(existsSync(join(home, ".tmux", "scripts", name)));

  const removed = run(home, "--uninstall");
  assert.equal(removed.status, 0, removed.stderr);
  const after = json(claude);
  assert.equal(after.theme, "dark");
  assert.equal(after.hooks.Stop.some((entry) => entry._source === "xtmux"), false);
  assert.equal(after.hooks.Stop.some((entry) => entry._source === "xtrm-global"), true);
  assert.deepEqual(json(pi).packages, ["npm:foreign"]);
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
