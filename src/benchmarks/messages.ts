#!/usr/bin/env bun
/**
 * Full-command latency benchmark for message-list on Corpus A: 10k messages
 * distributed across 10 recipients (scaled down from PRD §21's 100k×100 for
 * inline verification; run with XTMUX_BENCH_SCALE=10 to hit 100k×100).
 *
 * Measures full-command latency, matching PRD §21 acceptance: process startup
 * + DB open + schema verification + query + formatting + exit. Not raw SQL.
 *
 * Run: bun run src/benchmarks/messages.ts
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { openDb } from "../db/connection.ts";
import { migrate } from "../db/schema.ts";
import { sendMessage } from "../domains/messages/send.ts";
import type { Config } from "../config.ts";

const SCALE = Number(process.env["XTMUX_BENCH_SCALE"] ?? 1);
const N_MESSAGES  = 10_000 * SCALE;
const N_RECIPIENTS = 10 * SCALE;
const HOT_RECIPIENT = "$hot";
const ITER_PROBE = Number(process.env["XTMUX_BENCH_ITER"] ?? 100);
const WARMUP_ITER = 5;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * sorted.length)));
  return sorted[idx]!;
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-bench-"));
  const dbPath = join(dir, "bench.db");
  const cfg: Config = { dbPath, mode: "off", busyTimeoutMs: 3000 };

  console.log(`corpus: ${N_MESSAGES.toLocaleString()} messages × ${N_RECIPIENTS} recipients`);
  const boot = openDb(cfg);
  migrate(boot);
  const startSeed = performance.now();
  boot.raw.exec("BEGIN");
  for (let i = 0; i < N_MESSAGES; i++) {
    const recipient = i % N_RECIPIENTS === 0 ? HOT_RECIPIENT : `$r-${i % N_RECIPIENTS}`;
    sendMessage(boot, {
      messageKey: `bench-${i}`,
      senderId: "$sender",
      recipientId: recipient,
      summary: `msg ${i}`,
    }, () => 1_000 + i);
  }
  boot.raw.exec("COMMIT");
  boot.close();
  const seedMs = performance.now() - startSeed;
  console.log(`seed: ${seedMs.toFixed(0)} ms`);

  // Prefer the compiled binary (bin/xtmux-obs) when present — startup wins
  // ~40ms over `bun run src/cli.ts`. Fallback keeps parity for CI runs that
  // haven't run `bun run build` yet.
  const repoRoot = new URL("../../", import.meta.url).pathname;
  const binaryPath = join(repoRoot, "bin/xtmux-obs");
  const usingBinary = existsSync(binaryPath);
  const cmd = usingBinary ? binaryPath : "bun";
  const argvPrefix = usingBinary ? [] : ["run", join(repoRoot, "src/cli.ts")];
  const runtimeLabel = usingBinary ? "compiled binary" : "bun run src/cli.ts";
  console.log(`runtime: ${runtimeLabel} (${cmd})`);

  const samples: number[] = [];
  const total = ITER_PROBE + WARMUP_ITER;
  for (let i = 0; i < total; i++) {
    const t0 = performance.now();
    const r = spawnSync(cmd, [...argvPrefix, "message-list", "--for", HOT_RECIPIENT, "--limit", "200"], {
      env: { ...process.env, XTMUX_OBS_DB_PATH: dbPath, XTMUX_OBS_V2: "1" },
      encoding: "utf8",
    });
    const t = performance.now() - t0;
    if (r.status !== 0) {
      console.error(`iter ${i}: exit ${r.status}: ${r.stderr}`);
      process.exit(1);
    }
    if (i >= WARMUP_ITER) samples.push(t);
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.50);
  const p95 = percentile(sorted, 0.95);
  const p99 = percentile(sorted, 0.99);
  const max = sorted[sorted.length - 1] ?? 0;

  console.log(`message-list (hot recipient) full-command latency over ${ITER_PROBE} runs:`);
  console.log(`  p50: ${p50.toFixed(1)} ms`);
  console.log(`  p95: ${p95.toFixed(1)} ms`);
  console.log(`  p99: ${p99.toFixed(1)} ms`);
  console.log(`  max: ${max.toFixed(1)} ms`);
  console.log(`PRD §21 target: p99 < 100 ms on 100k-message corpus (SCALE=10)`);
  console.log(SCALE >= 10 && p99 >= 100 ? "FAIL" : "OK");

  rmSync(dir, { recursive: true, force: true });
}

main();
