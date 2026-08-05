import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, existsSync, readdirSync, readlinkSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
const runWithEnv = (home, env, ...args) => {
  mkdirSync(join(home, "runtime"), { recursive: true });
  mkdirSync(join(home, "tmp"), { recursive: true });
  return spawnSync(process.execPath, [installer, "--home", home, ...args], {
    cwd: root, encoding: "utf8", env: { ...isolatedEnv(home), ...env },
  });
};
const run = (home, ...args) => runWithEnv(home, {}, ...args);
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
  // agent-state, auto-monitor drain, and the Claude turn-capture Stop hook.
  assert.equal(settings.hooks.Stop.filter((entry) => entry._source === "xtmux").length, 3);
  assert.equal(settings.hooks.Stop.filter((entry) => entry._source === "xtrm-global").length, 1);
  assert.equal(settings.hooks.Stop.filter((entry) => entry.hooks?.[0]?.command === "user-stop").length, 1);
  const commands = Object.values(settings.hooks).flat().flatMap((entry) => entry.hooks?.map((hook) => hook.command) || []);
  assert.ok(commands.some((command) => command.includes('bash "') && command.includes("auto-monitor-on-send.sh")));
  assert.ok(commands.some((command) => command.includes('bash "') && command.includes("auto-monitor-consumed.sh")));
  assert.equal(commands.some((command) => command.includes('node "') && command.includes("auto-monitor-on-send.mjs")), false);
  assert.deepEqual(readdirSync(join(home, ".claude", "hooks", "xtmux")).sort(), [
    "agent-state.sh", "auto-monitor-consumed.mjs", "auto-monitor-consumed.sh", "auto-monitor-drain-stop.mjs", "auto-monitor-on-send.mjs", "auto-monitor-on-send.sh", "claude-agent-turn-capture.mjs",
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

// Without the flag a Claude pane never mints @agent_instance_id, never emits
// agent.ready, and every identity-keyed feature silently skips it (xtrm-wiy5n.4.25).
// The negative half is the other half of the spec: identity must NOT rotate on
// ordinary transitions (docs/xtmux-gaps.md 12.1).
test("Claude SessionStart mints a new agent instance, and no other event does", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-new-instance-"));
  assert.equal(run(home).status, 0);
  const hooks = json(join(home, ".claude", "settings.json")).hooks;
  const commandsFor = (event) => (hooks[event] || []).flatMap((entry) => entry.hooks?.map((hook) => hook.command) || []);

  const minting = (hooks.SessionStart || []).filter((entry) => entry.hooks?.some((hook) => /agent-state\.sh" idle --new-instance$/.test(hook.command)));
  assert.equal(minting.length, 1);
  // SessionStart also fires on `compact`, which continues an occupation instead
  // of starting one; a matcher that took it would mint a phantom second instance.
  assert.equal(minting[0].matcher, "startup|resume|clear");
  for (const event of Object.keys(hooks).filter((event) => event !== "SessionStart")) {
    assert.deepEqual(commandsFor(event).filter((command) => command.includes("--new-instance")), [], `${event} must not mint a new instance id`);
  }
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


// Ownership is proven ONLY by the _source tag (xtrm-wiy5n.4.27). Untagged
// entries — even ones pointing at our own script paths — are left alone; the
// installer cannot prove it wrote them. Live untagged duplicates stop growing
// because every entry the installer writes is tagged and self-removes.
test("leaves untagged legacy entries alone and stops growing on rerun", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-legacy-"));
  const claude = join(home, ".claude", "settings.json");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const legacyStop = [
    { hooks: [{ type: "command", command: "CLAUDE_HOOK_EVENT=Stop ~/.tmux/scripts/agent-state.sh done" }] },
    { hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.xtrm/hooks/auto-monitor-drain-stop.mjs"' }] },
  ];
  writeFileSync(claude, JSON.stringify({ hooks: { Stop: legacyStop } }));

  assert.equal(run(home).status, 0);
  const commands = () => Object.values(json(claude).hooks).flat().flatMap((entry) => entry.hooks?.map((hook) => hook.command) || []);
  assert.equal(commands().some((command) => command.includes("~/.tmux/scripts/agent-state.sh")), true, "legacy untagged tmux entry must survive");
  assert.equal(commands().some((command) => command.includes("$CLAUDE_PROJECT_DIR")), true, "legacy untagged xtrm entry must survive");
  const firstBytes = readFileSync(claude, "utf8");

  assert.equal(run(home).status, 0);
  assert.equal(readFileSync(claude, "utf8"), firstBytes, "second install must not add duplicates");
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

// Codex mirror of the Claude test in PR #79 (xtrm-wiy5n.4.25). Without the flag
// a Codex pane never mints @agent_instance_id, never emits agent.ready, and is
// invisible to every identity-keyed feature. The negative half enforces
// docs/xtmux-gaps.md 12.1: identity must NOT rotate on ordinary transitions.
test("Codex SessionStart mints a new agent instance, and no other event does", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-codex-new-instance-"));
  mkdirSync(join(home, ".codex"), { recursive: true });
  assert.equal(run(home).status, 0);
  const hooks = json(join(home, ".codex", "hooks.json")).hooks;
  const commandsFor = (event) => (hooks[event] || []).flatMap((entry) => entry.hooks?.map((hook) => hook.command) || []);

  const minting = (hooks.SessionStart || []).filter((entry) => entry.hooks?.some((hook) => /agent-state\.sh" idle --new-instance$/.test(hook.command)));
  assert.equal(minting.length, 1);
  // SessionStart also fires on `compact`, which continues an occupation instead
  // of starting one; a matcher that took it would mint a phantom second instance.
  assert.equal(minting[0].matcher, "startup|resume|clear");
  for (const event of Object.keys(hooks).filter((event) => event !== "SessionStart")) {
    assert.deepEqual(commandsFor(event).filter((command) => command.includes("--new-instance")), [], `${event} must not mint a new instance id`);
  }
  rmSync(home, { recursive: true, force: true });
});

// Only tagged entries have a known owner; every Codex entry the installer
// writes must carry _source so a subsequent install can remove it without
// pattern-matching untagged neighbors.
test("Codex entries the installer writes carry _source", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-codex-tag-"));
  mkdirSync(join(home, ".codex"), { recursive: true });
  assert.equal(run(home).status, 0);
  const hooks = json(join(home, ".codex", "hooks.json")).hooks;
  const owned = (entry) => entry?._source === "xtmux";
  const xtmuxCommand = (entry) => entry.hooks?.some((hook) => hook.command?.includes("/.codex/hooks/xtmux/agent-state.sh"));
  for (const event of ["SessionStart", "UserPromptSubmit"]) {
    const xtmuxEntries = (hooks[event] || []).filter(xtmuxCommand);
    assert.equal(xtmuxEntries.length, 1, `${event} must have exactly one xtmux entry`);
    assert.ok(xtmuxEntries.every(owned), `${event} xtmux entry must be tagged`);
  }
  rmSync(home, { recursive: true, force: true });
});

// Live untagged Codex entries pointing at our script must survive both install
// and uninstall — the installer cannot prove it wrote them (xtrm-wiy5n.4.27).
// A tagged entry it did write must self-remove on rerun so growth stays bounded.
test("Codex install leaves untagged xtmux-shaped entries alone and dedupes its own tagged writes", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-codex-untagged-"));
  const hooks = join(home, ".codex", "hooks.json");
  mkdirSync(join(home, ".codex"), { recursive: true });
  const legacy = { matcher: "startup|resume|clear", hooks: [{ type: "command", command: `bash "${home}/.codex/hooks/xtmux/agent-state.sh" idle` }] };
  writeFileSync(hooks, JSON.stringify({ hooks: { SessionStart: [legacy] } }));

  assert.equal(run(home).status, 0);
  const afterFirst = readFileSync(hooks, "utf8");
  const parsed = json(hooks).hooks.SessionStart;
  assert.equal(parsed.some((entry) => !entry._source && entry.hooks?.[0]?.command === legacy.hooks[0].command), true, "untagged legacy entry must survive");
  assert.equal(parsed.filter((entry) => entry._source === "xtmux").length, 1, "installer must write exactly one tagged entry");

  assert.equal(run(home).status, 0);
  assert.equal(readFileSync(hooks, "utf8"), afterFirst, "second install must be idempotent");
  rmSync(home, { recursive: true, force: true });
});

// K4 (xtmux-s96.4). Codex records hook trust POSITIONALLY in ~/.codex/config.toml:
//
//   [hooks.state."<abs hooks.json>:<event_snake_case>:<entryIndex>:<hookIndex>"]
//
// so an entry's trust belongs to its INDEX, not its content. Every release up to
// v0.2.3 PREPENDED, which shifted a pre-existing unowned entry from index 0 to 1
// and silently invalidated the trust the operator had granted it. This is the
// regression test for that: the unowned entry must hold index 0 through install,
// update and uninstall. It is the load-bearing assertion of the whole slice.
test("Codex install preserves the index of unowned entries so their hook trust survives", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-codex-trust-index-"));
  const hooks = join(home, ".codex", "hooks.json");
  mkdirSync(join(home, ".codex"), { recursive: true });
  const unowned = { hooks: [{ type: "command", command: "third-party-session-start" }] };
  const unownedPrompt = { hooks: [{ type: "command", command: "third-party-prompt" }] };
  writeFileSync(hooks, JSON.stringify({ hooks: { SessionStart: [unowned], UserPromptSubmit: [unownedPrompt] } }));

  const indexOfUnowned = (event, command) =>
    (json(hooks).hooks[event] || []).findIndex((entry) => entry.hooks?.[0]?.command === command);

  assert.equal(run(home).status, 0);
  assert.equal(indexOfUnowned("SessionStart", "third-party-session-start"), 0, "install must not shift an unowned entry");
  assert.equal(indexOfUnowned("UserPromptSubmit", "third-party-prompt"), 0, "install must not shift an unowned entry");
  assert.ok((json(hooks).hooks.SessionStart || []).length > 1, "xtmux entry must still be installed");

  assert.equal(run(home).status, 0);
  assert.equal(indexOfUnowned("SessionStart", "third-party-session-start"), 0, "update must not shift an unowned entry");

  assert.equal(run(home, "--uninstall").status, 0);
  assert.equal(indexOfUnowned("SessionStart", "third-party-session-start"), 0, "uninstall must not shift an unowned entry");
  assert.deepEqual(json(hooks).hooks, { SessionStart: [unowned], UserPromptSubmit: [unownedPrompt] });
  rmSync(home, { recursive: true, force: true });
});

// K4 (xtmux-s96.4) legacy owned-entry repair. Releases BEFORE PR #82 wrote these
// Codex entries with no _source tag (tagging shipped in #82, i.e. from v0.2.3
// onward), so upgrading from one left the untagged entry beside the new tagged
// one and every lifecycle transition fired TWICE. The shapes below are copied
// verbatim from `git show 9708c2d~1:scripts/install.mjs`, so a byte-exact match
// is proof of xtmux authorship — the same content-hash proof already used for
// compatibility links and managed directories. Adoption is whole-entry: any
// deviation is not provably ours and is preserved instead (asserted separately).
test("Codex install adopts byte-exact pre-tag entries instead of duplicating their lifecycle", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-codex-legacy-adopt-"));
  const hooks = join(home, ".codex", "hooks.json");
  mkdirSync(join(home, ".codex"), { recursive: true });
  const script = `${home}/.codex/hooks/xtmux/agent-state.sh`;
  writeFileSync(hooks, JSON.stringify({ hooks: {
    SessionStart: [{ matcher: "startup|resume|clear", hooks: [{ type: "command", command: `bash "${script}" idle`, statusMessage: "marking pane idle" }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: `bash "${script}" running`, statusMessage: "marking pane running" }] }],
  } }));

  const result = run(home);
  assert.equal(result.status, 0, result.stderr);
  const after = json(hooks).hooks;
  const firing = (event) => (after[event] || []).filter((entry) => entry.hooks?.some((hook) => hook.command?.includes("/.codex/hooks/xtmux/agent-state.sh")));
  assert.equal(firing("SessionStart").length, 1, "pre-tag SessionStart entry must be adopted, not duplicated");
  assert.equal(firing("UserPromptSubmit").length, 1, "pre-tag UserPromptSubmit entry must be adopted, not duplicated");
  assert.equal(firing("SessionStart")[0]._source, "xtmux", "the surviving entry must be the tagged canonical one");
  assert.match(result.stdout, /adopted/, "adoption must be reported to the operator");

  assert.equal(run(home, "--uninstall").status, 0);
  assert.deepEqual(json(hooks).hooks, {});
  rmSync(home, { recursive: true, force: true });
});

// The conservative half of adoption. An entry that names our managed hook path
// but does not match a known shape byte-for-byte is NOT provably ours: it may be
// a hand edit the operator depends on. It must be preserved, keep its index, and
// be surfaced so a human can decide — never silently removed or overwritten.
test("Codex install preserves and reports a near-miss entry it cannot prove it wrote", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-codex-near-miss-"));
  const hooks = join(home, ".codex", "hooks.json");
  mkdirSync(join(home, ".codex"), { recursive: true });
  const script = `${home}/.codex/hooks/xtmux/agent-state.sh`;
  const nearMiss = { matcher: "startup|resume|clear", hooks: [{ type: "command", command: `bash "${script}" idle --operator-tweak`, statusMessage: "marking pane idle" }] };
  writeFileSync(hooks, JSON.stringify({ hooks: { SessionStart: [nearMiss] } }));

  const result = run(home);
  assert.equal(result.status, 0, result.stderr);
  const entries = json(hooks).hooks.SessionStart;
  assert.deepEqual(entries[0], nearMiss, "a near-miss entry must be preserved verbatim at its original index");
  assert.match(result.stdout, /preserved unowned SessionStart\[0\]/, "a near-miss must be reported for human review");
  rmSync(home, { recursive: true, force: true });
});

// A distribution change that adds a managed Codex asset must not be able to ship
// a tarball missing it. Nothing asserted this before: install.test.mjs checked
// only scripts/agent-state.sh, and `npm pack --dry-run` runs in release.yml,
// after merge, which is too late to block.
test("package.json ships the managed Codex hook payload", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const files = manifest.files || [];
  // npm `files` entries may carry a trailing slash ("hooks/codex/"); normalise
  // both sides so a directory entry covers itself and everything beneath it.
  const covers = (path) => files.some((raw) => {
    const entry = raw.replace(/\/$/, "");
    return entry === path || path.startsWith(`${entry}/`);
  });
  assert.ok(covers("hooks/codex"), `package.json files must ship hooks/codex; got ${JSON.stringify(files)}`);
  for (const asset of readdirSync(join(root, "hooks", "codex"))) {
    assert.ok(covers(`hooks/codex/${asset}`), `package.json files must ship hooks/codex/${asset}`);
  }
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

test("persists replacement ownership when migration fails", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-migration-failure-"));
  const blockedDb = join(home, "blocked-observability-db");
  mkdirSync(blockedDb, { recursive: true });

  const failed = runWithEnv(home, { XTMUX_OBS_DB_PATH: blockedDb });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /legacy marker reconciliation failed/);
  const hooks = join(home, ".claude", "hooks", "xtmux");
  const changedHook = join(hooks, "agent-state.sh");
  const statePath = join(home, ".local", "state", "xtmux", "installer.json");
  const failedState = json(statePath);
  assert.equal(
    typeof failedState.snapshots?.claudeHooks?.["agent-state.sh"],
    "string",
    "replacement snapshots must survive migration failure",
  );

  writeFileSync(changedHook, "user-modified-after-failure\n");
  const retry = run(home);
  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr, /refusing to replace user-owned directory/);
  assert.equal(readFileSync(changedHook, "utf8"), "user-modified-after-failure\n");

  for (let i = 0; i < 2; i++) {
    const removed = run(home, "--uninstall");
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(readFileSync(changedHook, "utf8"), "user-modified-after-failure\n");
    assert.equal(existsSync(statePath), true, "state must remain while a modified managed directory is preserved");
  }
  assert.notEqual(run(home).status, 0);
  assert.equal(readFileSync(changedHook, "utf8"), "user-modified-after-failure\n");
  rmSync(home, { recursive: true, force: true });
});

test("adopts an unchanged pre-snapshot install by content", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-pre-snapshot-clean-"));
  assert.equal(run(home).status, 0);
  const statePath = join(home, ".local", "state", "xtmux", "installer.json");
  const state = json(statePath);
  delete state.snapshots;
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const update = run(home);
  assert.equal(update.status, 0, update.stderr);
  assert.equal(run(home, "--uninstall").status, 0);
  assert.equal(existsSync(statePath), false);
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
  const installerState = join(changedHome, ".local", "state", "xtmux", "installer.json");
  const preSnapshotState = json(installerState);
  delete preSnapshotState.snapshots;
  writeFileSync(installerState, `${JSON.stringify(preSnapshotState, null, 2)}\n`);
  writeFileSync(join(hooks, "agent-state.sh"), "user-modified\n");
  const update = run(changedHome);
  assert.notEqual(update.status, 0);
  assert.equal(readFileSync(join(hooks, "agent-state.sh"), "utf8"), "user-modified\n");
  const removed = run(changedHome, "--uninstall");
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(readFileSync(join(hooks, "agent-state.sh"), "utf8"), "user-modified\n");
  assert.equal(existsSync(installerState), true);
  assert.notEqual(run(changedHome).status, 0);
  assert.equal(readFileSync(join(hooks, "agent-state.sh"), "utf8"), "user-modified\n");
  rmSync(changedHome, { recursive: true, force: true });
});

// xtrm-9hq6w: the smoke-container drift-repair (core scripts/smoke-container/
// verify.sh:global_drift_and_repair) tampers ~/.claude/settings.json to strip
// --new-instance from every owned SessionStart agent-state.sh entry, then
// invokes the installer directly to prove the drift is repaired. The caller
// must use a bare `node scripts/install.mjs` — passing --from-npm keeps the
// installer behind the non-global-install guard by design.
test("drift-repair restores --new-instance on tampered owned SessionStart entry", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-drift-repair-"));
  mkdirSync(join(home, ".codex"), { recursive: true });
  assert.equal(run(home).status, 0);
  const claude = join(home, ".claude", "settings.json");
  const codex = join(home, ".codex", "hooks.json");
  const strip = (path) => {
    const settings = json(path);
    settings.hooks.SessionStart = settings.hooks.SessionStart.map((entry) => {
      if (!entry.hooks?.some((h) => h.command?.includes("agent-state.sh"))) return entry;
      return { ...entry, hooks: entry.hooks.map((h) => ({ ...h, command: h.command.replace(" --new-instance", "") })) };
    });
    writeFileSync(path, JSON.stringify(settings, null, 2));
  };
  const missing = (path) => json(path).hooks.SessionStart
    .flatMap((entry) => entry.hooks || [])
    .filter((h) => h.command?.includes("agent-state.sh") && !h.command.includes("--new-instance"))
    .length;
  strip(claude);
  strip(codex);
  assert.equal(missing(claude), 1, "tamper must strip the Claude flag");
  assert.equal(missing(codex), 1, "tamper must strip the Codex flag");

  // Bare invocation — no --from-npm, matching the paired verify.sh change.
  const repair = run(home);
  assert.equal(repair.status, 0, repair.stderr);
  assert.equal(missing(claude), 0, "Claude --new-instance must be restored");
  assert.equal(missing(codex), 0, "Codex --new-instance must be restored");
  rmSync(home, { recursive: true, force: true });
});

// Mirror case (xtrm-wiy5n.4.27 strict ownership): an UNTAGGED SessionStart
// agent-state.sh entry, even with the flag stripped, must be left alone —
// the installer cannot prove it wrote it.
test("drift-repair leaves an untagged tampered SessionStart entry alone", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-drift-untagged-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const claude = join(home, ".claude", "settings.json");
  const untampered = 'CLAUDE_HOOK_EVENT=SessionStart bash "~/.tmux/scripts/agent-state.sh" idle';
  writeFileSync(claude, JSON.stringify({ hooks: { SessionStart: [
    { matcher: "startup|resume|clear", hooks: [{ type: "command", command: untampered, timeout: 2000 }] },
  ] } }));

  const repair = run(home);
  assert.equal(repair.status, 0, repair.stderr);
  const survivors = json(claude).hooks.SessionStart.filter((entry) => !entry._source);
  assert.equal(survivors.length, 1, "untagged entry must survive");
  assert.equal(survivors[0].hooks[0].command, untampered, "untagged entry must be byte-identical");
  rmSync(home, { recursive: true, force: true });
});

// Safety valve: a non-global `npm i` OR `bun install` postinstall MUST no-op.
// This is runner-agnostic on purpose — the guard reads `npm_config_global`
// only. Codex #88 caught an earlier attempt at this fix that gated on
// `npm_lifecycle_event`, which bun does not set for a local postinstall; the
// installer then silently rewrote the user's HOME.
for (const [runner, env] of [
  ["npm local postinstall", { npm_lifecycle_event: "postinstall", npm_config_global: "false" }],
  // Bun runs `postinstall` with neither var set (Bun 1.2.14, `bun install --help`).
  ["bun local postinstall", { npm_lifecycle_event: "", npm_config_global: "" }],
]) {
  test(`--from-npm no-ops for a non-global ${runner}`, () => {
    const home = mkdtempSync(join(tmpdir(), "xtmux-postinstall-guard-"));
    const result = runWithEnv(home, env, "--from-npm");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(home, ".claude", "settings.json")), false, `${runner} must not touch HOME`);
    assert.equal(existsSync(join(home, ".local", "bin", "xtmux")), false, `${runner} must not install bins`);
    rmSync(home, { recursive: true, force: true });
  });
}

// A global install (npm_config_global=true) MUST proceed even under --from-npm
// — this is the normal `npm i -g @jaggerxtrm/xtmux` postinstall path.
test("--from-npm proceeds for a global postinstall", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-global-guard-"));
  const result = runWithEnv(home, { npm_lifecycle_event: "postinstall", npm_config_global: "true" }, "--from-npm");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(home, ".claude", "settings.json")), true, "global postinstall must install");
  assert.equal(existsSync(join(home, ".local", "bin", "xtmux")), true, "global postinstall must install bins");
  rmSync(home, { recursive: true, force: true });
});

// xtmux-s96.2.1 — compatibility links must adopt a byte-identical copy of our own
// packaged script instead of refusing forever. A pre-installer hand-copy of
// git-pane-status.sh blocked reinstall on a live host and took the whole xtmux
// observability spine down with it, because agent-state.sh gates its emit on
// `command -v xtmux` and the bins never got installed.
const compatDst = (home) => join(home, ".tmux", "scripts", "git-pane-status.sh");
const packagedCompat = join(root, "scripts", "git-pane-status.sh");
const seedCompat = (home, content) => {
  mkdirSync(join(home, ".tmux", "scripts"), { recursive: true });
  writeFileSync(compatDst(home), content);
};

test("adopts a byte-identical pre-existing compatibility file and keeps it recoverable", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-compat-adopt-"));
  seedCompat(home, readFileSync(packagedCompat, "utf8"));

  const result = run(home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /adopted byte-identical/);

  // The destination is now a symlink pointing at the packaged script.
  const stat = lstatSync(compatDst(home));
  assert.ok(stat.isSymbolicLink(), "destination should be a symlink after adoption");
  assert.equal(resolve(readlinkSync(compatDst(home))), packagedCompat);

  // The displaced copy is preserved, matching the .pre-xtmux convention.
  assert.ok(existsSync(`${compatDst(home)}.pre-xtmux`), "displaced copy must be recoverable");
  assert.equal(readFileSync(`${compatDst(home)}.pre-xtmux`, "utf8"), readFileSync(packagedCompat, "utf8"));

  rmSync(home, { recursive: true, force: true });
});

test("refuses foreign compatibility content and names the remedy", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-compat-foreign-"));
  seedCompat(home, "#!/bin/sh\n# a user's own script\necho mine\n");

  const result = run(home);
  assert.notEqual(result.status, 0, "foreign content must refuse");
  assert.match(result.stderr, /refusing to replace existing file/);
  assert.match(result.stderr, /content differs from the packaged script/);
  assert.match(result.stderr, /move it aside and re-run/);

  // The user's file is untouched and no backup was fabricated.
  assert.equal(readFileSync(compatDst(home), "utf8"), "#!/bin/sh\n# a user's own script\necho mine\n");
  assert.ok(!existsSync(`${compatDst(home)}.pre-xtmux`), "must not back up a file it refused to touch");

  rmSync(home, { recursive: true, force: true });
});

test("refuses an xtmux copy that has drifted from the packaged script", () => {
  // Our OWN older revision is byte-indistinguishable from a user edit at install
  // time, so it must refuse rather than silently overwrite. This is the case that
  // actually occurred on the live host.
  const home = mkdtempSync(join(tmpdir(), "xtmux-compat-drift-"));
  seedCompat(home, `${readFileSync(packagedCompat, "utf8")}\n# drifted\n`);

  const result = run(home);
  assert.notEqual(result.status, 0, "drifted content must refuse");
  assert.match(result.stderr, /content differs from the packaged script/);

  rmSync(home, { recursive: true, force: true });
});

test("dry-run reports the exact compatibility action and mutates nothing", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-compat-dryrun-"));
  seedCompat(home, readFileSync(packagedCompat, "utf8"));

  const result = run(home, "--dry-run");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dry-run: compatibility link plan/);
  assert.match(result.stdout, /adopt\s+.*git-pane-status\.sh/);
  assert.match(result.stdout, /link\s+.*agent-state\.sh/);
  assert.match(result.stdout, /dry-run: no changes were made/);

  // Nothing was written: still a regular file, no backup, no bins installed.
  assert.ok(lstatSync(compatDst(home)).isFile(), "dry-run must not replace the file");
  assert.ok(!existsSync(`${compatDst(home)}.pre-xtmux`));
  assert.ok(!existsSync(join(home, ".local", "bin", "xtmux")), "dry-run must not install bins");

  rmSync(home, { recursive: true, force: true });
});

test("dry-run reports a refusal without failing, and a second install is a no-op", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-compat-idempotent-"));
  seedCompat(home, readFileSync(packagedCompat, "utf8"));

  assert.equal(run(home).status, 0);
  const firstTarget = readlinkSync(compatDst(home));
  const backup = readFileSync(`${compatDst(home)}.pre-xtmux`, "utf8");

  // Second run: already an owned symlink, so it relinks rather than adopting,
  // and must not overwrite the preserved copy.
  const second = run(home);
  assert.equal(second.status, 0, second.stderr);
  assert.doesNotMatch(second.stdout, /adopted byte-identical/, "second run should not re-adopt");
  assert.equal(readlinkSync(compatDst(home)), firstTarget);
  assert.equal(readFileSync(`${compatDst(home)}.pre-xtmux`, "utf8"), backup);

  const plan = run(home, "--dry-run");
  assert.equal(plan.status, 0);
  assert.match(plan.stdout, /relink\s+.*git-pane-status\.sh/);

  rmSync(home, { recursive: true, force: true });
});
