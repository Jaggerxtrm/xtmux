#!/usr/bin/env bash
# auto-monitor-on-send prefilter — reads Claude Code PostToolUse Bash JSON on
# stdin, does a cheap regex on tool_input.command, and only invokes the Node
# hook when a target-bearing send is detected. Cuts the 99% no-match case
# from ~40ms (Node cold-start) to ~2ms (bash + one grep).
set -u
INPUT="$(cat)"
# very cheap grep — no target extraction, just detect the send commands
if ! printf '%s' "$INPUT" | grep -qE 'message-send|safe-send-pointer|tmux[[:space:]]+send-keys'; then
  exit 0
fi
# match: hand off to the node hook with the same stdin
printf '%s' "$INPUT" | exec node "$(dirname "$0")/auto-monitor-on-send.mjs"
