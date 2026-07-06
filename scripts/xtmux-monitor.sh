#!/usr/bin/env bash
# Open a tmux dashboard for xtmux team/orchestrator monitoring.
set -euo pipefail

usage() {
  cat <<'USAGE'
usage: scripts/xtmux-monitor.sh [options]

Options:
  -s, --session NAME        tmux session name (default: xtmux-monitor)
  -i, --interval SEC        dashboard refresh interval (default: 5)
  --audit-interval SEC      monitor/audit refresh interval (default: 10)
  --log FILE               xtmux JSONL event log path
                            default: ${XDG_STATE_HOME:-$HOME/.local/state}/xtmux/events.jsonl
  --picker PATH             tmux-session-picker path/command
  --messages TARGET         add pane with unacked messages for TARGET
  --turns                   add pane with recent agent.turn.done events
  --telemetry               add pane with recent git/bd/gh telemetry events
  --full                    equivalent to --turns --telemetry and messages for current tmux session if available
  --kill-existing           kill an existing monitor session before creating it
  --no-attach               create session but do not attach
  -h, --help                show this help

Examples:
  scripts/xtmux-monitor.sh
  scripts/xtmux-monitor.sh --full
  scripts/xtmux-monitor.sh --messages docs --turns
  scripts/xtmux-monitor.sh --session muxmon --interval 2 --kill-existing
USAGE
}

session="xtmux-monitor"
interval=5
audit_interval=10
log_file="${XTMUX_EVENT_LOG_FILE:-${XDG_STATE_HOME:-$HOME/.local/state}/xtmux/events.jsonl}"
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
picker="${XTMUX_PICKER:-}"
messages_target=""
add_turns=0
add_telemetry=0
attach=1
kill_existing=0

if [ -z "$picker" ]; then
  if command -v tmux-session-picker >/dev/null 2>&1; then
    picker="$(command -v tmux-session-picker)"
  else
    picker="$repo/bin/tmux-session-picker"
  fi
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    -s|--session) shift; [ "$#" -gt 0 ] || { usage >&2; exit 2; }; session="$1" ;;
    --session=*) session="${1#--session=}" ;;
    -i|--interval) shift; [ "$#" -gt 0 ] || { usage >&2; exit 2; }; interval="$1" ;;
    --interval=*) interval="${1#--interval=}" ;;
    --audit-interval) shift; [ "$#" -gt 0 ] || { usage >&2; exit 2; }; audit_interval="$1" ;;
    --audit-interval=*) audit_interval="${1#--audit-interval=}" ;;
    --log) shift; [ "$#" -gt 0 ] || { usage >&2; exit 2; }; log_file="$1" ;;
    --log=*) log_file="${1#--log=}" ;;
    --picker) shift; [ "$#" -gt 0 ] || { usage >&2; exit 2; }; picker="$1" ;;
    --picker=*) picker="${1#--picker=}" ;;
    --messages) shift; [ "$#" -gt 0 ] || { usage >&2; exit 2; }; messages_target="$1" ;;
    --messages=*) messages_target="${1#--messages=}" ;;
    --turns) add_turns=1 ;;
    --telemetry) add_telemetry=1 ;;
    --full)
      add_turns=1
      add_telemetry=1
      if [ -z "$messages_target" ]; then
        messages_target="$(tmux display-message -p '#S' 2>/dev/null || true)"
      fi
      ;;
    --kill-existing) kill_existing=1 ;;
    --no-attach) attach=0 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

case "$interval" in ''|*[!0-9]*) printf 'invalid --interval: %s\n' "$interval" >&2; exit 2 ;; esac
case "$audit_interval" in ''|*[!0-9]*) printf 'invalid --audit-interval: %s\n' "$audit_interval" >&2; exit 2 ;; esac

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found" >&2
  exit 127
fi
if ! command -v watch >/dev/null 2>&1; then
  echo "watch not found" >&2
  exit 127
fi
if [ ! -x "$picker" ] && ! command -v "$picker" >/dev/null 2>&1; then
  printf 'tmux-session-picker not found/executable: %s\n' "$picker" >&2
  exit 127
fi

mkdir -p "$(dirname -- "$log_file")"
touch "$log_file"

q() { printf '%q' "$1"; }

watch_cmd() {
  local every="$1" cmd="$2"
  printf 'watch -n %s %s' "$every" "$(q "$cmd")"
}

if tmux has-session -t "$session" 2>/dev/null; then
  if [ "$kill_existing" = 1 ]; then
    tmux kill-session -t "$session"
  else
    echo "monitor session already exists: $session"
    if [ "$attach" = 1 ]; then
      exec tmux attach -t "$session"
    fi
    exit 0
  fi
fi

export XTMUX_EVENT_LOG_FILE="$log_file"

pane_dashboard="$(watch_cmd "$interval" "$picker dashboard sessions-only")"
pane_audit="$(watch_cmd "$audit_interval" "$picker monitor-list; echo; $picker audit")"
pane_log="tail -F $(q "$log_file")"

tmux new-session -d -s "$session" -n monitor "$pane_dashboard"
window_id="$(tmux display-message -p -t "$session" '#{window_id}')"
tmux split-window -t "$window_id" -v "$pane_audit"
tmux split-window -t "$window_id" -h "$pane_log"

if [ -n "$messages_target" ]; then
  cmd="$picker message-list --for $(q "$messages_target") --unacked"
  tmux split-window -t "$window_id" "$(watch_cmd 3 "$cmd")"
fi

if [ "$add_turns" = 1 ]; then
  cmd="$picker log query --type agent.turn.done --since 2h --limit 30"
  tmux split-window -t "$window_id" "$(watch_cmd 5 "$cmd")"
fi

if [ "$add_telemetry" = 1 ]; then
  # Keep grep inside sh -c so no-match does not kill watch output.
  cmd="$picker log query --since 2h --limit 120 | grep -E '\"type\":\"(git\\.|bd\\.|gh\\.|git.pr)' || true"
  tmux split-window -t "$window_id" "$(watch_cmd 5 "$cmd")"
fi

tmux select-layout -t "$window_id" tiled >/dev/null

cat <<MSG
xtmux monitor session: $session
log file: $log_file
attach: tmux attach -t $session
MSG

if [ "$attach" = 1 ]; then
  exec tmux attach -t "$session"
fi
