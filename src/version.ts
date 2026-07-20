import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build identity for `xtmux version [--json]` (audit ~/dev/11.md §P1-07). Mirrors
 * the Core `xt version --json` shape so `xt doctor runtime-stack` can aggregate
 * all three executables against one contract:
 *
 *   { package, version, commit, dirty, source, built_at, runtime }
 *
 * xtmux differs from Core in ONE way that shapes this file: Core ships a Node
 * tarball whose package.json and dist sit on disk, so it reads identity live.
 * xtmux ships `bin/xtmux-obs` as a `bun build --compile` single-file executable
 * with no readable package.json or .git beside it. So the shipped binary's
 * identity is BAKED at build time via `bun build --define` (see scripts/build.mjs),
 * and this module falls back to a live package.json + git read only in dev
 * (`bun run src/cli.ts`) and under `bun test`, where the source tree is present.
 */

// Replaced at compile time by scripts/build.mjs. `typeof` on an undeclared global
// is the one read that does not throw, so in dev/test (no --define) these resolve
// to "undefined" and we fall through to the live reads below.
declare const __XTMUX_BUILD_VERSION__: string;
declare const __XTMUX_BUILD_COMMIT__: string;
declare const __XTMUX_BUILD_DIRTY__: string;
declare const __XTMUX_BUILD_AT__: string;

export interface VersionInfo {
  package: string;
  version: string;
  commit: string | null;
  dirty: boolean | null;
  source: "npm" | "local";
  built_at: string | null;
  runtime: {
    /** null when running under Node (packaging scripts) rather than Bun. */
    bun: string | null;
    node: string;
  };
}

function bakedStr(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

interface Baked {
  version: string | undefined;
  commit: string | undefined;
  dirty: boolean | undefined;
  builtAt: string | undefined;
}

function readBaked(): Baked {
  const version = typeof __XTMUX_BUILD_VERSION__ === "string" ? bakedStr(__XTMUX_BUILD_VERSION__) : undefined;
  const commit = typeof __XTMUX_BUILD_COMMIT__ === "string" ? bakedStr(__XTMUX_BUILD_COMMIT__) : undefined;
  const dirtyRaw = typeof __XTMUX_BUILD_DIRTY__ === "string" ? bakedStr(__XTMUX_BUILD_DIRTY__) : undefined;
  const builtAt = typeof __XTMUX_BUILD_AT__ === "string" ? bakedStr(__XTMUX_BUILD_AT__) : undefined;
  return { version, commit, dirty: dirtyRaw === undefined ? undefined : dirtyRaw === "true", builtAt };
}

function moduleFile(): string {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return "";
  }
}

/** Walk up from the module dir looking for the package.json that names us. On the
 *  compiled binary there is none on disk, so this returns null and we lean on the
 *  baked constants. */
function findPackageJson(startDir: string): { name: string; version: string; root: string } | null {
  let dir = startDir;
  for (let i = 0; i < 6 && dir; i++) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
      if (parsed?.name && parsed?.version) return { name: parsed.name, version: parsed.version, root: dir };
    } catch {
      /* keep walking */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function git(root: string, args: string[]): string | null {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return (r.stdout ?? "").trim();
}

export function collectVersionInfo(): VersionInfo {
  const baked = readBaked();
  const file = moduleFile();
  const pkg = file ? findPackageJson(dirname(file)) : null;
  // No package.json on disk == the compiled/published binary. A dev checkout
  // always finds one; an `npm i`-ed copy finds one under node_modules.
  const packaged = pkg === null;

  let commit: string | null = baked.commit ?? null;
  let dirty: boolean | null = baked.dirty ?? null;
  let builtAt: string | null = baked.builtAt ?? null;

  // Live git only makes sense against a real working tree (dev). A packaged copy
  // has no .git; its identity is whatever was baked in at build time.
  if (commit === null && pkg) {
    commit = git(pkg.root, ["rev-parse", "--short", "HEAD"]);
    const status = git(pkg.root, ["status", "--porcelain"]);
    dirty = status === null ? null : status !== "";
  }
  if (builtAt === null && file) {
    try {
      builtAt = new Date(statSync(file).mtime).toISOString();
    } catch {
      /* leave null */
    }
  }

  const source: "npm" | "local" = packaged || (pkg !== null && pkg.root.split(sep).includes("node_modules")) ? "npm" : "local";

  return {
    package: pkg?.name ?? "@jaggerxtrm/xtmux",
    version: baked.version ?? pkg?.version ?? "0.0.0",
    commit,
    dirty,
    source,
    built_at: builtAt,
    runtime: {
      bun: process.versions.bun ?? null,
      node: process.versions.node,
    },
  };
}

/** Human render. schemaVersion is xtmux-specific (the SQLite journal schema) and
 *  is kept visible so the one command an operator runs to ask "what am I running"
 *  still answers the question it answered before build identity was added. */
export function formatVersionHuman(info: VersionInfo, schemaVersion: number): string {
  const commitStr = info.commit ? info.commit + (info.dirty ? "-dirty" : "") : "unknown";
  const rt = info.runtime.bun ? `bun ${info.runtime.bun}` : `node ${info.runtime.node}`;
  return [
    `${info.package} ${info.version}`,
    `  commit:   ${commitStr}`,
    `  source:   ${info.source}`,
    `  built at: ${info.built_at ?? "unknown"}`,
    `  runtime:  ${rt}`,
    `  schema:   ${schemaVersion}`,
  ].join("\n");
}
