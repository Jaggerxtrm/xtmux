import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { ViewError } from "./core.mjs";

export function findExecutable(name, env = process.env) {
  const pathValue = env.PATH || "";
  const extensions = process.platform === "win32"
    ? (env.PATHEXT || ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = join(dir, `${name}${ext}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch { /* try next */ }
    }
  }
  return null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: options.env || process.env,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function renderDocument(document, options = {}) {
  const env = options.env || process.env;
  const renderer = options.renderer || "auto";
  const style = options.style || "dark";

  if (renderer === "raw") {
    process.stdout.write(document);
    return 0;
  }

  const glow = findExecutable("glow", env);
  if (!glow && renderer === "glow") {
    throw new ViewError(
      "XTMUX_VIEW_RENDERER_MISSING",
      "Glow is not installed; install Glow >= 2.1.0 or use --renderer raw",
    );
  }
  if (!glow) {
    throw new ViewError(
      "XTMUX_VIEW_RENDERER_MISSING",
      "no rich Markdown renderer found; install Glow >= 2.1.0 or use --renderer raw",
    );
  }

  const dir = mkdtempSync(join(tmpdir(), "xtmux-view-"));
  const path = join(dir, "turn.md");
  try {
    writeFileSync(path, document, { encoding: "utf8", mode: 0o600 });
    return run(glow, ["--tui", "-s", style, path], { env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
