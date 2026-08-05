#!/usr/bin/env bash
# EVAL-01 Codex column + K3 recovery evidence bundle (xtmux-s96.3, KAN-127).
#
# Runs the Codex gate suites against the merged K3 adapter and writes an
# evidence bundle: per-check results, a criterion->evidence matrix, and a
# failure classification (product / pre-existing / infrastructure).
#
#   product          an assertion about adapter behavior failed, OR the log
#                    mixes failure kinds, OR the failure is unrecognized.
#                    This is the blocking class and the conservative default.
#   pre-existing     at least one failing test identifier is present and EVERY
#                    failing identifier is listed in KNOWN_PREEXISTING below.
#                    A known flake never masks an unknown failure in the same
#                    log: one unrecognized identifier makes the log `product`.
#   infrastructure   NO assertion/test failure is present and the command
#                    failed for an environment reason (missing binary, spawn
#                    error, disk/tmp exhaustion). Any assertion failure mixed
#                    with infrastructure noise classifies as `product`.
#
# usage: bash scripts/verify-eval-01-codex.sh [--selftest]
#   --selftest runs only the deterministic classifier contract tests.
# env:   XTMUX_EVAL01_ARTIFACT_DIR  override the artifact directory
#
# Exit: 0 when no red check is classified `product` (a fully green run prints
# PASS; a run with only pre-existing/infrastructure failures prints
# PASS_WITH_CLASSIFIED). Non-zero only on product failures.
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

# Failures known to reproduce independently of this gate's files, with the
# evidence that classified them. Entries are `<test file>::<test name>`.
KNOWN_PREEXISTING=(
  # Load-sensitive virgin-DB open race; fresh-db family tracked by xtmux-kua.
  # Passes 3/3 in isolation (2026-08-03); fails only under full-suite load.
  "tests/contracts/fresh-db.test.ts::concurrent first-touch of a virgin DB does not corrupt or crash"
  # Load-sensitive V1/V2 differential flake: failed on a full `bun test` of the
  # K3 base tree WITHOUT this gate's files (2026-08-03); passes in isolation.
  "tests/contracts/differential-v1-v2.test.ts::audit stable output matches V1 after the same deterministic sort"
)

# Shell-specific forms: bash prints `bash: bun: command not found`, dash
# prints `/bin/sh: 1: bun: not found`. `: not found` is only consulted when no
# failing test identifier exists, so product assertion prose ("was not found")
# cannot be misread as infrastructure.
INFRA_PATTERNS='command not found|binary not found|: not found|No such file or directory|ENOENT|cannot execute|Out of memory|No space left'

# Failing test identifiers in a suite log: bun prints `(fail) <describe > test
# [Nms]` (inline and again in the trailing summary), node --test prints
# `not ok N - <name>`. Deduplicated; the trailing `[Nms]` is stripped so an
# identifier compares equal to its allowlist entry.
extract_failing_identifiers() {
  local log="$1"
  {
    grep -E '^\(fail\) ' "$log" 2>/dev/null | sed -E 's/^\(fail\) //; s/ \[[0-9]+(\.[0-9]+)?ms\]$//'
    grep -E '^not ok [0-9]+ - ' "$log" 2>/dev/null | sed -E 's/^not ok [0-9]+ - //'
  } | sort -u
}

is_allowlisted() {
  local id="$1" known
  for known in "${KNOWN_PREEXISTING[@]:-}"; do
    [ -n "$known" ] || continue
    case "$id" in *"${known##*::}"*) return 0 ;; esac
  done
  return 1
}

classify_failure() {
  local log="$1" id all_known
  local ids
  ids="$(extract_failing_identifiers "$log")"
  if [ -n "$ids" ]; then
    # Mixed kinds (assertion failures + infrastructure noise) are product: a
    # missing binary can explain the crash but not the assertion.
    grep -qE "$INFRA_PATTERNS" "$log" && { printf 'product'; return; }
    all_known=1
    while IFS= read -r id; do
      is_allowlisted "$id" || { all_known=0; break; }
    done <<< "$ids"
    [ "$all_known" -eq 1 ] && printf 'pre-existing' || printf 'product'
    return
  fi
  grep -qE "$INFRA_PATTERNS" "$log" && { printf 'infrastructure'; return; }
  printf 'product'
}

# Deterministic contract tests for the classifier. Fixed literals on purpose:
# they also fail loudly if KNOWN_PREEXISTING loses the entries the gate's
# honesty depends on.
SELFTEST_KNOWN_FRESH="concurrent first-touch of a virgin DB does not corrupt or crash"
SELFTEST_KNOWN_DIFF="audit stable output matches V1 after the same deterministic sort"

run_selftest() {
  local dir fails=0 name want got
  dir="$(mktemp -d)"
  printf '(fail) V2 commands on a virgin observability DB > %s [3881.02ms]\n' "$SELFTEST_KNOWN_FRESH" > "$dir/known-only.log"
  printf '(fail) V2 commands on a virgin observability DB > %s [3881.02ms]\n(fail) V2 commands on a virgin observability DB > %s [3881.02ms]\n' "$SELFTEST_KNOWN_FRESH" "$SELFTEST_KNOWN_DIFF" > "$dir/known-only-two.log"
  printf '(fail) V2 commands on a virgin observability DB > %s [3881.02ms]\n(fail) messages suite > brand new regression nobody allowlisted [5.00ms]\n' "$SELFTEST_KNOWN_FRESH" > "$dir/mixed-known-unknown.log"
  printf '/bin/sh: 1: bun: not found\nspawn bun ENOENT\n' > "$dir/infra-only.log"
  printf '(fail) messages suite > brand new regression nobody allowlisted [5.00ms]\n/bin/sh: 1: bun: not found\n' > "$dir/mixed-infra-assertion.log"
  printf '(fail) V2 commands on a virgin observability DB > %s [3881.02ms]\n/bin/sh: 1: bun: not found\n' "$SELFTEST_KNOWN_FRESH" > "$dir/mixed-infra-known.log"
  printf 'some unrecognized crash without test identifiers\n' > "$dir/unknown.log"

  st_check() {
    name="$1"; want="$2"
    got="$(classify_failure "$dir/$name.log")"
    if [ "$got" = "$want" ]; then
      printf 'selftest\tPASS\t%s -> %s\n' "$name" "$got"
    else
      printf 'selftest\tFAIL\t%s: want=%s got=%s\n' "$name" "$want" "$got"
      fails=$((fails + 1))
    fi
  }
  st_check known-only pre-existing
  st_check known-only-two pre-existing
  st_check mixed-known-unknown product
  st_check infra-only infrastructure
  st_check mixed-infra-assertion product
  st_check mixed-infra-known product
  st_check unknown product
  rm -rf "$dir"
  if [ "$fails" -ne 0 ]; then
    printf 'eval01-codex-selftest\tFAIL\t%s case(s)\n' "$fails" >&2
    return 1
  fi
  printf 'eval01-codex-selftest\tPASS\n'
}

if [ "${1:-}" = "--selftest" ]; then
  run_selftest
  exit $?
fi

artifact_dir="${XTMUX_EVAL01_ARTIFACT_DIR:-/tmp/xtmux-eval01-codex-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$artifact_dir"
summary="$artifact_dir/results.tsv"
printf 'check\texit_code\tduration_ms\tcommand\tlog\n' > "$summary"

overall_rc=0

run_check() {
  local name="$1" start end rc log command
  shift
  printf -v command '%q ' "$@"
  log="$artifact_dir/$name.log"
  start="$(date +%s%3N)"
  set +e
  (cd "$root" && "$@") >"$log" 2>&1
  rc=$?
  set -e
  end="$(date +%s%3N)"
  printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$rc" "$(( end - start ))" "$command" "$log" >> "$summary"
  if [ "$rc" -ne 0 ]; then
    overall_rc="$rc"
    tail -80 "$log" >&2
  fi
}

# The classifier must prove itself before it is trusted with the gate's red
# checks: any self-test mismatch fails the gate immediately.
run_selftest >> "$artifact_dir/selftest.log" 2>&1 || {
  cat "$artifact_dir/selftest.log" >&2
  printf 'eval01-codex-gate\tFAIL\tclassifier self-test failed\n' >&2
  exit 2
}

# Gate suites. The column runs first: it is the EVAL-01 evidence itself.
run_check eval01-codex-column bun test tests/contracts/eval-01-codex-matrix.test.ts
run_check codex-adapter bun test tests/contracts/codex-adapter.test.ts
run_check codex-characterization bun test tests/contracts/codex-characterization.test.ts
run_check installer node --test tests/installer/install.test.mjs
run_check full-bun-test bun test
run_check typecheck bun run typecheck

# Failure classification for every red check. Only `product` failures block
# the gate: pre-existing flakes and infrastructure gaps are evidence, not
# regressions (xtmux-s96.3 CONSTRAINTS).
classification="$artifact_dir/failure-classification.tsv"
printf 'check\tclassification\tlog\n' > "$classification"
blocking=0
while IFS=$'\t' read -r name rc _ _ log; do
  [ "$name" = "check" ] && continue
  [ "$rc" = "0" ] && continue
  class="$(classify_failure "$log")"
  printf '%s\t%s\t%s\n' "$name" "$class" "$log" >> "$classification"
  [ "$class" = "product" ] && blocking=1
done < "$summary"

# Criterion -> evidence matrix. Rows name the xtmux-s96.3 VALIDATION failure
# conditions and the EVAL-01 scenario mapping; evidence columns point at the
# test that fails if the condition regresses.
manifest="$artifact_dir/manifest.json"
node - "$artifact_dir" > "$manifest" <<'EOF'
const fs = require("fs");
const artifactDir = process.argv[2];
const results = fs.readFileSync(artifactDir + "/results.tsv", "utf8").trim().split("\n").slice(1)
  .map((line) => line.split("\t"))
  .map(([check, exitCode, durationMs, command, log]) => ({ check, exitCode: Number(exitCode), durationMs: Number(durationMs), command, log }));
const classifications = Object.fromEntries(
  fs.readFileSync(artifactDir + "/failure-classification.tsv", "utf8").trim().split("\n").slice(1)
    .map((line) => line.split("\t")).map(([check, cls]) => [check, cls]));
const green = (name) => (results.find((r) => r.check === name)?.exitCode ?? 1) === 0;
// A check is acceptable when green or red-but-not-product (pre-existing flake
// or infrastructure gap, classified in failure-classification.tsv).
const ok = (name) => green(name) || (classifications[name] !== undefined && classifications[name] !== "product");
const column = green("eval01-codex-column");
const matrix = [
  { criterion: "EVAL-01 S1 reply-required send arms a wait; no duplicate obligations", evidence: "tests/contracts/eval-01-codex-matrix.test.ts :: S1", status: column },
  { criterion: "EVAL-01 S2 FYI arms no wait; no phantom obligations (--expects-reply=false)", evidence: "tests/contracts/eval-01-codex-matrix.test.ts :: S2", status: column },
  { criterion: "EVAL-01 S3 correlated reply discharges the duty; replies never expect replies", evidence: "tests/contracts/eval-01-codex-matrix.test.ts :: S3", status: column },
  { criterion: "EVAL-01 S4 wake consumed exactly once; stale done never replayed on a working target", evidence: "tests/contracts/eval-01-codex-matrix.test.ts :: S4", status: column },
  { criterion: "EVAL-01 S5 wait-for-transition rides a real running->done cycle; never-worked times out", evidence: "tests/contracts/eval-01-codex-matrix.test.ts :: S5", status: column },
  { criterion: "EVAL-01 S6 inbound reply-required visible until acked; FYIs create no duty", evidence: "tests/contracts/eval-01-codex-matrix.test.ts :: S6", status: column },
  // Relabelled in K4 (xtmux-s96.4). S7 asserts OUTBOUND turn-FYI dedupe and
  // nothing else. It was labelled "bounded reminders", which reads as inbox
  // reminder coverage — a capability Codex does not yet have (no Codex hook
  // emits an inbox reminder, unlike Claude's auto-monitor-drain-stop.mjs and
  // Pi's pi-inbox-reply.ts). Citing this row as bounded-reminder parity
  // evidence would have been false. The real capability is tracked as an open
  // K4 item, not claimed here.
  { criterion: "EVAL-01 S7 outbound turn-FYI dedupe: duplicate Stops dedupe, one FYI per turn", evidence: "tests/contracts/eval-01-codex-matrix.test.ts :: S7", status: column },
  { criterion: "EVAL-01 S8 restart reconstruction; resume re-mints; dedupe survives id rotation", evidence: "tests/contracts/eval-01-codex-matrix.test.ts :: S8", status: column },
  { criterion: "EVAL-01 S9 hostile payloads are data: no turn, no message, no execution", evidence: "tests/contracts/eval-01-codex-matrix.test.ts :: S9", status: column },
  { criterion: "EVAL-01 S10 duplicate lifecycle events idempotent (one instance, debounced transitions)", evidence: "tests/contracts/eval-01-codex-matrix.test.ts :: S10", status: column },
  { criterion: "EVAL-01 S11 steering is an ordinary reply-required inbound (no harness auto-action)", evidence: "tests/contracts/eval-01-codex-matrix.test.ts :: S11", status: column },
  { criterion: "terminal cleanup: SessionEnd closes instance, clears lineage, preserves instance id", evidence: "tests/contracts/eval-01-codex-matrix.test.ts :: terminal cleanup", status: column },
  { criterion: "turn capture correlates to the minted instance via installed Stop hook", evidence: "tests/contracts/eval-01-codex-matrix.test.ts :: turn capture", status: column },
  { criterion: "installer ownership: idempotent install, non-destructive uninstall, unowned config preserved", evidence: "eval-01-codex-matrix.test.ts :: terminal cleanup + tests/installer/install.test.mjs", status: column && ok("installer") },
  { criterion: "lifecycle start/running/done/off/degraded over the existing authority", evidence: "tests/contracts/codex-adapter.test.ts :: installed Codex lifecycle wiring", status: green("codex-adapter") },
  { criterion: "xtrm.command-outcome.v1 boundary (full validation, hostile refusal)", evidence: "tests/contracts/codex-adapter.test.ts :: Core K2 outcome consumption", status: green("codex-adapter") },
  { criterion: "Codex 0.146.0 fixtures versioned, redacted, provenance-pinned", evidence: "tests/contracts/codex-characterization.test.ts", status: green("codex-characterization") },
  { criterion: "no regression in Claude/Pi columns and shared domains", evidence: "full bun test + typecheck (red checks classified in failure-classification.tsv)", status: ok("full-bun-test") && ok("typecheck") },
];
const failures = results.filter((r) => r.exitCode !== 0);
const productFailures = failures.filter((f) => classifications[f.check] === "product");
// The column IS the gate: no verdict above infrastructure can be issued when
// it never ran green, regardless of how the red check classifies.
const verdict = !green("eval01-codex-column") || productFailures.length > 0 ? "FAIL" : "PASS";
process.stdout.write(JSON.stringify({
  gate: "EVAL-01 Codex column + K3 recovery evidence (xtmux-s96.3)",
  generatedAtMs: Date.now(),
  codexFixtures: { version: "0.146.0", root: "tests/fixtures/codex/0.146.0" },
  checks: results,
  classifications,
  matrix,
  failures: failures.map((f) => ({ check: f.check, log: f.log, classification: classifications[f.check] ?? "unclassified" })),
  verdict,
}, null, 2) + "\n");
EOF

if ! grep -q $'eval01-codex-column\t0\t' "$summary"; then
  printf 'eval01-codex-gate\tFAIL\tcolumn did not run green; see failure-classification.tsv\tartifacts=%s\n' "$artifact_dir" >&2
  exit "${overall_rc:-1}"
fi

if [ "$blocking" -ne 0 ]; then
  printf 'eval01-codex-gate\tFAIL\tartifacts=%s\n' "$artifact_dir" >&2
  exit "$overall_rc"
fi
if [ "$overall_rc" -ne 0 ]; then
  printf 'eval01-codex-gate\tPASS_WITH_CLASSIFIED\tnon-product failures classified; see failure-classification.tsv\tartifacts=%s\n' "$artifact_dir"
  exit 0
fi
printf 'eval01-codex-gate\tPASS\tartifacts=%s\n' "$artifact_dir"
