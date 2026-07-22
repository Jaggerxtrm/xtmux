#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
SESSION_EVENTS_LIB_ONLY=1 source scripts/test-session-events.sh

cat >"$metadata_file" <<'JSON'
{
  "sessions": [{"sessionId":"$1","sessionName":"pi-events","beadId":"repo-1","repo":"repo","path":"/tmp/repo"}],
  "panes": [{"paneId":"%1","sessionId":"$1","command":"pi","path":"/tmp/repo"}]
}
JSON

fixtures='[
  {"id":"019f8475-0001-7000-8000-000000000001","issue_id":"repo-1","event_type":"created","actor":"tester","old_value":"","new_value":"","comment":null,"created_at":"2026-07-21T13:00:00Z"},
  {"id":"019f8475-0002-7000-8000-000000000002","issue_id":"repo-1","event_type":"claimed","actor":"tester","old_value":"{\"status\":\"open\"}","new_value":"{\"status\":\"in_progress\"}","comment":null,"created_at":"2026-07-21T13:00:01Z"},
  {"id":"019f8475-0003-7000-8000-000000000003","issue_id":"repo-1","event_type":"updated","actor":"tester","old_value":"{}","new_value":"{\"notes\":\"done\"}","comment":null,"created_at":"2026-07-21T13:00:02Z"},
  {"id":"019f8475-0004-7000-8000-000000000004","issue_id":"repo-1","event_type":"closed","actor":"tester","old_value":"","new_value":"done","comment":null,"created_at":"2026-07-21T13:00:03Z"},
  {"id":"019f8475-0005-7000-8000-000000000005","issue_id":"repo-1","event_type":"reopened","actor":"tester","old_value":"{\"status\":\"closed\"}","new_value":"{\"status\":\"open\"}","comment":null,"created_at":"2026-07-21T13:00:04Z"},
  {"id":"019f8475-0006-7000-8000-000000000006","issue_id":"repo-1","event_type":"status_changed","actor":"tester","old_value":"{\"status\":\"open\"}","new_value":"{\"status\":\"blocked\"}","comment":null,"created_at":"2026-07-21T13:00:05Z"}
]'

normalized="$(jq -c '.[]' <<<"$fixtures" | normalize_beads /tmp/repo repo)"
jq -e -s '
  map(.type) == ["bd.created", "bd.claimed", "bd.updated", "bd.closed", "bd.reopened", "bd.status_changed"]
  and all(.[]; .source == "beads" and .session.id == "$1" and .pane.id == "%1" and .pane.agent == "pi")
  and all(.[];
    .event.schema_version == "xtrm.beads.lifecycle-event.v1"
    and .event.source == "beads.events"
    and .event.occurred_at_ms == .ts
    and .event.timestamp_source == "uuidv7"
    and .event.actor == "tester")
  and (.[1].event.old_value.status == "open" and .[1].event.new_value.status == "in_progress")
' <<<"$normalized" >/dev/null

json_output=1
long_line="$(head -n 1 <<<"$normalized" | jq -c '.event.payload = ("x" * 10000)')"
serialized="$({ render <<<"$long_line" & render <<<"$long_line" & wait; })"
jq -e -s 'length == 2' <<<"$serialized" >/dev/null

json_output=0
use_color=false
human="$(render <<<"$(head -n 1 <<<"$normalized")")"
# Archon-shaped block: `LEVEL [ts]: type` header + indented `key: "value"` fields.
[[ "$human" == *']: bd.created'* ]]
[[ "$human" == *'session: "repo/pi-events"'* ]]
[[ "$human" == *'pane: "%1"'* ]]
[[ "$human" == *'agent: "pi"'* ]]
[[ "$human" == *'bead: "repo-1"'* ]]
[[ "$human" == *'actor: "tester"'* ]]

printf 'session event tests passed\n'
