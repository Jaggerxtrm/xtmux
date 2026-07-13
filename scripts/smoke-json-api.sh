#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
picker="$root/bin/tmux-session-picker"
label="xtmux-json-smoke-$$"
tmp="$(mktemp -d)"
monitor_id=''
cleanup() {
  [ -z "$monitor_id" ] || "$picker" monitor-kill "$monitor_id" --json >/dev/null 2>&1 || true
  tmux -L "$label" kill-server >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

command -v jq >/dev/null
tmux -L "$label" new-session -d -s smoke 'sleep 60'
socket="$(tmux -L "$label" display-message -p '#{socket_path}')"
pane="$(tmux -L "$label" display-message -p '#{pane_id}')"
sid="$(tmux -L "$label" display-message -p '#{session_id}')"
tmux -L "$label" set-option -p -t "$pane" @agent_state done

export TMUX="$socket,0,0" TMUX_PANE="$pane" XTMUX_OBS_V2=1
export XTMUX_OBS_DB_PATH="$tmp/observability.db" XDG_STATE_HOME="$tmp/state" XDG_RUNTIME_DIR="$tmp/runtime"
mkdir -p "$XDG_RUNTIME_DIR"
"$root/bin/xtmux-obs" migrate >/dev/null

key="json-smoke-$$"
"$picker" message-send --json --id "$key" --to "$pane" --from "$pane" --bead xtmux-d0a.6 --expects-reply=false --text 'json gate smoke' | jq -e --arg key "$key" '.messageKey == $key and .duplicate == false' >/dev/null
"$picker" message-list --for "$sid" --pane "$pane" --json | jq -e --arg key "$key" '.[0].messageKey == $key and .[0].targetPaneId != null' >/dev/null
"$picker" message-status --json "$key" | jq -e '.acked == false' >/dev/null
"$picker" unread-count --for "$sid" --pane "$pane" --json | jq -e '.unreadCount == 1' >/dev/null
"$picker" message-ack "$key" --by "$sid" --json | jq -e '.status == "acked"' >/dev/null
"$picker" unread-count --for "$sid" --pane "$pane" --json | jq -e '.unreadCount == 0' >/dev/null

"$picker" dashboard expanded --json | jq -e --arg sid "$sid" --arg pane "$pane" 'any(.sessions[]; .sessionId == $sid) and any(.panes[]; .paneId == $pane)' >/dev/null
"$picker" worktree-collisions --json | jq -e 'type == "array"' >/dev/null
"$picker" audit --stable --json | jq -e 'type == "array"' >/dev/null
"$picker" wait-agent "$pane" --json --timeout 2 --interval 1 | jq -e '.status == "done"' >/dev/null
"$picker" safe-send-pointer --json "$pane" /tmp/xtmux-json-smoke.txt | jq -e '.sent == false' >/dev/null
"$picker" handoff --json --target "$pane" --bead xtmux-d0a.6 --file "$tmp/handoff.txt" | jq -e '.sent == false' >/dev/null

# Arm while working so the monitor stays active long enough to exercise kill.
tmux -L "$label" set-option -p -t "$pane" @agent_state running
monitor_json="$("$picker" monitor-agent "$pane" --json --timeout 30 --interval 5)"
monitor_id="$(jq -er '.monitorId' <<< "$monitor_json")"
"$picker" monitor-list --json | jq -e --arg id "$monitor_id" 'any(.[]; .monitorId == $id)' >/dev/null
"$picker" monitor-kill "$monitor_id" --json | jq -e '.status == "killed"' >/dev/null
monitor_id=''

"$picker" log query --type query.completed --json | jq -e 'type == "array"' >/dev/null
"$root/bin/xtmux-obs" version --json | jq -e '.schemaVersion >= 1' >/dev/null
"$root/bin/xtmux-obs" obligations list --pane "$pane" --json | jq -e 'type == "array"' >/dev/null

printf 'json-api-live-smoke\tPASS\tsession=%s\tpane=%s\n' "$sid" "$pane"
