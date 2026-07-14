#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

if (!home) throw new Error("HOME is not set; pass --home <path>");
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

function link(src, dst) {
  const current = lstatSafe(dst);
  if (current) {
    if (!current.isSymbolicLink() || !ownedLink(dst)) throw new Error(`refusing to replace existing file: ${dst}`);
    rmSync(dst, { force: true });
  }
  mkdirSync(dirname(dst), { recursive: true });
  symlinkSync(src, dst);
}

function hash(wrapper) {
  return createHash("sha256").update(JSON.stringify({ matcher: wrapper.matcher ?? null, hooks: wrapper.hooks })).digest("hex");
}

function owned(wrapper) {
  if (wrapper && Object.hasOwn(wrapper, "_source") && wrapper._source !== source) return false;
  if (wrapper?._source === source) return true;
  const commands = Array.isArray(wrapper?.hooks) ? wrapper.hooks.map((hook) => hook?.command).filter(Boolean) : [];
  return commands.length > 0 && commands.every((command) =>
    command.includes("/.tmux/scripts/agent-state.sh") || command.includes("/.xtrm/hooks/auto-monitor-")
  );
}

function wrapper(matcher, command, timeout = 5000) {
  const data = { ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command, timeout }] };
  return { ...data, _source: source, _xtmux: { version: pkg.version, hash: hash(data) } };
}

const hook = (name) => join(claudeHooks, name);
function canonicalHooks() {
  const state = (event, next) => wrapper("", `CLAUDE_HOOK_EVENT=${event} bash "${hook("agent-state.sh")}" ${next}`, 2000);
  return {
    SessionStart: [state("SessionStart", "idle")],
    UserPromptSubmit: [state("UserPromptSubmit", "running")],
    PreToolUse: [state("PreToolUse", "running")],
    Notification: [state("Notification", "needs-input")],
    PostToolUse: [
      state("PostToolUse", "running"),
      wrapper("Bash", `bash "${hook("auto-monitor-on-send.sh")}"`),
      wrapper("Monitor|Bash", `bash "${hook("auto-monitor-consumed.sh")}"`),
    ],
    Stop: [state("Stop", "done"), wrapper(undefined, `node "${hook("auto-monitor-drain-stop.mjs")}"`)],
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
  if (existsSync(claudeSettings)) copyFileSync(claudeSettings, `${claudeSettings}.pre-xtmux`);
  writeJson(claudeSettings, settings);
}

function codexOwned(entry) {
  const commands = Array.isArray(entry?.hooks) ? entry.hooks.map((hook) => hook?.command).filter(Boolean) : [];
  return commands.length > 0 && commands.every((command) =>
    command.includes("/.codex/hooks/xtmux/agent-state.sh") || command.includes("/.tmux/scripts/agent-state.sh")
  );
}

function mergeCodex(removeOnly = false) {
  if (!existsSync(codexRoot) || (removeOnly && !existsSync(codexSettings))) return;
  const settings = readJson(codexSettings);
  const current = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  const next = {};
  for (const [event, entries] of Object.entries(current)) {
    const kept = Array.isArray(entries) ? entries.filter((entry) => !codexOwned(entry)) : [];
    if (kept.length) next[event] = kept;
  }
  if (!removeOnly) {
    const script = join(codexHooks, "agent-state.sh");
    next.SessionStart = [{ matcher: "startup|resume|clear", hooks: [{ type: "command", command: `bash "${script}" idle`, statusMessage: "marking pane idle" }] }, ...(next.SessionStart || [])];
    next.UserPromptSubmit = [{ hooks: [{ type: "command", command: `bash "${script}" running`, statusMessage: "marking pane running" }] }, ...(next.UserPromptSubmit || [])];
  }
  settings.hooks = next;
  if (existsSync(codexSettings)) copyFileSync(codexSettings, `${codexSettings}.pre-xtmux`);
  writeJson(codexSettings, settings);
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

function install() {
  console.log("1/5 Installing command links");
  for (const [name, src] of Object.entries(bins)) link(src, join(home, ".local", "bin", name));
  for (const [dst, src] of Object.entries(compatibilityLinks)) link(src, dst);

  console.log("2/5 Installing grouped Pi extensions");
  for (const name of ["xtmux-agent-state.ts", "xtmux-auto-monitor.ts", "xtmux-inbox-reply.ts"]) {
    const legacy = join(home, ".pi", "agent", "extensions", name);
    if (ownedLink(legacy)) rmSync(legacy, { force: true });
  }
  rmSync(piPackage, { recursive: true, force: true });
  mkdirSync(piPackage, { recursive: true });
  cpSync(join(root, "extensions"), join(piPackage, "extensions"), { recursive: true });
  writeJson(join(piPackage, "package.json"), {
    name: "@jaggerxtrm/xtmux-pi-local",
    private: true,
    pi: { extensions: ["./extensions/pi-agent-state.ts", "./extensions/pi-auto-monitor.ts"] },
  });
  mergePi();

  console.log("3/5 Installing Claude and existing Codex hooks");
  rmSync(claudeHooks, { recursive: true, force: true });
  mkdirSync(claudeHooks, { recursive: true });
  copyFileSync(join(root, "scripts", "agent-state.sh"), join(claudeHooks, "agent-state.sh"));
  for (const name of ["auto-monitor-on-send.mjs", "auto-monitor-on-send.sh", "auto-monitor-consumed.mjs", "auto-monitor-consumed.sh", "auto-monitor-drain-stop.mjs"]) {
    copyFileSync(join(root, "hooks", "claude", name), join(claudeHooks, name));
  }
  if (existsSync(codexRoot)) {
    rmSync(codexHooks, { recursive: true, force: true });
    mkdirSync(codexHooks, { recursive: true });
    copyFileSync(join(root, "scripts", "agent-state.sh"), join(codexHooks, "agent-state.sh"));
  }

  console.log("4/5 Updating Claude, Codex, and Pi settings");
  mergeClaude();
  mergeCodex();

  console.log("5/5 Saving installer state");
  writeJson(statePath, { source, version: pkg.version, packageRoot: root, piPackage, claudeHooks, codexHooks: existsSync(codexRoot) ? codexHooks : null, installedAt: new Date().toISOString() });
  if (installTmuxHooks) {
    const result = spawnSync(join(home, ".local", "bin", "xtmux"), ["install-hooks", join(home, ".local", "bin", "xtmux")], { stdio: "inherit" });
    if (result.status !== 0) throw new Error("tmux hook installation failed; is a tmux server running?");
  }
  console.log("Installation complete");
}

function remove() {
  console.log("1/4 Removing owned command links");
  for (const name of Object.keys(bins)) {
    const dst = join(home, ".local", "bin", name);
    if (ownedLink(dst)) rmSync(dst, { force: true });
  }
  for (const dst of Object.keys(compatibilityLinks)) if (ownedLink(dst)) rmSync(dst, { force: true });
  console.log("2/4 Removing grouped Pi extensions");
  mergePi(true);
  rmSync(piPackage, { recursive: true, force: true });
  console.log("3/4 Removing Claude/Codex hooks and owned settings entries");
  mergeClaude(true);
  mergeCodex(true);
  rmSync(claudeHooks, { recursive: true, force: true });
  rmSync(codexHooks, { recursive: true, force: true });
  console.log("4/4 Removing installer state");
  rmSync(statePath, { force: true });
  console.log("Uninstall complete");
}

uninstall ? remove() : install();
