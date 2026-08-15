import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDocument,
  episodeBody,
  normalizeTarget,
  parseCli,
  projectEpisode,
  safeTitle,
  sanitizeTerminalText,
  shellQuote,
  SUBSTANTIVE_MIN,
} from "../src/core.mjs";

const long = (text) => `${text} ${"y".repeat(SUBSTANTIVE_MIN)}`;

const episode = {
  schemaVersion: "xtmux.view.episode.v1",
  episodeId: 7,
  paneId: "%553",
  sessionId: "$42",
  runtime: "claude",
  beadId: "infra-er6h",
  openedAtMs: 1000,
  closedAtMs: null,
  candidates: [
    { turnId: 1, summary: "ack", lastMessageText: "Acknowledged.", completedAtMs: 1001, runtime: "claude" },
    {
      turnId: 2,
      summary: "main",
      lastMessageText: "# Status\n\n**Still open.**\n\n```mermaid\nflowchart LR\n A --> B\n```\n\n".concat(long("")),
      completedAtMs: 1002,
      runtime: "claude",
    },
    { turnId: 3, summary: "ok", lastMessageText: "ok", completedAtMs: 1003, runtime: "claude" },
    { turnId: 4, summary: "follow", lastMessageText: long("Follow-up B"), completedAtMs: 1004, runtime: "claude" },
  ],
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

test("projectEpisode: first substantive candidate is primary, later ones follow-ups, acks collapsed", () => {
  const projected = projectEpisode(episode);
  assert.equal(projected.primary.turnId, 2);
  assert.equal(projected.followUps.length, 1);
  assert.equal(projected.followUps[0].turnId, 4);
  assert.deepEqual(projected.collapsed.map((c) => c.turnId), [1, 3]);
});

test("projectEpisode: a short ack can never replace the substantive primary (the Mermaid case)", () => {
  const projected = projectEpisode(episode);
  // The primary body still holds the diagram even though a short
  // acknowledgement arrived AFTER it.
  assert.match(projected.primary.lastMessageText, /```mermaid/);
  assert.notEqual(projected.primary.turnId, 3);
});

test("projectEpisode: an UNDER-200-char Mermaid beats a later acknowledgement (review P1)", () => {
  // The reviewer's exact case: the useful response is a short fenced Mermaid
  // (< SUBSTANTIVE_MIN chars); a later "Acknowledged." must not displace it.
  const shortMermaid = "```mermaid\ngraph TD\n  A-->B\n```";
  assert.ok(shortMermaid.length < 200);
  assert.ok(shortMermaid.length < SUBSTANTIVE_MIN);
  const projected = projectEpisode({
    ...episode,
    candidates: [
      { turnId: 1, summary: "diagram", lastMessageText: shortMermaid, completedAtMs: 1001, runtime: "claude" },
      { turnId: 2, summary: "ack", lastMessageText: "Acknowledged.", completedAtMs: 1002, runtime: "claude" },
    ],
  });
  assert.equal(projected.primary.turnId, 1);
  assert.equal(projected.primary.lastMessageText, shortMermaid);
  assert.deepEqual(projected.followUps, []);
  assert.deepEqual(projected.collapsed.map((c) => c.turnId), [2]);
  // A short markdown table is substantive too; a plain short sentence is not.
  const tabled = projectEpisode({
    ...episode,
    candidates: [
      { turnId: 1, summary: "t", lastMessageText: "| a | b |\n|---|---|\n| 1 | 2 |", completedAtMs: 1001 },
      { turnId: 2, summary: "ack", lastMessageText: "done", completedAtMs: 1002 },
    ],
  });
  assert.equal(tabled.primary.turnId, 1);
  assert.deepEqual(tabled.collapsed.map((c) => c.turnId), [2]);
});

test("projectEpisode: with no substantive candidate, the last text-bearing one is primary", () => {
  const projected = projectEpisode({
    ...episode,
    candidates: [
      { turnId: 1, summary: "first", lastMessageText: "short one", completedAtMs: 1001 },
      { turnId: 2, summary: "last", lastMessageText: "final word", completedAtMs: 1002 },
    ],
  });
  assert.equal(projected.primary.turnId, 2);
  assert.deepEqual(projected.collapsed.map((c) => c.turnId), [1]);
  assert.deepEqual(projected.followUps, []);
});

test("buildDocument preserves assistant Markdown and adds bounded identity", () => {
  const doc = buildDocument(projectEpisode(episode));
  assert.match(doc, /`%553`/);
  assert.match(doc, /\*\*claude\*\*/);
  assert.match(doc, /bead `infra-er6h`/);
  assert.match(doc, /```mermaid/);
  assert.match(doc, /\*\*Still open\.\*\*/);
  assert.doesNotMatch(doc, /geometry|worktree|attached/i);
});

test("buildDocument renders substantive follow-ups and collapses short acks", () => {
  const doc = buildDocument(projectEpisode(episode));
  assert.match(doc, /## Follow-up/);
  assert.match(doc, /Follow-up B/);
  // Short acknowledgements appear only in the collapsed footer, never as body.
  assert.match(doc, /Collapsed: 2 short hook acknowledgement/);
  assert.doesNotMatch(doc, /^Acknowledged\.$/m);
  assert.doesNotMatch(doc, /^ok$/m);
});

test("buildDocument shows a placeholder for an episode with no captured text", () => {
  const doc = buildDocument(projectEpisode({ ...episode, candidates: [] }));
  assert.match(doc, /_No assistant text was captured for this episode\._/);
});

test("episodeBody is the identity-free pipe surface (primary + follow-ups only)", () => {
  const body = episodeBody(projectEpisode(episode));
  assert.match(body, /```mermaid/);
  assert.match(body, /Follow-up B/);
  assert.doesNotMatch(body, /`%553`/);
});

test("assistant text cannot inject terminal control sequences", () => {
  assert.equal(sanitizeTerminalText("ok\x1b[31mred\x07"), "ok[31mred");
  const doc = buildDocument(projectEpisode({
    ...episode,
    candidates: [{ turnId: 1, summary: "x", lastMessageText: "safe\x1b[2Jstill safe".concat(long("")), completedAtMs: 1 }],
  }));
  assert.doesNotMatch(doc, /\x1b/);
});

test("safeTitle removes terminal control characters", () => {
  assert.equal(safeTitle({ paneId: "%1", primary: { runtime: "claude\nboom" } }), "xtmux · %1 · claude boom");
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
