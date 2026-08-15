import test from "node:test";
import assert from "node:assert/strict";
import { buildDocument, normalizeTarget, parseCli, safeTitle, sanitizeTerminalText, shellQuote } from "../src/core.mjs";

const turn = {
  paneId: "%553",
  sessionId: "$42",
  runtime: "claude",
  beadId: "infra-er6h",
  lastMessageText: "# Status\n\n**Still open.**\n\n```mermaid\nflowchart LR\n A --> B\n```",
};

test("normalizeTarget accepts stable pane and session ids", () => {
  assert.equal(normalizeTarget("%553", {}), "%553");
  assert.equal(normalizeTarget("$42", {}), "$42");
  assert.equal(normalizeTarget(undefined, { TMUX_PANE: "%9" }), "%9");
});

test("normalizeTarget rejects shell-like and mutable names", () => {
  for (const bad of ["", "main", "%1;rm -rf /", "$(id)", "%1\n%2"]) {
    assert.throws(() => normalizeTarget(bad, {}));
  }
});

test("buildDocument preserves assistant Markdown and adds bounded identity", () => {
  const doc = buildDocument(turn);
  assert.match(doc, /`%553`/);
  assert.match(doc, /\*\*claude\*\*/);
  assert.match(doc, /bead `infra-er6h`/);
  assert.match(doc, /```mermaid/);
  assert.match(doc, /\*\*Still open\.\*\*/);
  assert.doesNotMatch(doc, /geometry|worktree|attached/i);
});

test("assistant text cannot inject terminal control sequences", () => {
  assert.equal(sanitizeTerminalText("ok\x1b[31mred\x07"), "ok[31mred");
  const doc = buildDocument({ ...turn, lastMessageText: "safe\x1b[2Jstill safe" });
  assert.doesNotMatch(doc, /\x1b/);
});

test("safeTitle removes terminal control characters", () => {
  assert.equal(safeTitle({ paneId: "%1", runtime: "claude\nboom" }), "xtmux · %1 · claude boom");
});

test("shellQuote produces one POSIX shell word", () => {
  assert.equal(shellQuote("/tmp/a b"), "'/tmp/a b'");
  assert.equal(shellQuote("a'b"), "'a'\"'\"'b'");
});

test("parseCli keeps popup and renderer settings explicit", () => {
  const parsed = parseCli(["%553", "--renderer=glow", "--style", "dark", "--popup-width", "80%"]);
  assert.equal(parsed.target, "%553");
  assert.equal(parsed.renderer, "glow");
  assert.equal(parsed.style, "dark");
  assert.equal(parsed.popupWidth, "80%");
  assert.equal(parsed.popupHeight, "90%");
});
