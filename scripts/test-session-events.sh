#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'usage: %s [--json] [--color|--no-color]\n' "${0##*/}"
}

json_output=0
force_color=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --json) json_output=1 ;;
    --color) force_color=1 ;;
    --no-color) force_color=0 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

# Colors: on when stdout is a terminal and NO_COLOR (no-color.org) is unset;
# --color/--no-color force it. Machine output (--json) never gets colors.
if [ -n "$force_color" ]; then
  [ "$force_color" -eq 1 ] && use_color=true || use_color=false
elif [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  use_color=true
else
  use_color=false
fi

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

# Multi-line blocks: the human render emits one JSON-encoded string per line
# (newlines escaped), so one input line == one whole event block. Decode and
# print it under a SINGLE flock so concurrent followers never interleave
# mid-event. (--json uses emit_lines: its records are already one per line.)
emit_blocks() {
  local line
  while IFS= read -r line; do
    { flock 9; jq -r '.' <<<"$line"; } 9>"$output_lock"
  done
}

render() {
  if [ "$json_output" -eq 1 ]; then
    emit_lines
    return
  fi

  # Archon-shaped multi-line blocks:
  #   LEVEL [YYYY-MM-DD HH:MM:SS.mmm +ZZZZ]: <type>  (duration)
  #       key:  "value"
  #       ...
  # Local time, milliseconds, and the UTC offset are computed in jq (no GNU date
  # dependency). Each block is emitted as ONE JSON-encoded line and decoded under
  # a per-block flock in emit_blocks, so concurrent followers never interleave.
  jq --unbuffered --argjson color "$use_color" '
    def pad2: tostring | if length < 2 then "0" + . else . end;
    def pad3: tostring | if length < 3 then ("0" * (3 - length)) + . else . end;
    def C($code): if $color then "\u001b[\($code)m" else "" end;
    def R: if $color then "\u001b[0m" else "" end;
    def level_code: ((.event.payload.level // "info") | if . == "error" then "1;31" elif . == "warn" then "1;33" else "1;32" end);
    def stamp:
      (. / 1000 | floor) as $sec
      | ((. % 1000 | floor) as $r | if $r < 0 then $r + 1000 else $r end) as $ms
      | ($sec | localtime) as $l
      | ((($l | mktime) - $sec) / 60 | round) as $offmin
      | ($offmin | fabs | floor) as $aoff
      | "\($l[0])-\($l[1] + 1 | pad2)-\($l[2] | pad2) \($l[3] | pad2):\($l[4] | pad2):\($l[5] | pad2).\($ms | pad3) \(if $offmin >= 0 then "+" else "-" end)\(($aoff / 60 | floor) | pad2)\(($aoff % 60) | pad2)";
    def qv: if type == "string" then "\"\(.)\"" else tostring end;
    def level: ((.event.payload.level // "info") | ascii_upcase);
    def dur_suffix:
      (.event.payload.duration_ms) as $d
      | if ($d | type) == "number" then
          (if $d >= 1000 then "  \(C("33"))(\($d / 1000 * 10 | round / 10)s)\(R)" else "  \(C("33"))(\($d | round)ms)\(R)" end)
        else "" end;
    def actor:
      .pane.agent // (if (.session.agents | length) > 0 then (.session.agents | join(",")) else "-" end);
    def session_id:
      .session.id // (if (.session.candidates | length) > 0 then (.session.candidates | join(",")) else "-" end);
    def pane_id:
      .pane.id // (if (.pane.candidates | length) > 0 then (.pane.candidates | join(",")) else "-" end);
    def detail_obj:
      if .source == "specialists" then
        { job: (.event.job_id // .event.forensic_event.correlation.job_id // "-"),
          role: (.event.specialist // .event.forensic_event.resource.participant_role // "-") }
      elif .source == "beads" then
        ( { bead: .event.issue_id, actor: (.event.actor // "-") }
          + (if .type == "bd.updated" and (.event.new_value | type) == "object" then { fields: (.event.new_value | keys | join(",")) }
             elif (.event.old_value | type) == "object" or (.event.new_value | type) == "object" then { status: "\(.event.old_value.status // "-")->\(.event.new_value.status // "-")" }
             else {} end) )
      elif .type == "messages.sent" then
        { from: (.event.payload.sender_id // "-"), to: (.event.payload.recipient_id // "-"), message: (.event.payload.message_id // "-") }
      elif .type == "messages.ack" then
        { by: (.event.payload.acked_by // "-"), message: (.event.payload.message_id // "-") }
      elif ((.type // "") | startswith("agents.state.")) then
        { task: (.event.payload.task // "-") }
      elif .type == "agents.instance.open" then
        { role: (.event.payload.role // "-"), runtime: (.event.payload.runtime // "-"), task: (.event.payload.task // "-") }
      elif (((.type // "") | startswith("handoffs.")) or ((.type // "") | startswith("deliveries."))) then
        { bead: (.event.bead_id // "-"), ref: (.event.correlation_id // "-") }
      elif .event.payload.module == "telemetry" then
        ( { tool: (.event.payload.tool // "-") }
          + (if .event.payload.outcome != null then { outcome: .event.payload.outcome } else {} end)
          + (if .event.payload.exit != null then { exit: .event.payload.exit } else {} end)
          + (if (.event.payload.duration_ms | type) == "number" then { durationMs: .event.payload.duration_ms } else {} end)
          + (if .event.correlation_id != null then { run: .event.correlation_id } else {} end) )
      else {} end;
    def fields:
      { module: (.event.payload.module // .source),
        source: .source,
        session: "\(.session.repo // "-")/\(.session.name // "?")",
        sessionId: session_id,
        pane: pane_id,
        agent: actor } + detail_obj;

    . as $e
    | ($e | fields) as $f
    | ( [ "\(C($e | level_code))\($e | level)\(R) \(C("90"))[\($e.ts | stamp)]\(R): \(C("1;36"))\($e.type)\(R)\($e | dur_suffix)" ]
        + ( $f | [ to_entries[] | "    \(C("36"))\(.key):\(R) \(.value | qv)" ] )
      ) | join("\n")
  ' | emit_blocks
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

    select(
      ((.event_type // "") | test("^(agents\\.instance\\.open|agents\\.state\\..+|handoffs\\..+|deliveries\\..+|messages\\.(sent|ack))$"))
      or (.payload.module == "telemetry")
    )
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
