#!/usr/bin/env bash
# Set the current tmux pane's agent state for xtmux.
# Usage: agent-state.sh <running|needs-input|done|idle|off>
#
# Agents should call this from lifecycle hooks. The picker reads the pane option
# `@agent_state` live (never from rendered-output cache), so badge/sort changes
# are reflected immediately.
set -euo pipefail

usage() {
  printf 'usage: %s <running|needs-input|done|idle|off>\n' "${0##*/}" >&2
}

state="${1:-}"
case "$state" in
  running|needs-input|done|idle|off) ;;
  ""|-h|--help) usage; exit 2 ;;
  *) printf 'agent-state.sh: invalid state: %s\n' "$state" >&2; usage; exit 2 ;;
esac

# Hooks run successfully even outside tmux (for example during tests, editor
# launches, or detached agents). Invalid states still fail above.
target="${TMUX_PANE:-}"
[ -n "$target" ] || exit 0

# Do not let a missing/dead pane fail the agent hook. The state is best-effort;
# the picker will simply render no badge if the option cannot be written.
tmux set-option -p -t "$target" -q @agent_state "$state" 2>/dev/null || true
