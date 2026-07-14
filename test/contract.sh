#!/usr/bin/env bash
# xtmux contract tests. run: ./test/contract.sh  (regen: --regen)
set -u
# xtmux-3xs.31: picker now defaults to V2. Contract tests exercise the V1
# byte-format explicitly (goldens are V1); force V1 for the whole suite.
# Sub-tests that need V2 set XTMUX_OBS_V2 themselves.
export XTMUX_OBS_V2=0

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
GOLDEN="$HERE/golden"
STATUS="$ROOT/scripts/git-pane-status.sh"
PICKER="$ROOT/bin/tmux-session-picker"
AGENT_STATE="$ROOT/scripts/agent-state.sh"
. "$HERE/lib/fixtures.sh"

# ok/nok/assert_eq/assert_golden live in lib/harness.sh. They record to a FILE,
# not to shell variables: several suites below run inside `( ... )` subshells
# (to scope a `tmux()` override), and variable counters silently lose every
# result a subshell produces. See lib/harness.sh, and test/harness-selftest.sh
# which proves a subshell failure still fails the suite.
. "$HERE/lib/harness.sh"
snapshot() { cp "$2" "$GOLDEN/$1.golden"; printf '  \033[36msnap\033[0m %s\n' "$1"; }

REGEN=0
[ "${1:-}" = "--regen" ] && REGEN=1

# normalize <text> — replace the volatile WORK temp path with a stable token
# so goldens are reproducible across runs (temp dir name changes each run).
norm() {
  local t="$1"
  printf '%s' "$t" | sed "s#${WORK}#/XTMUX_WORK#g"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$GOLDEN"
harness_init "$WORK/results.tsv"

echo "== grouping helper contract =="
fn_file="$WORK/picker-functions.sh"
awk '/^case "\$\{1:-\}" in/{exit} {print}' "$PICKER" > "$fn_file"
# shellcheck source=/dev/null
. "$fn_file"
# sourcing the picker imports its strict mode; contract.sh intentionally uses
# only set -u so pipeline probes don't fail on benign SIGPIPE from head/grep.
set +e
set +o pipefail
set -u
mkdir -p "$WORK/repo/.git" "$WORK/repo/.xtrm/worktrees/wt/sub" "$WORK/repo/.worktrees/wt"
group_root_for_path "$WORK/repo/.xtrm/worktrees/wt/sub" "$WORK/repo/.xtrm/worktrees/wt"; assert_eq "group: .xtrm worktree under parent repo" "$WORK/repo" "$REPLY"
group_root_for_path "$WORK/repo/.worktrees/wt" "$WORK/repo/.worktrees/wt"; assert_eq "group: .worktrees worktree under parent repo" "$WORK/repo" "$REPLY"
group_root_for_path "$WORK/other" "$WORK/other"; assert_eq "group: normal root unchanged" "$WORK/other" "$REPLY"

echo
echo "== idle badge contract =="
idle_plain() { printf '%s' "$1" | sed -E $'s/\x1b\[[0-9;]*m//g'; }
now_epoch=100000
idle_badge $((now_epoch - 30)) "$now_epoch"; assert_eq "idle badge: sub-minute" "[idle <1m]" "$(idle_plain "$REPLY")"
idle_badge $((now_epoch - 12 * 60)) "$now_epoch"; assert_eq "idle badge: minutes" "[idle 12m]" "$(idle_plain "$REPLY")"
idle_badge $((now_epoch - 2 * 3600)) "$now_epoch"; idle_rendered="$(idle_plain "$REPLY")"; idle_stale="$IDLE_STALE"
assert_eq "idle badge: hours" "[idle 2h]" "$idle_rendered"
assert_eq "idle badge: stale threshold" "1" "$idle_stale"
TMUX_PICKER_STALE_MINS=180 idle_badge $((now_epoch - 2 * 3600)) "$now_epoch"; idle_stale="$IDLE_STALE"; unset TMUX_PICKER_STALE_MINS
assert_eq "idle badge: threshold env" "0" "$idle_stale"

echo
echo "== cache helper contract =="
cache_tmp="$WORK/cachetmp"
cache_path="$cache_tmp/tmux-picker-cache-${UID:-$(id -u)}"
mkdir -p "$cache_path"
touch "$cache_path/git-table"
TMPDIR="$cache_tmp" clear_cache >/dev/null 2>&1
[ ! -e "$cache_path/git-table" ] && ok "clear-cache: removes cache file" || nok "clear-cache: removes cache file"
TMPDIR="$cache_tmp" clear_cache >/dev/null 2>&1 && ok "clear-cache: no-op when cache dir absent" || nok "clear-cache: no-op when cache dir absent"

if ! command -v tmux >/dev/null 2>&1; then
  printf '  \033[33mskip\033[0m install-hooks isolated server (tmux missing)\n'
else
  hook_sock="xtmux-contract-hooks-$$"
  if command tmux -L "$hook_sock" -f /dev/null new-session -d -s xtmux-hooks 'sleep 100' 2>/dev/null; then
    (
      tmux() { command tmux -L "$hook_sock" "$@"; }
      install_tmux_hooks "/tmp/tmux-session-picker" >/dev/null 2>&1
    )
    hooks="$(command tmux -L "$hook_sock" show-hooks -g 2>/dev/null)"
    hook_ok=1
    for event in session-created session-closed window-linked window-unlinked; do
      printf '%s\n' "$hooks" | grep -F "$event[90] run-shell \"/tmp/tmux-session-picker clear-cache\"" >/dev/null || hook_ok=0
    done
    [ "$hook_ok" = 1 ] && ok "install-hooks: lifecycle hooks at fixed indexes" || nok "install-hooks: lifecycle hooks at fixed indexes"
    command tmux -L "$hook_sock" kill-server >/dev/null 2>&1 || true
  else
    printf '  \033[33mskip\033[0m install-hooks isolated server (tmux unavailable)\n'
  fi
fi

echo
echo "== filter spec contract =="
# parse_filter sets FF_* globals (attention preset + content clauses, ANDed)
parse_filter "";                 assert_eq "parse: empty -> all"        "all"      "$FF_ATTN"
parse_filter "all";              assert_eq "parse: all preset"          "all"      "$FF_ATTN"
parse_filter "waiting";          assert_eq "parse: waiting preset"      "waiting"  "$FF_ATTN"
parse_filter "running";          assert_eq "parse: running preset"      "running"  "$FF_ATTN"
parse_filter "repo:xt";          assert_eq "parse: repo clause"         "xt"       "$FF_REPO"
parse_filter "branch:main";      assert_eq "parse: branch clause"       "main"     "$FF_BRANCH"
parse_filter "cmd:pi";           assert_eq "parse: cmd clause"          "pi"       "$FF_CMD"
parse_filter "grep:hi there";    assert_eq "parse: grep keeps spaces"   "hi there" "$FF_GREP"
parse_filter "repo:a,cmd:pi";    assert_eq "parse: compose repo"        "a"        "$FF_REPO";  assert_eq "parse: compose cmd" "pi" "$FF_CMD"
parse_filter "bogus:x,running";  assert_eq "parse: unknown ignored, attn kept" "running" "$FF_ATTN"
# classify_pane_cmd: bun first, then @agent_state, then shell binaries
classify_pane_cmd bun "";           assert_eq "classify: bun"            "bun"    "$REPLY"
classify_pane_cmd bash "";          assert_eq "classify: shell"          "shell"  "$REPLY"
classify_pane_cmd node "running";   assert_eq "classify: state->agent"   "agent"  "$REPLY"
classify_pane_cmd zsh "needs-input";assert_eq "classify: shell+state->agent" "agent" "$REPLY"
classify_pane_cmd vim "";           assert_eq "classify: other"          "other"  "$REPLY"
agent_meta_value "-"; assert_eq "agent meta: dash -> empty" "" "$REPLY"
agent_meta_value $'task\tline'; assert_eq "agent meta: strips tabs" "task line" "$REPLY"
agent_meta_label "xtmux-mux.1" "standardize metadata" "orch"; meta_plain="$(idle_plain "$REPLY")"
case "$meta_plain" in *"bead:xtmux-mux.1"*"task:standardize metadata"*"from:orch"*) ok "agent meta: label includes bead task parent" ;; *) nok "agent meta: label includes bead task parent" ;; esac
empty_bead_summary="$(bead_preview_summary "$ROOT" "")"; [ -z "$empty_bead_summary" ] && ok "bead preview: missing metadata is empty" || nok "bead preview: missing metadata is empty"
if command -v bd >/dev/null 2>&1; then
  valid_bead_summary="$(bead_preview_summary "$ROOT" "xtmux-mux.1")"; case "$valid_bead_summary" in *"bead-context xtmux-mux.1"*"xtmux-mux.1"*) ok "bead preview: valid bead summary" ;; *) nok "bead preview: valid bead summary" ;; esac
  invalid_bead_summary="$(bead_preview_summary "$ROOT" "xtmux-no-such-bead")"; case "$invalid_bead_summary" in *"bead-context xtmux-no-such-bead (not found"*) ok "bead preview: invalid bead degrades" ;; *) nok "bead preview: invalid bead degrades" ;; esac
else
  printf '  \033[33mskip\033[0m bead preview summaries (bd not on PATH)\n'
fi
extract_bead_id "session xtmux-rib.16 work"; assert_eq "bead derive: extract dot child id" "xtmux-rib.16" "$REPLY"
if command -v bd >/dev/null 2>&1; then
  derive_bead_id "agent-xtmux-rib.16" "$WORK/nope" ""; assert_eq "bead derive: from session name" "xtmux-rib.16" "$REPLY"
else
  printf '  \033[33mskip\033[0m bead derive from session name (bd not on PATH)\n'
fi
derive_bead_id "agent" "$WORK/.xtrm/worktrees/xtmux-mux.6-demo" "$WORK"; assert_eq "bead derive: from path convention" "xtmux-mux.6" "$REPLY"
derive_bead_id "feature-123" "$WORK/feature-123" ""; assert_eq "bead derive: avoids loose numeric slug" "" "$REPLY"
nonrepo_git_preview="$(git_worktree_preview "$WORK/no-such-repo")"; [ -z "$nonrepo_git_preview" ] && ok "git preview: non-repo degrades empty" || nok "git preview: non-repo degrades empty"
mk_repo "$WORK/preview-dirty"
add_clean "$WORK/preview-dirty" "dirty.txt" "base"
add_modified "$WORK/preview-dirty" "dirty.txt" "changed"
dirty_git_preview="$(git_worktree_preview "$WORK/preview-dirty")"
case "$dirty_git_preview" in *"git-worktree"*"dirty=1"*"diff-stat"*"dirty.txt"*) ok "git preview: dirty count + diff stat" ;; *) nok "git preview: dirty count + diff stat" ;; esac
# __repo_matches: case-insensitive substring on basename
__repo_matches "/x/MyRepo" "myrepo" && ok "repo match: case-insensitive" || nok "repo match: case-insensitive"
__repo_matches "/x/myrepo" "repo"   && ok "repo match: substring"        || nok "repo match: substring"
__repo_matches "/x/other"  "myrepo" && nok "repo match: false positive"  || ok "repo match: no false positive"
__repo_matches "" "x"               && nok "repo match: empty root"      || ok "repo match: empty root rejects"
# branch_from_root_status: REPO <icon> BRANCH ... (nerd + ascii icon)
br_nerd=$'repo \ue0a0 main';  branch_from_root_status "$br_nerd";  assert_eq "branch: nerd icon"  "main"   "$REPLY"
br_ascii=$'repo br feat-x';   branch_from_root_status "$br_ascii"; assert_eq "branch: ascii icon" "feat-x" "$REPLY"
branch_from_root_status "singleword";                              assert_eq "branch: malformed -> empty" "" "$REPLY"
# filter state file lives OUTSIDE the cache dir so clear-cache (lifecycle hooks)
# does not reset the active content filter.
filter_state_file; _fsf="$REPLY"; cache_dir; _cd="$REPLY"
case "$_fsf" in
  *tmux-picker-state-*/filter) [ "${_fsf#"$_cd"}" = "$_fsf" ] && ok "filter_state_file: outside cache dir (survives clear-cache)" || nok "filter_state_file: must not be under cache dir ($_fsf)" ;;
  *) nok "filter_state_file: unexpected path ($_fsf)" ;;
esac
# list mode state defaults to expanded and toggles/persists independently.
_old_tmpdir="${TMPDIR-}"
TMPDIR="$WORK/list-mode-state"
read_list_mode; assert_eq "list mode: default expanded" "expanded" "$REPLY"
write_list_mode sessions-only; read_list_mode; assert_eq "list mode: writes sessions-only" "sessions-only" "$REPLY"
toggle_list_mode; read_list_mode; assert_eq "list mode: toggles back to expanded" "expanded" "$REPLY"
if [ -n "$_old_tmpdir" ]; then TMPDIR="$_old_tmpdir"; else unset TMPDIR; fi
parse_wait_duration 30s; assert_eq "wait-agent: parse seconds" "30" "$REPLY"
parse_wait_duration 2m; assert_eq "wait-agent: parse minutes" "120" "$REPLY"
agent_state_is_working running && ok "wait-agent: running is working" || nok "wait-agent: running is working"
agent_state_is_working working && ok "wait-agent: working alias is working" || nok "wait-agent: working alias is working"
agent_state_is_working idle && nok "wait-agent: idle is not working" || ok "wait-agent: idle is not working"
(
  calls_file="$WORK/wait-agent-calls"
  printf '0' > "$calls_file"
  tmux() {
    case "$1" in
      display-message)
        case "${*: -1}" in
          '#{pane_id}') printf '%%mock\n' ;;
          '#{pane_current_command}') printf 'bash\n' ;;
          *) printf '%%mock\n' ;;
        esac
        ;;
      show-options)
        calls="$(cat "$calls_file")"; calls=$((calls + 1)); printf '%s' "$calls" > "$calls_file"
        if [ "$calls" -lt 2 ]; then printf 'running\n'; else printf 'idle\n'; fi
        ;;
      capture-pane) printf '' ;;
      *) return 1 ;;
    esac
  }
  sleep() { :; }
  out="$(wait_agent %mock --timeout 5s --interval 0s 2>/dev/null)"
  case "$out" in *"pane=%mock"*"state=idle"*) exit 0 ;; *) printf '%s\n' "$out" >&2; exit 1 ;; esac
) && ok "wait-agent: mocked running -> idle" || nok "wait-agent: mocked running -> idle"
(
  calls_file="$WORK/wait-agent-default-calls"
  printf '0' > "$calls_file"
  tmux() {
    case "$1" in
      display-message)
        case "${*: -1}" in '#{pane_id}') printf '%%mock\n' ;; *) printf 'bash\n' ;; esac
        ;;
      show-options) calls="$(cat "$calls_file")"; calls=$((calls + 1)); printf '%s' "$calls" > "$calls_file"; printf 'done\n' ;;
      *) return 1 ;;
    esac
  }
  out="$(wait_agent %mock --timeout 5s --interval 0s 2>/dev/null)"
  [ "$(cat "$calls_file")" -eq 1 ] && case "$out" in *"state=done"*) exit 0 ;; esac
  exit 1
) && ok "wait-agent: default terminal is immediate" || nok "wait-agent: default terminal is immediate"
(
  calls_file="$WORK/wait-agent-transition-calls"
  printf '0' > "$calls_file"
  tmux() {
    case "$1" in
      display-message)
        case "${*: -1}" in
          '#{pane_id}') printf '%%mock\n' ;;
          '#{pane_current_command}') printf 'bash\n' ;;
          *) printf '%%mock\n' ;;
        esac
        ;;
      show-options)
        calls="$(cat "$calls_file")"; calls=$((calls + 1)); printf '%s' "$calls" > "$calls_file"
        case "$calls" in 1) printf 'done\n' ;; 2) printf 'running\n' ;; *) printf 'done\n' ;; esac
        ;;
      capture-pane) printf '' ;;
      *) return 1 ;;
    esac
  }
  sleep() { :; }
  out="$(wait_agent %mock --wait-for-transition --timeout 5s --interval 0s 2>/dev/null)"
  [ "$(cat "$calls_file")" -eq 3 ] && case "$out" in *"state=done"*) exit 0 ;; esac
  printf '%s\n' "$out" >&2; exit 1
) && ok "wait-agent: terminal -> working -> terminal" || nok "wait-agent: terminal -> working -> terminal"
(
  calls_file="$WORK/monitor-transition-calls"
  printf '0' > "$calls_file"
  tmux() {
    case "$1" in
      show-options)
        calls="$(cat "$calls_file")"; calls=$((calls + 1)); printf '%s' "$calls" > "$calls_file"
        case "$calls" in 1) printf 'done\n' ;; 2) printf 'running\n' ;; *) printf 'done\n' ;; esac
        ;;
      *) return 1 ;;
    esac
  }
  sleep() { :; }
  obs_v2_mode() { REPLY=off; }
  log_event() { :; }
  monitor_write_record() { :; }
  monitor_run m1 target %mock 0 0 0 1 done >/dev/null
  [ "$(cat "$calls_file")" -eq 3 ]
) && ok "monitor-agent: terminal -> working -> terminal" || nok "monitor-agent: terminal -> working -> terminal"
(
  calls_file="$WORK/monitor-v2-transition-calls"; events_file="$WORK/monitor-v2-transition-events"
  printf '0' > "$calls_file"; : > "$events_file"
  tmux() {
    case "$1" in
      show-options)
        calls="$(cat "$calls_file")"; calls=$((calls + 1)); printf '%s' "$calls" > "$calls_file"
        case "$calls" in 1) printf 'done\n' ;; 2) printf 'running\n' ;; *) printf 'done\n' ;; esac
        ;;
      *) return 1 ;;
    esac
  }
  sleep() { :; }
  obs_v2_mode() { REPLY=on; }
  obs_call() { printf '%s\n' "$*" >> "$events_file"; }
  log_event() { :; }
  monitor_write_record() { :; }
  monitor_run m1 target %mock 0 0 0 1 done >/dev/null
  [ "$(cat "$calls_file")" -eq 3 ] && grep -F 'monitor terminate --id m1 --status done' "$events_file" >/dev/null
) && ok "monitor-agent: V2 waits for transition" || nok "monitor-agent: V2 waits for transition"
safe_pointer_payload "leggi /tmp/xtmux-task.txt e seguilo" && ok "safe-send-pointer: accepts /tmp pointer" || nok "safe-send-pointer: accepts /tmp pointer"
safe_pointer_payload "/compact" && ok "safe-send-pointer: accepts slash command" || nok "safe-send-pointer: accepts slash command"
safe_pointer_payload $'leggi /tmp/x\nseguilo' >/dev/null 2>&1 && nok "safe-send-pointer: rejects multiline" || ok "safe-send-pointer: rejects multiline"
safe_pointer_payload 'leggi /tmp/x $(rm -rf nope)' >/dev/null 2>&1 && nok "safe-send-pointer: rejects command substitution" || ok "safe-send-pointer: rejects command substitution"
safe_pointer_payload 'do this directly' >/dev/null 2>&1 && nok "safe-send-pointer: rejects non-pointer payload" || ok "safe-send-pointer: rejects non-pointer payload"
(
  tmux() {
    case "$1" in
      display-message) printf '%%mock\n' ;;
      show-options) printf 'running\n' ;;
      capture-pane) printf '' ;;
      send-keys) printf 'should-not-send\n' >&2; return 99 ;;
      *) return 1 ;;
    esac
  }
  safe_send_pointer %mock "leggi /tmp/task.txt e seguilo" >/dev/null 2>/dev/null
  [ "$?" -eq 75 ]
) && ok "safe-send-pointer: rejects working target" || nok "safe-send-pointer: rejects working target"
(
  tmux() {
    case "$1" in
      display-message) printf '%%mock\n' ;;
      show-options) printf 'idle\n' ;;
      capture-pane) printf '' ;;
      send-keys) printf 'should-not-send\n' >&2; return 99 ;;
      *) return 1 ;;
    esac
  }
  out="$(safe_send_pointer %mock "leggi /tmp/task.txt e seguilo" 2>/dev/null)"
  case "$out" in "tmux send-keys -t"*"/tmp/task.txt"*"Enter"*) exit 0 ;; *) printf '%s\n' "$out" >&2; exit 1 ;; esac
) && ok "safe-send-pointer: dry-run prints exact send command" || nok "safe-send-pointer: dry-run prints exact send command"
mk_repo "$WORK/collide-a"
mk_repo "$WORK/collide-b"
(
  tmux() {
    case "$1" in
      list-panes) printf '%s\n' $'s1\ta\t%1\t'"$WORK/collide-a" $'s2\tb\t%2\t'"$WORK/collide-a/sub" $'s3\tc\t%3\t'"$WORK/collide-b" ;;
      *) return 1 ;;
    esac
  }
  mkdir -p "$WORK/collide-a/sub"
  out="$(worktree_collisions)"
  if printf '%s' "$out" | grep -F $'shared-worktree\t'"$WORK/collide-a" >/dev/null && printf '%s' "$out" | grep -F $'\ta,b' >/dev/null; then
    exit 0
  else
    printf '%s\n' "$out" >&2; exit 1
  fi
) && ok "worktree-collisions: detects shared worktree" || nok "worktree-collisions: detects shared worktree"
(
  tmux() {
    case "$1" in
      list-panes) printf '%s\n' $'s1\ta\t%1\t'"$WORK/collide-a" $'s2\tb\t%2\t'"$WORK/collide-b" ;;
      *) return 1 ;;
    esac
  }
  out="$(worktree_collisions)"
  [ -z "$out" ]
) && ok "worktree-collisions: ignores distinct worktrees" || nok "worktree-collisions: ignores distinct worktrees"
(
  dashboard() {
    printf '%s\n' \
      $'dashboard\tmode\texpanded' \
      $'session\ts1\ttmp-agent\trunning\t\t\trepo\tmain\t2\t1\t5m\t'"$WORK/missing-path" \
      $'pane\ts1\ttmp-agent\t%1\trunning\t\t\tclaude\t'"$WORK/missing-path" \
      $'session\ts2\tsp-executor-dead\tdone\t\t\trepo\tmain\t0\t0\t1h\t'"$WORK" \
      $'session\ts3\tgood\tidle\txtmux-mux.8\tclean\trepo\tmain\t0\t0\t1m\t'"$WORK"
  }
  out="$(audit)"
  printf '%s\n' "$out" | grep -F $'audit\tread-only' >/dev/null && \
  printf '%s\n' "$out" | grep -F $'warning\tworking-do-not-kill\ts1' >/dev/null && \
  printf '%s\n' "$out" | grep -F $'warning\tdirty-worktree\ts1' >/dev/null && \
  printf '%s\n' "$out" | grep -F $'warning\tshared-worktree\ts1' >/dev/null && \
  printf '%s\n' "$out" | grep -F $'warning\tagent-pane-without-bead\ts1' >/dev/null && \
  printf '%s\n' "$out" | grep -F $'warning\tnaming-convention\ts1\ttmp-agent' >/dev/null && \
  printf '%s\n' "$out" | grep -F $'cleanup\tmissing-path\ts1' >/dev/null && \
  printf '%s\n' "$out" | grep -F $'cleanup\tstale-specialist\ts2' >/dev/null
) && ok "audit: separates warnings and cleanup candidates" || nok "audit: separates warnings and cleanup candidates"
(
  audit_walk() {
    printf '%s\n' \
      $'audit\tread-only\twarnings-and-cleanup-candidates' \
      $'warning\tz-kind\t$2\tzeta\tpath=/z' \
      $'cleanup\ta-kind\t$1\talpha\tpath=/a'
  }
  obs_v2_mode() { REPLY=on; }
  obs_available() { return 0; }
  obs_call() { :; }
  current_tmux_session_id() { REPLY='$mock'; }
  out="$(audit --stable)"
  [ "$out" = $'audit\tread-only\twarnings-and-cleanup-candidates\ncleanup\ta-kind\t$1\talpha\tpath=/a\nwarning\tz-kind\t$2\tzeta\tpath=/z' ]
) && ok "audit: V2 --stable sorts display only" || nok "audit: V2 --stable sorts display only"
(
  tmux() {
    case "$1" in
      display-message) printf '%%mock\n' ;;
      show-options) printf 'idle\n' ;;
      send-keys) printf 'unexpected-send\n' >&2; return 99 ;;
      set-option) printf 'unexpected-set\n' >&2; return 99 ;;
      *) return 1 ;;
    esac
  }
  hfile="$WORK/handoff.txt"
  out="$(handoff --target %mock --bead xtmux-mux.9 --note 'NO push' --file "$hfile" 2>/dev/null)"
  [ -f "$hfile" ] && grep -F 'contract: bd show xtmux-mux.9' "$hfile" >/dev/null && grep -F 'NO push' "$hfile" >/dev/null && \
  printf '%s\n' "$out" | grep -F $'prompt-file\t'"$hfile" >/dev/null && \
  printf '%s\n' "$out" | grep -F 'safe-send-pointer --yes' >/dev/null && \
  printf '%s\n' "$out" | grep -F 'leggi ' >/dev/null
) && ok "handoff: dry-run writes prompt file and prints safe command" || nok "handoff: dry-run writes prompt file and prints safe command"
(
  tmux() {
    case "$1" in
      display-message) printf '%%mock\n' ;;
      show-options) printf 'running\n' ;;
      send-keys) printf 'unexpected-send\n' >&2; return 99 ;;
      *) return 1 ;;
    esac
  }
  handoff --target %mock --bead xtmux-mux.9 --file "$WORK/handoff-working.txt" >/dev/null 2>/dev/null
  [ "$?" -eq 75 ] && [ ! -e "$WORK/handoff-working.txt" ]
) && ok "handoff: refuses working target before creating prompt" || nok "handoff: refuses working target before creating prompt"
help_text="$(mux_help)"
printf '%s\n' "$help_text" | grep -F 'beads first' >/dev/null && \
printf '%s\n' "$help_text" | grep -F 'never send while working' >/dev/null && \
printf '%s\n' "$help_text" | grep -F 'dashboard sessions-only' >/dev/null && \
printf '%s\n' "$help_text" | grep -F 'audit' >/dev/null && \
printf '%s\n' "$help_text" | grep -F 'Space    mark row' >/dev/null && \
printf '%s\n' "$help_text" | grep -F 'Tab      toggle nesting' >/dev/null && \
  ok "mux-help: includes multiplexing cheatsheet" || nok "mux-help: includes multiplexing cheatsheet"
XTMUX_EVENT_LOG_FILE="$WORK/events.jsonl" log_event test.event pane=%p session=s1 bead=xtmux-team.1 text=$'hello\tworld'
[ -s "$WORK/events.jsonl" ] && grep -F '"type":"test.event"' "$WORK/events.jsonl" >/dev/null && grep -F 'hello\tworld' "$WORK/events.jsonl" >/dev/null && ok "event log: writes escaped JSONL" || nok "event log: writes escaped JSONL"
XTMUX_EVENT_LOG_FILE="$WORK/events.jsonl" log_cli emit custom.event pane=%p session=s1 bead=xtmux-team.2 text=hi >/dev/null
query_out="$(XTMUX_EVENT_LOG_FILE="$WORK/events.jsonl" log_cli query --type custom.event --pane %p --bead xtmux-team.2)"
printf '%s\n' "$query_out" | grep -F '"type":"custom.event"' >/dev/null && ok "log CLI: emit/query filters" || nok "log CLI: emit/query filters"
tail_out="$(XTMUX_EVENT_LOG_FILE="$WORK/events.jsonl" log_cli tail 1)"
printf '%s\n' "$tail_out" | grep -F '"type":"custom.event"' >/dev/null && ok "log CLI: tail" || nok "log CLI: tail"
msg_out="$(XTMUX_EVENT_LOG_FILE="$WORK/events.jsonl" message_send --from orch --to worker --bead xtmux-team.4 --id msg-test --text 'blocked on data')"
printf '%s\n' "$msg_out" | grep -F $'message\tmsg-test\torch\tworker\txtmux-team.4\tblocked on data' >/dev/null && ok "message channel: send prints TSV" || nok "message channel: send prints TSV"
msg_list="$(XTMUX_EVENT_LOG_FILE="$WORK/events.jsonl" message_list --for worker --unacked)"
printf '%s\n' "$msg_list" | grep -F $'message\tmsg-test' >/dev/null && ok "message channel: list unacked" || nok "message channel: list unacked"
XTMUX_EVENT_LOG_FILE="$WORK/events.jsonl" message_ack msg-test --by worker >/dev/null
msg_list2="$(XTMUX_EVENT_LOG_FILE="$WORK/events.jsonl" message_list --for worker --unacked)"
printf '%s\n' "$msg_list2" | grep -F 'msg-test' >/dev/null && nok "message channel: ack hides unacked" || ok "message channel: ack hides unacked"
# xtmux-1hq: unacked column includes human age (Ns/Nm/Nh/Nd)
XTMUX_EVENT_LOG_FILE="$WORK/events.jsonl" message_send --from o --to w2 --bead xtmux-1hq --id msg-age --text 'age check' >/dev/null
age_out="$(XTMUX_EVENT_LOG_FILE="$WORK/events.jsonl" message_list --for w2 --unacked)"
printf '%s\n' "$age_out" | awk -F'\t' '{ print $4 }' | grep -Eq '^[0-9]+[smhd]$' && ok "message channel: unacked shows age column" || nok "message channel: unacked shows age column"
# xtmux-1hq: strict-fail on $N target that does not resolve; lenient on names
if XTMUX_EVENT_LOG_FILE="$WORK/events.jsonl" message_send --to '$99999' --text 'dead' 2>/dev/null; then
  nok "message channel: dead \$N target exits nonzero"
else
  grep -F '"type":"message.failed"' "$WORK/events.jsonl" >/dev/null && ok "message channel: dead \$N target exits nonzero" || nok "message channel: dead \$N target exits nonzero"
fi
# xtmux-1hq: log rotation triggers at size threshold (threshold is checked
# BEFORE write, so we need one seed to cross the line before the trigger send)
rot="$WORK/rot.jsonl"
XTMUX_EVENT_LOG_FILE="$rot" XTMUX_EVENT_LOG_MAX_BYTES=50 message_send --from a --to b --text 'seed' >/dev/null
XTMUX_EVENT_LOG_FILE="$rot" XTMUX_EVENT_LOG_MAX_BYTES=50 message_send --from a --to b --text 'triggers rotate' >/dev/null
[ -f "$rot.1" ] && ok "message channel: log rotation on size threshold" || nok "message channel: log rotation on size threshold"
grep -F '"turn_end"' extensions/pi-agent-state.ts >/dev/null && grep -F 'agent.turn.done' extensions/pi-agent-state.ts >/dev/null && grep -F 'last_message=' extensions/pi-agent-state.ts >/dev/null && ok "pi extension: publishes turn done" || nok "pi extension: publishes turn done"
grep -F '"--wait-for-transition"' extensions/pi-auto-monitor.ts >/dev/null && grep -F '"--wait-for-transition"' hooks/claude/auto-monitor-on-send.mjs >/dev/null && ok "auto-monitor: waits for next transition" || nok "auto-monitor: waits for next transition"
# The auto-monitor hooks shell out to bd; without it on PATH they cannot run.
if command -v bd >/dev/null 2>&1; then
json_picker="$WORK/json-picker"
cat > "$json_picker" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  monitor-list) printf '[]\n' ;;
  monitor-agent) printf '{"monitorId":"contract-monitor","target":"%s"}\n' "$2" ;;
  *) exit 2 ;;
esac
STUB
chmod +x "$json_picker"
# xtmux-3xs.23: three-hook Stop-block coordination — send touches pending, wait-agent consumes it, drain-stop blocks/allows.
(
  set -e
  export XDG_RUNTIME_DIR="$WORK"
  amdir="$WORK/xtmux-auto-monitor"; rm -rf "$amdir"
  # xtmux-3xs.30: hook now precheck-checks tmux has-session; stub tmux to accept every target.
  stubdir="$WORK/stub-tmux-23"; mkdir -p "$stubdir"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$stubdir/tmux"
  chmod +x "$stubdir/tmux"
  export PATH="$stubdir:$PATH"
  # 1. Reworded send touches pending from JSON output, independent of command text.
  echo '{"tool_name":"Bash","tool_input":{"command":"xtmux send --format changed --recipient differently-quoted"},"tool_response":{"exitCode":0,"stdout":"{\"messageKey\":\"m99\",\"duplicate\":false,\"senderId\":\"orchestrator\",\"recipientId\":\"xtmux:99\"}"}}' \
    | XTMUX_PICKER="$json_picker" node hooks/claude/auto-monitor-on-send.mjs >/dev/null 2>&1
  [ -f "$amdir/xtmux:99_pending" ] || exit 1
  # 2. Drain-stop blocks with decision=block.
  out="$(echo '{"stop_hook_active":false}' | node hooks/claude/auto-monitor-drain-stop.mjs)"
  echo "$out" | grep -q '"decision":"block"' || exit 2
  echo "$out" | grep -q 'wait-agent xtmux:99' || exit 3
  # 3. Wait-agent invocation clears pending.
  echo '{"tool_input":{"command":"tmux-session-picker wait-agent xtmux:99 --wait-for-transition"}}' \
    | node hooks/claude/auto-monitor-consumed.mjs
  [ ! -f "$amdir/xtmux:99_pending" ] || exit 4
  # 4. Drain-stop now allows (silent).
  out="$(echo '{"stop_hook_active":false}' | node hooks/claude/auto-monitor-drain-stop.mjs)"
  [ -z "$out" ] || exit 5
  # 5. Loop guard: stop_hook_active=true never blocks even with pending.
  touch "$amdir/xtmux:99_pending"
  out="$(echo '{"stop_hook_active":true}' | node hooks/claude/auto-monitor-drain-stop.mjs)"
  [ -z "$out" ] || exit 6
  # 6. TTL prunes stale.
  touch -d '2 hours ago' "$amdir/stale_pending"
  echo '{"stop_hook_active":false}' | node hooks/claude/auto-monitor-drain-stop.mjs >/dev/null
  [ ! -f "$amdir/stale_pending" ] || exit 7
) && ok "auto-monitor: three-hook Stop-block coordination (.23)" || nok "auto-monitor: three-hook Stop-block coordination (.23)"
# xtmux-3xs.29: XTMUX_AUTO_MONITOR_SKIP_TARGETS skips both marker + monitor spawn.
(
  set -e
  export XDG_RUNTIME_DIR="$WORK"
  amdir="$WORK/xtmux-auto-monitor"; rm -rf "$amdir"
  # xtmux-3xs.30: hook precheck-checks tmux has-session; stub tmux to accept every target.
  stubdir="$WORK/stub-tmux-29"; mkdir -p "$stubdir"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$stubdir/tmux"
  chmod +x "$stubdir/tmux"
  export PATH="$stubdir:$PATH"
  # send to alice WITHOUT skip → marker touched.
  echo '{"tool_name":"Bash","tool_input":{"command":"reworded send"},"tool_response":{"exitCode":0,"stdout":"{\"messageKey\":\"alice-msg\",\"duplicate\":false,\"senderId\":\"orchestrator\",\"recipientId\":\"alice\"}"}}' \
    | XTMUX_PICKER="$json_picker" node hooks/claude/auto-monitor-on-send.mjs >/dev/null 2>&1
  [ -f "$amdir/alice_pending" ] || exit 1
  rm -rf "$amdir"
  # send to alice WITH skip → no marker.
  echo '{"tool_name":"Bash","tool_input":{"command":"reworded send"},"tool_response":{"exitCode":0,"stdout":"{\"messageKey\":\"alice-msg\",\"duplicate\":false,\"senderId\":\"orchestrator\",\"recipientId\":\"alice\"}"}}' \
    | XTMUX_PICKER="$json_picker" XTMUX_AUTO_MONITOR_SKIP_TARGETS="alice:bob" node hooks/claude/auto-monitor-on-send.mjs >/dev/null 2>&1
  [ ! -f "$amdir/alice_pending" ] || exit 2
  # send to real target with skip set for others → still touches.
  echo '{"tool_name":"Bash","tool_input":{"command":"reworded send"},"tool_response":{"exitCode":0,"stdout":"{\"messageKey\":\"real-msg\",\"duplicate\":false,\"senderId\":\"orchestrator\",\"recipientId\":\"real:1.2\"}"}}' \
    | XTMUX_PICKER="$json_picker" XTMUX_AUTO_MONITOR_SKIP_TARGETS="alice:bob" node hooks/claude/auto-monitor-on-send.mjs >/dev/null 2>&1
  [ -f "$amdir/real:1.2_pending" ] || exit 3
) && ok "auto-monitor: SKIP_TARGETS bypass (.29)" || nok "auto-monitor: SKIP_TARGETS bypass (.29)"
# xtmux-3xs.30: tmux has-session precheck — phantom target skipped even without env.
(
  set -e
  export XDG_RUNTIME_DIR="$WORK"
  amdir="$WORK/xtmux-auto-monitor"; rm -rf "$amdir"
  # Stub tmux that exits 1 for our fake target (has-session -t phantom-30 returns 1).
  stubdir="$WORK/stub-tmux-30"; mkdir -p "$stubdir"
  cat > "$stubdir/tmux" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "has-session" ] && [ "$2" = "-t" ] && [ "$3" = "phantom-30" ]; then
  exit 1
fi
if [ "$1" = "has-session" ] && [ "$2" = "-t" ] && [ "$3" = "realone-30" ]; then
  exit 0
fi
exit 0
STUB
  chmod +x "$stubdir/tmux"
  # phantom target → no marker.
  echo '{"tool_name":"Bash","tool_input":{"command":"reworded send"},"tool_response":{"exitCode":0,"stdout":"{\"messageKey\":\"phantom-msg\",\"duplicate\":false,\"senderId\":\"orchestrator\",\"recipientId\":\"phantom-30\"}"}}' \
    | PATH="$stubdir:$PATH" XTMUX_PICKER="$json_picker" node hooks/claude/auto-monitor-on-send.mjs >/dev/null 2>&1
  [ ! -f "$amdir/phantom-30_pending" ] || exit 1
  # real target → marker.
  echo '{"tool_name":"Bash","tool_input":{"command":"reworded send"},"tool_response":{"exitCode":0,"stdout":"{\"messageKey\":\"realone-msg\",\"duplicate\":false,\"senderId\":\"orchestrator\",\"recipientId\":\"realone-30\"}"}}' \
    | PATH="$stubdir:$PATH" XTMUX_PICKER="$json_picker" node hooks/claude/auto-monitor-on-send.mjs >/dev/null 2>&1
  [ -f "$amdir/realone-30_pending" ] || exit 2
) && ok "auto-monitor: tmux has-session precheck (.30)" || nok "auto-monitor: tmux has-session precheck (.30)"
else
  printf '  \033[33mskip\033[0m auto-monitor hook contracts .23/.29/.30 (bd not on PATH)\n'
fi
# xtmux-3xs.25: log-query shadow-diff records divergence when V1 JSONL differs from V2 SQL.
(
  set -e
  self="$PICKER"
  ldb="$WORK/logshadow.db"
  llog="$WORK/logshadow-events.jsonl"
  # V1 log has an event that V2 SQL event_journal does NOT (V2 unpopulated).
  XTMUX_EVENT_LOG_FILE="$llog" log_cli_emit lqs.probe key1=v1 >/dev/null
  XTMUX_OBS_V2=shadow XTMUX_OBS_DB_PATH="$ldb" XTMUX_EVENT_LOG_FILE="$llog" \
    log_cli_query --type lqs.probe >/dev/null
  XTMUX_OBS_DB_PATH="$ldb" "$ROOT/bin/xtmux-obs" shadow-summary 2>/dev/null \
    | grep -q '"command": "log-query"' || exit 1
) && ok "shadow-mode: log-query divergence detection (.25)" || nok "shadow-mode: log-query divergence detection (.25)"
# xtmux-3xs.12: shadow-mode records divergence when V1 and V2 output disagree.
(
  set -e
  # Override $self so obs_available resolves the real picker/binary tree
  # (contract sources functions into a temp file, breaking the ${self%/bin/*} inference).
  self="$PICKER"
  sh_db="$WORK/shadow.db"
  sh_log="$WORK/shadow-events.jsonl"
  # 1. Divergence: V1 has a message in JSONL, V2 SQLite is empty. shadow message-list must detect.
  XTMUX_EVENT_LOG_FILE="$sh_log" \
    message_send --from src --to dst --text 'v1 only' --id m1 >/dev/null
  XTMUX_OBS_V2=shadow XTMUX_OBS_DB_PATH="$sh_db" XTMUX_EVENT_LOG_FILE="$sh_log" \
    message_list --for dst --unacked >/dev/null
  summary="$(XTMUX_OBS_DB_PATH="$sh_db" "$ROOT/bin/xtmux-obs" shadow-summary 2>/dev/null)"
  echo "$summary" | grep -q '"command": "message-list"' || { printf '%s\n' "$summary" >&2; exit 1; }
  # 2. shadow-record CLI verb path: direct call records without failing.
  XTMUX_OBS_DB_PATH="$sh_db" "$ROOT/bin/xtmux-obs" shadow-record --domain probe --command probe --diff-kind content --v1-snippet a --v2-snippet b
  XTMUX_OBS_DB_PATH="$sh_db" "$ROOT/bin/xtmux-obs" shadow-summary | grep -q '"domain": "probe"' || exit 2
) && ok "shadow-mode: divergence detection + shadow-record CLI (.12)" || nok "shadow-mode: divergence detection + shadow-record CLI (.12)"
tele_repo="$WORK/telemetry-repo"; mkdir -p "$tele_repo"; (cd "$tele_repo" && git init -q && git config user.email t@example.invalid && git config user.name Test && printf 'x\n' > a.txt && git add a.txt && git commit -q -m init)
tele_log="$WORK/telemetry-events.jsonl"
(cd "$tele_repo" && XTMUX_EVENT_LOG_FILE="$tele_log" telemetry_run git -- status --short >/dev/null)
grep -F '"type":"git.command"' "$tele_log" >/dev/null && grep -F '"tool":"git"' "$tele_log" >/dev/null && ok "telemetry: git wrapper logs command" || nok "telemetry: git wrapper logs command"
bash -n scripts/xtmux-monitor.sh && scripts/xtmux-monitor.sh --help | grep -F -- '--full' >/dev/null && ok "xtmux-monitor: help and syntax" || nok "xtmux-monitor: help and syntax"
mon_s="xtmux-monitor-contract-$$"
mon_log="$WORK/monitor-events.jsonl"
scripts/xtmux-monitor.sh --session "$mon_s" --log "$mon_log" --no-attach --kill-existing >/dev/null
if tmux has-session -t "$mon_s" 2>/dev/null && [ "$(tmux list-panes -t "$mon_s" 2>/dev/null | wc -l | tr -d ' ')" -ge 3 ] && [ -f "$mon_log" ]; then
  ok "xtmux-monitor: creates monitoring layout"
else
  nok "xtmux-monitor: creates monitoring layout"
fi
tmux kill-session -t "$mon_s" 2>/dev/null || true

echo
echo "== git-pane-status.sh contract =="

# clean repo on main
mk_repo "$WORK/clean"
add_clean "$WORK/clean" "src/a.txt" "a"
out="$("$STATUS" "" "$WORK/clean" 2>/dev/null)"; printf '%s' "$(norm "$out")" >"$WORK/clean.act"
if [ "$REGEN" = 1 ]; then snapshot status-clean "$WORK/clean.act"; else assert_golden "clean repo" "$WORK/clean.act" "$GOLDEN/status-clean.golden"; fi

# dirty: staged + modified + untracked
mk_repo "$WORK/dirty"
add_clean "$WORK/dirty" "kept.txt" "x"
add_modified "$WORK/dirty" "kept.txt" "changed"
add_staged "$WORK/dirty" "new.txt" "n"
add_untracked "$WORK/dirty" "junk.txt" "j"
out="$("$STATUS" "" "$WORK/dirty" 2>/dev/null)"; printf '%s' "$(norm "$out")" >"$WORK/dirty.act"
if [ "$REGEN" = 1 ]; then snapshot status-dirty "$WORK/dirty.act"; else assert_golden "dirty repo" "$WORK/dirty.act" "$GOLDEN/status-dirty.golden"; fi

# stash present
mk_repo "$WORK/stash"
add_clean "$WORK/stash" "base.txt" "b"
add_modified "$WORK/stash" "base.txt" "stashed"
add_stash "$WORK/stash"
out="$("$STATUS" "" "$WORK/stash" 2>/dev/null)"; printf '%s' "$(norm "$out")" >"$WORK/stash.act"
if [ "$REGEN" = 1 ]; then snapshot status-stash "$WORK/stash.act"; else assert_golden "stash present" "$WORK/stash.act" "$GOLDEN/status-stash.golden"; fi

# ahead of upstream
mk_repo "$WORK/ahead"
add_clean "$WORK/ahead" "x.txt" "1"
make_ahead "$WORK/ahead" 2
out="$("$STATUS" "" "$WORK/ahead" 2>/dev/null)"; printf '%s' "$(norm "$out")" >"$WORK/ahead.act"
if [ "$REGEN" = 1 ]; then snapshot status-ahead "$WORK/ahead.act"; else assert_golden "ahead of upstream" "$WORK/ahead.act" "$GOLDEN/status-ahead.golden"; fi

# non-repo fallback
mkdir -p "$WORK/notrepo"
out="$("$STATUS" "" "$WORK/notrepo" 2>/dev/null)"; printf '%s' "$(norm "$out")" >"$WORK/notrepo.act"
if [ "$REGEN" = 1 ]; then snapshot status-notrepo "$WORK/notrepo.act"; else assert_golden "non-repo fallback" "$WORK/notrepo.act" "$GOLDEN/status-notrepo.golden"; fi

# TMUX_GIT_TOPLEVEL fast path == standalone
fast="$(TMUX_GIT_TOPLEVEL="$WORK/clean" "$STATUS" "" "$WORK/clean" 2>/dev/null)"
standalone="$("$STATUS" "" "$WORK/clean" 2>/dev/null)"
if [ "$REGEN" = 0 ]; then assert_eq "TMUX_GIT_TOPLEVEL fast path == standalone" "$standalone" "$fast"; fi


echo
echo "== agent-state.sh contract =="

if env -u TMUX_PANE "$AGENT_STATE" running >/dev/null 2>&1; then
  ok "agent-state: no-op outside tmux"
else
  nok "agent-state: no-op outside tmux"
fi

if "$AGENT_STATE" nope >/dev/null 2>&1; then
  nok "agent-state: invalid state exits non-zero"
else
  ok "agent-state: invalid state exits non-zero"
fi

if ! tmux info >/dev/null 2>&1; then
  printf '  \033[33mskip\033[0m agent-state pane write (no live tmux server)\n'
else
  target="$(tmux list-panes -a -F '#{pane_id}' 2>/dev/null | head -1)"
  if [ -n "$target" ]; then
    TMUX_PANE="$target" "$AGENT_STATE" needs-input >/dev/null 2>&1
    got="$(tmux display-message -p -t "$target" '#{@agent_state}' 2>/dev/null || true)"
    if [ "$got" = "needs-input" ]; then ok "agent-state: writes pane option"; else nok "agent-state: writes pane option (got '$got')"; fi
    TMUX_PANE="$target" \
      XTMUX_AGENT_BEAD=xtmux-mux.1 \
      XTMUX_AGENT_TASK='standardize metadata' \
      XTMUX_AGENT_PROMPT_FILE=/tmp/xtmux-mux.1.txt \
      XTMUX_AGENT_PARENT_SESSION=orch \
      "$AGENT_STATE" running >/dev/null 2>&1
    got_meta="$(tmux display-message -p -t "$target" $'#{@agent_state}\t#{@agent_bead}\t#{@agent_task}\t#{@agent_prompt_file}\t#{@agent_parent_session}\t#{@agent_last_transition}' 2>/dev/null || true)"
    IFS=$'\t' read -r got_state got_bead got_task got_prompt got_parent got_last <<< "$got_meta"
    [ "$got_state" = running ] && [ "$got_bead" = xtmux-mux.1 ] && [ "$got_task" = 'standardize metadata' ] && [ "$got_prompt" = /tmp/xtmux-mux.1.txt ] && [ "$got_parent" = orch ] && [ -n "$got_last" ] && ok "agent-state: writes orchestration metadata" || nok "agent-state: writes orchestration metadata"
    meta_row="$($PICKER list all expanded 2>/dev/null | awk -F'\t' -v p="$target" '$1=="pane"&&$4==p{print $5; exit}')"
    meta_row_plain="$(idle_plain "$meta_row")"
    case "$meta_row_plain" in *"bead:xtmux-mux.1"*"task:standardize metadata"*"from:orch"*) ok "picker: pane row consumes optional agent metadata" ;; *) nok "picker: pane row consumes optional agent metadata" ;; esac
    target_sid="$(tmux display-message -p -t "$target" '#{session_id}' 2>/dev/null || true)"
    target_name="$(tmux display-message -p -t "$target" '#S' 2>/dev/null || true)"
    preview_meta="$($PICKER preview pane "$target_sid" "$target_name" "$target" 2>/dev/null)"
    case "$preview_meta" in *"agent-meta bead=xtmux-mux.1"*"bead-context xtmux-mux.1"*) ok "picker: pane preview shows bead context" ;; *) nok "picker: pane preview shows bead context" ;; esac
    TMUX_PANE="$target" "$AGENT_STATE" off >/dev/null 2>&1 || true
    got_clear="$(tmux display-message -p -t "$target" $'#{@agent_state}\t#{@agent_bead}\t#{@agent_task}\t#{@agent_prompt_file}\t#{@agent_parent_session}' 2>/dev/null || true)"
    IFS=$'\t' read -r got_state got_bead got_task got_prompt got_parent <<< "$got_clear"
    [ "$got_state" = off ] && [ -z "$got_bead$got_task$got_prompt$got_parent" ] && ok "agent-state: off clears optional metadata" || nok "agent-state: off clears optional metadata"
  else
    printf '  \033[33mskip\033[0m agent-state pane write (no panes)\n'
  fi
fi


echo
echo "== rename contract =="

if ! command -v tmux >/dev/null 2>&1; then
  printf '  \033[33mskip\033[0m rename tests (tmux missing)\n'
else
  rename_sock="xtmux-contract-rename-$$"
  if command tmux -L "$rename_sock" -f /dev/null new-session -d -s xtmux-rename-session -n oldwin 'sleep 100' 2>/dev/null; then
    (
      tmux() { command tmux -L "$rename_sock" "$@"; }
      rename_apply session xtmux-rename-session xtmux-renamed-session >/dev/null 2>&1
      if tmux has-session -t xtmux-renamed-session 2>/dev/null; then ok "rename: session apply"; else nok "rename: session apply"; fi

      pane_for_rename="$(tmux list-panes -t xtmux-renamed-session -F '#{pane_id}' | head -1)"
      rename_apply pane "$pane_for_rename" newwin >/dev/null 2>&1
      got_win="$(tmux display-message -p -t "$pane_for_rename" '#W' 2>/dev/null || true)"
      assert_eq "rename: pane row renames window" "newwin" "$got_win"

      rename_apply session xtmux-renamed-session "" >/dev/null 2>&1
      if tmux has-session -t xtmux-renamed-session 2>/dev/null; then ok "rename: empty name cancels"; else nok "rename: empty name cancels"; fi

      # The INTERACTIVE path (xtmux-d0a.19, Codex): tmux replaces %1 with the typed
      # text and then runs the command through its own parser. Reproduce exactly
      # that — substitute, then let tmux parse it via source-file. Routing the name
      # through `run-shell` instead makes sh word-split it ("new sprint board" ->
      # "new") and EXECUTE metacharacters; both assertions below fail against that.
      rn_sid="$(tmux display-message -p -t xtmux-renamed-session '#{session_id}' 2>/dev/null || true)"
      rn_tpl="$(rename_prompt_command session "$rn_sid")"

      # Substitute %1 the way tmux does: a literal splice. NOT ${tpl//%1/$name} —
      # bash 5.2 expands `&` in a substitution's replacement to the matched text,
      # so a name containing `&&` comes back as `%1%1` and the test lies about
      # what tmux would have seen.
      rn_subst() { # rn_subst <template> <value>
        printf '%s%s%s' "${1%%%1*}" "$2" "${1#*%1}"
      }

      rn_subst "$rn_tpl" 'new sprint board' >"$WORK/rn-space.tmux"
      tmux source-file "$WORK/rn-space.tmux" 2>/dev/null || true
      assert_eq "rename: typed name keeps its spaces (no shell word-splitting)" \
        "new sprint board" "$(tmux display-message -p -t "$rn_sid" '#S' 2>/dev/null || true)"

      # a name that WOULD run a command if it ever reached a shell
      rn_evil="evil; touch $WORK/pwned"
      rn_subst "$rn_tpl" "$rn_evil" >"$WORK/rn-evil.tmux"
      tmux source-file "$WORK/rn-evil.tmux" 2>/dev/null || true
      if [ ! -e "$WORK/pwned" ]; then
        ok "rename: shell metacharacters in a typed name are inert, not executed"
      else
        nok "rename: shell metacharacters in a typed name are inert, not executed"
      fi

      # ...and the metacharacters survive as text. No dots or colons in this one:
      # tmux itself rewrites those in a session name, which is tmux's business,
      # not a shell-expansion question.
      rn_meta='weird; $(echo boom) && echo done'
      rn_subst "$rn_tpl" "$rn_meta" >"$WORK/rn-meta.tmux"
      tmux source-file "$WORK/rn-meta.tmux" 2>/dev/null || true
      assert_eq "rename: metacharacter name is stored literally" \
        "$rn_meta" "$(tmux display-message -p -t "$rn_sid" '#S' 2>/dev/null || true)"
    )
    command tmux -L "$rename_sock" kill-server >/dev/null 2>&1 || true
  else
    printf '  \033[33mskip\033[0m rename tests (isolated tmux unavailable)\n'
  fi
fi

echo
echo "== claude-pane detection contract (xtmux-k0d) =="

if ! command -v tmux >/dev/null 2>&1; then
  printf '  \033[33mskip\033[0m claude detection (tmux missing)\n'
else
  cd_sock="xtmux-contract-claude-$$"
  cd_bin="$WORK/claude-detect-bin"; mkdir -p "$cd_bin"
  # `ps -o comm=` reports the executable's basename, so a COPY of sleep named
  # `claude` is a process the detector sees exactly as it sees the real one — and a
  # copy of sh named `node` reproduces the `xt claude` wrapper. Real process table,
  # no mocking of the thing under test.
  cp "$(command -v sleep)" "$cd_bin/claude" 2>/dev/null || true
  cp "$(command -v sh)"    "$cd_bin/node"   2>/dev/null || true
  if [ -x "$cd_bin/claude" ] && [ -x "$cd_bin/node" ] && \
     command tmux -L "$cd_sock" -f /dev/null new-session -d -s cdetect -n wrapped "$cd_bin/node -c '$cd_bin/claude 100; true'" 2>/dev/null; then
    (
      tmux() { command tmux -L "$cd_sock" "$@"; }
      tmux new-window -d -n direct "$cd_bin/claude 100"
      tmux new-window -d -n plain  "sleep 100"
      sleep 1
      cd_pane() { tmux list-panes -a -F '#{window_name} #{pane_id}' 2>/dev/null | awk -v w="$1" '$1==w{print $2; exit}'; }
      p_wrapped="$(cd_pane wrapped)"; p_direct="$(cd_pane direct)"; p_plain="$(cd_pane plain)"

      # If the fixture does not reproduce the real shape, everything below is
      # vacuous — so assert the shape first. `xt claude` panes report `node`.
      assert_eq "claude-detect: wrapped pane reports 'node', not 'claude'" \
        "node" "$(tmux display-message -p -t "$p_wrapped" '#{pane_current_command}' 2>/dev/null || true)"

      # The bug (xtmux-k0d): detection read pane_current_command only, so this pane
      # missed, got double_enter=0, and Claude Code's paste-detection ate the single
      # Enter — the pointer sat unsubmitted while the sender was told `sent`.
      if pane_is_claude_code "$p_wrapped"; then ok "claude-detect: node-wrapped claude pane IS detected"; else nok "claude-detect: node-wrapped claude pane IS detected"; fi

      # Regression guard on the path that already worked.
      if pane_is_claude_code "$p_direct"; then ok "claude-detect: direct claude pane still detected"; else nok "claude-detect: direct claude pane still detected"; fi

      # The other half of the contract. A spurious second Enter into a pi or shell
      # pane submits whatever is sitting in its prompt — false positives are not
      # harmless, so a non-claude pane must stay negative.
      if pane_is_claude_code "$p_plain"; then nok "claude-detect: non-claude pane is NOT detected"; else ok "claude-detect: non-claude pane is NOT detected"; fi
    )
    command tmux -L "$cd_sock" kill-server >/dev/null 2>&1 || true
  else
    printf '  \033[33mskip\033[0m claude detection (isolated tmux unavailable)\n'
  fi
fi

echo
echo "== kill contract =="

if ! command -v tmux >/dev/null 2>&1; then
  printf '  \033[33mskip\033[0m kill tests (tmux missing)\n'
else
  kill_sock="xtmux-contract-kill-$$"
  if command tmux -L "$kill_sock" -f /dev/null new-session -d -s xtmux-kill-session 'sleep 100' 2>/dev/null; then
    (
      tmux() { command tmux -L "$kill_sock" "$@"; }

      kill_confirm xtmux-kill-session "" >/dev/null 2>&1
      if tmux has-session -t xtmux-kill-session 2>/dev/null; then ok "kill-confirm: empty answer cancels"; else nok "kill-confirm: empty answer cancels"; fi

      kill_confirm xtmux-kill-session "y" >/dev/null 2>&1
      if tmux has-session -t xtmux-kill-session 2>/dev/null; then nok "kill-confirm: y kills session"; else ok "kill-confirm: y kills session"; fi

      tmux new-session -d -s xtmux-kill-pane 'sleep 100' 2>/dev/null
      tmux split-window -t xtmux-kill-pane 'sleep 100' 2>/dev/null
      pane_to_kill="$(tmux list-panes -t xtmux-kill-pane -F '#{pane_id}' | tail -1)"
      kill_target pane xtmux-kill-pane "$pane_to_kill" >/dev/null 2>&1
      if tmux list-panes -t xtmux-kill-pane -F '#{pane_id}' | grep -Fx "$pane_to_kill" >/dev/null; then
        nok "kill: pane row remains immediate"
      else
        ok "kill: pane row remains immediate"
      fi

      tmux new-session -d -s xtmux-bulk-session-a 'sleep 100' 2>/dev/null
      bulk_kill_confirm "" xtmux-bulk-session-a >/dev/null 2>&1
      if tmux has-session -t xtmux-bulk-session-a 2>/dev/null; then ok "bulk-kill: empty confirm cancels sessions"; else nok "bulk-kill: empty confirm cancels sessions"; fi
      bulk_kill_confirm "y" xtmux-bulk-session-a >/dev/null 2>&1
      if tmux has-session -t xtmux-bulk-session-a 2>/dev/null; then nok "bulk-kill: y confirms sessions"; else ok "bulk-kill: y confirms sessions"; fi

      tmux split-window -t xtmux-kill-pane 'sleep 100' 2>/dev/null
      bulk_pane="$(tmux list-panes -t xtmux-kill-pane -F '#{pane_id}' | tail -1)"
      bulk_kill $'pane\txtmux-kill-pane\txtmux-kill-pane\t'"$bulk_pane"$'\trow' >/dev/null 2>&1
      if tmux list-panes -t xtmux-kill-pane -F '#{pane_id}' | grep -Fx "$bulk_pane" >/dev/null; then
        nok "bulk-kill: pane rows immediate"
      else
        ok "bulk-kill: pane rows immediate"
      fi
    )
    command tmux -L "$kill_sock" kill-server >/dev/null 2>&1 || true
  else
    printf '  \033[33mskip\033[0m kill tests (isolated tmux unavailable)\n'
  fi
fi

echo
echo "== act (act-on-preview) contract =="

if "$PICKER" act session x "" approve >/dev/null 2>&1; then
  ok "act: session-row guard is a safe no-op"
else
  ok "act: session-row guard is a safe no-op (exit ok)"
fi

if "$PICKER" act session x "" approve >/dev/null 2>&1; then
  :
else
  :
fi
# session-row act must not error on the guard path (exit 0 regardless)
"$PICKER" act session "" "" approve >/dev/null 2>&1 && ok "act: session row returns 0"

if "$PICKER" act pane x "%nopenope" frobnicate >/dev/null 2>&1; then
  nok "act: unknown action should fail"
else
  ok "act: unknown action exits non-zero"
fi

if ! tmux info >/dev/null 2>&1; then
  printf '  \033[33mskip\033[0m act delivery (no live tmux server)\n'
else
  wsess="xtmux-contract-act-$$"
  tmux new-session -d -s "$wsess" -x 120 -y 30 'cat' 2>/dev/null
  wpane="$(tmux list-panes -t "$wsess" -F '#{pane_id}' 2>/dev/null | head -1)"
  if [ -n "$wpane" ]; then
    "$PICKER" act pane "$wsess" "$wpane" approve >/dev/null 2>&1
    sleep 0.3
    if tmux capture-pane -p -t "$wpane" 2>/dev/null | grep -q '^y$'; then
      ok "act: approve sends 'y' to the pane"
    else
      nok "act: approve delivery"
    fi
  else
    printf '  \033[33mskip\033[0m act delivery (no pane)\n'
  fi
  tmux kill-session -t "$wsess" 2>/dev/null || true
fi

echo
echo "== list/preview contract (live tmux) =="

if ! tmux info >/dev/null 2>&1; then
  printf '  \033[33mskip\033[0m no live tmux server\n'
else
  rows="$("$PICKER" list all 2>/dev/null)"
  shape_ok=1
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    tabs="$(printf '%s' "$line" | tr -cd '\t' | wc -c)"
    if [ "$tabs" -ne 4 ]; then nok "TSV shape (got $tabs tabs)"; shape_ok=0; break; fi
    t="${line%%$'\t'*}"
    case "$t" in session|pane|header) ;; *) nok "row type '$t'"; shape_ok=0; break;; esac
  done <<< "$rows"
  [ "$shape_ok" = 1 ] && ok "TSV 5-col shape"

  nonempty=1
  while IFS=$'\t' read -r t sid name target rest; do
    [ -n "$t" ] || continue
    [ "$t" = header ] && continue
    if [ -z "$sid" ] || [ -z "$name" ] || [ -z "$target" ]; then nonempty=0; break; fi
  done <<< "$rows"
  [ "$nonempty" = 1 ] && ok "non-empty sid/name/target" || nok "empty fields"

  # preview a real session
  first="$(printf '%s\n' "$rows" | awk -F'\t' '$1=="session"{print $2"\t"$3; exit}')"
  sid="${first%%$'\t'*}"; name="${first#*$'\t'}"
  if [ -n "$sid" ]; then
    lines="$("$PICKER" preview session "$sid" "$name" 2>/dev/null | wc -l)"
    [ "$lines" -gt 0 ] && ok "preview session $name (${lines}L)" || nok "preview empty"
  fi

  # bad arg exits non-zero
  if "$PICKER" __bad__ >/dev/null 2>&1; then nok "bad-arg exit code"; else ok "bad-arg exits non-zero"; fi
fi


echo

echo "== monitor registry contract (live tmux) =="

if ! tmux info >/dev/null 2>&1; then
  printf '  \033[33mskip\033[0m monitor registry tests (no live tmux server)\n'
else
  mon_tmp="$WORK/monitor-state"
  mon_sess="xtmux-monitor-$$"
  tmux kill-session -t "$mon_sess" 2>/dev/null || true
  tmux new-session -d -s "$mon_sess" -c "$ROOT" 'sleep 100' 2>/dev/null
  mon_pane="$(tmux list-panes -t "$mon_sess" -F '#{pane_id}' 2>/dev/null | head -1)"
  if [ -n "$mon_pane" ]; then
    tmux set-option -p -t "$mon_pane" -q @agent_state running
    mon_start="$(TMPDIR="$mon_tmp" "$PICKER" monitor-agent "$mon_pane" --timeout 10s --interval 1s 2>/dev/null)"
    mon_id="$(printf '%s\n' "$mon_start" | awk -F'\t' '$1=="monitor"{print $2; exit}')"
    mon_list="$(TMPDIR="$mon_tmp" "$PICKER" monitor-list 2>/dev/null)"
    if [ -n "$mon_id" ] && printf '%s\n' "$mon_list" | awk -F'\t' -v id="$mon_id" '$1=="monitor"&&$2==id&&$5!=""&&$6=="running"{found=1} END{exit found?0:1}'; then
      ok "monitor-registry: start then list active monitor"
    else
      nok "monitor-registry: start then list active monitor"
    fi
    TMPDIR="$mon_tmp" "$PICKER" monitor-kill "$mon_id" >/dev/null 2>&1 || true
    mon_list_after_kill="$(TMPDIR="$mon_tmp" "$PICKER" monitor-list 2>/dev/null)"
    if ! printf '%s\n' "$mon_list_after_kill" | grep -F "$mon_id" >/dev/null; then ok "monitor-registry: kill removes registry entry"; else nok "monitor-registry: kill removes registry entry"; fi

    tmux set-option -p -t "$mon_pane" -q @agent_state running
    mon_start2="$(TMPDIR="$mon_tmp" "$PICKER" monitor-agent "$mon_pane" --timeout 10s --interval 1s 2>/dev/null)"
    mon_id2="$(printf '%s\n' "$mon_start2" | awk -F'\t' '$1=="monitor"{print $2; exit}')"
    ( sleep 1; tmux set-option -p -t "$mon_pane" -q @agent_state idle ) &
    mon_cleaned=0
    for _ in 1 2 3 4 5; do
      sleep 1
      mon_list_done="$(TMPDIR="$mon_tmp" "$PICKER" monitor-list 2>/dev/null)"
      if ! printf '%s\n' "$mon_list_done" | grep -F "$mon_id2" >/dev/null; then mon_cleaned=1; break; fi
    done
    [ "$mon_cleaned" = 1 ] && ok "monitor-registry: completed monitor cleans registry entry" || nok "monitor-registry: completed monitor cleans registry entry"
    TMPDIR="$mon_tmp" "$PICKER" monitor-kill "$mon_id2" >/dev/null 2>&1 || true
  else
    printf '  \033[33mskip\033[0m monitor registry tests (no pane)\n'
  fi
  tmux kill-session -t "$mon_sess" 2>/dev/null || true
fi

echo

echo "== delegation dashboard contract (live tmux) =="

if ! tmux info >/dev/null 2>&1; then
  printf '  \033[33mskip\033[0m dashboard tests (no live tmux server)\n'
else
  dash_repo="$WORK/dashboard-repo"
  mk_repo "$dash_repo"
  add_clean "$dash_repo" "dirty.txt" "base"
  add_modified "$dash_repo" "dirty.txt" "changed"
  dash_a="xtmux-dashboard-a-$$"
  dash_b="xtmux-dashboard-b-$$"
  tmux kill-session -t "$dash_a" 2>/dev/null || true
  tmux kill-session -t "$dash_b" 2>/dev/null || true
  tmux new-session -d -s "$dash_a" -c "$dash_repo" 'sleep 100' 2>/dev/null
  tmux new-session -d -s "$dash_b" -c "$dash_repo" 'sleep 100' 2>/dev/null
  dash_pane_a="$(tmux list-panes -t "$dash_a" -F '#{pane_id}' 2>/dev/null | head -1)"
  if [ -n "$dash_pane_a" ]; then
    TMUX_PANE="$dash_pane_a" XTMUX_AGENT_BEAD=xtmux-mux.6 XTMUX_AGENT_TASK='dash task' XTMUX_AGENT_PARENT_SESSION=orch "$AGENT_STATE" needs-input >/dev/null 2>&1
  fi
  dash_rows="$($PICKER dashboard sessions-only 2>/dev/null)"
  dash_a_row="$(printf '%s\n' "$dash_rows" | awk -F'\t' -v n="$dash_a" '$1=="session" && $3==n {print; exit}')"
  dash_b_row="$(printf '%s\n' "$dash_rows" | awk -F'\t' -v n="$dash_b" '$1=="session" && $3==n {print; exit}')"
  IFS=$'\t' read -r _ _ _ dash_state dash_bead dash_task dash_repo_name dash_branch dash_dirty dash_shared _ <<< "$dash_a_row"
  [ "$dash_state" = needs-input ] && [ "$dash_bead" = xtmux-mux.6 ] && [ "$dash_task" = 'dash task' ] && [ "$dash_dirty" -gt 0 ] && [ "$dash_shared" = 1 ] && ok "dashboard: session row has state bead task dirty shared" || nok "dashboard: session row has state bead task dirty shared"
  dash_b_shared="$(printf '%s\n' "$dash_b_row" | awk -F'\t' '{print $10}')"
  [ "$dash_b_shared" = 1 ] && ok "dashboard: missing metadata still reports shared worktree" || nok "dashboard: missing metadata still reports shared worktree"
  dash_expanded="$($PICKER dashboard expanded 2>/dev/null)"
  dash_pane_row="$(printf '%s\n' "$dash_expanded" | awk -F'\t' -v p="$dash_pane_a" '$1=="pane" && $4==p {print; exit}')"
  IFS=$'\t' read -r _ _ _ _ pane_state pane_bead pane_task _ <<< "$dash_pane_row"
  [ "$pane_state" = needs-input ] && [ "$pane_bead" = xtmux-mux.6 ] && [ "$pane_task" = 'dash task' ] && ok "dashboard: expanded mode exposes pane detail" || nok "dashboard: expanded mode exposes pane detail"
  TMUX_PANE="$dash_pane_a" "$AGENT_STATE" off >/dev/null 2>&1 || true
  tmux kill-session -t "$dash_a" 2>/dev/null || true
  tmux kill-session -t "$dash_b" 2>/dev/null || true
fi


echo
echo "== specialist sp-* contract =="

if ! tmux info >/dev/null 2>&1; then
  printf '  \033[33mskip\033[0m specialist tests (no live tmux server)\n'
else
  sp_sess="sp-executor-deadbe"
  tmux kill-session -t "$sp_sess" 2>/dev/null || true
  tmux new-session -d -s "$sp_sess" -x 120 -y 30 'cat' 2>/dev/null
  sp_pane="$(tmux list-panes -t "$sp_sess" -F '#{pane_id}' 2>/dev/null | head -1)"
  sp_sid="$(tmux display-message -p -t "$sp_sess" '#{session_id}' 2>/dev/null)"

  all_sp_rows="$($PICKER list all 2>/dev/null)"
  sp_rows="$(printf '%s
' "$all_sp_rows" | grep "$sp_sess" || true)"
  if printf '%s' "$sp_rows" | grep -q '\[sp\]' && printf '%s' "$sp_rows" | grep -q 'executor' && ! printf '%s' "$sp_rows" | grep -q '\[stale\]'; then
    ok "specialist: sp-* pane gets [sp] role badge without false [stale]"
  else
    nok "specialist: sp-* list badge"
    printf '      rows: %s
' "$sp_rows"
  fi

  header_line="$(printf '%s
' "$all_sp_rows" | awk -F'	' '$1=="header" && $3=="specialists"{print NR; exit}')"
  sp_line="$(printf '%s
' "$all_sp_rows" | awk -F'	' -v s="$sp_sess" '$1=="session" && $3==s{print NR; exit}')"
  if [ -n "$header_line" ] && [ -n "$sp_line" ] && [ "$header_line" -lt "$sp_line" ]; then
    ok "specialist: sp-* sessions grouped under bottom header"
  else
    nok "specialist: sp-* sessions grouped under bottom header"
  fi

  sp_prev="$("$PICKER" preview pane "$sp_sid" "$sp_sess" "$sp_pane" 2>/dev/null | head -5)"
  if printf '%s' "$sp_prev" | grep -q 'specialist job=deadbe bead=? role=executor state=stale'; then
    ok "specialist: pane preview header"
  else
    nok "specialist: pane preview header"
    printf '      preview: %s
' "$sp_prev"
  fi

  sp_sess_prev="$("$PICKER" preview session "$sp_sid" "$sp_sess" 2>/dev/null | head -5)"
  if printf '%s' "$sp_sess_prev" | grep -q 'specialist job=deadbe bead=? role=executor state=stale'; then
    ok "specialist: session preview header"
  else
    nok "specialist: session preview header"
    printf '      preview: %s
' "$sp_sess_prev"
  fi

  TMUX_PANE="$sp_pane" "$AGENT_STATE" needs-input >/dev/null 2>&1
  sp_wait_rows="$("$PICKER" list waiting 2>/dev/null | grep "$sp_sess" || true)"
  if printf '%s' "$sp_wait_rows" | grep -q '\[sp\]' && printf '%s' "$sp_wait_rows" | grep -q '\[wait\]'; then
    ok "specialist: explicit waiting state appears in waiting filter"
  else
    nok "specialist: waiting filter"
    printf '      rows: %s
' "$sp_wait_rows"
  fi
  TMUX_PANE="$sp_pane" "$AGENT_STATE" off >/dev/null 2>&1 || true

  tmux kill-session -t "$sp_sess" 2>/dev/null || true
fi

echo
echo "== filter contract (live tmux) =="

if ! tmux info >/dev/null 2>&1; then
  printf '  \033[33mskip\033[0m filter tests (no live tmux server)\n'
else
  fa="$WORK/filtA"; fb="$WORK/filtB"
  mk_repo "$fa"
  mk_repo "$fb"
  # repo B on a 'feat' branch (drop main) so branch: filters are deterministic
  git -C "$fb" checkout -q -b feat 2>/dev/null || git -C "$fb" checkout -q feat 2>/dev/null || true
  git -C "$fb" branch -q -D main 2>/dev/null || true

  sa="xt-contract-filt-a"; sb="xt-contract-filt-b"
  tmux kill-session -t "$sa" 2>/dev/null || true
  tmux kill-session -t "$sb" 2>/dev/null || true
  # detached 'bash' -> pane_current_command=bash (classify: shell), stays alive
  tmux new-session -d -s "$sa" -c "$fa" 'bash' 2>/dev/null
  tmux new-session -d -s "$sb" -c "$fb" 'bash' 2>/dev/null
  pa="$(tmux list-panes -t "$sa" -F '#{pane_id}' 2>/dev/null | head -1)"
  pb="$(tmux list-panes -t "$sb" -F '#{pane_id}' 2>/dev/null | head -1)"

  # helper: does `list <spec>` contain session <name>?
  list_has() { "$PICKER" list "$1" 2>/dev/null | awk -F'\t' -v s="$2" '$1=="session"&&$3==s{f=1} END{exit !f}'; }
  # unique grep token written into A's pane only
  grep_tok="XTMUXFILTTOKENzz9"
  tmux send-keys -t "$pa" "printf '%s' '$grep_tok'" Enter 2>/dev/null
  sleep 0.5

  # repo filter: A in repo filtA, B in filtB
  list_has "repo:filtA" "$sa" && ok "filter: repo narrows to matching repo" || nok "filter: repo narrows to matching repo"
  list_has "repo:filtA" "$sb" && nok "filter: repo excludes other repo"     || ok "filter: repo excludes other repo"

  # branch filter: A on main, B on feat
  list_has "branch:main" "$sa" && ok "filter: branch:main includes main"    || nok "filter: branch:main includes main"
  list_has "branch:feat" "$sb" && ok "filter: branch:feat includes feat"    || nok "filter:branch:feat includes feat"
  list_has "branch:main" "$sb" && nok "filter: branch excludes non-main"    || ok "filter: branch excludes non-main"

  # cmd filter: both panes are bash -> shell
  list_has "cmd:shell" "$sa" && ok "filter: cmd:shell matches bash pane"    || nok "filter: cmd:shell matches bash pane"
  list_has "cmd:agent" "$sa" && nok "filter: cmd:agent excludes plain shell"|| ok "filter: cmd:agent excludes plain shell"
  # promote A to an agent via truthful @agent_state -> cmd:agent now matches A
  TMUX_PANE="$pa" "$AGENT_STATE" running >/dev/null 2>&1
  list_has "cmd:agent" "$sa" && ok "filter: cmd:agent matches @agent_state" || nok "filter: cmd:agent matches @agent_state"
  TMUX_PANE="$pa" "$AGENT_STATE" off >/dev/null 2>&1 || true

  # free-text grep: the unique token lives only in A
  list_has "grep:$grep_tok" "$sa" && ok "filter: grep matches pane text"    || nok "filter: grep matches pane text"
  list_has "grep:$grep_tok" "$sb" && nok "filter: grep excludes other pane" || ok "filter: grep excludes other pane"

  # composition: repo AND cmd
  list_has "repo:filtA,cmd:shell" "$sa" && ok "filter: compose repo,cmd"   || nok "filter: compose repo,cmd"

  # attention presets unchanged
  list_has "all" "$sa" && ok "filter: all preset still works" || nok "filter: all preset still works"

  # state-file flow: filter-clear / list-active / prompt-label (non-interactive)
  filter_state_file; _ffile="$REPLY"
  "$PICKER" filter-clear >/dev/null 2>&1
  assert_eq "filter: clear -> prompt all>" "all> " "$("$PICKER" prompt-label 2>/dev/null)"
  printf 'repo:filtA' > "$_ffile"
  _la="$("$PICKER" list-active 2>/dev/null | awk -F'\t' -v s="$sa" '$1=="session"&&$3==s{print;exit}')"
  [ -n "$_la" ] && ok "filter: list-active applies file spec" || nok "filter: list-active applies file spec"
  assert_eq "filter: prompt reflects spec" "repo:filtA> " "$("$PICKER" prompt-label 2>/dev/null)"
  "$PICKER" filter-clear >/dev/null 2>&1

  tmux kill-session -t "$sa" 2>/dev/null || true
  tmux kill-session -t "$sb" 2>/dev/null || true
fi
echo
echo "== xtmux alias =="
# `xtmux` is a second symlink to bin/tmux-session-picker (see install.sh).
# The picker derives its root as ${self%/bin/*} and BASH_SOURCE does not resolve
# symlinks, so root comes from the directory the alias SITS IN, not from its
# target. Next to the picker symlink, $root/bin/xtmux-obs resolves; anywhere else
# it silently does not, and the V2 backend disappears. Both halves are asserted.
alias_bin="$WORK/fakehome/.local/bin"
mkdir -p "$alias_bin"
ln -sf "$PICKER" "$alias_bin/tmux-session-picker"
ln -sf "$PICKER" "$alias_bin/xtmux"

# stub obs backend at $root/bin/xtmux-obs, i.e. exactly where a correctly-placed
# alias must look for it. `log query` execs the backend, so stdout is verbatim.
cat > "$alias_bin/xtmux-obs" <<'STUB'
#!/usr/bin/env bash
printf '{"stub":"obs-resolved"}\n'
STUB
chmod +x "$alias_bin/xtmux-obs"

# 1. the alias is the same program: identical help surface. The usage line echoes
#    $self (argv[0]), which SHOULD differ between the two names — that is correct
#    CLI behaviour, not drift — so it is normalized away. Everything else, i.e.
#    the whole subcommand surface, must be byte-identical.
_norm_self() { sed -E 's#^usage: [^ ]+#usage: <self>#'; }
"$alias_bin/xtmux" help 2>&1 | _norm_self >"$WORK/alias-help.act"
"$alias_bin/tmux-session-picker" help 2>&1 | _norm_self >"$WORK/compat-help.act"
if diff -q "$WORK/compat-help.act" "$WORK/alias-help.act" >/dev/null 2>&1; then
  ok "alias: xtmux help == tmux-session-picker help (modulo argv[0])"
else
  nok "alias: xtmux help == tmux-session-picker help (modulo argv[0])"
  diff -u "$WORK/compat-help.act" "$WORK/alias-help.act" | sed 's/^/      /' | head -10
fi

# 2. correctly-placed alias resolves root -> finds $root/bin/xtmux-obs
_alias_obs="$(XTMUX_OBS_V2=1 "$alias_bin/xtmux" log query --type query.completed --json 2>&1)"
case "$_alias_obs" in
  *obs-resolved*) ok "alias: root resolves through xtmux -> V2 backend found" ;;
  *) nok "alias: root resolves through xtmux -> V2 backend found"
     printf '      actual: %s\n' "$_alias_obs" ;;
esac

# 3. THE TRAP: an alias outside the bin/ dir resolves root wrong and loses V2.
#    This is why install.sh must keep xtmux next to tmux-session-picker.
ln -sf "$PICKER" "$WORK/fakehome/.local/xtmux"
_misplaced="$(XTMUX_OBS_V2=1 "$WORK/fakehome/.local/xtmux" log query --type query.completed --json 2>&1)"
case "$_misplaced" in
  *XTMUX_JSON_BACKEND_UNAVAILABLE*) ok "alias: misplaced alias loses V2 backend (documents the trap)" ;;
  *obs-resolved*) nok "alias: misplaced alias loses V2 backend (documents the trap)"
     printf '      misplaced alias unexpectedly found the backend\n' ;;
  *) nok "alias: misplaced alias loses V2 backend (documents the trap)"
     printf '      actual: %s\n' "$_misplaced" ;;
esac

echo
echo "== install.sh (fresh machine) =="
# The section above stubs xtmux-obs to prove root RESOLUTION. A stub cannot see
# the artifact MISSING, which is exactly how install.sh shipped for months without
# ever linking bin/xtmux-obs. So run the REAL installer into a throwaway HOME and
# require that the entrypoints it places reach the REAL compiled backend.
fresh="$WORK/freshhome"
mkdir -p "$fresh"
if HOME="$fresh" bash "$ROOT/install.sh" >"$WORK/install.out" 2>&1; then
  ok "install: completes"
  # every binary the picker needs at runtime must be placed, xtmux-obs included
  for _e in xtmux tmux-session-picker xtmux-obs xtmux-monitor; do
    if [ -x "$fresh/.local/bin/$_e" ]; then
      ok "install: links $_e"
    else
      nok "install: links $_e"
    fi
  done
  # no stub anywhere on this path: this only passes if install.sh actually placed
  # the compiled backend where ${self%/bin/*} looks for it.
  _fresh_json="$(HOME="$fresh" XDG_STATE_HOME="$fresh/.local/state" XTMUX_OBS_V2=1 \
    "$fresh/.local/bin/xtmux" log query --type query.completed --limit 1 --json 2>&1)"
  # NB: the failure IS json ({"error":"XTMUX_JSON_BACKEND_UNAVAILABLE"...}), so
  # "parses as json" is not the assertion — a missing backend must not look like
  # a pass. Require the query's own array result, and no error payload.
  case "$_fresh_json" in
    *XTMUX_JSON_BACKEND_UNAVAILABLE*|*'"error"'*)
       nok "install: fresh install reaches a real V2 backend (no stub)"
       printf '      actual: %s\n' "$_fresh_json" ;;
    '['*) ok "install: fresh install reaches a real V2 backend (no stub)" ;;
    *) nok "install: fresh install reaches a real V2 backend (no stub)"
       printf '      actual: %s\n' "$_fresh_json" ;;
  esac
else
  nok "install: completes"
  sed 's/^/      /' "$WORK/install.out" | head -5
fi

echo
echo "== help surface (xtmux-d0a.15) =="
# Help that rots is worse than no help, so nothing here trusts the help text:
# the command list is checked BOTH ways against the real dispatch table, and the
# documented --json field names are checked against LIVE command output.
"$PICKER" help >"$WORK/help.out" 2>&1
_help_lines="$(wc -l <"$WORK/help.out" | tr -d ' ')"

if [ "$_help_lines" -ge 50 ] && [ "$_help_lines" -le 160 ]; then
  ok "help: grouped and scannable ($_help_lines lines, bd/sp/xt band is 50-160)"
else
  nok "help: grouped and scannable ($_help_lines lines, want 50-160)"
fi

# the authoritative command list: the top-level dispatch arms themselves
awk '/^case "\$\{1:-\}" in/{inblock=1; next}
     inblock && /^esac/{exit}
     inblock && /^  [a-z][a-z0-9|_-]*\)/{
       sub(/\).*/, "", $1); n=split($1, arms, "|");
       for (i=1; i<=n; i++) if (arms[i] ~ /^[a-z]/) print arms[i]
     }' "$PICKER" | sort -u >"$WORK/dispatch.cmds"
_ndispatch="$(wc -l <"$WORK/dispatch.cmds" | tr -d ' ')"

# 1. forward: every real command is documented (a new command must not land undocumented)
_undocumented=''
while read -r _cmd; do
  grep -qE "(^|[[:space:],])${_cmd}([[:space:],]|$)" "$WORK/help.out" || _undocumented="$_undocumented $_cmd"
done <"$WORK/dispatch.cmds"
if [ -z "$_undocumented" ]; then
  ok "help: documents every dispatch command ($_ndispatch commands)"
else
  nok "help: documents every dispatch command"
  printf '      undocumented:%s\n' "$_undocumented"
fi

# 2. reverse: help invents nothing (a removed/renamed command must not linger).
#    The help FORMAT is the contract: a command is the first word of a line
#    indented exactly 2 spaces and starting lowercase. Prose is indented deeper
#    or starts uppercase; field lists are indented 4. The only multi-command
#    lines are the comma lists under PICKER INTERNALS. "json output:" is a header.
awk '/^  [a-z]/ && !/^   / {
       line=$0; sub(/^  /, "", line);
       if (line ~ /^([a-z][a-z0-9_-]*, )+[a-z][a-z0-9_-]*,?$/) {      # pure comma list
         n=split(line, toks, /, */);
         for (i=1; i<=n; i++) { gsub(/,/, "", toks[i]); if (toks[i] != "") print toks[i] }
       } else {
         split(line, f, / /);                                          # first word only
         gsub(/[^a-z0-9_-]/, "", f[1]);
         if (f[1] != "" && f[1] != "json") print f[1]
       }
     }' "$WORK/help.out" | sort -u >"$WORK/help.cmds"
_phantom=''
while read -r _cmd; do
  grep -qx "$_cmd" "$WORK/dispatch.cmds" || _phantom="$_phantom $_cmd"
done <"$WORK/help.cmds"
if [ -z "$_phantom" ]; then
  ok "help: names no command that does not exist"
else
  nok "help: names no command that does not exist"
  printf '      phantom:%s\n' "$_phantom"
fi

# 3. the two discoverability retries from the design consult must be answerable
#    from help alone. (a) required input arg, loud failure:
grep -q -- '--for is REQUIRED' "$WORK/help.out" \
  && ok "help: marks message-list --for as REQUIRED" \
  || nok "help: marks message-list --for as REQUIRED"
_noforl="$("$PICKER" message-list --json 2>&1 >/dev/null; printf 'exit=%s' "$?")"
case "$_noforl" in *exit=2*) ok "help: matches reality — message-list without --for exits 2" ;;
  *) nok "help: matches reality — message-list without --for exits 2 ($_noforl)" ;; esac

# (b) the silent one: guessed output fields return null instead of failing.
grep -q 'messageKey' "$WORK/help.out" && grep -q 'summary' "$WORK/help.out" \
  && ok "help: documents the message output fields (messageKey, summary)" \
  || nok "help: documents the message output fields (messageKey, summary)"
grep -q 'no `text` field and no `id` field' "$WORK/help.out" \
  && ok "help: names the id/text trap explicitly" \
  || nok "help: names the id/text trap explicitly"

# 4. THE DRIFT GUARD: documented json fields vs what the commands actually emit.
#    Pinned to live output, not to a doc — a doc can rot in lockstep with help.
if command -v jq >/dev/null 2>&1 && [ -x "$ROOT/bin/xtmux-obs" ] && tmux info >/dev/null 2>&1; then
  _hstate="$WORK/helpstate"; mkdir -p "$_hstate"
  _hs="xt-help-fields-$$"
  tmux new-session -d -s "$_hs" 'sleep 30' 2>/dev/null
  _hp="$(tmux list-panes -t "$_hs" -F '#{pane_id}' 2>/dev/null | head -1)"
  # each: <label> <live json keys>
  _live_keys() { # _live_keys <jq-filter> <cmd...>
    local filter="$1"; shift
    XDG_STATE_HOME="$_hstate" XTMUX_OBS_V2=1 "$PICKER" "$@" 2>/dev/null | jq -r "$filter" 2>/dev/null
  }
  # The field must be documented in THAT command's own `json output:` block —
  # grepping the whole help would let a field survive in a neighbouring block and
  # mask its removal here (a false pass this test was written to catch).
  _help_block() { # _help_block <label> -> that label's field block
    awk -v L="$1" '
      $0 ~ "^    " L "([[:space:]]|$)" { inb=1; print; next }
      inb && /^    [a-z]/ { exit }   # next label at the same indent
      inb && /^[A-Z]/     { exit }   # next section
      inb && /^$/         { exit }   # end of the json output block
      inb                 { print }
    ' "$WORK/help.out"
  }
  _assert_fields() { # _assert_fields <label> <live-keys> [doc-label]
    local label="$1" keys="$2" doclabel="${3:-$1}" block missing=''
    block="$(_help_block "$doclabel")"
    if [ -z "$block" ]; then
      nok "help: json fields match live output ($label)"
      printf '      no `json output:` block documents %s\n' "$doclabel"
      return
    fi
    for _k in $keys; do
      printf '%s' "$block" | grep -q "\b$_k\b" || missing="$missing $_k"
    done
    if [ -z "$missing" ]; then
      ok "help: json fields match live output ($label)"
    else
      nok "help: json fields match live output ($label)"
      printf '      emitted but undocumented under `%s`:%s\n' "$doclabel" "$missing"
    fi
  }
  _k_send="$(_live_keys 'keys|join(" ")' message-send --to "$_hp" --from "$_hp" --text 'help-field-probe' --json)"
  _assert_fields "message-send" "$_k_send"
  # message-list rows are the `message` model — that is the block agents misread
  _k_list="$(_live_keys '.[0]|keys|join(" ")' message-list --for "$_hp" --json)"
  _assert_fields "message-list" "$_k_list" "message"
  _k_unread="$(_live_keys 'keys|join(" ")' unread-count --for "$_hp" --json)"
  _assert_fields "unread-count" "$_k_unread"
  _k_dash="$(_live_keys 'keys|join(" ")' dashboard sessions-only --json)"
  _assert_fields "dashboard" "$_k_dash"
  tmux kill-session -t "$_hs" 2>/dev/null || true
else
  printf '  \033[33mskip\033[0m help json-field drift guard (needs jq + built xtmux-obs + live tmux)\n'
fi

# 5. help and docs/json-command-api.md cannot fork: every field the doc calls stable
#    for a Message must be documented in help's `message` block.
if [ -f "$ROOT/docs/json-command-api.md" ]; then
  _doc_msg_fields="$(awk -F'|' '/^\| Message \|/{gsub(/`|,/, "", $3); print $3; exit}' "$ROOT/docs/json-command-api.md")"
  _doc_missing=''
  _msg_block="$(awk '/^    message([[:space:]])/{inb=1; print; next} inb && /^    [a-z]/{exit} inb && /^$/{exit} inb{print}' "$WORK/help.out")"
  for _f in $_doc_msg_fields; do
    printf '%s' "$_msg_block" | grep -q "\b$_f\b" || _doc_missing="$_doc_missing $_f"
  done
  if [ -n "$_doc_msg_fields" ] && [ -z "$_doc_missing" ]; then
    ok "help: agrees with docs/json-command-api.md stable Message fields"
  else
    nok "help: agrees with docs/json-command-api.md stable Message fields"
    printf '      documented in the doc but missing from help:%s\n' "${_doc_missing:- (doc table not parsed)}"
  fi
fi

# 6. mux-help survives and help points at it
[ "$("$PICKER" mux-help 2>/dev/null | wc -l)" -gt 10 ] \
  && ok "help: mux-help still works (protocol, not command reference)" \
  || nok "help: mux-help still works (protocol, not command reference)"
grep -q 'mux-help' "$WORK/help.out" \
  && ok "help: cross-references mux-help" \
  || nok "help: cross-references mux-help"

harness_summary
exit $?
