import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Db } from "../db/connection.ts";
import { importLegacyJsonl, manifestSources, type ImportCounts } from "./legacy-jsonl.ts";
import { importLegacyMonitorTsv, type MonitorImportCounts } from "./legacy-monitor-tsv.ts";

function defaultSources(): string[] {
  const state = process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state");
  const base = join(state, "xtmux");
  const files: string[] = [];
  const primary = join(base, "events.jsonl");
  if (existsSync(primary)) files.push(primary);
  for (let i = 1; i <= 9; i++) {
    const rotated = `${primary}.${i}`;
    if (existsSync(rotated)) files.push(rotated);
  }
  return files;
}

export interface RunOptions {
  apply: boolean;             // false = dry-run
  sources?: string[];
}

export interface RunReport {
  id: string;
  mode: "dry-run" | "apply";
  counts: ImportCounts;
  monitorCounts: MonitorImportCounts;
  sources: Array<{ path: string; sizeBytes: number; mtimeMs: number; sha256: string }>;
  durationMs: number;
}

export function runMigration(db: Db, opts: RunOptions, now: () => number = Date.now): RunReport {
  const sources = opts.sources ?? defaultSources();
  const startedAtMs = now();
  const id = `mig-${startedAtMs}-${randomBytes(4).toString("hex")}`;
  const manifest = manifestSources(sources);

  const counts = importLegacyJsonl(db, {
    apply: opts.apply,
    sources,
    now,
  });
  // Reconstruct typed monitor rows from historical .tsv files (xtmux-3xs.13).
  // Uses default source dir (${XTMUX_PICKER_STATE:-${TMPDIR:-/tmp}/tmux-picker-state-<uid>}/monitors).
  const monitorCounts = importLegacyMonitorTsv(db, { apply: opts.apply, now });

  const completedAtMs = now();
  if (opts.apply) {
    db.raw
      .prepare<
        unknown,
        [string, number, number, string, string, string, number, number, number, number]
      >(
        `INSERT INTO migration_runs
           (id, started_at_ms, completed_at_ms, mode, source_manifest, counts_json,
            orphan_acks, malformed_records, unsupported_types, duplicates_skipped)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        startedAtMs,
        completedAtMs,
        "apply",
        JSON.stringify(manifest),
        JSON.stringify(counts),
        counts.orphanAcks,
        counts.malformedRecords,
        counts.unsupportedTypes,
        counts.duplicatesSkipped,
      );
  }

  return {
    id,
    mode: opts.apply ? "apply" : "dry-run",
    counts,
    monitorCounts,
    sources: manifest,
    durationMs: completedAtMs - startedAtMs,
  };
}
