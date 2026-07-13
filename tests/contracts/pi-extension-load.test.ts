import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";
import xtmuxAutoMonitor from "../../extensions/pi-auto-monitor.ts";

const root = join(import.meta.dir, "../..");

test("pinned Pi API loads the two package entrypoints", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-pi-home-"));
  const agentDir = join(home, "pi-agent");
  const marker = join(home, "ambient-extension-loaded");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(join(agentDir, "extensions/ambient.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "leaked"); export default function () {}`);

  const extensions = [
    "extensions/pi-agent-state.ts",
    "extensions/pi-auto-monitor.ts",
  ];
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir };
  delete env.NODE_PATH;

  // Without this, a missing binary makes spawnSync return `status: undefined` and
  // the whole failure reads `Expected: 0 / Received: undefined` — which names
  // neither `pi` nor node_modules, and looks exactly like a merge regression.
  // That cost a real false regression scare: CI runs `bun install --frozen-lockfile`
  // and stays green, so only stale local checkouts see it (xtmux-d0a.20).
  //
  // Fail, do not skip. This test is the only thing pinning the Pi extension API,
  // and a skip would hide it on CI too — if `pi` ever fell out of the lockfile,
  // the pin would silently evaporate instead of going red.
  const piBin = join(root, "node_modules/.bin/pi");
  if (!existsSync(piBin)) {
    throw new Error(
      `pi binary not found: ${piBin}\n` +
      `This test pins the Pi extension API and cannot run without it.\n` +
      `Your node_modules is stale — \`pi\` (@earendil-works/pi-coding-agent) is a devDependency.\n` +
      `Fix: run \`bun install\` (CI runs \`bun install --frozen-lockfile\`).`,
    );
  }

  try {
    const result = spawnSync(piBin, [
      "--no-extensions",
      ...extensions.flatMap((path) => ["-e", join(root, path)]),
      "--list-models",
    ], { cwd: root, env, encoding: "utf8" });

    // spawn itself can fail for reasons the exit-status assertion cannot express
    // (EACCES on a non-executable shim, ENOEXEC on a broken install): those also
    // surface as `status: undefined`, so name them here rather than downstream.
    if (result.error) {
      throw new Error(
        `failed to spawn ${piBin}: ${result.error.message}\n` +
        `The binary exists but could not run — try \`bun install\` to repair node_modules.`,
      );
    }

    expect(result.status, result.stderr).toBe(0);
    expect(extensions).toHaveLength(2);
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);


test("pi-auto-monitor initializes inbox exactly once", () => {
  const events: string[] = [];
  const pi = { on(event: string) { events.push(event); } };
  xtmuxAutoMonitor(pi as any);

  // Inbox contributes one session_start and agent lifecycle handlers; auto-monitor
  // adds only its own tool_result listener. Loading pi-inbox-reply as a third package
  // entrypoint would duplicate these registrations and its idle polling timer.
  expect(events.filter((event) => event === "session_start")).toHaveLength(1);
  expect(events.filter((event) => event === "session_shutdown")).toHaveLength(1);
  expect(events.filter((event) => event === "tool_result")).toHaveLength(2);
});
