import { test } from "node:test";
import assert from "node:assert/strict";
import { decorateMermaid } from "../src/renderer.mjs";

const FLOWCHART = `flowchart TD
  A[Start] --> B{Go?}
  B -->|yes| C[End]`;

function fence(src) {
  return "```mermaid\n" + src + "\n```";
}

function glyphLines(out) {
  return out.split("\n").filter((l) => /[─│┌┐└┘◇]/.test(l));
}

test("flowchart fence renders to a plain code fence with box-drawing glyphs", async () => {
  const doc = "# Turn\n\n" + fence(FLOWCHART) + "\n\nafter";
  const out = await decorateMermaid(doc, { width: 200 });
  assert.ok(!out.includes("```mermaid"), "source fence is gone");
  assert.ok(out.includes("```\n"), "a plain code fence replaces it");
  for (const glyph of "─┌┐└┘│") {
    assert.ok(out.includes(glyph), `output contains ${glyph}`);
  }
  assert.ok(out.includes("after"), "surrounding document is preserved");
});

test("broken fence is preserved verbatim", async () => {
  const src = "classDiagram\n  ??? ????";
  const doc = "before\n" + fence(src) + "\nafter";
  const out = await decorateMermaid(doc, { width: 200 });
  assert.ok(out.includes("```mermaid"), "source fence kept");
  assert.ok(out.includes(src), "broken source preserved verbatim");
  assert.ok(out.includes("before") && out.includes("after"));
});

test("wide diagram never exceeds the popup width", async () => {
  const doc = fence("flowchart TD\n  A[Start] --> B{Go?} --> C[End]");
  const out = await decorateMermaid(doc, { width: 12 });
  assert.ok(!out.includes("```mermaid"), "still rendered");
  const lines = glyphLines(out);
  assert.ok(lines.length > 0, "contains rendered diagram lines");
  for (const line of lines) {
    assert.ok(line.length <= 12, `line of ${line.length} cols exceeds width 12: ${JSON.stringify(line)}`);
  }
});

test("narrow width renders narrower than wide width for the same diagram", async () => {
  const doc = fence("flowchart TD\n  A[Start] --> B{Go?} --> C[End]");
  const wide = Math.max(...glyphLines(await decorateMermaid(doc, { width: 200 })).map((l) => l.length));
  const narrow = Math.max(...glyphLines(await decorateMermaid(doc, { width: 8 })).map((l) => l.length));
  assert.ok(narrow <= 8, "clipped to narrow width");
  assert.ok(narrow < wide, "narrow width yields narrower output");
});

test("unsupported diagram type is left as source", async () => {
  const src = "pie title Pie\n  \"Cats\" : 1";
  const out = await decorateMermaid("before\n" + fence(src) + "\nafter", { width: 200 });
  assert.ok(out.includes("```mermaid") && out.includes(src));
});

test("renderer raw path passes a mermaid fence through untouched", async () => {
  // --raw maps to renderer:"raw", which returns before decorateMermaid runs.
  const { renderDocument } = await import("../src/renderer.mjs");
  const doc = "heading\n" + fence(FLOWCHART) + "\ntail";
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    captured += chunk;
    return true;
  };
  try {
    const code = await renderDocument(doc, { renderer: "raw" });
    assert.equal(code, 0);
  } finally {
    process.stdout.write = original;
  }
  assert.equal(captured, doc, "raw output is byte-for-byte unchanged");
});

const { selectRenderer } = await import("../src/renderer.mjs");
const glow = "/bin/glow";
const mdcat = "/bin/mdcat";

function assertThrowsMissing(fn) {
  assert.throws(fn, (e) => e.code === "XTMUX_VIEW_RENDERER_MISSING");
}

test("selectRenderer: auto prefers mdcat when both renderers exist", () => {
  const r = selectRenderer("auto", { glow, mdcat });
  assert.equal(r.bin, mdcat);
  assert.equal(r.decorate, false, "mdcat renders Mermaid natively, no decorate");
});

test("selectRenderer: auto falls back to glow when mdcat is absent", () => {
  const r = selectRenderer("auto", { glow, mdcat: null });
  assert.equal(r.bin, glow);
  assert.equal(r.decorate, true);
});

test("selectRenderer: explicit glow wins over mdcat", () => {
  const r = selectRenderer("glow", { glow, mdcat });
  assert.equal(r.bin, glow);
  assert.equal(r.decorate, true);
});

test("selectRenderer: explicit mdcat does not decorate", () => {
  const r = selectRenderer("mdcat", { glow, mdcat });
  assert.equal(r.bin, mdcat);
  assert.equal(r.decorate, false);
});

test("selectRenderer: raw returns a raw marker", () => {
  assert.deepEqual(selectRenderer("raw", { glow, mdcat }), { raw: true });
});

test("selectRenderer: missing requested renderer throws", () => {
  assertThrowsMissing(() => selectRenderer("mdcat", { glow, mdcat: null }));
  assertThrowsMissing(() => selectRenderer("glow", { glow: null, mdcat }));
  assertThrowsMissing(() => selectRenderer("auto", { glow: null, mdcat: null }));
});
