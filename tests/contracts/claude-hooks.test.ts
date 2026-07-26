import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const installer = join(root, "scripts/install.mjs");
const homes: string[] = [];

function home(settings: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-claude-hooks-"));
  homes.push(dir);
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude/settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings, null, 2));
  return dir;
}

function run(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, [installer, "--home", dir, ...args], { cwd: root, encoding: "utf8" });
}

function settings(dir: string): any {
  return JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
}

function commands(value: any): string[] {
  return Object.values(value.hooks ?? {}).flatMap((entries: any) =>
    entries.flatMap((entry: any) => (entry.hooks ?? []).map((hook: any) => hook.command)),
  );
}

const foreign = {
  model: "opus",
  permissions: { allow: ["Bash(ls:*)"] },
  hooks: {
    SessionStart: [{ _source: "xtrm-global", hooks: [{ type: "command", command: 'node "$HOME/.xtrm/hooks/start.mjs"' }] }],
    Stop: [{ hooks: [{ type: "command", command: "user-stop" }] }],
  },
};

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Claude settings merge", () => {
  test("preserves unrelated top-level settings and hooks", () => {
    const dir = home(foreign);
    expect(run(dir).status).toBe(0);
    const after = settings(dir);
    expect(after.model).toBe("opus");
    expect(after.permissions).toEqual(foreign.permissions);
    expect(commands(after)).toContain('node "$HOME/.xtrm/hooks/start.mjs"');
    expect(commands(after)).toContain("user-stop");
  });

  test("is byte-idempotent", () => {
    const dir = home(foreign);
    expect(run(dir).status).toBe(0);
    const once = readFileSync(join(dir, ".claude/settings.json"), "utf8");
    expect(run(dir).status).toBe(0);
    expect(readFileSync(join(dir, ".claude/settings.json"), "utf8")).toBe(once);
  });

  // xtrm-wiy5n.4.27: ownership is proven only by _source: "xtmux". Untagged
  // entries — even ones invoking our script paths — are not ours to remove; the
  // installer cannot prove it wrote them. Live untagged duplicates stop growing
  // because every tagged write self-removes on rerun.
  test("leaves untagged legacy entries alone and still adds canonical hooks", () => {
    const dir = home({ hooks: { Stop: [
      { hooks: [{ type: "command", command: "CLAUDE_HOOK_EVENT=Stop ~/.tmux/scripts/agent-state.sh done" }] },
      { hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.xtrm/hooks/auto-monitor-drain-stop.mjs"' }] },
    ] } });
    expect(run(dir).status).toBe(0);
    const installed = commands(settings(dir));
    expect(installed.some((command) => command.includes("~/.tmux/scripts/agent-state.sh"))).toBe(true);
    expect(installed.some((command) => command.includes("$CLAUDE_PROJECT_DIR"))).toBe(true);
    const canonicalDrain = settings(dir).hooks.Stop.filter((entry: any) =>
      entry._source === "xtmux" && entry.hooks?.some((hook: any) => hook.command.includes("auto-monitor-drain-stop.mjs")));
    expect(canonicalDrain).toHaveLength(1);
  });

  // xtrm-wiy5n.4.27: the pre-existing untagged clones on the operator machine
  // (three copies of every hook) are LEFT in place, and the installer's own
  // tagged writes must be exactly one per hook and byte-idempotent on rerun.
  test("leaves untagged clones alone and its own tagged writes are byte-idempotent", () => {
    const clone = (dir: string, event: string, command: string) => ({
      ...(event === "PostToolUse" ? { matcher: "Bash" } : {}),
      hooks: [{ type: "command", command: command.replace("<HOME>", dir) }],
    });
    const dir = mkdtempSync(join(tmpdir(), "xtmux-claude-hooks-"));
    homes.push(dir);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const dup = (event: string, command: string) => [clone(dir, event, command), clone(dir, event, command)];
    const stopCmd = 'CLAUDE_HOOK_EVENT=Stop bash "<HOME>/.claude/hooks/xtmux/agent-state.sh" done'.replace("<HOME>", dir);
    const sendCmd = 'bash "<HOME>/.claude/hooks/xtmux/auto-monitor-on-send.sh"'.replace("<HOME>", dir);
    writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify({
      hooks: {
        Stop: [
          ...dup("Stop", 'CLAUDE_HOOK_EVENT=Stop bash "<HOME>/.claude/hooks/xtmux/agent-state.sh" done'),
          { hooks: [{ type: "command", command: "user-stop" }] },
        ],
        PostToolUse: dup("PostToolUse", 'bash "<HOME>/.claude/hooks/xtmux/auto-monitor-on-send.sh"'),
      },
    }));

    expect(run(dir).status).toBe(0);
    const after = settings(dir);
    expect(after.hooks.Stop.filter((entry: any) => !entry._source && entry.hooks?.[0]?.command === stopCmd)).toHaveLength(2);
    expect(after.hooks.PostToolUse.filter((entry: any) => !entry._source && entry.hooks?.[0]?.command === sendCmd)).toHaveLength(2);
    const taggedStop = after.hooks.Stop.filter((entry: any) => entry._source === "xtmux" && entry.hooks?.[0]?.command.startsWith("CLAUDE_HOOK_EVENT=Stop "));
    expect(taggedStop).toHaveLength(1);
    const taggedSend = after.hooks.PostToolUse.filter((entry: any) => entry._source === "xtmux" && entry.hooks?.[0]?.command.includes("auto-monitor-on-send.sh"));
    expect(taggedSend).toHaveLength(1);
    expect(commands(after)).toContain("user-stop");

    const once = readFileSync(join(dir, ".claude/settings.json"), "utf8");
    expect(run(dir).status).toBe(0);
    expect(readFileSync(join(dir, ".claude/settings.json"), "utf8")).toBe(once);

    expect(run(dir, "--uninstall").status).toBe(0);
    const afterUninstall = settings(dir);
    expect(afterUninstall.hooks.Stop.filter((entry: any) => entry._source === "xtmux")).toHaveLength(0);
    expect(afterUninstall.hooks.Stop.filter((entry: any) => !entry._source && entry.hooks?.[0]?.command === stopCmd)).toHaveLength(2);
    expect(commands(afterUninstall)).toContain("user-stop");
  });

  // The ownership sweep is scoped to the managed hooks directory. A user who
  // drops their OWN script in there and registers it untagged must survive:
  // remove() runs mergeClaude(true) before it ever examines the directory, so a
  // bare directory match would strip the registration on uninstall — leaving an
  // orphaned script and no hook. Proximity to our files is not ownership.
  test("preserves a user script registered from inside the managed hooks dir", () => {
    const dir = home({});
    expect(run(dir).status).toBe(0);
    const mine = join(dir, ".claude/hooks/xtmux/my-own-hook.sh");
    writeFileSync(mine, "#!/usr/bin/env bash\nexit 0\n");
    const current = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
    current.hooks.Stop.push({ hooks: [{ type: "command", command: `bash "${mine}"` }] });
    writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify(current, null, 2));

    expect(run(dir, "--uninstall").status).toBe(0);
    expect(commands(settings(dir))).toEqual([`bash "${mine}"`]);
    expect(existsSync(mine)).toBe(true);
  });

  test("uninstall removes only xtmux-owned entries", () => {
    const dir = home(foreign);
    expect(run(dir).status).toBe(0);
    expect(run(dir, "--uninstall").status).toBe(0);
    const after = settings(dir);
    expect(after.model).toBe("opus");
    expect(commands(after).sort()).toEqual(['node "$HOME/.xtrm/hooks/start.mjs"', "user-stop"].sort());
  });

  test("refuses corrupt JSON without replacing it", () => {
    const dir = home("{ this is not json");
    expect(run(dir).status).not.toBe(0);
    expect(readFileSync(join(dir, ".claude/settings.json"), "utf8")).toBe("{ this is not json");
  });

  test("registers shell prefilters and materializes every hook file", () => {
    const dir = home({});
    expect(run(dir).status).toBe(0);
    const installed = commands(settings(dir));
    expect(installed.some((command) => command.includes("auto-monitor-on-send.sh"))).toBe(true);
    expect(installed.some((command) => command.includes("auto-monitor-consumed.sh"))).toBe(true);
    expect(installed.some((command) => command.includes('node "') && command.includes("auto-monitor-on-send.mjs"))).toBe(false);
    for (const name of ["auto-monitor-on-send.sh", "auto-monitor-on-send.mjs", "auto-monitor-consumed.sh", "auto-monitor-consumed.mjs", "auto-monitor-drain-stop.mjs"]) {
      expect(existsSync(join(dir, ".claude/hooks/xtmux", name))).toBe(true);
    }
  });
});
