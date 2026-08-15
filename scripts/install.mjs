#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const args = process.argv.slice(2);
const value = (flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
const home = resolve(value("--home") || process.env.HOME || "");
const uninstall = args.includes("--uninstall");
const fromNpm = args.includes("--from-npm");
const installTmuxHooks = args.includes("--tmux-hooks") || args.includes("--hooks");
const dryRun = args.includes("--dry-run");

if (!home) throw new Error("HOME is not set; pass --home <path>");
// --from-npm is set by the package.json `postinstall` script and MUST no-op
// on a non-global install. The signal is `npm_config_global` alone, not the
// presence of an npm-only env var — bun runs postinstall without setting
// `npm_lifecycle_event` (Codex #88, xtrm-9hq6w), and a matrix of runner
// vars would just leak into a silent HOME write the next time a runner is
// added. Callers that want the installer to actually run must NOT pass
// --from-npm (npm's own `install:global` script and the smoke-container
// drift-repair invocation both use a bare `node scripts/install.mjs`).
if (fromNpm && process.env.npm_config_global !== "true") process.exit(0);

const source = "xtmux";
const stateDir = join(home, ".local", "state", "xtmux");
const statePath = join(stateDir, "installer.json");
const claudeSettings = join(home, ".claude", "settings.json");
const codexRoot = join(home, ".codex");
const codexSettings = join(codexRoot, "hooks.json");
const codexHooks = join(codexRoot, "hooks", "xtmux");
const piSettings = join(home, ".pi", "agent", "settings.json");
const piPackage = join(home, ".pi", "agent", "packages", "xtmux");
const claudeHooks = join(home, ".claude", "hooks", "xtmux");
const bins = {
  xtmux: join(root, "bin", "tmux-session-picker"),
  "tmux-session-picker": join(root, "bin", "tmux-session-picker"),
  "xtmux-obs": join(root, "scripts", "xtmux-obs.mjs"),
  "xtmux-monitor": join(root, "scripts", "xtmux-monitor.sh"),
  "xtmux-events": join(root, "scripts", "test-session-events.sh"),
  "xtmux-changelog": join(root, "scripts", "changelog.mjs"),
};
const compatibilityLinks = {
  [join(home, ".tmux", "scripts", "git-pane-status.sh")]: join(root, "scripts", "git-pane-status.sh"),
  [join(home, ".tmux", "scripts", "agent-state.sh")]: join(root, "scripts", "agent-state.sh"),
  [join(home, ".tmux", "scripts", "xtmux-host-id.sh")]: join(root, "scripts", "xtmux-host-id.sh"),
};

function readJson(path, fallback = {}) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.xtmux-tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
}

function snapshotDirectory(path) {
  if (!lstatSafe(path)?.isDirectory()) return null;
  const snapshot = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const item = join(dir, entry.name);
      if (entry.isDirectory()) walk(item);
      else if (entry.isFile()) snapshot[relative(path, item)] = createHash("sha256").update(readFileSync(item)).digest("hex");
      else if (entry.isSymbolicLink()) snapshot[relative(path, item)] = `link:${readlinkSync(item)}`;
      else snapshot[relative(path, item)] = "unsupported";
    }
  };
  walk(path);
  return snapshot;
}

function sameSnapshot(actual, expected) {
  const canonical = (snapshot) => Object.fromEntries(Object.entries(snapshot || {}).sort(([a], [b]) => a.localeCompare(b)));
  return actual !== null && expected && JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected));
}

function installerState() {
  if (!existsSync(statePath)) return null;
  const state = readJson(statePath);
  if (state.source !== source) throw new Error(`refusing foreign installer state: ${statePath}`);
  return state;
}

const PI_PACKAGE_MANIFEST = {
  name: "@jaggerxtrm/xtmux-pi-local",
  private: true,
  pi: { extensions: ["./extensions/pi-agent-state.ts", "./extensions/pi-auto-monitor.ts"] },
};
const managedSources = {
  claudeHooks: {
    "agent-state.sh": join(root, "scripts", "agent-state.sh"),
    ...Object.fromEntries(["auto-monitor-on-send.mjs", "auto-monitor-on-send.sh", "auto-monitor-consumed.mjs", "auto-monitor-consumed.sh", "auto-monitor-drain-stop.mjs", "claude-agent-turn-capture.mjs", "claude-user-prompt-episode.mjs"]
      .map((name) => [name, join(root, "hooks", "claude", name)])),
  },
  codexHooks: {
    "agent-state.sh": join(root, "scripts", "agent-state.sh"),
    ...Object.fromEntries(["codex-agent-turn-capture.mjs", "codex-inbox-reply-stop.mjs"]
      .map((name) => [name, join(root, "hooks", "codex", name)])),
  },
};

function expectedManagedSnapshot(key) {
  const expected = {};
  if (key === "piPackage") {
    expected["package.json"] = createHash("sha256").update(`${JSON.stringify(PI_PACKAGE_MANIFEST, null, 2)}\n`).digest("hex");
    for (const name of readdirSync(join(root, "extensions"))) {
      expected[`extensions/${name}`] = createHash("sha256").update(readFileSync(join(root, "extensions", name))).digest("hex");
    }
    return expected;
  }
  for (const [name, sourcePath] of Object.entries(managedSources[key])) {
    expected[name] = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
  }
  return expected;
}

function manageableDirectory(path, key, state = installerState()) {
  if (!existsSync(path)) return true;
  const snapshot = snapshotDirectory(path);
  if (state?.snapshots && Object.hasOwn(state.snapshots, key)) return sameSnapshot(snapshot, state.snapshots[key]);
  return sameSnapshot(snapshot, expectedManagedSnapshot(key));
}

function assertManageableDirectory(path, key, state) {
  if (!manageableDirectory(path, key, state)) throw new Error(`refusing to replace user-owned directory: ${path}`);
}

function removeManagedDirectory(path, key, state) {
  if (!existsSync(path)) return true;
  if (!manageableDirectory(path, key, state)) return false;
  rmSync(path, { recursive: true, force: true });
  return true;
}

function lstatSafe(path) {
  try { return lstatSync(path); } catch { return undefined; }
}

function ownedLink(path) {
  if (!lstatSafe(path)?.isSymbolicLink()) return false;
  const target = resolve(dirname(path), readlinkSync(path));
  if (target.startsWith(`${root}/`)) return true;
  let cursor = dirname(target);
  while (cursor !== dirname(cursor)) {
    const manifest = join(cursor, "package.json");
    if (existsSync(manifest)) {
      try {
        return ["@jaggerxtrm/xtmux", "@xtmux/observability"].includes(readJson(manifest).name);
      } catch { return false; }
    }
    cursor = dirname(cursor);
  }
  return false;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Compatibility links are plain mirrors of a packaged script, so a pre-installer
// hand-copy of that same script is our own payload wearing the wrong hat. When the
// bytes match the packaged source exactly it is safe to adopt: replacing an
// identical file with a link to its own content changes nothing observable.
//
// This is the content-based adoption manageableDirectory() already performs for
// managed directories (expectedManagedSnapshot); compatibility links had no
// equivalent, so the installer refused forever on a file it authored itself.
//
// Deliberately NOT adopted: content that differs for any reason, including OUR OWN
// earlier revisions. A stale copy of an old git-pane-status.sh is byte-indistinguishable
// from a user edit of the same file, and the installer has no repository history at
// install time to tell them apart. Those still refuse — but with a diagnostic that
// names the remedy instead of a bare "refusing to replace".
function compatibilityAction(dst, src) {
  const current = lstatSafe(dst);
  if (!current) return "link";
  if (current.isSymbolicLink()) return ownedLink(dst) ? "relink" : "refuse";
  if (current.isFile() && sha256File(dst) === sha256File(src)) return "adopt";
  return "refuse";
}

function compatibilityRefusal(dst, src) {
  const current = lstatSafe(dst);
  const kind = current?.isSymbolicLink() ? "a symlink to content we do not own" : "a regular file whose content differs from the packaged script";
  return [
    `refusing to replace existing file: ${dst}`,
    `  reason: ${kind}`,
    `  packaged source: ${src}`,
    "  xtmux only adopts a byte-identical copy of its own packaged script.",
    "  If this file is yours, leave it and xtmux will keep refusing.",
    `  If it is a stale xtmux copy, move it aside and re-run: mv ${dst} ${dst}.pre-xtmux`,
  ].join("\n");
}

// Adoption is recoverable: the displaced file is preserved as <dst>.pre-xtmux,
// matching the convention already used for Claude and Codex settings.
function linkCompatibility(src, dst) {
  const action = compatibilityAction(dst, src);
  if (action === "refuse") throw new Error(compatibilityRefusal(dst, src));
  if (action === "adopt" && !existsSync(`${dst}.pre-xtmux`)) copyFileSync(dst, `${dst}.pre-xtmux`);
  if (action !== "link") rmSync(dst, { force: true });
  mkdirSync(dirname(dst), { recursive: true });
  symlinkSync(src, dst);
  return action;
}

function link(src, dst) {
  const current = lstatSafe(dst);
  if (current) {
    if (!current.isSymbolicLink() || !ownedLink(dst)) throw new Error(`refusing to replace existing file: ${dst}`);
    rmSync(dst, { force: true });
  }
  mkdirSync(dirname(dst), { recursive: true });
  symlinkSync(src, dst);
}

function preflightInstall() {
  for (const dst of Object.keys(bins).map((name) => join(home, ".local", "bin", name))) {
    const current = lstatSafe(dst);
    if (current && (!current.isSymbolicLink() || !ownedLink(dst))) throw new Error(`refusing to replace existing file: ${dst}`);
  }
  // Compatibility links get the content-based adoption path; bins above do not,
  // because a bin is an entry point a user may legitimately have shadowed.
  for (const [dst, src] of Object.entries(compatibilityLinks)) {
    if (compatibilityAction(dst, src) === "refuse") throw new Error(compatibilityRefusal(dst, src));
  }
  for (const path of [claudeSettings, piSettings, ...(existsSync(codexRoot) ? [codexSettings] : [])]) {
    if (existsSync(path)) readJson(path);
  }
}

function hash(wrapper) {
  return createHash("sha256").update(JSON.stringify({ matcher: wrapper.matcher ?? null, hooks: wrapper.hooks })).digest("hex");
}

// Strict tag-based ownership: only entries carrying our _source are ours to
// remove (xtrm-wiy5n.4.27). Pattern-based adoption of untagged entries could
// silently delete a user hook that happens to invoke our script paths, so
// untagged entries are always left alone. Live untagged duplicates leak once
// but stop growing, because every entry the installer writes from here on is
// tagged and self-removes on the next run.
function owned(wrapper) {
  return wrapper?._source === source;
}

function wrapper(matcher, command, timeout = 5000) {
  const data = { ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command, timeout }] };
  return { ...data, _source: source, _xtmux: { version: pkg.version, hash: hash(data) } };
}

const hook = (name) => join(claudeHooks, name);
function canonicalHooks() {
  const state = (event, next, matcher = "") => wrapper(matcher, `CLAUDE_HOOK_EVENT=${event} bash "${hook("agent-state.sh")}" ${next}`, 2000);
  return {
    // --new-instance on SessionStart ONLY (docs/xtmux-gaps.md 12.1): a Claude
    // pane with no fresh @agent_instance_id never emits agent.ready, so nothing
    // keyed on agent identity — `xt claude --role/--bead` auto-assign included —
    // can ever see it. Rotating it on ordinary idle transitions is forbidden.
    //
    // The matcher is what keeps that promise: SessionStart also fires on
    // `compact`, which continues one occupation rather than starting one. An
    // empty matcher would take it, mint a second id without ending the first,
    // and split the pane's history and Specialists jobs across a phantom
    // instance. `startup|resume|clear` is the same set the Codex wiring uses.
    SessionStart: [state("SessionStart", "idle --new-instance", "startup|resume|clear")],
    // xtmux-gdk: the episode-opener runs alongside the state marker. It must
    // never block (exit 0 always) — UserPromptSubmit exit 2 would erase the
    // user's prompt. Order relative to the state marker carries no weight.
    UserPromptSubmit: [state("UserPromptSubmit", "running"), wrapper(undefined, `node "${hook("claude-user-prompt-episode.mjs")}"`)],
    PreToolUse: [state("PreToolUse", "running")],
    Notification: [state("Notification", "needs-input")],
    PostToolUse: [
      state("PostToolUse", "running"),
      wrapper("Bash", `bash "${hook("auto-monitor-on-send.sh")}"`),
      wrapper("Monitor|Bash", `bash "${hook("auto-monitor-consumed.sh")}"`),
    ],
    Stop: [state("Stop", "done"), wrapper(undefined, `node "${hook("auto-monitor-drain-stop.mjs")}"`), wrapper(undefined, `node "${hook("claude-agent-turn-capture.mjs")}"`)],
    SubagentStop: [state("SubagentStop", "done")],
    SessionEnd: [state("SessionEnd", "off")],
  };
}

function mergeClaude(removeOnly = false) {
  const settings = readJson(claudeSettings);
  const current = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  const next = {};
  for (const [event, entries] of Object.entries(current)) {
    const kept = Array.isArray(entries) ? entries.filter((entry) => !owned(entry)) : [];
    if (kept.length) next[event] = kept;
  }
  if (!removeOnly) for (const [event, entries] of Object.entries(canonicalHooks())) next[event] = [...entries, ...(next[event] || [])];
  settings.hooks = next;
  if (existsSync(claudeSettings) && !existsSync(`${claudeSettings}.pre-xtmux`)) copyFileSync(claudeSettings, `${claudeSettings}.pre-xtmux`);
  writeJson(claudeSettings, settings);
}

function codexOwned(entry) {
  return entry?._source === source;
}

function codexEntry(matcher, command, statusMessage) {
  const data = { ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command, statusMessage }] };
  return { ...data, _source: source, _xtmux: { version: pkg.version, hash: hash(data) } };
}

function canonicalCodexHooks() {
  const script = join(codexHooks, "agent-state.sh");
  const turnCapture = join(codexHooks, "codex-agent-turn-capture.mjs");
  const inboxReply = join(codexHooks, "codex-inbox-reply-stop.mjs");
  return {
    // --new-instance on SessionStart ONLY (docs/xtmux-gaps.md 12.1): without it
    // a Codex pane never mints @agent_instance_id, never emits agent.ready, and
    // stays invisible to every identity-keyed feature (mirror of the Claude fix
    // in PR #79 / xtrm-wiy5n.4.25). The startup|resume|clear matcher keeps
    // compaction out of the rotation. XTMUX_AGENT_RUNTIME tags the durable
    // instance with its runtime; CODEX_HOOK_EVENT attributes every transition
    // to its hook event, mirroring the Claude wiring.
    SessionStart: [codexEntry("startup|resume|clear", `XTMUX_AGENT_RUNTIME=codex CODEX_HOOK_EVENT=SessionStart bash "${script}" idle --new-instance`, "marking pane idle")],
    UserPromptSubmit: [codexEntry(undefined, `CODEX_HOOK_EVENT=UserPromptSubmit bash "${script}" running`, "marking pane running")],
    // K3 (xtmux-s96.2): Stop closes the turn. The state command and the turn
    // capture are separate entries, mirroring Claude's Stop wiring; the capture
    // reads last_assistant_message (required but nullable) directly from the
    // Codex payload and never scans transcripts.
    // K4 (xtmux-s96.4) appends the inbound side. Ordered after the turn capture
    // on purpose: the capture is what creates this turn's outbound FYI, and the
    // inbox/obligation pass should see the state that turn just produced. All
    // three entries are recorders — none writes to stdout, so Codex can read no
    // decision from any of them and the order carries no correctness weight
    // beyond that freshness.
    Stop: [
      codexEntry(undefined, `CODEX_HOOK_EVENT=Stop bash "${script}" done`, "marking pane done"),
      codexEntry(undefined, `node "${turnCapture}"`, "capturing Codex turn"),
      codexEntry(undefined, `node "${inboxReply}"`, "checking Codex inbox and reply duties"),
    ],
    // SessionEnd is the lifecycle end marker: `off` ends the durable instance
    // through the shared transition store. Codex 0.146.0 delivers a single
    // reason value ("other"), so no reason-based split is evidence-backed.
    SessionEnd: [codexEntry(undefined, `CODEX_HOOK_EVENT=SessionEnd bash "${script}" off`, "marking pane off")],
  };
}

// Codex records hook trust POSITIONALLY in ~/.codex/config.toml:
//
//   [hooks.state."<abs hooks.json>:<event_snake_case>:<entryIndex>:<hookIndex>"]
//   trusted_hash = "sha256:..."
//
// An entry's trust therefore belongs to its INDEX, not to its content. Every
// xtmux release up to v0.2.3 PREPENDED its entries, which shifted any
// pre-existing unowned entry from index 0 to index 1; its recorded trusted_hash
// key no longer matched its position and the user's own hook went silently
// untrusted. Appending keeps unowned entries at the indices Codex trusted them
// at, which is the whole point of "preserve unowned configuration".
//
// Execution precedence changes as a consequence: xtmux entries now run AFTER
// unowned entries for the same event. That is safe for these hooks
// specifically. They are recorders, not gates: agent-state.sh writes tmux pane
// options and appends a JSONL event, codex-agent-turn-capture.mjs persists the
// turn, and NEITHER writes anything to stdout that Codex could read as a
// decision. Both fail open (agent-state.sh exits 0 without TMUX/TMUX_PANE; the
// capture hook exits 0 on any unreadable payload). They are wired only to
// SessionStart / UserPromptSubmit / Stop / SessionEnd — none of which carry a
// deny/allow verdict, unlike pre_tool_use or permission_request, which xtmux
// does not install into at all. No xtmux hook mutates state another hook reads
// within the same event, so no ordering dependency exists to regress.
//
// The alternative — keep prepending and RE-KEY the trust store — was rejected:
// it would make xtmux a writer of ~/.codex/config.toml, a file Codex owns and
// that holds unowned configuration a lossy TOML round-trip could destroy, in
// exchange for an execution order that carries no correctness weight here.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function entryFingerprint(entry) {
  return createHash("sha256").update(stableStringify(entry)).digest("hex");
}

// Content-based adoption for hooks.json entries, mirroring compatibilityAction()
// for links and expectedManagedSnapshot() for managed directories. Releases
// v0.1.0 through v0.2.2 wrote these Codex entries WITHOUT the _source tag
// (tagging landed in PR #82, first shipped in v0.2.3), so an upgrade from those
// releases used to leave the untagged entry in place next to the new tagged one
// and every lifecycle transition fired twice.
//
// The shapes below are the exact literals those releases emitted, reproduced
// verbatim; `script` resolves to the same managed path they used. Adoption is
// whole-entry: the fingerprint covers every key, so an entry that merely looks
// similar — an extra field, a different statusMessage, a hand-edited command —
// does not match, is preserved, and is reported. Anything not in this table is
// not provably ours and is never touched.
function legacyCodexFingerprints() {
  const script = join(codexHooks, "agent-state.sh");
  const shapes = {
    SessionStart: [
      { matcher: "startup|resume|clear", hooks: [{ type: "command", command: `bash "${script}" idle`, statusMessage: "marking pane idle" }] },
      { matcher: "startup|resume|clear", hooks: [{ type: "command", command: `bash "${script}" idle --new-instance`, statusMessage: "marking pane idle" }] },
    ],
    UserPromptSubmit: [
      { hooks: [{ type: "command", command: `bash "${script}" running`, statusMessage: "marking pane running" }] },
    ],
  };
  return Object.fromEntries(Object.entries(shapes).map(([event, entries]) => [event, new Set(entries.map(entryFingerprint))]));
}

// The reader for _xtmux.hash, which every tagged release has WRITTEN and none
// has read. It answers one question about an owned entry: is its body still the
// body we recorded when we wrote it? A mismatch means the entry drifted (the
// smoke-container drift-repair tamper, a hand edit, an older release's shape),
// so the plan reports `replace` instead of `refresh`. Either way the canonical
// entry is rewritten — the hash makes the repair visible instead of silent.
function codexOwnedDrifted(entry) {
  const recorded = entry?._xtmux?.hash;
  if (typeof recorded !== "string") return true;
  return recorded !== hash({ matcher: entry.matcher, hooks: entry.hooks });
}

function entryCommands(entry) {
  return (Array.isArray(entry?.hooks) ? entry.hooks : []).map((item) => item?.command).filter(Boolean).join(" ; ");
}

// A preserved entry that names our managed hook directory is a near miss: it
// looks like ours but did not match a known shape. It is kept, and reported so
// an operator can decide, because the installer cannot prove it wrote it.
function mentionsManagedCodexHook(entry) {
  return entryCommands(entry).includes(`${codexHooks}/`);
}

function planCodexHooks(removeOnly = false) {
  const settings = readJson(codexSettings);
  const current = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  const legacy = legacyCodexFingerprints();
  const actions = [];
  const next = {};
  for (const [event, entries] of Object.entries(current)) {
    const kept = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      const command = entryCommands(entry);
      if (codexOwned(entry)) {
        actions.push({ event, action: removeOnly ? "remove" : codexOwnedDrifted(entry) ? "replace" : "refresh", command });
      } else if (legacy[event]?.has(entryFingerprint(entry))) {
        actions.push({ event, action: removeOnly ? "remove" : "adopt", command });
      } else {
        actions.push({ event, action: "keep", index: kept.length, command, nearMiss: mentionsManagedCodexHook(entry) });
        kept.push(entry);
      }
    }
    if (kept.length) next[event] = kept;
  }
  if (!removeOnly) {
    for (const [event, entries] of Object.entries(canonicalCodexHooks())) {
      const kept = next[event] || [];
      // Appended, never prepended: see the trust-key note above.
      for (const [offset, entry] of entries.entries()) actions.push({ event, action: "add", index: kept.length + offset, command: entryCommands(entry) });
      next[event] = [...kept, ...entries];
    }
  }
  return { settings, next, actions };
}

function reportCodexActions(actions) {
  const count = (action) => actions.filter((item) => item.action === action).length;
  const kept = actions.filter((item) => item.action === "keep");
  console.log(`    codex hooks: ${count("add")} added, ${count("adopt")} adopted, ${count("replace")} repaired, ${count("remove")} removed, ${kept.length} unowned preserved`);
  for (const item of kept.filter((entry) => entry.nearMiss)) {
    console.log(`    preserved unowned ${item.event}[${item.index}] naming a managed hook (not a known xtmux shape): ${item.command}`);
  }
}

function mergeCodex(removeOnly = false) {
  if (!existsSync(codexRoot) || (removeOnly && !existsSync(codexSettings))) return;
  const { settings, next, actions } = planCodexHooks(removeOnly);
  settings.hooks = next;
  if (existsSync(codexSettings) && !existsSync(`${codexSettings}.pre-xtmux`)) copyFileSync(codexSettings, `${codexSettings}.pre-xtmux`);
  writeJson(codexSettings, settings);
  reportCodexActions(actions);
}

const CANONICAL_PI_PACKAGE = "npm:@jaggerxtrm/xtmux";

function isCanonicalPiPackage(entry) {
  const packageSource = typeof entry === "string" ? entry : entry?.source;
  return typeof packageSource === "string" &&
    (packageSource === CANONICAL_PI_PACKAGE || packageSource.startsWith(`${CANONICAL_PI_PACKAGE}@`));
}

function mergePi(removeOnly = false) {
  const settings = readJson(piSettings);
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  settings.packages = packages.filter((entry) =>
    !isCanonicalPiPackage(entry) && entry !== piPackage && entry?.source !== piPackage
  );
  if (!removeOnly) settings.packages.push(piPackage);
  writeJson(piSettings, settings);
}

function runLegacyMigration() {
  const stateHome = process.env.XDG_STATE_HOME || join(home, ".local", "state");
  const runtimeDir = process.env.XDG_RUNTIME_DIR || "/tmp";
  const result = spawnSync(process.execPath, [join(root, "scripts", "xtmux-obs.mjs"), "obs-migrate", "--apply"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: stateHome,
      XDG_RUNTIME_DIR: runtimeDir,
      XTMUX_OBS_DB_PATH: process.env.XTMUX_OBS_DB_PATH || join(stateHome, "xtmux", "observability.db"),
      XTMUX_OBS_V2: "1",
    },
  });
  if (result.status !== 0) throw new Error(`legacy marker reconciliation failed: ${(result.stderr || result.error?.message || "unknown error").trim().slice(0, 600)}`);
  const report = JSON.parse(result.stdout);
  console.log(`    legacy markers: ${report.legacyMarkers.imported} imported, ${report.legacyMarkers.discarded} discarded, ${report.legacyMarkers.quarantined} quarantined`);
}

function install() {
  const state = installerState();
  preflightInstall();
  assertManageableDirectory(piPackage, "piPackage", state);
  assertManageableDirectory(claudeHooks, "claudeHooks", state);
  if (existsSync(codexRoot)) assertManageableDirectory(codexHooks, "codexHooks", state);

  console.log("1/5 Installing command links");
  for (const [name, src] of Object.entries(bins)) link(src, join(home, ".local", "bin", name));
  for (const [dst, src] of Object.entries(compatibilityLinks)) {
    const action = linkCompatibility(src, dst);
    if (action === "adopt") console.log(`    adopted byte-identical ${dst} (previous copy kept at ${dst}.pre-xtmux)`);
  }

  console.log("2/5 Installing grouped Pi extensions");
  for (const name of ["xtmux-agent-state.ts", "xtmux-auto-monitor.ts", "xtmux-inbox-reply.ts"]) {
    const legacy = join(home, ".pi", "agent", "extensions", name);
    if (ownedLink(legacy)) rmSync(legacy, { force: true });
  }
  removeManagedDirectory(piPackage, "piPackage", state);
  mkdirSync(piPackage, { recursive: true });
  cpSync(join(root, "extensions"), join(piPackage, "extensions"), { recursive: true });
  writeJson(join(piPackage, "package.json"), PI_PACKAGE_MANIFEST);
  mergePi();

  console.log("3/5 Installing Claude and existing Codex hooks");
  removeManagedDirectory(claudeHooks, "claudeHooks", state);
  mkdirSync(claudeHooks, { recursive: true });
  copyFileSync(join(root, "scripts", "agent-state.sh"), join(claudeHooks, "agent-state.sh"));
  for (const name of ["auto-monitor-on-send.mjs", "auto-monitor-on-send.sh", "auto-monitor-consumed.mjs", "auto-monitor-consumed.sh", "auto-monitor-drain-stop.mjs", "claude-agent-turn-capture.mjs", "claude-user-prompt-episode.mjs"]) {
    copyFileSync(join(root, "hooks", "claude", name), join(claudeHooks, name));
  }
  if (existsSync(codexRoot)) {
    removeManagedDirectory(codexHooks, "codexHooks", state);
    mkdirSync(codexHooks, { recursive: true });
    for (const [name, sourcePath] of Object.entries(managedSources.codexHooks)) {
      copyFileSync(sourcePath, join(codexHooks, name));
    }
  }

  console.log("4/5 Updating Claude, Codex, and Pi settings");
  mergeClaude();
  mergeCodex();

  console.log("5/5 Saving installer state and reconciling legacy markers");
  writeJson(statePath, {
    source,
    version: pkg.version,
    packageRoot: root,
    piPackage,
    claudeHooks,
    codexHooks: existsSync(codexRoot) ? codexHooks : null,
    installedAt: new Date().toISOString(),
    snapshots: {
      piPackage: snapshotDirectory(piPackage),
      claudeHooks: snapshotDirectory(claudeHooks),
      codexHooks: existsSync(codexRoot) ? snapshotDirectory(codexHooks) : null,
    },
  });
  runLegacyMigration();
  if (installTmuxHooks) {
    const result = spawnSync(join(home, ".local", "bin", "xtmux"), ["install-hooks", join(home, ".local", "bin", "xtmux")], { stdio: "inherit" });
    if (result.status !== 0) throw new Error("tmux hook installation failed; is a tmux server running?");
  }
  console.log("Installation complete");
}

function remove() {
  const state = installerState();
  console.log("1/4 Removing owned command links");
  for (const name of Object.keys(bins)) {
    const dst = join(home, ".local", "bin", name);
    if (ownedLink(dst)) rmSync(dst, { force: true });
  }
  for (const dst of Object.keys(compatibilityLinks)) if (ownedLink(dst)) rmSync(dst, { force: true });
  console.log("2/4 Removing grouped Pi extensions");
  mergePi(true);
  const piRemoved = removeManagedDirectory(piPackage, "piPackage", state);
  console.log("3/4 Removing Claude/Codex hooks and owned settings entries");
  mergeClaude(true);
  mergeCodex(true);
  const claudeRemoved = removeManagedDirectory(claudeHooks, "claudeHooks", state);
  const codexRemoved = removeManagedDirectory(codexHooks, "codexHooks", state);
  console.log("4/4 Removing installer state");
  if (state?.source === source && piRemoved && claudeRemoved && codexRemoved) rmSync(statePath, { force: true });
  console.log("Uninstall complete");
}

function planCompatibilityLinks() {
  console.log("dry-run: compatibility link plan");
  for (const [dst, src] of Object.entries(compatibilityLinks)) {
    const action = compatibilityAction(dst, src);
    console.log(`  ${action.padEnd(7)} ${dst}`);
    if (action === "refuse") console.log(compatibilityRefusal(dst, src).split("\n").slice(1).join("\n"));
  }
}

// A dry run previously planned links only, so the one file where a mistake is
// least recoverable — a Codex hooks.json holding the operator's unowned,
// individually trusted entries — was the one part nobody could preview. Every
// action planCodexHooks would take is reported here, and nothing is written.
function planCodexHooksDryRun() {
  console.log("dry-run: codex hooks plan");
  if (!existsSync(codexRoot)) {
    console.log("  skip    no ~/.codex directory; xtmux never creates one");
    return;
  }
  const { actions } = planCodexHooks(uninstall);
  if (!actions.length) console.log("  (no codex hook entries to change)");
  for (const item of actions) {
    const where = item.index === undefined ? item.event : `${item.event}[${item.index}]`;
    console.log(`  ${item.action.padEnd(7)} ${where.padEnd(26)} ${item.command}`);
    if (item.nearMiss) console.log("          ^ names a managed hook but is not a known xtmux shape; preserved for review");
  }
}

if (dryRun) {
  planCompatibilityLinks();
  planCodexHooksDryRun();
  console.log("dry-run: no changes were made");
}
else uninstall ? remove() : install();
