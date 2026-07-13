import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";

const root = join(import.meta.dir, "../..");

test("pinned Pi API loads exactly the three project extensions", () => {
  const home = mkdtempSync(join(tmpdir(), "xtmux-pi-home-"));
  const agentDir = join(home, "pi-agent");
  const marker = join(home, "ambient-extension-loaded");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(join(agentDir, "extensions/ambient.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "leaked"); export default function () {}`);

  const extensions = [
    "extensions/pi-agent-state.ts",
    "extensions/pi-inbox-reply.ts",
    "extensions/pi-auto-monitor.ts",
  ];
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir };
  delete env.NODE_PATH;
  try {
    const result = spawnSync(join(root, "node_modules/.bin/pi"), [
      "--no-extensions",
      ...extensions.flatMap((path) => ["-e", join(root, path)]),
      "--list-models",
    ], { cwd: root, env, encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(extensions).toHaveLength(3);
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);
