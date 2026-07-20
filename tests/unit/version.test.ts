import { describe, expect, test } from "bun:test";
import { collectVersionInfo, formatVersionHuman } from "../../src/version.ts";

// Unit coverage for the build-identity surface (audit §P1-07). Runs from source,
// so the live package.json + git fallback path is what's exercised here; the baked
// `--define` path is covered by the compiled-binary smoke in scripts/smoke-json-api.sh.
describe("collectVersionInfo", () => {
  test("reports the xtmux package identity from the source tree", () => {
    const info = collectVersionInfo();
    expect(info.package).toBe("@jaggerxtrm/xtmux");
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    // A dev checkout is 'local' and (usually) resolves a real short commit.
    expect(info.source).toBe("local");
    expect(info.commit === null || /^[0-9a-f]{7,}$/.test(info.commit)).toBe(true);
    expect(info.dirty === null || typeof info.dirty === "boolean").toBe(true);
  });

  test("always carries a node runtime; bun when run under bun", () => {
    const info = collectVersionInfo();
    expect(typeof info.runtime.node).toBe("string");
    expect(info.runtime.node.length).toBeGreaterThan(0);
    // This test file runs under `bun test`.
    expect(info.runtime.bun).toBe(process.versions.bun ?? null);
    expect(info.runtime.bun).not.toBeNull();
  });

  test("human render surfaces identity and the additive schema line", () => {
    const info = collectVersionInfo();
    const out = formatVersionHuman(info, 7);
    expect(out).toContain(`${info.package} ${info.version}`);
    expect(out).toContain("schema:   7");
    expect(out).toContain(info.runtime.bun ? `bun ${info.runtime.bun}` : `node ${info.runtime.node}`);
  });
});
