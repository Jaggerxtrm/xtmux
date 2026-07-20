import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Bounded, read-only terminal preview for a Console viewer (docs/xtmux-gaps.md
 * §5.5). Deliberately separate from the topology snapshot: topology is identity
 * and must stay small and cheap enough to poll, while pane content is unbounded
 * and is fetched on demand for one pane at a time.
 */
export interface PaneCaptureV1 {
  schema_version: "xtrm.xtmux.pane-capture.v1";
  pane_id: string;
  captured_at_ms: number;
  requested_lines: number;
  returned_lines: number;
  /** The server-side cap. A caller that asked for more than this got less. */
  max_lines: number;
  /** The caller is NOT holding the whole buffer — there is more above. */
  truncated: boolean;
  content: string;
}

export interface PaneCaptureError {
  code: "XTMUX_INVALID_ARGUMENT" | "XTMUX_PANE_UNRESOLVED";
  message: string;
  detail: Record<string, string>;
}

export type PaneCaptureResult =
  | { ok: true; capture: PaneCaptureV1 }
  | { ok: false; error: PaneCaptureError };

/**
 * A remote viewer must never be able to ask for an unbounded buffer: this is the
 * one command whose response size a caller controls, and it is reachable over the
 * bridge. Over-large requests are CLAMPED and the response says so, rather than
 * being honored silently or rejected outright.
 */
export const MAX_LINES = 2000;

/**
 * Async so a slow or hung `tmux capture-pane` cannot block the bridge event loop
 * and starve concurrent journal follows (audit §P2-07). The optional AbortSignal
 * lets a caller cancel the subprocess (bridge.cancel, per-op timeout, peer
 * disconnect); when it fires mid-capture the underlying error is re-thrown so the
 * caller can label it, rather than being flattened into XTMUX_PANE_UNRESOLVED.
 */
export async function capturePane(
  paneId: string,
  requestedLines: number,
  now: () => number = Date.now,
  signal?: AbortSignal,
): Promise<PaneCaptureResult> {
  if (!paneId.startsWith("%")) {
    return {
      ok: false,
      error: {
        code: "XTMUX_INVALID_ARGUMENT",
        message: "pane capture --pane requires a stable tmux pane id (%N)",
        detail: { pane: paneId },
      },
    };
  }
  if (!Number.isInteger(requestedLines) || requestedLines <= 0) {
    return {
      ok: false,
      error: {
        code: "XTMUX_INVALID_ARGUMENT",
        message: "pane capture --lines requires a positive integer",
        detail: { lines: String(requestedLines) },
      },
    };
  }

  const lines = Math.min(requestedLines, MAX_LINES);
  // -p: to stdout. -e: keep ANSI escapes — the viewer renders them; xtmux never
  // parses this content, never logs it, and never puts it in the journal.
  // -S -N: start N lines back from the bottom of the history.
  // maxBuffer is the output byte cap: a runaway capture rejects rather than
  // growing our RSS unbounded.
  let stdout: string;
  try {
    const r = await execFileAsync("tmux", ["capture-pane", "-p", "-e", "-t", paneId, "-S", `-${lines}`], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      signal,
    });
    stdout = r.stdout;
  } catch (err) {
    // A fired signal (cancel/timeout/disconnect) is not a pane resolution failure:
    // re-throw so the bridge layer can answer with the right terminal reason and
    // preserve the one-response-per-request-id invariant.
    if (signal?.aborted) throw err;
    return {
      ok: false,
      error: {
        code: "XTMUX_PANE_UNRESOLVED",
        message: `pane capture could not resolve pane ${paneId}`,
        detail: { pane: paneId },
      },
    };
  }

  // tmux's `-S -N` starts N lines into the scrollback but still runs to the
  // bottom of the VISIBLE screen, so it pads with however many blank rows the
  // pane happens to be tall. Asking for 5 lines of a 24-row pane returns 29.
  // The contract is "the last N lines", so bound it here: drop the trailing
  // blank rows the screen contributed, then keep the last N.
  const all = (stdout ?? "").replace(/\n$/, "").split("\n");
  while (all.length > 0 && all[all.length - 1] === "") all.pop();
  const kept = all.slice(-lines);
  return {
    ok: true,
    capture: {
      schema_version: "xtrm.xtmux.pane-capture.v1",
      pane_id: paneId,
      captured_at_ms: now(),
      requested_lines: requestedLines,
      returned_lines: kept.length,
      max_lines: MAX_LINES,
      // Exactly one meaning: the caller is NOT holding the whole buffer. A
      // request clamped to MAX_LINES against a shorter buffer still returns
      // everything, and reporting that as truncated would make a viewer render a
      // "scroll for more" affordance over content that has no more.
      truncated: all.length > kept.length,
      content: kept.length > 0 ? `${kept.join("\n")}\n` : "",
    },
  };
}
