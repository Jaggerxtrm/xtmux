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
  printf 'usage: %s <running|needs-input|done|idle|off> [--new-instance]\n' "${0##*/}" >&2
  printf '\n  --new-instance  start a new agent occupation of this pane: generate a\n' >&2
  printf '                  fresh @agent_instance_id before emitting the state event.\n' >&2
  printf '                  Call it on session start only (Pi session_start, Claude\n' >&2
  printf '                  SessionStart), never on ordinary transitions.\n' >&2
  printf '\noptional metadata env (pane-scoped):\n' >&2
  printf '  XTMUX_AGENT_BEAD           -> @agent_bead\n' >&2
  printf '  XTMUX_AGENT_TASK           -> @agent_task\n' >&2
  printf '  XTMUX_AGENT_PROMPT_FILE    -> @agent_prompt_file\n' >&2
  printf '  XTMUX_AGENT_PARENT_SESSION -> @agent_parent_session\n' >&2
  printf '\n@agent_last_transition is written on every state transition.\n' >&2
}

state=""
new_instance=0
for arg in "$@"; do
  case "$arg" in
    running|needs-input|done|idle|off) state="$arg" ;;
    --new-instance) new_instance=1 ;;
    -h|--help) usage; exit 2 ;;
    *) printf 'agent-state.sh: invalid argument: %s\n' "$arg" >&2; usage; exit 2 ;;
  esac
done
[ -n "$state" ] || { usage; exit 2; }

# hooks run fine even outside tmux (tests, editor launches, detached agents).
# invalid states still fail above. TMUX_PANE alone is not enough: without the
# client socket, tmux may resolve the pane against a bystander server.
[ -n "${TMUX:-}" ] || exit 0
target="${TMUX_PANE:-}"
[ -n "$target" ] || exit 0

host_id_source="$(readlink -f -- "${BASH_SOURCE[0]}" 2>/dev/null || printf '%s' "${BASH_SOURCE[0]}")"
host_id_source="$(cd -- "$(dirname -- "$host_id_source")" && pwd)/xtmux-host-id.sh"
[ -r "$host_id_source" ] || host_id_source="$HOME/.tmux/scripts/xtmux-host-id.sh"
source "$host_id_source"
unset host_id_source

json_escape() {
  local s="${1:-}"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\n'/\\n}"
  printf '%s' "$s"
}

event_log_file() {
  if [ -n "${XTMUX_EVENT_LOG_FILE:-}" ]; then
    REPLY="$XTMUX_EVENT_LOG_FILE"
  else
    REPLY="${XDG_STATE_HOME:-$HOME/.local/state}/xtmux/events.jsonl"
  fi
}

log_agent_state_event() {
  local file dir ts epoch session bead task prompt parent event host instance
  event_log_file; file="$REPLY"; dir="${file%/*}"
  mkdir -p "$dir" 2>/dev/null || true
  ts="$(date -Is 2>/dev/null || date '+%Y-%m-%dT%H:%M:%S%z')"
  epoch="$(date +%s 2>/dev/null || printf '0')"
  session="$(tmux display-message -p -t "$target" '#S' 2>/dev/null || true)"
  bead="$(tmux show-options -p -t "$target" -qv @agent_bead 2>/dev/null || true)"
  task="$(tmux show-options -p -t "$target" -qv @agent_task 2>/dev/null || true)"
  prompt="$(tmux show-options -p -t "$target" -qv @agent_prompt_file 2>/dev/null || true)"
  parent="$(tmux show-options -p -t "$target" -qv @agent_parent_session 2>/dev/null || true)"
  instance="$(tmux show-options -p -t "$target" -qv @agent_instance_id 2>/dev/null || true)"
  host_id; host="$REPLY"
  event="${CLAUDE_HOOK_EVENT:-${PI_HOOK_EVENT:-}}"
  printf '{"ts":"%s","ts_epoch":%s,"type":"agent.state","pane":"%s","session":"%s","state":"%s","event":"%s","bead":"%s","task":"%s","prompt_file":"%s","parent":"%s","host_id":"%s","agent_instance_id":"%s"}\n' \
    "$(json_escape "$ts")" "$epoch" "$(json_escape "$target")" "$(json_escape "$session")" "$(json_escape "$state")" "$(json_escape "$event")" "$(json_escape "$bead")" "$(json_escape "$task")" "$(json_escape "$prompt")" "$(json_escape "$parent")" "$(json_escape "$host")" "$(json_escape "$instance")" >> "$file" 2>/dev/null || true
}

sanitize_meta_value() {
  local value="${1:-}"
  value="${value//$'\t'/ }"
  value="${value//$'\r'/ }"
  value="${value//$'\n'/ }"
  printf '%s' "$value"
}

set_pane_option() {
  local opt="$1" value="$2"
  if [ -n "$value" ]; then
    tmux set-option -p -t "$target" -q "$opt" "$value" 2>/dev/null || true
  else
    # Setting an explicit empty value is more reliable for user options than
    # unsetting: tmux formats may otherwise resolve an inherited value.
    tmux set-option -p -t "$target" -q "$opt" "" 2>/dev/null || true
  fi
}

set_meta_from_env() {
  # Only variables that are present in the environment are applied. This keeps
  # existing hooks backward compatible: callers that only pass a state do not
  # accidentally wipe metadata during normal running/done transitions.
  [ "${XTMUX_AGENT_BEAD+x}" = x ] && set_pane_option @agent_bead "$(sanitize_meta_value "$XTMUX_AGENT_BEAD")"
  [ "${XTMUX_AGENT_TASK+x}" = x ] && set_pane_option @agent_task "$(sanitize_meta_value "$XTMUX_AGENT_TASK")"
  [ "${XTMUX_AGENT_PROMPT_FILE+x}" = x ] && set_pane_option @agent_prompt_file "$(sanitize_meta_value "$XTMUX_AGENT_PROMPT_FILE")"
  [ "${XTMUX_AGENT_PARENT_SESSION+x}" = x ] && set_pane_option @agent_parent_session "$(sanitize_meta_value "$XTMUX_AGENT_PARENT_SESSION")"
  return 0
}

clear_optional_meta() {
  set_pane_option @agent_bead ""
  set_pane_option @agent_task ""
  set_pane_option @agent_prompt_file ""
  set_pane_option @agent_parent_session ""
}

# a new agent occupation of the pane gets a fresh identity, written before the
# state event so the event already carries it. ordinary transitions preserve the
# id: rotating it per-idle would make every turn look like a new agent, and a
# pane's Specialists jobs would scatter across phantom instances.
if [ "$new_instance" = 1 ]; then
  xtmux_gen_uuid
  set_pane_option @agent_instance_id "$REPLY"
fi

# don't let a missing/dead pane fail the agent hook. the state is best-effort;
# the picker just renders no badge if the option can't be written.
tmux set-option -p -t "$target" -q @agent_state "$state" 2>/dev/null || true
tmux set-option -p -t "$target" -q @agent_last_transition "$(date -Is)" 2>/dev/null || true
set_meta_from_env
# off is the explicit lifecycle end marker: keep @agent_state=off for backward
# compatibility, but clear optional task metadata so previews do not show stale
# bead/task pointers for a reused pane. @agent_instance_id deliberately survives
# so a post-mortem can still attribute the pane's last occupation; the next
# --new-instance overwrites it.
[ "$state" = off ] && clear_optional_meta
log_agent_state_event

# optional empirical audit log (off by default). records the firing event and
# transition so an operator/orchestrator can verify hook ordering on real runs.
# CLAUDE_HOOK_EVENT / PI_HOOK_EVENT may be exported by the calling hook config.
if [ "${XTMUX_AGENT_STATE_LOG:-0}" = "1" ]; then
  log_file="${XTMUX_AGENT_STATE_LOG_FILE:-$HOME/.cache/xtmux/agent-state.log}"
  mkdir -p "$(dirname "$log_file")" 2>/dev/null || true
  printf '%s\t%s\t%s\t%s\n' "$(date -Is)" "$target" "${CLAUDE_HOOK_EVENT:-${PI_HOOK_EVENT:-?}}" "$state" >> "$log_file" 2>/dev/null || true
fi
