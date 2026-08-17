#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { buildDocument, episodeBody, normalizeTarget, parseCli, projectEpisode, safeTitle, shellQuote, ViewError, defaultDbPath } from "./core.mjs";
import { findExecutable, renderDocument } from "./renderer.mjs";
import { readLatestEpisode } from "./store.mjs";

function help() {
  process.stdout.write(`xtmux-view — rich Markdown overlay for xtmux-managed agent turns

Usage:
  xtmux-view [<%pane|$session>]
  xtmux-view --target <%pane|$session>
  xtmux-view --raw [target]
  xtmux-view --json [target]
  xtmux-view doctor

Options:
  --renderer auto|glow|mdcat|raw   renderer backend (default: auto, prefers mdcat)
  --style <name|path>        Glow style (default: dark)
  --popup-width <value>      tmux popup width (default: 88%)
  --popup-height <value>     tmux popup height (default: 90%)
  --no-popup                 render in the current terminal
  --raw                      print captured Markdown without rich rendering
  --json                     print the normalized episode record
  --render                   internal: render directly without creating a popup
  -h, --help                 show help

Environment:
  XTMUX_OBS_DB_PATH          override xtmux observability DB
  XTMUX_VIEW_RENDERER        auto|glow|mdcat|raw
  XTMUX_VIEW_GLOW_STYLE      Glow style
  XTMUX_VIEW_POPUP_WIDTH     tmux popup width
  XTMUX_VIEW_POPUP_HEIGHT    tmux popup height
`);
}

function printError(error) {
  if (error instanceof ViewError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    return;
  }
  process.stderr.write(`XTMUX_VIEW_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
}

export async function doctor(env = process.env) {
  let mermaid = false;
  try {
    await import("mermaid");
    mermaid = true;
  } catch { /* renderer unavailable */ }
  const data = {
    schemaVersion: "xtmux.view.doctor.v3",
    tmux: findExecutable("tmux", env),
    glow: findExecutable("glow", env),
    mdcat: findExecutable("mdcat", env),
    mermaid,
    bun: process.versions.bun || null,
    dbPath: defaultDbPath(env),
    inTmux: Boolean(env.TMUX),
    currentPane: env.TMUX_PANE || null,
  };
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  return data.glow && data.bun ? 0 : 1;
}

// Resolve a "NN%" or absolute size against a total, clamped to [1, total].
// Percentages must be resolved against the *client* size, not the session window:
// tmux sizes % popups off the window, which can exceed the client and make the
// popup stretch to fill (or overflow) the whole terminal.
function parseSize(value, total) {
  const s = String(value ?? "").trim();
  const match = /^(\d+(?:\.\d+)?)%$/.exec(s);
  const size = match ? Math.floor((Number(match[1]) / 100) * total) : Number(s);
  return Math.max(1, Math.min(Number.isFinite(size) ? size : total, total));
}

function clientSize(tmux) {
  const r = spawnSync(tmux, ["display-message", "-p", "#{client_width} #{client_height}"], { encoding: "utf8" });
  const [w, h] = (r.stdout || "").trim().split(/\s+/).map(Number);
  return { width: Number.isFinite(w) ? w : 80, height: Number.isFinite(h) ? h : 24 };
}

function popupCommand(args, target, turn) {
  const tmux = findExecutable("tmux");
  if (!tmux) {
    throw new ViewError("XTMUX_VIEW_TMUX_MISSING", "tmux is not available on PATH");
  }
  const executable = process.execPath;
  const script = process.argv[1];
  const commandArgs = [
    executable,
    script,
    "--render",
    "--target", target,
    "--renderer", args.renderer,
    "--style", args.style,
  ];
  const shellCommand = commandArgs.map(shellQuote).join(" ");

  const { width: cw, height: ch } = clientSize(tmux);
  const width = parseSize(args.popupWidth, cw);
  const height = parseSize(args.popupHeight, ch);
  const x = Math.max(0, Math.floor((cw - width) / 2));
  const y = Math.max(0, Math.floor((ch - height) / 2));

  const result = spawnSync(tmux, [
    "display-popup",
    "-E",
    "-x", String(x),
    "-y", String(y),
    "-w", String(width),
    "-h", String(height),
    "-T", safeTitle(turn),
    shellCommand,
  ], { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function main() {
  const args = parseCli(process.argv.slice(2));
  if (args.help) { help(); return 0; }
  if (args.doctor) return await doctor();

  const target = normalizeTarget(args.target);
  const rawEpisode = await readLatestEpisode(target);
  if (!rawEpisode) {
    throw new ViewError(
      "XTMUX_VIEW_NO_EPISODE",
      `no completed response episode is stored for ${target}`,
      { target },
    );
  }
  const episode = projectEpisode(rawEpisode);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(episode, null, 2)}\n`);
    return 0;
  }
  if (args.raw) {
    process.stdout.write(`${episodeBody(episode)}\n`);
    return 0;
  }

  if (args.render || args.noPopup || !process.env.TMUX) {
    return renderDocument(buildDocument(episode), {
      renderer: args.renderer,
      style: args.style,
      env: process.env,
      width: Number(process.env.COLUMNS) || 80,
    });
  }

  return popupCommand(args, target, episode);
}

try {
  process.exitCode = await main();
} catch (error) {
  printError(error);
  process.exitCode = 2;
}
