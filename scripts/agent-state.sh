#!/usr/bin/env bash
# set the current tmux pane's agent state for xtmux.
# usage: agent-state.sh <running|needs-input|done|idle|off>
#
# agents call this from lifecycle hooks. the picker reads the pane option
# `@agent_state` live (never from rendered-output cache), so badge/sort changes
# show up immediately.
#
# optional audit logging: set XTMUX_AGENT_STATE_LOG=1 to append every transition
# (timestamp, pane, caller event) to $XTMUX_AGENT_STATE_LOG_FILE or
# ~/.cache/xtmux/agent-state.log. handy for verifying hook firing order for
# multiplexing/orchestrator correctness. off by default.
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

# hooks run fine even outside tmux (tests, editor launches, detached agents).
# invalid states still fail above.
target="${TMUX_PANE:-}"
[ -n "$target" ] || exit 0

# don't let a missing/dead pane fail the agent hook. the state is best-effort;
# the picker just renders no badge if the option can't be written.
tmux set-option -p -t "$target" -q @agent_state "$state" 2>/dev/null || true

# optional empirical audit log (off by default). records the firing event and
# transition so an operator/orchestrator can verify hook ordering on real runs.
# CLAUDE_HOOK_EVENT / PI_HOOK_EVENT may be exported by the calling hook config.
if [ "${XTMUX_AGENT_STATE_LOG:-0}" = "1" ]; then
  log_file="${XTMUX_AGENT_STATE_LOG_FILE:-$HOME/.cache/xtmux/agent-state.log}"
  mkdir -p "$(dirname "$log_file")" 2>/dev/null || true
  printf '%s\t%s\t%s\t%s\n' "$(date -Is)" "$target" "${CLAUDE_HOOK_EVENT:-${PI_HOOK_EVENT:-?}}" "$state" >> "$log_file" 2>/dev/null || true
fi
