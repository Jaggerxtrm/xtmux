import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/connection.ts";

/**
 * xtmux-3xs.13: reconstruct typed monitor rows from historical .tsv files.
 *
 * The picker's V1 monitor registry writes one TSV per active monitor at
 * `${XTMUX_PICKER_STATE:-/tmp/tmux-picker-state-<uid>}/monitors/<id>.tsv`.
 * Phase 9's JSONL importer preserves start/done/timeout/killed envelopes but
 * does not create a monitors row per historical monitor — the counter
 * `monitorsImported` overcounts (envelopes, not rows). This importer fills
 * that gap.
 *
 * Idempotent: `INSERT OR IGNORE` keyed on `monitors.id` (PK). Source files
 * are never deleted.
 *
 * Terminal-status derivation for a historical row (the PID is almost never
 * still alive; the pane may be gone; the whole thing is by definition ended):
 * - if the recorded `state` is a terminal value ('done','finished','stop',
 *   'complete') → `terminal_status='done'`
 * - if the file's mtime + timeout_ms is in the past → `terminal_status='timeout'`
 * - otherwise → `terminal_status='process_gone'` (the historical PID is gone
 *   and no other terminal cause is provable)
 */

const TERMINAL_STATES = new Set(["done", "finished", "stop", "complete"]);

export interface MonitorImportCounts {
  filesScanned: number;
  monitorsInserted: number;
  duplicatesSkipped: number;
  malformedRecords: number;
  byTerminalStatus: Record<string, number>;
}

export function defaultTsvSources(env: NodeJS.ProcessEnv = process.env): string[] {
  // Match the picker's shell logic: XTMUX_PICKER_STATE overrides, else
  // ${TMPDIR:-/tmp}/tmux-picker-state-<uid>/monitors.
  const explicit = env["XTMUX_PICKER_STATE"];
  if (explicit) {
    const dir = join(explicit, "monitors");
    return existsSync(dir) ? listTsvFiles(dir) : [];
  }
  const tmpdir = env["TMPDIR"] ?? "/tmp";
  const uid = process.getuid?.() ?? 1000;
  const dir = join(tmpdir, `tmux-picker-state-${uid}`, "monitors");
  return existsSync(dir) ? listTsvFiles(dir) : [];
}

function listTsvFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".tsv"))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

interface TsvRow {
  id: string;
  pid: number;
  target: string;
  paneId: string;
  state: string;
  startedAtMs: number;
  timeoutMs: number;
  intervalMs: number;
  updatedAtMs: number;
}

function parseTsvLine(line: string): TsvRow | null {
  // Format: monitor\t<id>\t<pid>\t<target>\t<pane>\t<state>\t<start>\t<timeout>\t<interval>\t<updated>
  // start/timeout/interval/updated are seconds (V1 shell writes `date +%s`).
  const parts = line.split("\t");
  if (parts.length < 10 || parts[0] !== "monitor") return null;
  const id = parts[1] ?? "";
  const pid = Number(parts[2] ?? 0);
  const target = parts[3] ?? "";
  const paneId = parts[4] ?? "";
  const state = parts[5] ?? "";
  const startedSecs = Number(parts[6] ?? 0);
  const timeoutSecs = Number(parts[7] ?? 0);
  const intervalSecs = Number(parts[8] ?? 0);
  const updatedSecs = Number(parts[9] ?? 0);
  if (!id || !target || !paneId || !Number.isFinite(startedSecs)) return null;
  return {
    id,
    pid,
    target,
    paneId,
    state,
    startedAtMs: startedSecs * 1000,
    timeoutMs: timeoutSecs * 1000,
    intervalMs: intervalSecs * 1000,
    updatedAtMs: updatedSecs * 1000,
  };
}

function deriveTerminalStatus(row: TsvRow, fileMtimeMs: number, now: number): string {
  if (TERMINAL_STATES.has(row.state)) return "done";
  // The monitor's own clock is authoritative when the file was last updated.
  const wallClock = row.updatedAtMs || fileMtimeMs;
  if (row.timeoutMs > 0 && wallClock + row.timeoutMs < now) return "timeout";
  return "process_gone";
}

export function importLegacyMonitorTsv(
  db: Db,
  opts: { apply: boolean; sources?: string[]; now?: () => number } = { apply: false },
): MonitorImportCounts {
  const now = opts.now ?? (() => Date.now());
  const sources = opts.sources ?? defaultTsvSources();
  const counts: MonitorImportCounts = {
    filesScanned: 0,
    monitorsInserted: 0,
    duplicatesSkipped: 0,
    malformedRecords: 0,
    byTerminalStatus: {},
  };

  if (!opts.apply || sources.length === 0) {
    counts.filesScanned = sources.length;
    return counts;
  }

  // Guard against dupes at the SQL layer via INSERT OR IGNORE. changes==0 →
  // duplicate; changes==1 → new row.
  const insert = db.raw.prepare<
    unknown,
    [string, number | null, string, string, string, number, number, number, number, string, number]
  >(
    `INSERT OR IGNORE INTO monitors
       (id, owner_pid, target, pane_id, state, started_at_ms, updated_at_ms,
        timeout_ms, interval_ms, terminal_status, terminal_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const nowMs = now();
  for (const path of sources) {
    counts.filesScanned += 1;
    let mtimeMs: number;
    let raw: string;
    try {
      mtimeMs = statSync(path).mtimeMs;
      raw = readFileSync(path, "utf-8");
    } catch {
      counts.malformedRecords += 1;
      continue;
    }
    const line = raw.trim().split("\n")[0] ?? "";
    const row = parseTsvLine(line);
    if (!row) {
      counts.malformedRecords += 1;
      continue;
    }
    const terminal = deriveTerminalStatus(row, mtimeMs, nowMs);
    const terminalAtMs = row.updatedAtMs || mtimeMs;
    const r = insert.run(
      row.id,
      row.pid > 0 ? row.pid : null,
      row.target,
      row.paneId,
      row.state,
      row.startedAtMs,
      row.updatedAtMs || mtimeMs,
      row.timeoutMs,
      row.intervalMs,
      terminal,
      terminalAtMs,
    );
    const changes = Number((r as { changes?: number }).changes ?? 0);
    if (changes === 0) {
      counts.duplicatesSkipped += 1;
    } else {
      counts.monitorsInserted += 1;
      counts.byTerminalStatus[terminal] = (counts.byTerminalStatus[terminal] ?? 0) + 1;
    }
  }

  return counts;
}
