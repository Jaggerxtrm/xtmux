import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const ROOT = join(import.meta.dir, "../..");
const DOC = join(ROOT, "docs/json-command-api.md");

function rows(): Set<string> {
  const text = readFileSync(DOC, "utf8");
  return new Set([...text.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]!));
}

describe("JSON command classification matrix", () => {
  test("classifies every picker dispatcher command", () => {
    const source = readFileSync(join(ROOT, "bin/tmux-session-picker"), "utf8");
    const start = source.lastIndexOf('case "${1:-}" in');
    const body = source.slice(start, source.indexOf("\nesac\n\nif ! command -v fzf", start));
    const commands = [...body.matchAll(/^  ([^ \n][^\n]*)\)\n/gm)]
      .flatMap((match) => match[1]!.split("|"))
      .map((command) => command.replaceAll('"', ""))
      .filter((command) => command && command !== "*");
    const documented = rows();
    expect(commands.filter((command) => !documented.has(`picker:${command}`))).toEqual([]);
  });

  test("classifies every compiled CLI command and domain subcommand", () => {
    const source = readFileSync(join(ROOT, "src/cli.ts"), "utf8");
    const start = source.indexOf("switch (cmd)");
    const commands = new Set([...source.slice(start).matchAll(/case "([^"]+)":/g)].map((match) => match[1]!));
    const documented = rows();
    expect([...commands].filter((command) => !documented.has(`obs:${command}`))).toEqual([]);
    for (const command of [
      "monitor:register", "monitor:adopt", "monitor:heartbeat", "monitor:terminate", "monitor:list", "monitor:kill",
      "telemetry:start", "telemetry:finish", "audit:ingest", "obligations:list",
    ]) expect(documented.has(`obs:${command}`)).toBe(true);
  });
});
