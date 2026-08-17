import { homedir } from "node:os";
import { join } from "node:path";

const TARGET_RE = /^(?:%\d+|\$\d+)$/;

export class ViewError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "ViewError";
    this.code = code;
    this.detail = detail;
  }
}

export function normalizeTarget(value, env = process.env) {
  const target = String(value ?? env.TMUX_PANE ?? "").trim();
  if (!target) {
    throw new ViewError(
      "XTMUX_VIEW_TARGET_REQUIRED",
      "target is required outside a tmux pane; pass %pane or $session",
    );
  }
  if (!TARGET_RE.test(target)) {
    throw new ViewError(
      "XTMUX_VIEW_INVALID_TARGET",
      `invalid target ${JSON.stringify(target)}; expected %<pane-id> or $<session-id>`,
      { target },
    );
  }
  return target;
}

export function defaultDbPath(env = process.env) {
  const xdgState = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return env.XTMUX_OBS_DB_PATH || join(xdgState, "xtmux", "observability.db");
}

function consumeValue(argv, index, name) {
  const arg = argv[index];
  const eq = arg.indexOf("=");
  if (eq > 0) return { value: arg.slice(eq + 1), next: index };
  const next = argv[index + 1];
  if (next === undefined || next.startsWith("--")) {
    throw new ViewError("XTMUX_VIEW_INVALID_ARGUMENT", `${name} requires a value`);
  }
  return { value: next, next: index + 1 };
}

export function parseCli(argv) {
  const out = {
    target: undefined,
    help: false,
    doctor: false,
    raw: false,
    json: false,
    render: false,
    noPopup: false,
    renderer: process.env.XTMUX_VIEW_RENDERER || "auto",
    style: process.env.XTMUX_VIEW_GLOW_STYLE || "dark",
    popupWidth: process.env.XTMUX_VIEW_POPUP_WIDTH || "88%",
    popupHeight: process.env.XTMUX_VIEW_POPUP_HEIGHT || "90%",
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") out.help = true;
    else if (arg === "doctor") out.doctor = true;
    else if (arg === "--raw") out.raw = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--render") out.render = true;
    else if (arg === "--no-popup") out.noPopup = true;
    else if (arg === "--target" || arg.startsWith("--target=")) {
      const consumed = consumeValue(argv, i, "--target");
      out.target = consumed.value;
      i = consumed.next;
    } else if (arg === "--renderer" || arg.startsWith("--renderer=")) {
      const consumed = consumeValue(argv, i, "--renderer");
      out.renderer = consumed.value;
      i = consumed.next;
    } else if (arg === "--style" || arg.startsWith("--style=")) {
      const consumed = consumeValue(argv, i, "--style");
      out.style = consumed.value;
      i = consumed.next;
    } else if (arg === "--popup-width" || arg.startsWith("--popup-width=")) {
      const consumed = consumeValue(argv, i, "--popup-width");
      out.popupWidth = consumed.value;
      i = consumed.next;
    } else if (arg === "--popup-height" || arg.startsWith("--popup-height=")) {
      const consumed = consumeValue(argv, i, "--popup-height");
      out.popupHeight = consumed.value;
      i = consumed.next;
    } else if (arg.startsWith("--")) {
      throw new ViewError("XTMUX_VIEW_INVALID_ARGUMENT", `unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (!out.target && positional.length > 0) out.target = positional[0];
  if (positional.length > 1) {
    throw new ViewError("XTMUX_VIEW_INVALID_ARGUMENT", "only one target may be supplied");
  }
  if (!new Set(["auto", "glow", "mdcat", "raw"]).has(out.renderer)) {
    throw new ViewError(
      "XTMUX_VIEW_INVALID_ARGUMENT",
      `unsupported renderer ${JSON.stringify(out.renderer)}; expected auto|glow|mdcat|raw`,
    );
  }
  return out;
}

export function sanitizeTerminalText(value) {
  return String(value ?? "")
    // C0 + DEL + C1 controls: terminal control sequences (ESC, CSI U+009B,
    // BEL, …) must never reach the rendered Markdown from any candidate role.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u0080-\u009f]/g, "")
    .replace(/\r\n?/g, "\n");
}

// xtmux-it6: a candidate is "substantive" when its text clears this bar;
// shorter rows are hook acknowledgements ("Acknowledged.") and are collapsed,
// never used to replace the primary response. Length alone is not the rule: a
// short Mermaid/table/code block is still a real response, and a later short
// acknowledgement must never displace it. Mirrors isSubstantiveText in
// src/domains/agents/episode.ts (xtmux core) — the two must stay in lockstep.
export const SUBSTANTIVE_MIN = 200;

export function isSubstantiveText(text) {
  const t = String(text ?? "");
  if (t.length >= SUBSTANTIVE_MIN) return true;
  if (t.includes("```") || t.includes("~~~")) return true;
  if (t.includes("\n") && /^\s*\|/m.test(t)) return true;
  return false;
}

function candidateText(candidate) {
  return String(candidate.lastMessageText ?? candidate.summary ?? "");
}

/**
 * Conservative episode projection (the viewer half of the contract): the
 * first substantive candidate is the primary response, later substantive
 * candidates are follow-ups, and short hook acknowledgements are collapsed.
 * With no substantive candidate, the last text-bearing one becomes primary so
 * a capture that only ever got short text is still visible.
 */
export function projectEpisode(episode) {
  const candidates = episode.candidates ?? [];
  const substantive = candidates.filter((c) => isSubstantiveText(candidateText(c)));
  const primary = substantive[0]
    ?? [...candidates].reverse().find((c) => candidateText(c).length > 0)
    ?? null;
  const followUps = substantive.slice(1);
  const collapsed = candidates.filter((c) => c !== primary && !followUps.includes(c));
  return { ...episode, primary, followUps, collapsed };
}

function markdownCode(value) {
  return `\`${String(value).replaceAll("`", "\\`")}\``;
}

// The rendered episode body: primary response, then each substantive follow-up
// as its own section. Short hook acknowledgements appear only as a collapsed
// footer — they never replace or displace the primary (the Mermaid case: a
// response holding a diagram survives a later "acknowledged" Stop candidate).
export function episodeBody(episode) {
  const sections = [];
  if (episode.primary) {
    const body = sanitizeTerminalText(candidateText(episode.primary)).trim();
    if (body) sections.push(body);
  }
  for (const followUp of episode.followUps ?? []) {
    const body = sanitizeTerminalText(candidateText(followUp)).trim();
    if (body) sections.push(`## Follow-up\n\n${body}`);
  }
  const collapsedCount = (episode.collapsed ?? []).length;
  if (collapsedCount > 0) {
    // Collapsed hints pass through the SAME sanitization boundary as the
    // primary and follow-ups: a short "Acknowledged. <ESC>[2J" must be at
    // least as safe when collapsed as it would be as a body section.
    const hints = (episode.collapsed ?? [])
      .map((c) => sanitizeTerminalText(candidateText(c)).replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 3)
      .map((text) => `\"${text.slice(0, 80)}\"`);
    const suffix = collapsedCount > hints.length ? ` (+${collapsedCount - hints.length} more)` : "";
    sections.push(`_Collapsed: ${collapsedCount} short hook acknowledgement(s)${suffix}${hints.length ? ` — ${hints.join(" · ")}` : ""}_`);
  }
  return sections.join("\n\n---\n\n");
}

export function buildDocument(episode) {
  const bits = [markdownCode(episode.paneId)];
  const runtime = episode.primary?.runtime || episode.candidates?.[0]?.runtime || null;
  if (runtime) bits.push(`**${String(runtime).replace(/[\r\n]/g, " ")}**`);
  if (episode.sessionId) bits.push(markdownCode(episode.sessionId));
  if (episode.beadId) bits.push(`bead ${markdownCode(episode.beadId)}`);
  const body = episodeBody(episode);
  return `${bits.join(" · ")}\n\n---\n\n${body || "_No assistant text was captured for this episode._"}\n`;
}

export function safeTitle(episode) {
  const runtime = episode.primary?.runtime || episode.candidates?.[0]?.runtime || "agent";
  return `xtmux · ${episode.paneId} · ${runtime}`
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .slice(0, 120);
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}
