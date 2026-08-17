import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { renderMermaidASCII } from "beautiful-mermaid";
import { ViewError } from "./core.mjs";

const MERMAID_FENCE_RE = /```mermaid\s*\r?\n([\s\S]*?)```/g;
const MAX_BLOCKS = 5;
const MAX_SOURCE_LINES = 400;
const MAX_SOURCE_CHARS = 20_000;
// Diagram types beautiful-mermaid can render; anything else is left as source.
const SUPPORTED_TYPES = new Map([
  ["graph", "flowchart"],
  ["flowchart", "flowchart"],
  ["sequenceDiagram", "sequence"],
  ["classDiagram", "class"],
  ["erDiagram", "er"],
  ["stateDiagram", "state"],
  ["stateDiagram-v2", "state"],
]);
// Width-based preset selection: pick the first that fits, else tightest.
const ASCII_PRESETS = [
  { key: "default", paddingX: 5, boxBorderPadding: 1 },
  { key: "compact", paddingX: 3, boxBorderPadding: 1 },
  { key: "tight", paddingX: 2, boxBorderPadding: 1 },
  { key: "squeezed", paddingX: 1, boxBorderPadding: 0 },
];

let mermaidPromise;
function getMermaid() {
  // Lazy; heavy import. Returns null when unavailable (never crashes the CLI).
  mermaidPromise ??= import("mermaid")
    .then((mod) => {
      const api = mod.default;
      api.initialize?.({ startOnLoad: false });
      return api;
    })
    .catch(() => null);
  return mermaidPromise;
}

function diagramType(block) {
  for (const line of block.split(/\r?\n/)) {
    const token = line.trim();
    if (!token || token.startsWith("%%")) continue;
    return SUPPORTED_TYPES.get(token.split(/\s+/)[0]) ?? null;
  }
  return null;
}

function maxLineWidth(ascii) {
  return ascii.split("\n").reduce((max, line) => Math.max(max, line.length), 0);
}

// mermaid.parse cannot run headlessly: valid HTML-bearing diagrams (flowchart/class/state)
// throw a DOMPurify sanitizer error, and some broken input passes. So treat a genuine
// non-DOMPurify Parse error as broken (preserve source) and everything else as unvalidated
// (render). This never preserves a valid diagram, matching pi-mermaid-viewer's isDomPurifyError.
function isBroken(message) {
  return Boolean(message && !/DOMPurify/i.test(message));
}

async function isBrokenSource(block) {
  try {
    const mermaid = await getMermaid();
    if (!mermaid) return false;
    await mermaid.parse(block);
    return false;
  } catch (error) {
    return isBroken(error?.message || String(error));
  }
}

// Returns the rendered code-fence block, or null to keep the original ```mermaid source.
async function renderBlock(block, width) {
  if (!diagramType(block)) return null;
  const sourceLines = block.split(/\r?\n/);
  if (sourceLines.length > MAX_SOURCE_LINES) return null;
  if (block.length > MAX_SOURCE_CHARS) return null;
  if (await isBrokenSource(block)) return null;

  let chosen = null;
  for (const preset of ASCII_PRESETS) {
    let ascii;
    try {
      ascii = renderMermaidASCII(block, {
        paddingX: preset.paddingX,
        boxBorderPadding: preset.boxBorderPadding,
        colorMode: "none",
      }).trimEnd();
    } catch {
      return null; // render failure → leave source (Glow shows it verbatim)
    }
    if (!ascii) return null;
    const w = maxLineWidth(ascii);
    chosen ??= { ascii, width: w };
    if (w <= width) { chosen = { ascii, width: w }; break; }
  }

  const clipped = chosen.width > width;
  const rendered = chosen.ascii
    .split("\n")
    .map((line) => (line.length > width ? line.slice(0, width) : line))
    .join("\n");
  const hint = clipped ? "\n... clipped; widen the popup to see the full diagram" : "";
  return "```\n" + rendered + hint + "\n```";
}

// Swap ```mermaid fences for rendered ASCII inside plain code fences. Unsupported types,
// broken source, oversized blocks, and render failures are left untouched so Glow shows the
// source. Never used by --raw/--json (those paths bypass renderDocument entirely).
export async function decorateMermaid(document, { width = 80 } = {}) {
  if (!document.includes("```mermaid")) return document;
  const out = [];
  const re = MERMAID_FENCE_RE;
  let last = 0;
  let blockCount = 0;
  let m;
  while ((m = re.exec(document)) !== null) {
    out.push(document.slice(last, m.index));
    blockCount += 1;
    const rendered =
      blockCount <= MAX_BLOCKS ? await renderBlock(m[1], width) : null;
    out.push(rendered ?? m[0]); // m[0] = original fence, preserved as source
    last = m.index + m[0].length;
  }
  out.push(document.slice(last));
  return out.join("");
}

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

// Pick a renderer backend. Returns { bin, args, decorate, width } or { raw: true }.
// mdcat renders Mermaid natively, so for it we skip decorateMermaid and hand it the
// original fence. "auto" prefers mdcat, falling back to glow.
export function selectRenderer(renderer, { glow, mdcat, style = "dark", width = 80 } = {}) {
  if (renderer === "raw") return { raw: true };
  if (renderer === "mdcat") {
    if (!mdcat) {
      throw new ViewError(
        "XTMUX_VIEW_RENDERER_MISSING",
        "mdcat is not installed; install mdcat or use --renderer glow|raw",
      );
    }
    return { bin: mdcat, args: ["--no-pager"], decorate: false };
  }
  if (renderer === "glow") {
    if (!glow) {
      throw new ViewError(
        "XTMUX_VIEW_RENDERER_MISSING",
        "Glow is not installed; install Glow >= 2.1.0 or use --renderer mdcat|raw",
      );
    }
    return { bin: glow, args: ["--tui", "-s", style], decorate: true, width };
  }
  if (mdcat) return { bin: mdcat, args: ["--no-pager"], decorate: false };
  if (glow) return { bin: glow, args: ["--tui", "-s", style], decorate: true, width };
  throw new ViewError(
    "XTMUX_VIEW_RENDERER_MISSING",
    "no rich Markdown renderer found; install mdcat or Glow, or use --renderer raw",
  );
}

export async function renderDocument(document, options = {}) {
  const env = options.env || process.env;
  const renderer = options.renderer || "auto";
  const rendererChoice = selectRenderer(renderer, {
    glow: findExecutable("glow", env),
    mdcat: findExecutable("mdcat", env),
    style: options.style,
    width: options.width ?? (Number(env.COLUMNS) || 80),
  });
  if (rendererChoice.raw) {
    process.stdout.write(document);
    return 0;
  }

  const width = rendererChoice.width ?? (Number(env.COLUMNS) || 80);
  const content = rendererChoice.decorate
    ? await decorateMermaid(document, { width })
    : document;

  const dir = mkdtempSync(join(tmpdir(), "xtmux-view-"));
  const path = join(dir, "turn.md");
  try {
    writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
    return run(rendererChoice.bin, [...rendererChoice.args, path], { env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
