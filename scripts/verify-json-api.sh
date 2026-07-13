#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
artifact_dir="${XTMUX_JSON_GATE_ARTIFACT_DIR:-/tmp/xtmux-json-gate-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$artifact_dir"
summary="$artifact_dir/results.tsv"
printf 'check\tmode\texit_code\tduration_ms\tcommand\tlog\n' > "$summary"

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
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "${XTMUX_OBS_V2:-default-on}" "$rc" "$(( end - start ))" "$command" "$log" >> "$summary"
  if [ "$rc" -ne 0 ]; then
    tail -80 "$log" >&2
    printf 'json-api-gate\tFAIL\tcheck=%s\tartifacts=%s\n' "$name" "$artifact_dir" >&2
    exit "$rc"
  fi
}

run_check build bun run build
if find "$root/src" -type f -name '*.ts' -newer "$root/bin/xtmux-obs" -print -quit | grep -q .; then
  printf 'json-api-gate\tFAIL\tcheck=build-freshness\tartifacts=%s\n' "$artifact_dir" >&2
  exit 1
fi
printf 'build-freshness\t%s\t0\t0\tmtime(src)<=mtime(binary)\t%s\n' "${XTMUX_OBS_V2:-default-on}" "$root/bin/xtmux-obs" >> "$summary"
run_check bun-tests bun test
run_check typecheck bun run typecheck
# Runs BEFORE the contract suite on purpose: it proves the suite can still fail.
# The counters used to live in shell variables, so a failure inside a subshell
# printed FAIL and counted nothing, and this gate reported PASS while the suite
# printed failures (xtmux-d0a.19). A green contract run means nothing unless the
# harness underneath it can go red.
run_check harness-selftest bash test/harness-selftest.sh
run_check shell-contracts bash test/contract.sh
run_check v1-fixtures bash scripts/capture-v1-fixtures.sh --check
run_check live-smoke bash scripts/smoke-json-api.sh

printf 'json-api-gate\tPASS\tartifacts=%s\n' "$artifact_dir"
