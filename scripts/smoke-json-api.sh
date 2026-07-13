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
export XTMUX_PICKER="$picker"
mkdir -p "$XDG_RUNTIME_DIR"
"$root/bin/xtmux-obs" migrate >/dev/null
native() { bun run "$root/tests/fixtures/run-pi-xtmux-tool.ts" "$1" "$2"; }

# Native Pi pilot: each tool returns the exact JSON stdout from the CLI invocation it delegates to.
native_key="native-json-smoke-$$"
native xtmux_message_send "$(jq -cn --arg to "$pane" --arg from "$pane" --arg key "$native_key" '{to:$to,from:$from,text:"native gate smoke",messageKey:$key,expectsReply:false}')" | jq -e --arg key "$native_key" '.messageKey == $key and .duplicate == false' >/dev/null
native xtmux_message_list "$(jq -cn --arg for "$sid" --arg pane "$pane" '{for:$for,pane:$pane}')" | jq -e --arg key "$native_key" 'any(.[]; .messageKey == $key)' >/dev/null
native xtmux_message_status "$(jq -cn --arg key "$native_key" '{messageKey:$key}')" | jq -e '.acked == false' >/dev/null
native xtmux_unread_count "$(jq -cn --arg for "$sid" --arg pane "$pane" '{for:$for,pane:$pane}')" | jq -e '.unreadCount == 1' >/dev/null
native xtmux_message_ack "$(jq -cn --arg key "$native_key" --arg by "$sid" '{messageKey:$key,by:$by}')" | jq -e '.status == "acked"' >/dev/null
native xtmux_unread_count "$(jq -cn --arg for "$sid" --arg pane "$pane" '{for:$for,pane:$pane}')" | jq -e '.unreadCount == 0' >/dev/null
native xtmux_wait_agent "$(jq -cn --arg target "$pane" '{target:$target,timeout:"2",interval:"1"}')" | jq -e '.status == "done"' >/dev/null
tmux -L "$label" set-option -p -t "$pane" @agent_state running
set +e
native xtmux_wait_agent "$(jq -cn --arg target "$pane" '{target:$target,timeout:"1",interval:"1"}')" >/dev/null 2>"$tmp/native-timeout.err"
native_timeout_rc=$?
set -e
[ "$native_timeout_rc" -eq 124 ] && jq -e '.code == "XTMUX_WAIT_TIMEOUT"' "$tmp/native-timeout.err" >/dev/null
monitor_json="$(native xtmux_monitor_agent "$(jq -cn --arg target "$pane" '{target:$target,timeout:"30",interval:"5"}')")"
monitor_id="$(jq -er '.monitorId' <<< "$monitor_json")"
native xtmux_monitor_list '{}' | jq -e --arg id "$monitor_id" 'any(.[]; .monitorId == $id)' >/dev/null
native xtmux_monitor_kill "$(jq -cn --arg id "$monitor_id" '{monitorId:$id}')" | jq -e '.status == "killed"' >/dev/null
monitor_id=''
tmux -L "$label" set-option -p -t "$pane" @agent_state done

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
