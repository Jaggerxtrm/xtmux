import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const ROOT = join(import.meta.dir, "../..");
const PICKER = join(ROOT, "bin/xtmux-classic");
const INSTALL = join(ROOT, "install.sh");

type Fixture = {
  root: string;
  bin: string;
  core: string;
  coreLog: string;
  fzfLog: string;
  fzfInputLog: string;
};

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "xtmux-classic-ui-"));
  const bin = join(root, "bin");
  const core = join(root, "tmux-session-picker");
  const coreLog = join(root, "core.log");
  const fzfLog = join(root, "fzf.log");
  const fzfInputLog = join(root, "fzf-input.log");
  mkdirSync(bin);

  writeFileSync(core, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CORE_LOG"
case "\${1:-}" in
  list|list-active) printf '%s\\n' $'session\\t$42\\talpha\\t$42\\t\\033[1m\\033[38;5;81malpha\\033[0m' ;;
esac
`);
  chmodSync(core, 0o755);

  writeFileSync(join(bin, "fzf"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > "$FZF_LOG"
cat > "$FZF_INPUT_LOG"
head -1 "$FZF_INPUT_LOG"
`);
  chmodSync(join(bin, "fzf"), 0o755);

  return { root, bin, core, coreLog, fzfLog, fzfInputLog };
}

function run(fx: Fixture, args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [PICKER, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${fx.bin}:${process.env.PATH ?? ""}`,
      XTMUX_CLASSIC_CORE: fx.core,
      CORE_LOG: fx.coreLog,
      FZF_LOG: fx.fzfLog,
      FZF_INPUT_LOG: fx.fzfInputLog,
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

function fzfArgs(fx: Fixture): string[] {
  return readFileSync(fx.fzfLog, "utf8").trimEnd().split("\n");
}

describe("xtmux-classic presentation contract", () => {
  test("uses the full canvas, tmux-yellow selection, neutral rows, and hidden details", () => {
    const fx = fixture();
    try {
      const result = run(fx);
      expect(result.status).toBe(0);
      const args = fzfArgs(fx);

      expect(args).toContain("--height=100%");
      expect(args).toContain("--border=none");
      expect(args).toContain("--margin=0");
      expect(args).toContain("--padding=0");
      // Full-width current row, flush-left item text: the default renderer paints
      // bg+ over the item text only, and every gutter column (pointer, marker)
      // insets the text from the left edge of the popup.
      expect(args).toContain("--highlight-line");
      expect(args).toContain("--pointer=");
      expect(args).toContain("--marker=✓");
      // Attribute SGR only reaches fzf if --ansi is on; without it the escapes
      // render as literal text.
      expect(args).toContain("--ansi");
      // Chrome weight comes from the colour spec, which --no-bold does not
      // cancel for an explicit attribute.
      expect(args.some((arg) => arg.startsWith("--color=") && arg.includes("prompt:yellow:bold")
        && arg.includes("header:8:dim") && arg.includes("info:8:dim"))).toBe(true);
      expect(args).toContain("--preview-window=hidden,bottom,40%,border-top,wrap,follow");
      expect(args).toContain("--header=Enter switch · Ctrl-/ details · ? help");
      expect(args.some((arg) => arg.startsWith("--color=") && arg.includes("bg+:yellow") && arg.includes("fg+:black"))).toBe(true);
      expect(args.some((arg) => arg.startsWith("--border-label"))).toBe(false);
      expect(args.some((arg) => arg.includes("transform-border-label"))).toBe(false);
      expect(args.some((arg) => arg.includes("?:change-preview(") && arg.includes("+show-preview"))).toBe(true);

      const fzfInput = readFileSync(fx.fzfInputLog, "utf8");
      // Machine fields stay byte-identical, so every {1}/{2}/{4} action binding
      // and the jump path keep working.
      expect(fzfInput).toContain("session\t$42\talpha\t$42\t");
      // Weight survives the filter (the launcher owns emphasis)...
      expect(fzfInput).toContain("\u001b[1m");
      // ...while the legacy palette's colour does not, so fzf owns colour.
      expect(fzfInput).not.toContain("38;5;81");

      const coreCalls = readFileSync(fx.coreLog, "utf8");
      expect(coreCalls).toContain("list all\n");
      expect(coreCalls).toContain("jump session $42 $42\n");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("compact-nowrap keeps the details pane hidden and disables wrapping", () => {
    const fx = fixture();
    try {
      const result = run(fx, [], { TMUX_PICKER_MODE: "compact-nowrap" });
      expect(result.status).toBe(0);
      expect(fzfArgs(fx)).toContain("--preview-window=hidden,bottom,40%,border-top,follow");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("non-interactive subcommands delegate directly to the legacy implementation", () => {
    const fx = fixture();
    try {
      const result = run(fx, ["dashboard", "sessions-only"]);
      expect(result.status).toBe(0);
      expect(readFileSync(fx.coreLog, "utf8")).toBe("dashboard sessions-only\n");
      expect(existsSync(fx.fzfLog)).toBe(false);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("publishes the classic launcher and routes checkout install scripts through install.sh", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.bin["xtmux-classic"]).toBe("bin/xtmux-classic");
    expect(pkg.files).toContain("bin/xtmux-classic");
    expect(pkg.scripts["install:global"]).toBe("bash install.sh");
    expect(pkg.scripts["uninstall:global"]).toBe("bash install.sh --uninstall");
    expect(spawnSync("bash", ["-n", PICKER]).status).toBe(0);
    expect(spawnSync("bash", ["-n", INSTALL]).status).toBe(0);
  });

  test("checkout install refuses a foreign classic launcher before mutating existing command links", () => {
    const home = mkdtempSync(join(tmpdir(), "xtmux-classic-install-conflict-"));
    const bin = join(home, ".local", "bin");
    const foreign = join(bin, "xtmux-classic");
    mkdirSync(bin, { recursive: true });
    writeFileSync(foreign, "foreign\n");
    try {
      const result = spawnSync("bash", [INSTALL], {
        cwd: ROOT,
        env: {
          ...process.env,
          HOME: home,
          XDG_STATE_HOME: join(home, ".local", "state"),
          XDG_RUNTIME_DIR: join(home, "runtime"),
          TMPDIR: join(home, "tmp"),
        },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("refusing to replace existing file");
      expect(readFileSync(foreign, "utf8")).toBe("foreign\n");
      expect(existsSync(join(bin, "xtmux"))).toBe(false);
      expect(existsSync(join(home, ".claude", "hooks", "xtmux"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
