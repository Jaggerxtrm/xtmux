#!/usr/bin/env bash
# capture-v1-fixtures.sh — deterministic golden-fixture capture for
# tests/fixtures/golden/v1/. Runs the picker inside an isolated XDG_STATE_HOME
# and TMPDIR so `events.jsonl`, monitor TSV, cache, and rotated files come from
# a known-clean slate. Only reproducible-from-empty fixtures land here; live
# traffic samples get the `.live` suffix and are informative only.
#
# Usage: scripts/capture-v1-fixtures.sh [--check]
#   default: (re)write tests/fixtures/golden/v1/<label>.{stdout,stderr,exit}
#   --check: recapture into a tmp dir and diff against committed fixtures.
#            Exit 0 on match, 1 on drift. Feeds the byte-identity check for
#            PRD §20 / xtmux-3xs.2 Phase 2 VALIDATION.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PICKER="$REPO_ROOT/bin/tmux-session-picker"
FX_DIR="$REPO_ROOT/tests/fixtures/golden/v1"

mode=write
[ "${1:-}" = "--check" ] && mode=check

isolate() {
  local sandbox="$1"
  export XDG_STATE_HOME="$sandbox/state"
  export TMPDIR="$sandbox/tmp"
  export XTMUX_OBS_V2=0
  unset XTMUX_EVENT_LOG_FILE
  mkdir -p "$XDG_STATE_HOME" "$TMPDIR"
}

capture() {
  local dest="$1" label="$2"; shift 2
  local stdout stderr rc
  stdout="$("$PICKER" "$@" 2>"$dest/$label.stderr")" || rc=$?
  rc="${rc:-0}"
  printf '%s' "$stdout"                  > "$dest/$label.stdout"
  printf '%d\n' "$rc"                    > "$dest/$label.exit"
}

capture_all() {
  local dest="$1"
  capture "$dest" message-list-empty         message-list --for nonexistent-session
  capture "$dest" message-list-unacked-empty message-list --for nonexistent-session --unacked
  capture "$dest" monitor-list-empty         monitor-list
  capture "$dest" log-tail-empty             log tail
  capture "$dest" log-query-empty            log query --type message.sent
}

sandbox="$(mktemp -d -t xtmux-v1-fx-XXXXXX)"
trap 'rm -rf "$sandbox"' EXIT
isolate "$sandbox"

if [ "$mode" = write ]; then
  mkdir -p "$FX_DIR"
  capture_all "$FX_DIR"
  echo "wrote fixtures to $FX_DIR"
  exit 0
fi

# check mode
tmp="$sandbox/fx"
mkdir -p "$tmp"
capture_all "$tmp"
drift=0
for f in "$FX_DIR"/*.stdout "$FX_DIR"/*.stderr "$FX_DIR"/*.exit; do
  base="${f##*/}"
  # Skip files that don't exist in the freshly-captured set (e.g. .live samples)
  [ -f "$tmp/$base" ] || continue
  if ! diff -q "$f" "$tmp/$base" >/dev/null 2>&1; then
    echo "DRIFT: $base"
    diff "$f" "$tmp/$base" | head -10 || true
    drift=1
  fi
done
if [ "$drift" = 0 ]; then
  echo "ok: no drift against $FX_DIR"
  exit 0
fi
exit 1
