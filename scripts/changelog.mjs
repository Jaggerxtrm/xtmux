#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = fileURLToPath(import.meta.resolve("git-cliff/cli"));
const result = spawnSync(process.execPath, [cli, "--config", join(root, "changelog", "cliff.toml"), ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) {
  console.error(`xtmux-changelog: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
