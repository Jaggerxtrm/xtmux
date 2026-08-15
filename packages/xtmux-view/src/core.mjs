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
  if (!new Set(["auto", "glow", "raw"]).has(out.renderer)) {
    throw new ViewError(
      "XTMUX_VIEW_INVALID_ARGUMENT",
      `unsupported renderer ${JSON.stringify(out.renderer)}; expected auto|glow|raw`,
    );
  }
  return out;
}

export function sanitizeTerminalText(value) {
  return String(value ?? "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\r\n?/g, "\n");
}

function markdownCode(value) {
  return `\`${String(value).replaceAll("`", "\\`")}\``;
}

export function buildDocument(turn) {
  const bits = [markdownCode(turn.paneId)];
  if (turn.runtime) bits.push(`**${String(turn.runtime).replace(/[\r\n]/g, " ")}**`);
  if (turn.sessionId) bits.push(markdownCode(turn.sessionId));
  if (turn.beadId) bits.push(`bead ${markdownCode(turn.beadId)}`);
  const body = sanitizeTerminalText(turn.lastMessageText || turn.summary || "").trim();
  return `${bits.join(" · ")}\n\n---\n\n${body || "_No assistant text was captured for this turn._"}\n`;
}

export function safeTitle(turn) {
  const runtime = turn.runtime ? String(turn.runtime) : "agent";
  return `xtmux · ${turn.paneId} · ${runtime}`
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .slice(0, 120);
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}
