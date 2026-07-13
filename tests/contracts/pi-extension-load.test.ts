import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "bun:test";

const root = join(import.meta.dir, "../..");

test("pinned Pi API compiles and loads every extension without NODE_PATH", () => {
  const env = { ...process.env };
  delete env.NODE_PATH;
  const result = spawnSync(join(root, "node_modules/.bin/pi"), [
    "-e", join(root, "extensions/pi-agent-state.ts"),
    "-e", join(root, "extensions/pi-inbox-reply.ts"),
    "-e", join(root, "extensions/pi-auto-monitor.ts"),
    "-e", join(root, "tests/fixtures/pi-extension-api-probe.ts"),
    "--list-models",
  ], { cwd: root, env, encoding: "utf8" });

  expect(result.status, result.stderr).toBe(0);
}, 20_000);
