#!/usr/bin/env bash
# Set the current tmux pane's agent state for xtmux.
# Usage: agent-state.sh <running|needs-input|done|idle|off>
#
# Agents should call this from lifecycle hooks. The picker reads the pane option
# `@agent_state` live (never from rendered-output cache), so badge/sort changes
# are reflected immediately.
#
# Optional audit logging: set XTMUX_AGENT_STATE_LOG=1 to append every transition
# (with timestamp, pane, caller event) to $XTMUX_AGENT_STATE_LOG_FILE or
# ~/.cache/xtmux/agent-state.log. Useful for verifying hook firing order for
# multiplexing/orchestrator correctness. Off by default.
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

# Optional empirical audit log (off by default). Records the firing event and
# transition so an operator/orchestrator can verify hook ordering on real runs.
# CLAUDE_HOOK_EVENT / PI_HOOK_EVENT may be exported by the calling hook config.
if [ "${XTMUX_AGENT_STATE_LOG:-0}" = "1" ]; then
  log_file="${XTMUX_AGENT_STATE_LOG_FILE:-$HOME/.cache/xtmux/agent-state.log}"
  mkdir -p "$(dirname "$log_file")" 2>/dev/null || true
  printf '%s\t%s\t%s\t%s\n' "$(date -Is)" "$target" "${CLAUDE_HOOK_EVENT:-${PI_HOOK_EVENT:-?}}" "$state" >> "$log_file" 2>/dev/null || true
fi
