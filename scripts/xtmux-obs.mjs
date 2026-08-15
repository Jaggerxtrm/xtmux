#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
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

// Bun refuses to start when the caller's cwd was deleted, and `xt end` tears
// down the worktree that an agent session's cwd points at (xtmux coord-backend
// error after teardown). Every state path the runtime touches resolves
// absolutely from XDG_STATE_HOME, so restore a valid cwd before spawning:
// the repo root when present, else the home directory.
const cwd = existsSync(root) ? root : homedir();
const result = spawnSync(bun, [join(root, "src/cli.ts"), ...process.argv.slice(2)], { stdio: "inherit", cwd });
if (result.error) {
  console.error(`xtmux-obs: cannot start Bun (${result.error.message}). Reinstall @jaggerxtrm/xtmux or set XTMUX_BUN.`);
  process.exit(1);
}
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
