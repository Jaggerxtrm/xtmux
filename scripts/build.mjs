#!/usr/bin/env node
// Compile bin/xtmux-obs, baking build identity (audit §P1-07) into the binary via
// `bun build --define`. The compiled single-file executable has no package.json or
// .git beside it at runtime, so `xtmux version` can only be honest about its
// commit / version / build time if those are frozen here, at build time.
//
// src/version.ts reads these with a `typeof ... === "string"` guard, so a plain
// `bun build`/`bun run` without these defines still works — it just falls back to
// the live package.json + git read that only a dev checkout has.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const git = (args) => {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "").trim() : "";
};

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const commit = git(["rev-parse", "--short", "HEAD"]);
const dirty = git(["status", "--porcelain"]) !== "";
const builtAt = new Date().toISOString();

// JSON.stringify gives a properly-quoted JS string literal, which is what --define
// expects on the right-hand side.
const define = (name, value) => ["--define", `${name}=${JSON.stringify(value)}`];

const args = [
  "build",
  "--compile",
  "--minify",
  "--sourcemap",
  join(root, "src", "cli.ts"),
  "--outfile",
  join(root, "bin", "xtmux-obs"),
  ...define("__XTMUX_BUILD_VERSION__", pkg.version),
  ...define("__XTMUX_BUILD_COMMIT__", commit),
  ...define("__XTMUX_BUILD_DIRTY__", String(dirty)),
  ...define("__XTMUX_BUILD_AT__", builtAt),
];

const result = spawnSync("bun", args, { stdio: "inherit", cwd: root });
if (result.error) {
  console.error(`xtmux-build: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
