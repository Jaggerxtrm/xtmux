#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'usage: %s [--json]\n' "${0##*/}"
}

json_output=0
case "${1:-}" in
  --json) json_output=1; shift ;;
  -h|--help) usage; exit 0 ;;
esac
[ "$#" -eq 0 ] || { usage >&2; exit 2; }

for command in xtmux sp bd git jq flock; do
  command -v "$command" >/dev/null || { printf 'missing command: %s\n' "$command" >&2; exit 127; }
done

metadata_file="$(mktemp)"
output_lock="$(mktemp)"
pids=()
cleanup() {
  status=$?
  trap - EXIT INT TERM
  [ "${#pids[@]}" -eq 0 ] || kill "${pids[@]}" 2>/dev/null || true
  wait "${pids[@]}" 2>/dev/null || true
  rm -f "$metadata_file" "$output_lock"
  exit "$status"
}
trap cleanup EXIT INT TERM

emit_lines() {
  local line
  while IFS= read -r line; do
    { flock 9; printf '%s\n' "$line"; } 9>"$output_lock"
  done
}

render() {
  if [ "$json_output" -eq 1 ]; then
    emit_lines
    return
  fi

  jq --unbuffered -r '
    def detail:
      if .source == "specialists" then
        " job=\(.event.job_id // .event.forensic_event.correlation.job_id // "-") role=\(.event.specialist // .event.forensic_event.resource.participant_role // "-")"
      elif .source == "beads" then
        " bead=\(.event.issue_id) actor=\(.event.actor // "-")" +
        (if .type == "bd.updated" and (.event.new_value | type) == "object" then
          " fields=\(.event.new_value | keys | join(","))"
        elif (.event.old_value | type) == "object" or (.event.new_value | type) == "object" then
          " status=\(.event.old_value.status // "-")->\(.event.new_value.status // "-")"
        else "" end)
      elif .type == "messages.sent" then
        " from=\(.event.payload.sender_id // "-") to=\(.event.payload.recipient_id // "-") message=\(.event.payload.message_id // "-")"
      elif .type == "messages.ack" then
        " by=\(.event.payload.acked_by // "-") message=\(.event.payload.message_id // "-")"
      elif ((.type // "") | startswith("agents.state.")) then
        " task=\(.event.payload.task // "-")"
      elif .type == "agents.instance.open" then
        " role=\(.event.payload.role // "-") runtime=\(.event.payload.runtime // "-") task=\(.event.payload.task // "-")"
      elif (((.type // "") | startswith("handoffs.")) or ((.type // "") | startswith("deliveries."))) then
        " bead=\(.event.bead_id // "-") ref=\(.event.correlation_id // "-")"
      else ""
      end;
    def actor:
      .pane.agent // (if (.session.agents | length) > 0 then (.session.agents | join(",")) else "-" end);
    def session_id:
      .session.id // (if (.session.candidates | length) > 0 then (.session.candidates | join(",")) else "-" end);
    def pane_id:
      .pane.id // (if (.pane.candidates | length) > 0 then (.pane.candidates | join(",")) else "-" end);

    "[\(.ts / 1000 | strftime("%H:%M:%SZ"))] [\(.source)] [\(.session.repo // "-")/\(.session.name // "?") \(session_id)] [\(actor) \(pane_id)] \(.type)\(detail)"
  ' | emit_lines
}

follow_beads() {
  local root="$1" cursor_time="$2" cursor_id="$3" rows last
  while :; do
    if rows="$(bd -C "$root" sql --json "
      SELECT id, issue_id, event_type, actor, old_value, new_value, comment, created_at
      FROM events
      WHERE created_at > '$cursor_time' OR (created_at = '$cursor_time' AND id > '$cursor_id')
      ORDER BY created_at, id
      LIMIT 100
    " 2>/dev/null)"; then
      last="$(jq -r '(last? // empty) | [(.created_at | sub("T"; " ") | rtrimstr("Z")), .id] | @tsv' <<<"$rows")"
      if [ -n "$last" ]; then
        IFS=$'\t' read -r cursor_time cursor_id <<<"$last"
        jq --unbuffered -c '.[] | select(.event_type | IN("created", "claimed", "updated", "closed", "reopened", "status_changed"))' <<<"$rows"
      fi
    fi
    # ponytail: poll per repo until Beads exposes a lifecycle watch API.
    sleep 2
  done
}

normalize_beads() {
  local root="$1" repo="$2"
  jq --unbuffered -c --arg root "$root" --arg repo "$repo" --arg host_id "${HOSTNAME:-unknown}" --slurpfile dashboard "$metadata_file" '
    def under($path; $root): ($path // "") == $root or (($path // "") | startswith($root + "/"));
    def sessions($root): [$dashboard[0].sessions[]? | select(under(.path; $root))];
    def session_for($root; $issue):
      sessions($root) as $all
      | [$all[] | select(.beadId == $issue)] as $exact
      | if ($exact | length) == 1 then $exact[0] elif ($all | length) == 1 then $all[0] else {} end;
    def hex:
      reduce explode[] as $c (0;
        . * 16 + (if $c >= 48 and $c <= 57 then $c - 48 elif $c >= 97 and $c <= 102 then $c - 87 else $c - 55 end));
    def event_ms($event):
      if $event.id[14:15] == "7" then ($event.id | gsub("-"; "") | .[0:12] | hex)
      else ($event.created_at | fromdateiso8601 * 1000) end;
    def value:
      . as $value | if $value == null or $value == "" then $value else try ($value | fromjson) catch $value end;

    . as $event
    | sessions($root) as $sessions
    | session_for($root; .issue_id) as $session
    | ($sessions | map(.sessionId)) as $session_ids
    | [$dashboard[0].panes[]? as $pane
        | select(($session_ids | index($pane.sessionId)) != null)
        | select($pane.command == "claude" or $pane.command == "pi")
        | $pane] as $agent_panes
    | (if $session == {} then [] else [$agent_panes[] | select(.sessionId == $session.sessionId)] end) as $session_panes
    | (if ($session_panes | length) == 1 then $session_panes[0] else {} end) as $pane
    | {
        ts: event_ms($event),
        source: "beads",
        type: ("bd." + .event_type),
        host_id: $host_id,
        session: {
          id: ($session.sessionId // null),
          name: ($session.sessionName // null),
          repo: $repo,
          path: $root,
          agents: ($agent_panes | map(.command) | unique),
          candidates: ($sessions | map(.sessionId))
        },
        pane: {
          id: ($pane.paneId // null),
          agent: ($pane.command // null),
          command: ($pane.command // null),
          path: ($pane.path // null),
          candidates: ($agent_panes | map(.paneId))
        },
        event: ($event | {
          schema_version: "xtrm.beads.lifecycle-event.v1",
          source: "beads.events",
          id,
          issue_id,
          event_type,
          actor,
          old_value: (.old_value | value),
          new_value: (.new_value | value),
          comment,
          created_at,
          occurred_at_ms: event_ms($event),
          timestamp_source: (if .id[14:15] == "7" then "uuidv7" else "created_at" end)
        })
      }
  '
}

if [ "${SESSION_EVENTS_LIB_ONLY:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

# ponytail: snapshot once; restart the helper to include sessions opened later.
xtmux dashboard expanded --json >"$metadata_file"
session_count="$(jq -r '.sessions | length' "$metadata_file")"
started_at="$(date -Is)"
cursor="$(xtmux log query --after-id 0 --limit 1 --json | jq -er '.latest_available_id // 0')"

printf 'following %s open xtmux sessions from journal cursor %s\n' "$session_count" "$cursor" >&2

xtmux log follow --after-id "$cursor" --json |
  jq --unbuffered -c --slurpfile dashboard "$metadata_file" '
    def session($id): first($dashboard[0].sessions[]? | select(.sessionId == $id)) // {};
    def pane($id): first($dashboard[0].panes[]? | select(.paneId == $id)) // {};
    def agents($id):
      [$dashboard[0].panes[]? | select(.sessionId == $id) | .command | select(. == "claude" or . == "pi")] | unique;
    def agent($pane; $session):
      if $pane.command == "claude" or $pane.command == "pi" then $pane.command
      elif (($session.sessionName // "") | startswith("claude-")) then "claude"
      elif ((($session.sessionName // "") | startswith("pi-")) or (($session.sessionName // "") | contains("-pi-"))) then "pi"
      else null end;

    select((.event_type // "") | test("^(agents\\.instance\\.open|agents\\.state\\..+|handoffs\\..+|deliveries\\..+|messages\\.(sent|ack))$"))
    | .session_id as $sid
    | .pane_id as $pid
    | session($sid) as $session
    | pane($pid) as $pane
    | select($session != {})
    | {
        ts: .occurred_at_ms,
        source: "xtmux",
        type: .event_type,
        host_id: .host_id,
        session: {id: $sid, name: $session.sessionName, repo: $session.repo, path: $session.path, agents: agents($sid)},
        pane: {id: $pid, agent: agent($pane; $session), command: ($pane.command // null), path: ($pane.path // null)},
        event: .
      }
  ' |
  render &
pids+=("$!")

sp log --since "$started_at" --follow --json |
  jq --unbuffered -c --slurpfile dashboard "$metadata_file" '
    def session($id): first($dashboard[0].sessions[]? | select(.sessionId == $id)) // {};
    def pane($id): first($dashboard[0].panes[]? | select(.paneId == $id)) // {};
    def agents($id):
      [$dashboard[0].panes[]? | select(.sessionId == $id) | .command | select(. == "claude" or . == "pi")] | unique;
    def agent($pane; $session):
      if $pane.command == "claude" or $pane.command == "pi" then $pane.command
      elif (($session.sessionName // "") | startswith("claude-")) then "claude"
      elif ((($session.sessionName // "") | startswith("pi-")) or (($session.sessionName // "") | contains("-pi-"))) then "pi"
      else null end;

    select(.forensic_event.event_name == "job.started")
    | .forensic_event as $forensic
    | ($forensic.links.spawned_by.tmux_pane_id // $forensic.links.root_runtime_origin.tmux_pane_id) as $pid
    | ($forensic.links.spawned_by.tmux_session_id // pane($pid).sessionId) as $sid
    | session($sid) as $session
    | pane($pid) as $pane
    | select($session != {})
    | {
        ts: $forensic.t_unix_ms,
        source: "specialists",
        type: "job.started",
        host_id: ($forensic.links.spawned_by.host_id // $forensic.links.root_runtime_origin.host_id),
        session: {id: $sid, name: $session.sessionName, repo: $session.repo, path: $session.path, agents: agents($sid)},
        pane: {id: $pid, agent: agent($pane; $session), command: ($pane.command // null), path: ($pane.path // null)},
        event: .
      }
  ' |
  render &
pids+=("$!")

declare -A watched_roots=()
beads_roots=()
beads_started_at="$(date '+%Y-%m-%d %H:%M:%S')"
while IFS= read -r path; do
  common_dir="$(git -C "$path" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  [ -n "$common_dir" ] || continue
  root="$(dirname "$common_dir")"
  [ -e "$root/.beads" ] || continue
  [ -z "${watched_roots[$root]:-}" ] || continue
  watched_roots[$root]=1
  beads_roots+=("$root")
done < <(jq -r '.sessions[].path' "$metadata_file")

for root in "${beads_roots[@]}"; do
  follow_beads "$root" "$beads_started_at" "" |
    normalize_beads "$root" "$(basename "$root")" |
    render &
  pids+=("$!")
done

printf 'following Beads lifecycle events from %s repositories\n' "${#beads_roots[@]}" >&2

status=0
wait -n "${pids[@]}" || status=$?
exit "$status"
