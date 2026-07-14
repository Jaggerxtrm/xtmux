#!/usr/bin/env bash
# auto-monitor-consumed prefilter — reads PostToolUse JSON on stdin, and only
# invokes the Node hook when a wait-agent invocation is detected. Cuts the
# 99% non-match case from ~60ms (Node cold-start) to ~10ms.
set -u
INPUT="$(cat)"
if ! printf '%s' "$INPUT" | grep -qE 'wait-agent'; then
  exit 0
fi
printf '%s' "$INPUT" | exec node "$(dirname "$0")/auto-monitor-consumed.mjs"
