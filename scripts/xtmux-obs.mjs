#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let bun = process.env.XTMUX_BUN || "bun";
try {
  const manifest = createRequire(import.meta.url).resolve("bun/package.json");
  bun = join(dirname(manifest), "bin", "bun.exe");
} catch {
  // Fall back to PATH for checkout installs that intentionally omit npm dependencies.
}

const result = spawnSync(bun, [join(root, "src/cli.ts"), ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) {
  console.error(`xtmux-obs: cannot start Bun (${result.error.message}). Reinstall @jaggerxtrm/xtmux or set XTMUX_BUN.`);
  process.exit(1);
}
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
