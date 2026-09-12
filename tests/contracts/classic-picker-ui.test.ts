import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const ROOT = join(import.meta.dir, "../..");
const PICKER = join(ROOT, "bin/xtmux-classic");

type Fixture = {
  root: string;
  bin: string;
  core: string;
  coreLog: string;
  fzfLog: string;
};

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "xtmux-classic-ui-"));
  const bin = join(root, "bin");
  const core = join(root, "tmux-session-picker");
  const coreLog = join(root, "core.log");
  const fzfLog = join(root, "fzf.log");
  mkdirSync(bin);

  writeFileSync(core, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CORE_LOG"
case "\${1:-}" in
  list) printf '%s\\n' $'session\\t$42\\talpha\\t$42\\talpha' ;;
esac
`);
  chmodSync(core, 0o755);

  writeFileSync(join(bin, "fzf"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > "$FZF_LOG"
cat >/dev/null
printf '%s\\n' $'session\\t$42\\talpha\\t$42\\talpha'
`);
  chmodSync(join(bin, "fzf"), 0o755);

  return { root, bin, core, coreLog, fzfLog };
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
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

function fzfArgs(fx: Fixture): string[] {
  return readFileSync(fx.fzfLog, "utf8").trimEnd().split("\n");
}

describe("xtmux-classic presentation contract", () => {
  test("uses the full canvas, tmux-yellow selection, and hidden on-demand details", () => {
    const fx = fixture();
    try {
      const result = run(fx);
      expect(result.status).toBe(0);
      const args = fzfArgs(fx);

      expect(args).toContain("--height=100%");
      expect(args).toContain("--border=none");
      expect(args).toContain("--margin=0");
      expect(args).toContain("--padding=0");
      expect(args).toContain("--preview-window=hidden,bottom,40%,border-top,wrap,follow");
      expect(args).toContain("--header=Enter switch · Ctrl-/ details · ? help");
      expect(args.some((arg) => arg.startsWith("--color=") && arg.includes("bg+:yellow") && arg.includes("fg+:black"))).toBe(true);
      expect(args.some((arg) => arg.startsWith("--border-label"))).toBe(false);
      expect(args.some((arg) => arg.includes("transform-border-label"))).toBe(false);
      expect(args.some((arg) => arg.includes("?:change-preview(") && arg.includes("+show-preview"))).toBe(true);

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
});
