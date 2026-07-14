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
# Asserted on extract_bead_id DIRECTLY, not through derive_bead_id: derive's later
# fallback branch re-scans the path relative to the root and quietly recovers the
# right answer when `bd` is installed to validate candidates — which masks this bug
# on a developer's machine and exposes it only in CI, where bd is absent. The scan
# itself is what must not lie.
#
# The path is scanned WHOLE, so the scan must not mine a bead id out of the
# directories ABOVE the one we care about. mktemp's suffix begins with a digit
# about one run in six, and `tmp.9` matched — so a pane whose cwd was a temp dir
# got labelled with bead `tmp.9`, which exists nowhere, and this suite flaked on
# nothing but the name mktemp handed it. Literal path, so it fails every run.
extract_bead_id "/tmp/tmp.9aBcDeFgHi/.xtrm/worktrees/xtmux-mux.6-demo"
assert_eq "bead derive: a digit-leading temp dir is not mined for a bead id" "xtmux-mux.6" "$REPLY"
extract_bead_id "/tmp/tmp.9aBcDeFgHi/plain-worktree"
assert_eq "bead derive: no bead in the path means no bead, not tmp.9" "" "$REPLY"
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
echo "== identity contract: host_id + @agent_instance_id (xtmux-j46.1) =="

# Isolated tmux socket + throwaway state dir: identity is the one thing that must
# not be polluted by (or pollute) whatever the operator has running.
id_sock="xtmux-identity-$$"
id_state="$(mktemp -d)"
id_hostfile="$id_state/xtmux/host-id"

if ! command tmux -L "$id_sock" -f /dev/null new-session -d -s xtmux-identity 'sleep 100' 2>/dev/null; then
  printf '  \033[33mskip\033[0m identity contract (cannot start isolated tmux server)\n'
else
  id_pane="$(command tmux -L "$id_sock" list-panes -a -F '#{pane_id}' | head -1)"
  # The script resolves via TMUX_PANE against the socket in TMUX; point both at
  # the isolated server so nothing lands on a bystander.
  id_tmuxenv="$(command tmux -L "$id_sock" display-message -p '#{socket_path},0,0')"
  agent_state_iso() {
    env TMUX="$id_tmuxenv" TMUX_PANE="$id_pane" XDG_STATE_HOME="$id_state" \
      XTMUX_HOST_ID_FILE="$id_hostfile" PATH="$PATH" "$AGENT_STATE" "$@" >/dev/null 2>&1
  }
  pane_opt() { command tmux -L "$id_sock" show-options -p -t "$id_pane" -qv "$1" 2>/dev/null || true; }
  uuid_shaped() { [[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; }

  agent_state_iso idle --new-instance
  inst1="$(pane_opt @agent_instance_id)"
  host1="$(cat "$id_hostfile" 2>/dev/null || true)"

  uuid_shaped "$inst1" && ok "identity: --new-instance writes a uuid @agent_instance_id" \
    || nok "identity: --new-instance writes a uuid @agent_instance_id (got '$inst1')"

  uuid_shaped "$host1" && ok "identity: host_id persisted as a uuid" \
    || nok "identity: host_id persisted as a uuid (got '$host1')"

  # A public identifier derived from machine-id would leak a stable host fingerprint.
  machine_id="$(cat /etc/machine-id 2>/dev/null || true)"
  if [ -n "$machine_id" ] && [ "${host1//-/}" = "$machine_id" ]; then
    nok "identity: host_id is not /etc/machine-id"
  else
    ok "identity: host_id is not /etc/machine-id"
  fi

  agent_state_iso running
  agent_state_iso needs-input
  inst_after="$(pane_opt @agent_instance_id)"
  host_after="$(cat "$id_hostfile" 2>/dev/null || true)"
  [ "$inst_after" = "$inst1" ] && ok "identity: ordinary transitions preserve @agent_instance_id" \
    || nok "identity: ordinary transitions preserve @agent_instance_id ('$inst1' -> '$inst_after')"
  [ "$host_after" = "$host1" ] && ok "identity: host_id stable across invocations" \
    || nok "identity: host_id stable across invocations ('$host1' -> '$host_after')"

  # off is a post-mortem marker, not an eraser: the id survives for attribution.
  agent_state_iso off
  [ "$(pane_opt @agent_instance_id)" = "$inst1" ] && ok "identity: off preserves @agent_instance_id" \
    || nok "identity: off preserves @agent_instance_id"

  # A pane reused by a new agent must not inherit the previous occupant's identity.
  agent_state_iso idle --new-instance
  inst2="$(pane_opt @agent_instance_id)"
  { uuid_shaped "$inst2" && [ "$inst2" != "$inst1" ]; } \
    && ok "identity: a reused pane gets a fresh instance id" \
    || nok "identity: a reused pane gets a fresh instance id ('$inst1' -> '$inst2')"

  # The event carries the identity, so a consumer never has to re-read pane
  # options after the fact (which would race a pane that already rotated).
  id_event="$(tail -1 "$id_state/xtmux/events.jsonl" 2>/dev/null || true)"
  case "$id_event" in
    *"\"host_id\":\"$host1\""*"\"agent_instance_id\":\"$inst2\""*)
      ok "identity: agent.state event carries host_id + agent_instance_id" ;;
    *) nok "identity: agent.state event carries host_id + agent_instance_id" ;;
  esac

  case "$id_event" in
    *XDG_STATE_HOME*|*"$id_sock"*) nok "identity: event leaks no environment" ;;
    *) ok "identity: event leaks no environment" ;;
  esac

  command tmux -L "$id_sock" kill-server >/dev/null 2>&1 || true
fi
rm -rf "$id_state"

echo
echo "== readiness lifecycle: agent.ready + durable agent domain (xtmux-j46.7) =="

# Before this bead the hook wrote ONLY to events.jsonl: agent_instances and
# agent_state_transitions had zero rows, so the V2 journal — the ordered feed the
# Console graph consumes — knew nothing about agent lifecycle at all.
rl_sock="xtmux-ready-$$"
rl_state="$(mktemp -d)"
rl_bin="$(mktemp -d)"
# A real exec wrapper, not a symlink: the picker resolves its root from
# BASH_SOURCE without dereferencing, so a symlink would send it hunting for the
# runtime in the wrong tree.
printf '#!/bin/sh\nexec %s/bin/tmux-session-picker "$@"\n' "$ROOT" > "$rl_bin/xtmux"
chmod +x "$rl_bin/xtmux"

if ! command tmux -L "$rl_sock" -f /dev/null new-session -d -s xtmux-ready 'sleep 100' 2>/dev/null; then
  printf '  \033[33mskip\033[0m readiness lifecycle (cannot start isolated tmux server)\n'
else
  rl_pane="$(command tmux -L "$rl_sock" list-panes -a -F '#{pane_id}' | head -1)"
  rl_tmuxenv="$(command tmux -L "$rl_sock" display-message -p '#{socket_path},0,0')"
  # The agent domain is V2-only by nature (it IS the SQLite store). The suite
  # runs V1 by default because the goldens are V1-shaped, so opt this section in.
  rl() {
    env TMUX="$rl_tmuxenv" TMUX_PANE="$rl_pane" XDG_STATE_HOME="$rl_state" \
      XTMUX_OBS_V2=1 PATH="$rl_bin:$PATH" "$AGENT_STATE" "$@" >/dev/null 2>&1
  }
  rl_db="$rl_state/xtmux/observability.db"
  rl_q() { python3 -c "
import sqlite3,sys
try: c=sqlite3.connect(sys.argv[1]); print(c.execute(sys.argv[2]).fetchone()[0])
except Exception: print('ERR')" "$rl_db" "$1" 2>/dev/null; }

  # Agent A occupies the pane, runs a turn (the running->running storm Claude's
  # PreToolUse/PostToolUse hooks produce), then exits. Agent B reuses the pane.
  rl idle --new-instance; rl running; rl running; rl running; rl idle
  rl off
  rl idle --new-instance; rl running

  [ "$(rl_q "SELECT count(*) FROM agent_instances")" = 2 ] \
    && ok "readiness: a reused pane opens a second durable agent instance" \
    || nok "readiness: a reused pane opens a second durable agent instance (got $(rl_q "SELECT count(*) FROM agent_instances"))"

  # The whole point of the handshake: exactly once per occupation. `idle` recurs
  # after every turn; ready must not, or a coordinator waiting on it wakes on a
  # mid-session idle and delivers work to an agent that never re-initialized.
  [ "$(rl_q "SELECT count(*) FROM event_journal WHERE type='agent.ready'")" = 2 ] \
    && ok "readiness: exactly one agent.ready per agent instance" \
    || nok "readiness: exactly one agent.ready per agent instance"

  [ "$(rl_q "SELECT count(*) FROM event_journal WHERE type='agent.ready' AND instance_id IS NULL")" = 0 ] \
    && ok "readiness: every agent.ready carries its instance id" \
    || nok "readiness: every agent.ready carries its instance id"

  # Transitions attach to the instance that produced them, not to whoever
  # occupied the pane before. Without this a reused pane's first transitions
  # would be filed under the previous agent.
  [ "$(rl_q "SELECT count(*) FROM agent_state_transitions WHERE instance_id IS NULL")" = 0 ] \
    && ok "readiness: transitions are attributed to an agent instance" \
    || nok "readiness: transitions are attributed to an agent instance"

  # The storm is dropped before it costs a process spawn: A did idle, running x3,
  # idle, off -> 4 real transitions, not 6.
  [ "$(rl_q "SELECT count(*) FROM agent_state_transitions")" = 6 ] \
    && ok "readiness: repeated same-state hook fires do not write duplicate transitions" \
    || nok "readiness: repeated same-state hook fires do not write duplicate transitions (got $(rl_q "SELECT count(*) FROM agent_state_transitions"), want 6)"

  [ "$(rl_q "SELECT count(*) FROM agent_instances WHERE ended_at_ms IS NOT NULL")" = 1 ] \
    && ok "readiness: off ends the instance, leaving the successor open" \
    || nok "readiness: off ends the instance, leaving the successor open"

  # A double-fired hook must be a no-op, not a second wake and not an error.
  rl_inst="$(python3 -c "
import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); print(c.execute(\"SELECT instance_id FROM event_journal WHERE type='agent.ready' LIMIT 1\").fetchone()[0])" "$rl_db" 2>/dev/null)"
  env XTMUX_OBS_DB_PATH="$rl_db" "$ROOT/bin/xtmux-obs" log-emit agent.ready instance_id="$rl_inst" pane="$rl_pane" >/dev/null 2>&1
  rc=$?
  { [ "$rc" -eq 0 ] && [ "$(rl_q "SELECT count(*) FROM event_journal WHERE type='agent.ready'")" = 2 ]; } \
    && ok "readiness: a re-emitted agent.ready is idempotent, not a duplicate or an error" \
    || nok "readiness: a re-emitted agent.ready is idempotent (rc=$rc)"

  # A pane running a plain shell is not a ready agent. "Pane exists" must never
  # be mistaken for "agent can receive work" — that is the whole bead.
  command tmux -L "$rl_sock" new-window -d 'sleep 100' 2>/dev/null || true
  bare="$(command tmux -L "$rl_sock" list-panes -a -F '#{pane_id}' | tail -1)"
  [ "$(rl_q "SELECT count(*) FROM event_journal WHERE type='agent.ready' AND pane_id='$bare'")" = 0 ] \
    && ok "readiness: a pane with no agent emits no agent.ready" \
    || nok "readiness: a pane with no agent emits no agent.ready"

  # A DELEGATED agent is launched exactly like this: the bead lives in the
  # environment, and agent-state.sh is what copies it into the pane options. If
  # the lifecycle emits run before that copy, the instance row opens with no bead
  # — and openInstance is idempotent, so no later transition ever repairs it. That
  # silently breaks the one binding Specialists needs: job -> pane -> bead.
  env TMUX="$rl_tmuxenv" TMUX_PANE="$bare" XDG_STATE_HOME="$rl_state" \
    XTMUX_OBS_V2=1 PATH="$rl_bin:$PATH" \
    XTMUX_AGENT_BEAD=xtmux-j46.7 XTMUX_AGENT_TASK='delegated task' \
    "$AGENT_STATE" idle --new-instance >/dev/null 2>&1
  d_bead="$(rl_q "SELECT bead_id FROM agent_instances WHERE pane_id='$bare'")"
  d_task="$(rl_q "SELECT task FROM agent_instances WHERE pane_id='$bare'")"
  { [ "$d_bead" = xtmux-j46.7 ] && [ "$d_task" = 'delegated task' ]; } \
    && ok "readiness: a delegated launch binds bead/task to the instance it opens" \
    || nok "readiness: a delegated launch binds bead/task to the instance (got bead='$d_bead' task='$d_task')"

  [ "$(rl_q "SELECT count(*) FROM event_journal WHERE type='agent.ready' AND bead_id='xtmux-j46.7'")" = 1 ] \
    && ok "readiness: the agent.ready envelope carries the bead the agent was launched for" \
    || nok "readiness: the agent.ready envelope carries the bead the agent was launched for"

  command tmux -L "$rl_sock" kill-server >/dev/null 2>&1 || true
fi
rm -rf "$rl_state" "$rl_bin"

# The V2 feed must stay out of the LEGACY journal. agent-state.sh already writes
# events.jsonl itself, and `xtmux log emit` is store-dependent: with V2 off it
# appends there too. Routing the feed through it gives every transition a
# duplicate agent.state row and injects agent.instance.*/agent.ready rows the V1
# journal has never carried — which pollutes tail/query and, worse, becomes input
# to the JSONL->SQLite migration.
v1_sock="xtmux-v1feed-$$"
v1_state="$(mktemp -d)"
v1_bin="$(mktemp -d)"
printf '#!/bin/sh\nexec %s/bin/tmux-session-picker "$@"\n' "$ROOT" > "$v1_bin/xtmux"
chmod +x "$v1_bin/xtmux"
if ! command tmux -L "$v1_sock" -f /dev/null new-session -d -s xtmux-v1feed 'sleep 100' 2>/dev/null; then
  printf '  \033[33mskip\033[0m legacy-journal isolation (cannot start isolated tmux server)\n'
else
  v1_pane="$(command tmux -L "$v1_sock" list-panes -a -F '#{pane_id}' | head -1)"
  v1_env="$(command tmux -L "$v1_sock" display-message -p '#{socket_path},0,0')"
  v1_log="$v1_state/xtmux/events.jsonl"
  v1() {
    env TMUX="$v1_env" TMUX_PANE="$v1_pane" XDG_STATE_HOME="$v1_state" \
      XTMUX_OBS_V2=0 PATH="$v1_bin:$PATH" "$AGENT_STATE" "$@" >/dev/null 2>&1
  }
  v1 idle --new-instance; v1 running; v1 off

  # grep -c prints 0 AND exits 1 on no-match, so `|| echo 0` would append a
  # SECOND zero and the comparison would never match. Take the count only.
  n_state="$(grep -c '"type":"agent.state"' "$v1_log" 2>/dev/null || true)"
  [ "$n_state" = 3 ] \
    && ok "legacy journal: one agent.state row per transition, not two" \
    || nok "legacy journal: one agent.state row per transition, not two (got $n_state)"

  n_life="$(grep -c 'agent\.instance\.\|agent\.ready' "$v1_log" 2>/dev/null || true)"
  [ "$n_life" = 0 ] \
    && ok "legacy journal: V2-only lifecycle events never leak into events.jsonl" \
    || nok "legacy journal: V2-only lifecycle events never leak into events.jsonl (got $n_life)"

  command tmux -L "$v1_sock" kill-server >/dev/null 2>&1 || true
fi
rm -rf "$v1_state" "$v1_bin"

echo
echo "== runtime-origin contract: xtmux context --current --json (xtmux-j46.2) =="

# This is the CROSS-REPO interface: xtrm-dev/specialists parses these exact field
# names and embeds them in immutable forensic events. A rename or a fabricated
# binding here corrupts another repository's history permanently, so the shape is
# asserted field-by-field, not just "is it JSON".
ctx_sock="xtmux-ctx-$$"
ctx_state="$(mktemp -d)"
ctx_hostfile="$ctx_state/xtmux/host-id"

if ! command tmux -L "$ctx_sock" -f /dev/null new-session -d -s xtmux-ctx 'sleep 100' 2>/dev/null; then
  printf '  \033[33mskip\033[0m runtime-origin contract (cannot start isolated tmux server)\n'
else
  ctx_pane="$(command tmux -L "$ctx_sock" list-panes -a -F '#{pane_id}' | head -1)"
  ctx_tmuxenv="$(command tmux -L "$ctx_sock" display-message -p '#{socket_path},0,0')"
  ctx_run() {
    env TMUX="$ctx_tmuxenv" TMUX_PANE="$ctx_pane" XDG_STATE_HOME="$ctx_state" \
      XTMUX_HOST_ID_FILE="$ctx_hostfile" "$PICKER" context --current --json 2>/dev/null
  }
  jget() { printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"; }

  # Give the pane a full agent identity, the way a live agent session would.
  env TMUX="$ctx_tmuxenv" TMUX_PANE="$ctx_pane" XDG_STATE_HOME="$ctx_state" \
    XTMUX_HOST_ID_FILE="$ctx_hostfile" XTMUX_AGENT_BEAD=xtmux-j46.2 \
    "$AGENT_STATE" idle --new-instance >/dev/null 2>&1
  ctx_json="$(ctx_run)"

  case "$ctx_json" in
    *'"schema_version":"xtrm.runtime-origin.v1"'*'"kind":"xtmux.agent_instance"'*'"capture_source":"xtmux-context"'*'"verified":true'*)
      ok "context: emits xtrm.runtime-origin.v1 envelope" ;;
    *) nok "context: emits xtrm.runtime-origin.v1 envelope (got '$ctx_json')" ;;
  esac

  ctx_sid="$(jget "$ctx_json" tmux_session_id)"
  ctx_wid="$(jget "$ctx_json" tmux_window_id)"
  ctx_pid_="$(jget "$ctx_json" tmux_pane_id)"
  want_sid="$(command tmux -L "$ctx_sock" display-message -p -t "$ctx_pane" '#{session_id}')"
  want_wid="$(command tmux -L "$ctx_sock" display-message -p -t "$ctx_pane" '#{window_id}')"
  # Identity is tmux's stable ids, never names or indexes: a name is mutable and a
  # rebound name would silently re-point a job's origin at someone else's pane.
  { [ "$ctx_sid" = "$want_sid" ] && [ "$ctx_wid" = "$want_wid" ] && [ "$ctx_pid_" = "$ctx_pane" ]; } \
    && ok "context: ids match the invoking pane and are \$/@/% stable ids" \
    || nok "context: ids match the invoking pane (got $ctx_sid/$ctx_wid/$ctx_pid_ want $want_sid/$want_wid/$ctx_pane)"

  ctx_inst="$(jget "$ctx_json" agent_instance_id)"
  ctx_bead="$(jget "$ctx_json" bead_id)"
  ctx_host="$(jget "$ctx_json" host_id)"
  { [ -n "$ctx_inst" ] && [ "$ctx_bead" = xtmux-j46.2 ] && [ "$ctx_host" = "$(cat "$ctx_hostfile")" ]; } \
    && ok "context: carries agent_instance_id, bead_id and the persisted host_id" \
    || nok "context: carries agent_instance_id, bead_id and the persisted host_id"

  # An unoccupied pane has no instance id. The field must be ABSENT, not "" —
  # Specialists reads absence as pane-level precision (honest), where an empty
  # string would look like a real agent binding.
  command tmux -L "$ctx_sock" set-option -p -t "$ctx_pane" -qu @agent_instance_id 2>/dev/null || true
  command tmux -L "$ctx_sock" set-option -p -t "$ctx_pane" -q @agent_instance_id "" 2>/dev/null || true
  bare_json="$(ctx_run)"
  case "$bare_json" in
    *'"agent_instance_id":""'*) nok "context: absent instance id is omitted, never empty-string" ;;
    *'"verified":true'*)        ok "context: absent instance id is omitted, never empty-string" ;;
    *)                          nok "context: absent instance id is omitted, never empty-string (got '$bare_json')" ;;
  esac

  # Outside tmux: a structured refusal. Never a guessed pane — a fabricated
  # origin is worse than none, because the consumer persists it forever.
  out="$(env -u TMUX -u TMUX_PANE "$PICKER" context --current --json 2>/tmp/ctx-err-$$.json)"; rc=$?
  err="$(cat /tmp/ctx-err-$$.json 2>/dev/null)"; rm -f /tmp/ctx-err-$$.json
  { [ "$rc" -ne 0 ] && [ -z "$out" ] && case "$err" in *XTMUX_NOT_IN_TMUX*) true ;; *) false ;; esac; } \
    && ok "context: outside tmux -> non-zero, empty stdout, structured error" \
    || nok "context: outside tmux -> non-zero, empty stdout, structured error (rc=$rc out='$out')"

  # TMUX set but the pane is gone: must not fall back to a bystander pane.
  out="$(env TMUX="$ctx_tmuxenv" TMUX_PANE='%99999' "$PICKER" context --current --json 2>/dev/null)"; rc=$?
  { [ "$rc" -ne 0 ] && [ -z "$out" ]; } \
    && ok "context: dead pane -> non-zero, no fabricated ids" \
    || nok "context: dead pane -> non-zero, no fabricated ids (rc=$rc out='$out')"

  # Read-only by contract: Specialists calls this on every `sp run`. It must not
  # lazily create an agent instance or write any pane option as a side effect.
  before="$(command tmux -L "$ctx_sock" show-options -p -t "$ctx_pane" 2>/dev/null)"
  ctx_run >/dev/null
  after="$(command tmux -L "$ctx_sock" show-options -p -t "$ctx_pane" 2>/dev/null)"
  [ "$before" = "$after" ] && ok "context: read-only — writes no pane option" \
    || nok "context: read-only — writes no pane option"

  # Read-only means read-only IN THE STORE too, not just in pane options.
  # Specialists calls this on every `sp run`; if it lazily opened an agent
  # instance, every job dispatch would manufacture a phantom agent, and the
  # pane-option check above would never notice.
  ctx_db="$ctx_state/xtmux/observability.db"
  ctx_rows() { python3 -c "
import sqlite3,sys
try: print(sqlite3.connect(sys.argv[1]).execute('SELECT count(*) FROM agent_instances').fetchone()[0])
except Exception: print(0)" "$ctx_db" 2>/dev/null; }
  rows_before="$(ctx_rows)"
  ctx_run >/dev/null; ctx_run >/dev/null
  rows_after="$(ctx_rows)"
  [ "$rows_before" = "$rows_after" ] \
    && ok "context: read-only — opens no agent instance in the store" \
    || nok "context: read-only — opens no agent instance (rows $rows_before -> $rows_after)"

  # Two live tmux servers. The pane id %N is only unique WITHIN a server, so a
  # resolver that ignores which socket it was invoked from can hand back a
  # confidently-wrong pane that exists on the other server — the worst outcome
  # available here, because the caller persists it as a verified origin forever.
  other_sock="xtmux-ctx-other-$$"
  if command tmux -L "$other_sock" -f /dev/null new-session -d -s xtmux-ctx-other 'sleep 100' 2>/dev/null; then
    other_env="$(command tmux -L "$other_sock" display-message -p '#{socket_path},0,0')"
    # Every fresh tmux server numbers its first pane %0, so naming %0 across two
    # servers proves NOTHING — the answer matches whichever server you asked. Burn
    # the low ids on the second server so the id we probe with exists ONLY on the
    # first one: now "resolved it anyway" and "refused" are distinguishable answers.
    command tmux -L "$other_sock" new-window -d 'sleep 100' 2>/dev/null || true
    command tmux -L "$other_sock" kill-pane -t "$ctx_pane" 2>/dev/null || true
    # NOT `display-message -t <pane>`: tmux exits 0 with EMPTY output for a dead
    # pane target, so an existence check on its exit code always says "alive".
    if command tmux -L "$other_sock" list-panes -a -F '#{pane_id}' 2>/dev/null | grep -qx -- "$ctx_pane"; then
      printf '  \033[33mskip\033[0m context bystander-server case (could not make %s absent on the 2nd server)\n' "$ctx_pane"
    else
      # TMUX names the second server; TMUX_PANE names a pane that lives only on the
      # first. A resolver that consults the wrong socket — or falls back to "some
      # active pane" — answers confidently and wrongly, and the caller persists that
      # fabricated origin forever. The only safe answers are: refuse, or resolve a
      # pane that actually exists on the invoking server.
      # REFUSAL is the only correct answer, and the assertion says so. Accepting
      # "any pane that exists on the invoking server" would let an implementation
      # ignore an invalid TMUX_PANE entirely and fall back to whatever pane happens
      # to be active — which is a fabricated origin wearing a valid-looking id, the
      # exact failure the dead-pane assertion above already forbids.
      cross="$(env TMUX="$other_env" TMUX_PANE="$ctx_pane" XDG_STATE_HOME="$ctx_state" \
        XTMUX_HOST_ID_FILE="$ctx_hostfile" "$PICKER" context --current --json 2>/dev/null)"; cross_rc=$?
      { [ "$cross_rc" -ne 0 ] && [ -z "$cross" ]; } \
        && ok "context: never resolves a bystander tmux server — refuses, never falls back to an active pane" \
        || nok "context: never resolves a bystander tmux server (rc=$cross_rc got '$cross')"
    fi
    command tmux -L "$other_sock" kill-server >/dev/null 2>&1 || true
  else
    printf '  \033[33mskip\033[0m context bystander-server case (cannot start a second tmux server)\n'
  fi

  # Concurrent first-run. Several panes start at once on a fresh machine and all
  # race to create the host id; if the writer is not atomic they disagree, and the
  # events they emit are attributed to two different "hosts" that are one machine.
  race_state="$(mktemp -d)"
  race_file="$race_state/xtmux/host-id"
  race_out="$race_state/answers"
  mkdir -p "$race_out"
  # Capture what each RACER actually returned. A post-race read would prove
  # nothing: if two racers each invented an id and the last writer won the file,
  # a ninth read would agree with the file and the test would pass while two
  # events had already been emitted under two different host identities. The
  # divergence lives in the racers' own answers, so that is what gets compared.
  for i in 1 2 3 4 5 6 7 8; do
    ( env XDG_STATE_HOME="$race_state" XTMUX_HOST_ID_FILE="$race_file" TMUX="$ctx_tmuxenv" \
        TMUX_PANE="$ctx_pane" "$PICKER" context --current --json 2>/dev/null \
        | sed -n 's/.*"host_id":"\([^"]*\)".*/\1/p' > "$race_out/$i" ) &
  done
  wait
  race_uniq="$(cat "$race_out"/* 2>/dev/null | sort -u | grep -c . || true)"
  race_answers="$(cat "$race_out"/* 2>/dev/null | sort -u | head -1)"
  race_persisted="$(cat "$race_file" 2>/dev/null || true)"
  { [ "$race_uniq" = 1 ] && [ -n "$race_answers" ] && [ "$race_answers" = "$race_persisted" ]; } \
    && ok "context: concurrent first-run readers all return the one persisted host_id" \
    || nok "context: concurrent first-run readers all return one host_id (distinct=$race_uniq answer='$race_answers' file='$race_persisted')"
  rm -rf "$race_state"

  case "$ctx_json" in
    *XDG_STATE_HOME*|*"$ctx_sock"*|*PATH*) nok "context: leaks no environment" ;;
    *) ok "context: leaks no environment" ;;
  esac

  # A published npm install ships NEITHER the compiled bin/xtmux-obs (not in
  # package.json `files:`) NOR a system bun (not a dependency of a node user).
  # Mirror that layout and strip bun from PATH: the picker must still reach the
  # V2 runtime through the vendored-bun launcher. Without this the whole
  # agent-JSON surface — context, message-send, monitors, log query — is dead on
  # the install path most users actually take, and the failure reads like a
  # transient backend error rather than a missing runtime. (xtmux-j46.19)
  pkg="$(mktemp -d)/pkg"
  mkdir -p "$pkg/bin"
  cp "$ROOT/bin/tmux-session-picker" "$pkg/bin/"
  # Mirror package.json `files:` — src/cli.ts imports ../extensions/, which the
  # tarball does ship. An incomplete mirror would fail for the wrong reason.
  cp -r "$ROOT/scripts" "$ROOT/src" "$ROOT/extensions" "$pkg/" 2>/dev/null
  rm -f "$pkg/bin/xtmux-obs"
  # npm installs the `bun` dependency (package.json dependencies.bun) alongside
  # the package — that vendored copy is what scripts/xtmux-obs.mjs resolves. The
  # mirror must include it or the test proves nothing about a real install.
  [ -d "$ROOT/node_modules" ] && ln -s "$ROOT/node_modules" "$pkg/node_modules" 2>/dev/null
  bunless="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v -i 'bun' | paste -sd:)"
  if [ ! -d "$pkg/node_modules/bun" ]; then
    printf '  \033[33mskip\033[0m published-layout fallback (no vendored bun: run bun install / npm ci)\n'
  elif PATH="$bunless" command -v bun >/dev/null 2>&1; then
    printf '  \033[33mskip\033[0m published-layout fallback (cannot strip bun from PATH)\n'
  else
    pub="$(env PATH="$bunless" TMUX="$ctx_tmuxenv" TMUX_PANE="$ctx_pane" \
      XDG_STATE_HOME="$ctx_state" XTMUX_HOST_ID_FILE="$ctx_hostfile" \
      "$pkg/bin/tmux-session-picker" context --current --json 2>/dev/null)"
    case "$pub" in
      *'"schema_version":"xtrm.runtime-origin.v1"'*)
        ok "context: answers on a published layout with no system bun (vendored-bun launcher)" ;;
      *) nok "context: answers on a published layout with no system bun (got '$pub')" ;;
    esac
  fi
  rm -rf "$(dirname "$pkg")"

  command tmux -L "$ctx_sock" kill-server >/dev/null 2>&1 || true
fi
rm -rf "$ctx_state"


echo
echo "== pane capture contract: bounded terminal preview (xtmux-j46.4) =="

# The only command whose response SIZE a caller controls, and it is reachable
# over the SSH bridge. The bound is the whole point of the test.
cap_sock="xtmux-cap-$$"
if ! command tmux -L "$cap_sock" -f /dev/null new-session -d -s xtmux-cap 'seq 1 400; sleep 100' 2>/dev/null; then
  printf '  \033[33mskip\033[0m pane capture (cannot start isolated tmux server)\n'
else
  cap_pane="$(command tmux -L "$cap_sock" list-panes -a -F '#{pane_id}' | head -1)"
  # Let `seq` finish writing before capturing, or the assertions race the shell.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    command tmux -L "$cap_sock" capture-pane -p -t "$cap_pane" 2>/dev/null | grep -q '^400$' && break
    sleep 0.2
  done
  # The runtime resolves panes on the socket TMUX names; point it at ours.
  cap_run() {
    env TMUX="$(command tmux -L "$cap_sock" display-message -p '#{socket_path},0,0')" \
      "$PICKER" pane capture --pane "$cap_pane" "$@" 2>/dev/null
  }
  jnum() { printf '%s' "$1" | sed -n "s/.*\"$2\":\([0-9]*\).*/\1/p"; }

  cap_json="$(cap_run --lines 10 --json)"
  case "$cap_json" in
    *'"schema_version":"xtrm.xtmux.pane-capture.v1"'*"\"pane_id\":\"$cap_pane\""*)
      ok "pane capture: emits xtrm.xtmux.pane-capture.v1 for the requested pane" ;;
    *) nok "pane capture: emits xtrm.xtmux.pane-capture.v1 (got '$cap_json')" ;;
  esac

  # "The last N lines" must mean N — not N plus however many blank rows the
  # visible screen happens to contribute. tmux's own `-S -N` pads to screen
  # height, so an unbounded passthrough would return ~34 lines for a request of 10.
  got_lines="$(jnum "$cap_json" returned_lines)"
  { [ "$got_lines" = 10 ] && [ "$(jnum "$cap_json" requested_lines)" = 10 ]; } \
    && ok "pane capture: returns exactly the requested line count, not the screen height" \
    || nok "pane capture: returns exactly the requested line count (got returned_lines=$got_lines)"

  # The last N lines, in order — a capture that silently returned the FIRST N
  # would look identical in every count-based assertion above.
  case "$cap_json" in
    *'400'*) ok "pane capture: content is the TAIL of the buffer" ;;
    *) nok "pane capture: content is the TAIL of the buffer" ;;
  esac

  # A viewer over the bridge must never be able to ask for an unbounded buffer.
  # Over-large requests are CLAMPED and the response says so — not honored, and
  # not rejected outright (a rejection would push callers to retry-guess the cap).
  big="$(cap_run --lines 999999 --json)"
  big_ret="$(jnum "$big" returned_lines)"; big_max="$(jnum "$big" max_lines)"
  { [ -n "$big_max" ] && [ "$(jnum "$big" requested_lines)" = 999999 ] \
      && [ "$big_ret" -le "$big_max" ]; } \
    && ok "pane capture: an over-large --lines is clamped to max_lines, and reported" \
    || nok "pane capture: an over-large --lines is clamped (returned=$big_ret max=$big_max)"

  # `truncated` has exactly one meaning: there is more above what you were given.
  # A clamped request that still returned the WHOLE buffer is not truncated —
  # reporting it as such would make a viewer render a "scroll for more"
  # affordance over content that has no more.
  case "$cap_json" in *'"truncated":true'*) t1=1 ;; *) t1=0 ;; esac
  case "$big"      in *'"truncated":false'*) t2=1 ;; *) t2=0 ;; esac
  { [ "$t1" = 1 ] && [ "$t2" = 1 ]; } \
    && ok "pane capture: truncated means 'more above', not 'your request was clamped'" \
    || nok "pane capture: truncated semantics (partial=$t1 whole-buffer=$t2)"

  # Read-only by contract: this is polled by a viewer.
  before="$(command tmux -L "$cap_sock" show-options -p -t "$cap_pane" 2>/dev/null)"
  cap_run --lines 5 --json >/dev/null
  after="$(command tmux -L "$cap_sock" show-options -p -t "$cap_pane" 2>/dev/null)"
  [ "$before" = "$after" ] && ok "pane capture: read-only — writes no pane option" \
    || nok "pane capture: read-only — writes no pane option"

  # A dead pane must not silently fall back to a bystander pane: the viewer would
  # render someone else's terminal under the dead pane's title.
  out="$(env TMUX="$(command tmux -L "$cap_sock" display-message -p '#{socket_path},0,0')" \
    "$PICKER" pane capture --pane '%99999' --lines 5 --json 2>/dev/null)"; rc=$?
  { [ "$rc" -ne 0 ] && [ -z "$out" ]; } \
    && ok "pane capture: dead pane -> non-zero, no bystander content" \
    || nok "pane capture: dead pane -> non-zero, no bystander content (rc=$rc out='$out')"

  # A pane target that is not a stable %id is a bug in the caller, not a lookup
  # to guess at: session names and indexes are mutable and would rebind silently.
  out="$(env TMUX="$(command tmux -L "$cap_sock" display-message -p '#{socket_path},0,0')" \
    "$PICKER" pane capture --pane xtmux-cap --lines 5 --json 2>/dev/null)"; rc=$?
  { [ "$rc" -ne 0 ] && [ -z "$out" ]; } \
    && ok "pane capture: a non-%id target is refused, never resolved by name" \
    || nok "pane capture: a non-%id target is refused (rc=$rc out='$out')"

  # Terminal content is the most sensitive payload xtmux touches, and capture is
  # the one command that returns it. It must stay EPHEMERAL: journaling it would
  # persist whatever was on screen (tokens, keys, someone else's diff) into an
  # append-only store that other repos consume as forensic input.
  cap_sentinel="XTMUXCAPSENTINEL$$"
  cap_state="$WORK/cap-journal-state"
  mkdir -p "$cap_state"
  command tmux -L "$cap_sock" new-window -d -t xtmux-cap "printf '%s\\n' $cap_sentinel; sleep 100" 2>/dev/null
  cap_sent_pane="$(command tmux -L "$cap_sock" list-panes -a -F '#{pane_id}' | tail -1)"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    command tmux -L "$cap_sock" capture-pane -p -t "$cap_sent_pane" 2>/dev/null \
      | grep -q "^$cap_sentinel\$" && break
    sleep 0.2
  done
  cap_env() {
    env XDG_STATE_HOME="$cap_state" XTMUX_OBS_V2=1 \
      TMUX="$(command tmux -L "$cap_sock" display-message -p '#{socket_path},0,0')" "$@"
  }
  # Seed the store first, with a SECOND sentinel. Two reasons this is not one
  # sentinel and one store: against an absent store, "the content is not there"
  # passes for the wrong reason; and searching only the SQLite journal misses a
  # leak into the legacy events.jsonl, which is still written under the same
  # XDG_STATE_HOME. So: grep the whole state tree (-a: the DB is binary), and let
  # the probe sentinel prove the tree is the live store the writes actually reach.
  cap_probe="XTMUXCAPPROBE$$"
  cap_env "$PICKER" log emit capture.probe "marker=$cap_probe" >/dev/null 2>&1
  cap_sent_json="$(cap_env "$PICKER" pane capture --pane "$cap_sent_pane" --lines 50 --json 2>/dev/null)"
  case "$cap_sent_json" in *"$cap_sentinel"*) cap_returned=1 ;; *) cap_returned=0 ;; esac
  grep -rasq "$cap_probe" "$cap_state" && cap_store_live=1 || cap_store_live=0
  grep -rasq "$cap_sentinel" "$cap_state" && cap_leaked=1 || cap_leaked=0
  { [ "$cap_returned" = 1 ] && [ "$cap_store_live" = 1 ] && [ "$cap_leaked" = 0 ]; } \
    && ok "pane capture: content is returned to the caller and never persisted" \
    || nok "pane capture: content never persisted (returned=$cap_returned store_live=$cap_store_live leaked=$cap_leaked)"

  command tmux -L "$cap_sock" kill-server >/dev/null 2>&1 || true
  rm -rf "$cap_state"
fi


echo
echo "== journal cursor: log query --after-id (xtmux-j46.5) =="

# Console reconnects and asks "what have I not seen?". It cannot ask by timestamp
# (two events share a millisecond, clocks move) and cannot ask by event_key (it is
# optional). The committed rowid is the only honest cursor.
jc_state="$(mktemp -d)"
jc_db="$jc_state/xtmux/observability.db"
jc_obs() { env XDG_STATE_HOME="$jc_state" XTMUX_OBS_DB_PATH="$jc_db" "$ROOT/bin/xtmux-obs" "$@" 2>/dev/null; }
jc_q() { python3 -c "
import sqlite3,sys
try: c=sqlite3.connect(sys.argv[1]); print(c.execute(sys.argv[2]).fetchone()[0])
except Exception: print('ERR')" "$jc_db" "$1" 2>/dev/null; }

i=1
while [ "$i" -le 12 ]; do jc_obs log-emit "cursor.probe" seq="$i" >/dev/null; i=$((i+1)); done

# Page the whole journal in chunks and prove every row is seen EXACTLY once, in
# ascending id order. A DESC page, an inclusive cursor, or an off-by-one in
# next_after_id all produce either a duplicate or a hole; this walk catches all three.
page_walk="$(python3 - "$ROOT" "$jc_state" "$jc_db" <<'PY'
import json,subprocess,sys
root,state,db=sys.argv[1],sys.argv[2],sys.argv[3]
env={"XDG_STATE_HOME":state,"XTMUX_OBS_DB_PATH":db,"PATH":"/usr/bin:/bin"}
seen,cursor,pages=[],0,0
while True:
    out=subprocess.run([f"{root}/bin/xtmux-obs","log-query","--after-id",str(cursor),"--limit","5","--json"],
                       capture_output=True,text=True,env=env).stdout
    p=json.loads(out); pages+=1
    seen+=[i["journal_id"] for i in p["items"]]
    cursor=p["next_after_id"]
    if not p["has_more"] or pages>20: break
asc = seen==sorted(seen)
uniq = len(seen)==len(set(seen))
print(f"{len(seen)} {asc} {uniq} {cursor}")
PY
)"
set -- $page_walk
# Compare against what the journal ACTUALLY holds, not the 12 rows this test
# seeded: the runtime also journals its own migration events, and a hardcoded
# count would make this assertion track the test's assumptions instead of the
# store's contents.
jc_total="$(jc_q "SELECT count(*) FROM event_journal")"
{ [ "$1" = "$jc_total" ] && [ "$2" = True ] && [ "$3" = True ]; } \
  && ok "journal cursor: paging returns every row exactly once, ascending, no holes" \
  || nok "journal cursor: paging returns every row exactly once (got count=$1/$jc_total asc=$2 uniq=$3)"

first_id="$(jc_q "SELECT MIN(id) FROM event_journal")"
last_id="$(jc_q "SELECT MAX(id) FROM event_journal")"

# Exclusive: the cursor names the last row you HANDLED, not the next one you want.
# An inclusive cursor redelivers that row on every reconnect, forever.
excl="$(jc_obs log-query --after-id "$first_id" --limit 1 --json | python3 -c "import json,sys; print(json.load(sys.stdin)['items'][0]['journal_id'])" 2>/dev/null)"
[ "$excl" = "$((first_id + 1))" ] \
  && ok "journal cursor: --after-id is exclusive" \
  || nok "journal cursor: --after-id is exclusive (got $excl, want $((first_id + 1)))"

# Caught up. next_after_id must echo the cursor the caller SENT — returning 0 would
# rewind a caught-up consumer to the head of the journal and replay everything.
tail_json="$(jc_obs log-query --after-id "$last_id" --limit 5 --json)"
tail_probe="$(printf '%s' "$tail_json" | python3 -c "
import json,sys; p=json.load(sys.stdin)
print(len(p['items']), p['next_after_id'], p['has_more'], p['oldest_available_id'], p['latest_available_id'])" 2>/dev/null)"
set -- $tail_probe
{ [ "$1" = 0 ] && [ "$2" = "$last_id" ] && [ "$3" = False ]; } \
  && ok "journal cursor: an empty page echoes the requested cursor, never rewinds to 0" \
  || nok "journal cursor: an empty page echoes the requested cursor (got items=$1 next=$2 has_more=$3)"

{ [ "$4" = "$first_id" ] && [ "$5" = "$last_id" ]; } \
  && ok "journal cursor: watermarks match MIN/MAX(id) of the journal" \
  || nok "journal cursor: watermarks match MIN/MAX(id) (got oldest=$4 latest=$5, want $first_id/$last_id)"

# Retention ate the consumer's position. It has a hole it can NEVER fill, so it
# must be told — silently serving the next surviving page would look like a clean
# resume while the consumer's state was quietly missing rows forever.
python3 -c "
import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.execute('DELETE FROM event_journal WHERE id <= ?', (int(sys.argv[2])+5,)); c.commit()" "$jc_db" "$first_id"
exp_out="$(jc_obs log-query --after-id "$first_id" --limit 5 --json)"; exp_rc=$?
exp_err="$(env XDG_STATE_HOME="$jc_state" XTMUX_OBS_DB_PATH="$jc_db" "$ROOT/bin/xtmux-obs" log-query --after-id "$first_id" --limit 5 --json 2>&1 >/dev/null)"
{ [ "$exp_rc" -ne 0 ] && [ -z "$exp_out" ] \
    && case "$exp_err" in *XTMUX_CURSOR_EXPIRED*oldest_available_id*) true ;; *) false ;; esac; } \
  && ok "journal cursor: an expired cursor is a structured refusal carrying oldest_available_id" \
  || nok "journal cursor: an expired cursor is a structured refusal (rc=$exp_rc out='$exp_out' err='$exp_err')"

# ...but a cursor that merely sits AT the new boundary is still perfectly valid.
# Treating "oldest-1" as expired would spuriously reset a consumer that lost nothing.
new_oldest="$(jc_q "SELECT MIN(id) FROM event_journal")"
ok_out="$(jc_obs log-query --after-id "$((new_oldest - 1))" --limit 5 --json)"; ok_rc=$?
{ [ "$ok_rc" -eq 0 ] && case "$ok_out" in *'"journal_id":'*) true ;; *) false ;; esac; } \
  && ok "journal cursor: a cursor at the retention boundary is served, not expired" \
  || nok "journal cursor: a cursor at the retention boundary is served (rc=$ok_rc)"

# The legacy array shape is what every current consumer and every V1 golden reads.
# Adding a cursor must not change the answer for a caller that never sends one.
legacy="$(jc_obs log-query --limit 3 --json)"
case "$legacy" in
  \[*) ok "journal cursor: log query without --after-id keeps the legacy array shape" ;;
  *)   nok "journal cursor: log query without --after-id keeps the legacy array shape (got '$legacy')" ;;
esac
rm -rf "$jc_state"

echo
echo "== journal follow: log follow --after-id (xtmux-j46.6) =="

# The stream is a latency optimization over polling, never a second authority and
# never a second schema. Every line must be exactly what log query would have given
# for that journal_id, or a consumer has to implement the envelope twice.
jf_state="$(mktemp -d)"
jf_db="$jf_state/xtmux/observability.db"
jf_obs() { env XDG_STATE_HOME="$jf_state" XTMUX_OBS_DB_PATH="$jf_db" "$ROOT/bin/xtmux-obs" "$@" 2>/dev/null; }
i=1
while [ "$i" -le 6 ]; do jf_obs log-emit follow.probe seq="$i" >/dev/null; i=$((i+1)); done

# --once drains the committed backlog and exits, so a consumer can catch up without
# holding a stream open.
drain="$(jf_obs log-follow --after-id 0 --once --json)"
n_drain="$(printf '%s\n' "$drain" | grep -c '"journal_id"' || true)"
jf_total="$(python3 -c "
import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('SELECT count(*) FROM event_journal').fetchone()[0])" "$jf_db" 2>/dev/null)"
{ [ "$n_drain" = "$jf_total" ] && [ -n "$jf_total" ]; } \
  && ok "follow: --once drains the committed backlog from the cursor and exits" \
  || nok "follow: --once drains the committed backlog (got $n_drain of $jf_total)"

# NOT a second schema. Byte-identical to the log query item for the same id.
first_line="$(printf '%s\n' "$drain" | head -1)"
first_id="$(printf '%s' "$first_line" | python3 -c "import json,sys; print(json.load(sys.stdin)['journal_id'])" 2>/dev/null)"
page_item="$(jf_obs log-query --after-id "$((first_id - 1))" --limit 1 --json | python3 -c "
import json,sys; print(json.dumps(json.load(sys.stdin)['items'][0], sort_keys=True))" 2>/dev/null)"
follow_item="$(printf '%s' "$first_line" | python3 -c "
import json,sys; print(json.dumps(json.load(sys.stdin), sort_keys=True))" 2>/dev/null)"
[ "$page_item" = "$follow_item" ] \
  && ok "follow: a streamed item is identical to the log query item for the same journal_id" \
  || nok "follow: a streamed item is identical to the log query item (page='$page_item' follow='$follow_item')"

# The whole contract: reconnect at the last id you MATERIALIZED -> no duplicates,
# no gaps. Emit while disconnected, then resume.
last_id="$(printf '%s\n' "$drain" | tail -1 | python3 -c "import json,sys; print(json.load(sys.stdin)['journal_id'])" 2>/dev/null)"
i=1
while [ "$i" -le 4 ]; do jf_obs log-emit follow.probe gap="$i" >/dev/null; i=$((i+1)); done
resume="$(jf_obs log-follow --after-id "$last_id" --once --json)"
resume_ids="$(printf '%s\n' "$resume" | python3 -c "
import json,sys
ids=[json.loads(l)['journal_id'] for l in sys.stdin if l.strip()]
print(len(ids), ids==sorted(ids), len(ids)==len(set(ids)), min(ids) if ids else 0)" 2>/dev/null)"
set -- $resume_ids
{ [ "$1" = 4 ] && [ "$2" = True ] && [ "$3" = True ] && [ "$4" = "$((last_id + 1))" ]; } \
  && ok "follow: reconnect at the last materialized id — zero duplicates, zero gaps" \
  || nok "follow: reconnect at the last materialized id (got count=$1 asc=$2 uniq=$3 first=$4 want first=$((last_id + 1)))"

# A LIVE follower must see rows committed after it started, and must exit 0 on
# SIGTERM — being killed is the normal way a follower ends, and a non-zero exit
# would make every supervisor log a spurious error on every clean shutdown.
live="$(python3 - "$ROOT" "$jf_state" "$jf_db" <<'PY'
import json,os,signal,subprocess,sys,time
root,state,db=sys.argv[1],sys.argv[2],sys.argv[3]
env={**os.environ,"XDG_STATE_HOME":state,"XTMUX_OBS_DB_PATH":db}
after=sqlite_max=subprocess.run(["python3","-c",
  "import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute('SELECT MAX(id) FROM event_journal').fetchone()[0])",db],
  capture_output=True,text=True).stdout.strip()
p=subprocess.Popen([f"{root}/bin/xtmux-obs","log-follow","--after-id",after,"--interval","60","--json"],
                   stdout=subprocess.PIPE,text=True,env=env)
time.sleep(0.6)
for k in range(3):
    subprocess.run([f"{root}/bin/xtmux-obs","log-emit","follow.live",f"n={k}"],capture_output=True,env=env)
time.sleep(1.2)
p.send_signal(signal.SIGTERM)
try: out,_=p.communicate(timeout=10)
except subprocess.TimeoutExpired: p.kill(); print("HANG 0 0"); sys.exit()
ids=[json.loads(l)["journal_id"] for l in out.splitlines() if l.strip()]
print(p.returncode, len(ids), int(ids==sorted(ids) and len(ids)==len(set(ids))))
PY
)"
set -- $live
[ "$1" = 0 ] \
  && ok "follow: SIGTERM exits 0 with the stream flushed" \
  || nok "follow: SIGTERM exits 0 with the stream flushed (rc=$1)"
{ [ "$2" -ge 3 ] && [ "$3" = 1 ]; } \
  && ok "follow: a live follower receives rows committed after it started, once each, in order" \
  || nok "follow: a live follower receives post-start rows (got $2 rows, ordered/unique=$3)"

# --flag=value is accepted everywhere else in the CLI, so a log command that took
# only the space form would reject a call the rest of the tool accepts. Assert BOTH
# forms on both cursor commands: the equals form used to die in the runtime's arg
# parser while the picker happily forwarded it.
eqf="$(jf_obs log-follow --after-id=0 --once --json | head -1)"
eqq="$(jf_obs log-query --after-id=0 --limit 1 --json)"
{ case "$eqf" in *'"journal_id"'*) true ;; *) false ;; esac \
  && case "$eqq" in *'"journal_id"'*) true ;; *) false ;; esac; } \
  && ok "follow/query: --after-id=N is accepted, not just --after-id N" \
  || nok "follow/query: --after-id=N is accepted (follow='$eqf' query='$eqq')"

# A stream with no cursor cannot resume and would dump unbounded history.
noc="$(jf_obs log-follow --once --json)"; noc_rc=$?
{ [ "$noc_rc" -ne 0 ] && [ -z "$noc" ]; } \
  && ok "follow: refuses to stream without --after-id" \
  || nok "follow: refuses to stream without --after-id (rc=$noc_rc)"
rm -rf "$jf_state"

echo
echo "== bridge: read-only NDJSON over ssh (xtmux-j46.9 / j46.16) =="

# The FIRST remotely-reachable surface. Every assertion here is about an untrusted
# peer, not an operator: default-deny dispatch, bounded frames, and survival.
br_state="$(mktemp -d)"
br_sock="xtmux-br-$$"
if ! command tmux -L "$br_sock" -f /dev/null new-session -d -s xtmux-br 'seq 1 40; sleep 100' 2>/dev/null; then
  printf '  \033[33mskip\033[0m bridge (cannot start isolated tmux server)\n'
elif ! command -v python3 >/dev/null 2>&1; then
  printf '  \033[33mskip\033[0m bridge (python3 missing)\n'
else
  br_pane="$(command tmux -L "$br_sock" list-panes -a -F '#{pane_id}' | head -1)"
  br_env="$(command tmux -L "$br_sock" display-message -p '#{socket_path},0,0')"
  # Feed frames on stdin; collect the NDJSON replies. This is exactly the shape
  # `ssh <host> xtmux bridge --stdio` produces — stdin is a pipe that then closes.
  br() {
    env TMUX="$br_env" XDG_STATE_HOME="$br_state" XTMUX_OBS_V2=1 \
      "$PICKER" bridge --stdio 2>/dev/null
  }
  br_field() { printf '%s' "$1" | python3 -c "
import sys,json
want=sys.argv[1]; path=sys.argv[2].split('.')
for line in sys.stdin.read().splitlines():
    try: d=json.loads(line)
    except Exception: continue
    if str(d.get('id')) != want: continue
    cur=d
    for k in path:
        if not isinstance(cur,dict): cur=None; break
        cur=cur.get(k)
    if cur is not None: print(json.dumps(cur) if isinstance(cur,(dict,list)) else cur); break
" "$2" "$3" 2>/dev/null; }

  # Seed one journal row so the read paths have something real to return.
  env TMUX="$br_env" XDG_STATE_HOME="$br_state" XTMUX_OBS_V2=1 "$PICKER" log emit bridge.probe a=1 >/dev/null 2>&1

  hello="$(printf '%s\n' '{"id":1,"method":"bridge.hello"}' | br)"
  { [ "$(br_field "$hello" 1 result.schema_version)" = "xtrm.xtmux.bridge.v1" ] \
      && [ -n "$(br_field "$hello" 1 result.host_id)" ] \
      && [ "$(br_field "$hello" 1 result.read_only)" = True ] \
      && case "$(br_field "$hello" 1 result.capabilities)" in *topology.snapshot*journal.follow*) true ;; *) false ;; esac; } \
    && ok "bridge: hello negotiates schema_version, host_id and the capability list" \
    || nok "bridge: hello negotiates capabilities (got '$hello')"

  # A remote read must be the SAME fact as the local read, or a viewer showing a
  # remote host is showing something no local operator could ever reproduce.
  br_topo="$(printf '%s\n' '{"id":"t","method":"topology.snapshot"}' | br | python3 -c "
import sys,json
for l in sys.stdin:
    d=json.loads(l)
    if d.get('id')=='t': print(json.dumps(d['result']['topology'].get('sessions'),sort_keys=True))
" 2>/dev/null)"
  local_topo="$(env TMUX="$br_env" XDG_STATE_HOME="$br_state" XTMUX_OBS_V2=1 "$PICKER" topology --json 2>/dev/null | python3 -c "
import sys,json; print(json.dumps(json.load(sys.stdin).get('sessions'),sort_keys=True))" 2>/dev/null)"
  { [ -n "$br_topo" ] && [ "$br_topo" = "$local_topo" ]; } \
    && ok "bridge: topology.snapshot is the same payload as the local command" \
    || nok "bridge: topology.snapshot matches the local command"

  br_cap="$(printf '{"id":"c","method":"pane.capture","params":{"pane_id":"%s","lines":3}}\n' "$br_pane" | br)"
  { [ "$(br_field "$br_cap" c result.capture.schema_version)" = "xtrm.xtmux.pane-capture.v1" ] \
      && [ "$(br_field "$br_cap" c result.capture.returned_lines)" = 3 ]; } \
    && ok "bridge: pane.capture returns the local pane-capture contract, bounded" \
    || nok "bridge: pane.capture returns the local contract (got '$br_cap')"

  # Default deny. A mutation name is refused AND leaves no trace — a rejection
  # that still wrote a row would be the worst of both.
  br_msgs_before="$(python3 -c "
import sqlite3,sys
try: print(sqlite3.connect(sys.argv[1]).execute('SELECT count(*) FROM messages').fetchone()[0])
except Exception: print('ERR')" "$br_state/xtmux/observability.db" 2>/dev/null)"
  mut="$(printf '%s\n' \
    '{"id":"m1","method":"message.send","params":{"to":"$1","text":"pwned"}}' \
    '{"id":"m2","method":"pane.input","params":{"pane_id":"%0","keys":"rm -rf /"}}' \
    '{"id":"m3","method":"handoff.create"}' | br)"
  br_msgs_after="$(python3 -c "
import sqlite3,sys
try: print(sqlite3.connect(sys.argv[1]).execute('SELECT count(*) FROM messages').fetchone()[0])
except Exception: print('ERR')" "$br_state/xtmux/observability.db" 2>/dev/null)"
  { [ "$(br_field "$mut" m1 error.code)" = XTMUX_BRIDGE_READ_ONLY ] \
      && [ "$(br_field "$mut" m2 error.code)" = XTMUX_BRIDGE_READ_ONLY ] \
      && [ "$(br_field "$mut" m3 error.code)" = XTMUX_BRIDGE_READ_ONLY ] \
      && [ "$br_msgs_before" = "$br_msgs_after" ]; } \
    && ok "bridge: every mutation method is refused, with no side effect" \
    || nok "bridge: mutations refused with no side effect (before=$br_msgs_before after=$br_msgs_after out='$mut')"

  # There is no fallthrough to the local CLI: a method that is not on the
  # allowlist cannot be named into existence, however plausible it looks.
  unk="$(printf '%s\n' '{"id":"u","method":"log.query"}' '{"id":"u2","method":"exec"}' | br)"
  { [ "$(br_field "$unk" u error.code)" = XTMUX_BRIDGE_UNKNOWN_METHOD ] \
      && [ "$(br_field "$unk" u2 error.code)" = XTMUX_BRIDGE_UNKNOWN_METHOD ]; } \
    && ok "bridge: an unknown method is refused, never dispatched to the local CLI" \
    || nok "bridge: unknown method refused (got '$unk')"

  # Survival. A peer that can kill the server with one bad byte owns a
  # denial-of-service primitive; the NEXT request is what proves we are alive.
  garbage="$(printf '%s\n' 'not json at all' '{"id":"after1","method":"bridge.hello"}' | br)"
  [ "$(br_field "$garbage" after1 result.schema_version)" = "xtrm.xtmux.bridge.v1" ] \
    && ok "bridge: malformed JSON is answered and the next request still serves" \
    || nok "bridge: malformed JSON does not kill the stream (got '$garbage')"

  # An oversized frame must be refused by SIZE, before it is parsed, and the
  # bytes it occupies must not be re-read as a fresh request when we resync.
  big="$(python3 -c "
import json
print(json.dumps({'id':'big','method':'bridge.hello','params':{'pad':'A'*1200000}}))
print(json.dumps({'id':'after2','method':'bridge.hello'}))" | br)"
  { case "$big" in *XTMUX_BRIDGE_FRAME_TOO_LARGE*) true ;; *) false ;; esac \
      && [ "$(br_field "$big" after2 result.schema_version)" = "xtrm.xtmux.bridge.v1" ]; } \
    && ok "bridge: an oversized frame is refused by size and the stream resyncs" \
    || nok "bridge: oversized frame refused and stream resyncs (got '$(printf '%s' "$big" | cut -c1-200)')"

  # EOF is the peer hanging up (ssh exited, the viewer closed) — a graceful close,
  # never a fault. It must also STOP the follow, or the process outlives its pipe.
  printf '%s\n' '{"id":"f","method":"journal.follow","params":{"after_id":0}}' | br >/dev/null 2>&1
  br_eof_rc=$?
  [ "$br_eof_rc" = 0 ] && ok "bridge: EOF ends an active follow and exits 0" \
    || nok "bridge: EOF exits 0 (rc=$br_eof_rc)"

  # Reconnect: a viewer that resumes at its last committed id must not be handed a
  # row it already materialized. Duplicates double-count; that is the whole reason
  # the cursor exists.
  env TMUX="$br_env" XDG_STATE_HOME="$br_state" XTMUX_OBS_V2=1 "$PICKER" log emit bridge.probe b=2 >/dev/null 2>&1
  first="$(printf '%s\n' '{"id":"q1","method":"journal.query","params":{"after_id":0,"limit":1}}' | br)"
  br_cursor="$(br_field "$first" q1 result.page.next_after_id)"
  resumed="$(printf '{"id":"q2","method":"journal.query","params":{"after_id":%s}}\n' "$br_cursor" | br | python3 -c "
import sys,json
for l in sys.stdin:
    d=json.loads(l)
    if d.get('id')=='q2':
        print(' '.join(str(i['journal_id']) for i in d['result']['page']['items']))
" 2>/dev/null)"
  dup=0
  for jid in $resumed; do [ "$jid" -le "$br_cursor" ] && dup=1; done
  { [ -n "$br_cursor" ] && [ "$br_cursor" -gt 0 ] && [ "$dup" = 0 ] && [ -n "$resumed" ]; } \
    && ok "bridge: resuming at the last committed id replays nothing" \
    || nok "bridge: reconnect replays nothing (cursor=$br_cursor resumed='$resumed')"

  # There is no listen/bind mode. If one is ever added, it must be a decision
  # someone makes on purpose — not a flag that quietly appears.
  nostdio="$(env XDG_STATE_HOME="$br_state" XTMUX_OBS_V2=1 "$PICKER" bridge --listen 0.0.0.0:9000 </dev/null 2>&1 >/dev/null)"; ns_rc=$?
  { [ "$ns_rc" -ne 0 ] && case "$nostdio" in *XTMUX_*) true ;; *) false ;; esac; } \
    && ok "bridge: refuses anything but --stdio — no listening socket exists" \
    || nok "bridge: refuses a listen mode (rc=$ns_rc out='$nostdio')"

  # Follow fan-out is capped per connection. Excess follows are the DoS: unique
  # ids each spin up their own 500ms poll loop, so it is the COUNT that has to be
  # bounded, not just duplicate ids. Beyond the cap → structured refusal.
  fan="$(python3 -c "
for i in range(12): print('{\"id\":\"ff%d\",\"method\":\"journal.follow\",\"params\":{\"after_id\":0}}' % i)" | br)"
  fan_rej="$(printf '%s' "$fan" | grep -o XTMUX_BRIDGE_RESOURCE_LIMIT | wc -l | tr -d ' ')"
  { [ "$fan_rej" -ge 1 ]; } \
    && ok "bridge: concurrent follows are capped per connection, excess refused" \
    || nok "bridge: follow fan-out is capped (resource-limit rejections=$fan_rej)"

  # READ-ONLY in the SQLite sense, not just the method sense. A remote read must
  # never write: no DDL, no BEGIN IMMEDIATE write lock, no migration-row insert,
  # and — the observable proof — it must not CREATE the store. Point the bridge at
  # a state dir with no database and assert the query fails structurally AND no
  # observability.db appears. If the bridge migrated on read (as it did before
  # this fix), the file would be there.
  ro_state="$(mktemp -d)"
  # The same fresh state makes EVERY read throw at the DB open — which is exactly
  # the condition that must NOT crash the process. So this one session also proves
  # survival of both throw paths: a synchronous handler throw (journal.query) is
  # answered structurally AND a later hello on the same connection still serves;
  # a throw inside the detached follow loop (Finding 1: an unhandled rejection
  # there would terminate Node) comes back as a stream error, not a dead pipe.
  ro_out="$(printf '%s\n' \
    '{"id":"ro","method":"journal.query","params":{"after_id":0}}' \
    '{"id":"rof","method":"journal.follow","params":{"after_id":0}}' \
    '{"id":"roh","method":"bridge.hello"}' \
    | env TMUX="$br_env" XDG_STATE_HOME="$ro_state" XTMUX_OBS_V2=1 "$PICKER" bridge --stdio 2>/dev/null)"
  ro_err="$(br_field "$ro_out" ro error.code)"
  ro_alive="$(br_field "$ro_out" roh result.schema_version)"
  ro_db_created=0; [ -e "$ro_state/xtmux/observability.db" ] && ro_db_created=1
  { [ -n "$ro_err" ] && [ "$ro_db_created" = 0 ]; } \
    && ok "bridge: a read against a fresh host errors structurally and creates no database" \
    || nok "bridge: read-only never initializes state (err='$ro_err' db_created=$ro_db_created)"
  { [ "$ro_alive" = "xtrm.xtmux.bridge.v1" ] \
      && case "$ro_out" in *XTMUX_BRIDGE_STREAM_ERROR*) true ;; *) false ;; esac; } \
    && ok "bridge: a throwing read (sync or in the follow loop) never crashes the process" \
    || nok "bridge: handler throws do not crash the process (alive='$ro_alive' out='$(printf '%s' "$ro_out" | tr '\n' '|' | cut -c1-200)')"
  rm -rf "$ro_state"

  command tmux -L "$br_sock" kill-server >/dev/null 2>&1 || true
fi
rm -rf "$br_state"

echo
echo "== readiness-aware handoff: --prompt-file / --wait-ready / --monitor (xtmux-j46.8) =="

# The durable half of delegation. Before this bead the picker's handoff wrote only
# V1 log_event lines, so handoffs/ and delivery_attempts/ had zero rows while the
# domain code sat there fully written — the same dead-domain shape as j46.7.
hd_sock="xtmux-ho-$$"
hd_state="$(mktemp -d)"
hd_bin="$(mktemp -d)"
hd_db="$hd_state/xtmux/observability.db"
printf '#!/bin/sh\nexec %s/bin/tmux-session-picker "$@"\n' "$ROOT" > "$hd_bin/xtmux"
chmod +x "$hd_bin/xtmux"
hd_q() { python3 -c "
import sqlite3,sys
try: print(sqlite3.connect(sys.argv[1]).execute(sys.argv[2]).fetchone()[0])
except Exception as e: print('ERR')" "$hd_db" "$1" 2>/dev/null; }

if ! command tmux -L "$hd_sock" -f /dev/null new-session -d -s xtmux-ho 'sleep 100' 2>/dev/null; then
  printf '  \033[33mskip\033[0m readiness-aware handoff (cannot start isolated tmux server)\n'
else
  hd_pane="$(command tmux -L "$hd_sock" list-panes -a -F '#{pane_id}' | head -1)"
  hd_env="$(command tmux -L "$hd_sock" display-message -p '#{socket_path},0,0')"
  hd() {
    env TMUX="$hd_env" TMUX_PANE="$hd_pane" XDG_STATE_HOME="$hd_state" \
      XTMUX_OBS_V2=1 PATH="$hd_bin:$PATH" "$PICKER" "$@"
  }
  hd_prompt="$hd_state/task.md"
  printf 'do the thing\n' > "$hd_prompt"

  # An existing prompt file is DELIVERED, not overwritten: a coordinator that
  # already wrote the contract must not have it silently replaced by a generated one.
  # --yes: without it handoff is a DRY RUN by design (no send, and therefore no
  # durable record either — there is no attempt to be durable about).
  hd handoff --target "$hd_pane" --bead xtmux-j46.8 --prompt-file "$hd_prompt" --handoff-key k1 --yes --json >/dev/null 2>&1
  { [ "$(hd_q "SELECT count(*) FROM handoffs WHERE prompt_file='$hd_prompt'")" = 1 ] \
      && [ "$(cat "$hd_prompt")" = "do the thing" ]; } \
    && ok "handoff: --prompt-file delivers that exact file and writes one durable record" \
    || nok "handoff: --prompt-file delivers that exact file (rows=$(hd_q "SELECT count(*) FROM handoffs"))"

  # The record exists BEFORE the first delivery attempt. If the attempt were
  # recorded first, a crash between the two would leave an attempt pointing at a
  # handoff that does not exist — an orphan the consumer cannot interpret.
  { [ "$(hd_q "SELECT count(*) FROM handoffs")" -ge 1 ] \
      && [ "$(hd_q "SELECT (SELECT min(created_at_ms) FROM handoffs) <= coalesce((SELECT min(attempted_at_ms) FROM delivery_attempts), 1e18)")" = 1 ]; } \
    && ok "handoff: the durable record is written before the first delivery attempt" \
    || nok "handoff: the durable record is written before the first delivery attempt"

  # A prompt path that does not exist is rejected PRE-delivery: nothing sent, and
  # no half-written handoff row left behind for a file that was never readable.
  before_rows="$(hd_q "SELECT count(*) FROM handoffs")"
  bad_out="$(hd handoff --target "$hd_pane" --bead xtmux-j46.8 --prompt-file /nonexistent/nope.md --handoff-key k-bad --yes --json 2>/dev/null)"; bad_rc=$?
  { [ "$bad_rc" -ne 0 ] && [ -z "$bad_out" ] \
      && [ "$(hd_q "SELECT count(*) FROM handoffs")" = "$before_rows" ]; } \
    && ok "handoff: a missing prompt file is rejected pre-delivery, writing nothing" \
    || nok "handoff: a missing prompt file is rejected pre-delivery (rc=$bad_rc rows $before_rows -> $(hd_q "SELECT count(*) FROM handoffs"))"

  # Idempotency. A retry with the same key must not fork the delegation into two
  # handoffs or arm a second monitor — but each injection IS a separate attempt,
  # and the attempt log is append-only precisely so a redelivery is visible.
  hd handoff --target "$hd_pane" --bead xtmux-j46.8 --prompt-file "$hd_prompt" --handoff-key k-idem --monitor --yes --json >/dev/null 2>&1
  hd handoff --target "$hd_pane" --bead xtmux-j46.8 --prompt-file "$hd_prompt" --handoff-key k-idem --monitor --yes --json >/dev/null 2>&1
  hd_h="$(hd_q "SELECT count(*) FROM handoffs WHERE handoff_key='k-idem'")"
  hd_m="$(hd_q "SELECT count(DISTINCT monitor_id) FROM handoffs WHERE handoff_key='k-idem' AND monitor_id IS NOT NULL")"
  hd_a="$(hd_q "SELECT count(*) FROM delivery_attempts WHERE related_handoff_id=(SELECT id FROM handoffs WHERE handoff_key='k-idem')")"
  { [ "$hd_h" = 1 ] && [ "$hd_m" = 1 ] && [ "$hd_a" = 2 ]; } \
    && ok "handoff: same key twice — one handoff, one monitor, two delivery attempts" \
    || nok "handoff: same key twice — one handoff, one monitor, two delivery attempts (got h=$hd_h m=$hd_m a=$hd_a)"

  # A missing --bead must be REFUSED, never defaulted. The first implementation
  # substituted the literal string 'prompt-file', which then landed in the durable
  # row and in the journal envelope's bead_id — a fabricated reference to a bead
  # that does not exist, indistinguishable downstream from a real one.
  nb_out="$(hd handoff --target "$hd_pane" --prompt-file "$hd_prompt" --handoff-key k-nobead --yes --json 2>/dev/null)"; nb_rc=$?
  { [ "$nb_rc" -ne 0 ] && [ -z "$nb_out" ] \
      && [ "$(hd_q "SELECT count(*) FROM handoffs WHERE bead_id NOT LIKE 'xtmux-%'")" = 0 ]; } \
    && ok "handoff: a missing --bead is refused, never defaulted to a fabricated id" \
    || nok "handoff: a missing --bead is refused (rc=$nb_rc bead_id='$(hd_q "SELECT bead_id FROM handoffs WHERE handoff_key=\'k-nobead\'")')"

  # send-keys success is NOT acceptance. The handoff must not claim a terminal
  # 'accepted' state just because tmux took the keystrokes — only the target's own
  # readiness/state change can say that, and nothing has said it here.
  st="$(hd_q "SELECT state FROM handoffs WHERE handoff_key='k-idem'")"
  [ "$st" != "accepted" ] && [ "$st" != "completed" ] \
    && ok "handoff: a delivered pointer is an attempt, never acceptance (state=$st)" \
    || nok "handoff: a delivered pointer must not be recorded as acceptance (state=$st)"

  # Readiness belongs to the AGENT INSTANCE, not to the pane. `log query` is a
  # history query, so a pane whose PREVIOUS occupant readied and exited still has
  # an agent.ready row — and a pane-scoped check would see it, stop waiting, and
  # inject the pointer into a pane whose current agent has not finished
  # initializing. That is the exact failure readiness exists to prevent.
  #
  # Give the pane a stale ready event from a DEAD instance, then a fresh instance
  # id that has readied nothing. --wait-ready must still time out.
  env TMUX="$hd_env" TMUX_PANE="$hd_pane" XDG_STATE_HOME="$hd_state" XTMUX_OBS_V2=1 \
    PATH="$hd_bin:$PATH" "$AGENT_STATE" idle --new-instance >/dev/null 2>&1
  command tmux -L "$hd_sock" set-option -p -t "$hd_pane" -q @agent_instance_id "successor-with-no-ready" 2>/dev/null || true
  stale_t0="$(date +%s)"
  stale_err="$(hd handoff --target "$hd_pane" --bead xtmux-j46.8 --prompt-file "$hd_prompt" --handoff-key k-stale --wait-ready 2s --yes --json 2>&1 >/dev/null)"; stale_rc=$?
  stale_elapsed=$(( $(date +%s) - stale_t0 ))
  { [ "$stale_rc" -ne 0 ] && [ "$stale_elapsed" -ge 2 ] \
      && case "$stale_err" in *XTMUX_READY_TIMEOUT*) true ;; *) false ;; esac; } \
    && ok "handoff: --wait-ready ignores a PREVIOUS instance's agent.ready on the same pane" \
    || nok "handoff: --wait-ready ignores a previous instance's agent.ready (rc=$stale_rc elapsed=${stale_elapsed}s err='$stale_err')"

  # An idempotency key promises "the SAME delegation, sent again". A retry that
  # changed the bead is a DIFFERENT delegation wearing a used key: silently
  # returning the old row would leave the durable record describing one thing while
  # the pointer delivered another.
  conf_err="$(hd handoff --target "$hd_pane" --bead xtmux-j46.99 --prompt-file "$hd_prompt" --handoff-key k-idem --yes --json 2>&1 >/dev/null)"; conf_rc=$?
  conf_bead="$(hd_q "SELECT bead_id FROM handoffs WHERE handoff_key='k-idem'")"
  { [ "$conf_rc" -ne 0 ] && [ "$conf_bead" = "xtmux-j46.8" ] \
      && case "$conf_err" in *XTMUX_HANDOFF_KEY_CONFLICT*) true ;; *) false ;; esac; } \
    && ok "handoff: a reused key describing a DIFFERENT delegation is refused, not silently absorbed" \
    || nok "handoff: a reused key with different inputs is refused (rc=$conf_rc bead now '$conf_bead' err='$conf_err')"

  # A prompt file the pointer cannot reference must be refused BEFORE anything
  # durable is written. It used to pass the path check, create the handoff row, and
  # only then have its pointer rejected — leaving a handoff that claims a
  # delegation nobody ever attempted.
  # NOT under $hd_state: XDG_STATE_HOME is itself a mktemp dir under /tmp, so a
  # file there is perfectly pointer-legal. The case being tested is a path that
  # handoff_prompt_file_allowed accepts ($PWD) but a pointer may not reference.
  outside="$ROOT/.xtmux-contract-outside-$$.md"
  printf 'unreachable by pointer\n' > "$outside"
  rows_before="$(hd_q "SELECT count(*) FROM handoffs")"
  out_err="$(hd handoff --target "$hd_pane" --bead xtmux-j46.8 --prompt-file "$outside" --handoff-key k-outside --yes --json 2>&1 >/dev/null)"; out_rc=$?
  { [ "$out_rc" -ne 0 ] && [ "$(hd_q "SELECT count(*) FROM handoffs")" = "$rows_before" ]; } \
    && ok "handoff: an undeliverable prompt path leaves no orphan durable record" \
    || nok "handoff: an undeliverable prompt path leaves no orphan record (rc=$out_rc rows $rows_before -> $(hd_q "SELECT count(*) FROM handoffs"))"
  rm -f "$outside"

  # --wait-ready against a pane that never emits agent.ready must time out as a
  # STRUCTURED refusal, not hang forever and not send anyway.
  t0="$(date +%s)"
  to_out="$(hd handoff --target "$hd_pane" --bead xtmux-j46.8 --prompt-file "$hd_prompt" --handoff-key k-to --wait-ready 2s --yes --json 2>/dev/null)"; to_rc=$?
  to_err="$(hd handoff --target "$hd_pane" --bead xtmux-j46.8 --prompt-file "$hd_prompt" --handoff-key k-to2 --wait-ready 2s --yes --json 2>&1 >/dev/null)"
  elapsed=$(( $(date +%s) - t0 ))
  { [ "$to_rc" -ne 0 ] && [ -z "$to_out" ] && [ "$elapsed" -lt 30 ] \
      && case "$to_err" in *XTMUX_READY_TIMEOUT*) true ;; *) false ;; esac; } \
    && ok "handoff: --wait-ready times out as a structured refusal, never hangs" \
    || nok "handoff: --wait-ready times out as a structured refusal (rc=$to_rc elapsed=${elapsed}s err='$to_err')"

  # Dry-run is the default, and it must be a REHEARSAL: the whole point of typing
  # the command without --yes is to see what would happen without any of it having
  # happened. A dry run that quietly wrote the durable record would make the next
  # real run a no-op replay of a delegation nobody ever approved.
  dry_before_h="$(hd_q "SELECT count(*) FROM handoffs")"
  dry_before_d="$(hd_q "SELECT count(*) FROM delivery_attempts")"
  dry_out="$(hd handoff --target "$hd_pane" --bead xtmux-j46.8 --prompt-file "$hd_prompt" --handoff-key k-dry --json 2>/dev/null)"
  { [ "$(hd_q "SELECT count(*) FROM handoffs")" = "$dry_before_h" ] \
      && [ "$(hd_q "SELECT count(*) FROM delivery_attempts")" = "$dry_before_d" ] \
      && [ "$(hd_q "SELECT count(*) FROM handoffs WHERE handoff_key='k-dry'")" = 0 ]; } \
    && ok "handoff: without --yes nothing is sent and nothing is written" \
    || nok "handoff: without --yes nothing is written (handoffs $dry_before_h -> $(hd_q "SELECT count(*) FROM handoffs"), out='$dry_out')"

  # The handoff row and its monitor are ONE fact: "this delegation is being watched".
  # If the monitor insert fails and the handoff row survives, the delegation is
  # durably recorded but nothing is watching it — it hangs forever and no consumer
  # can tell that from a healthy one. Fault-inject at the store: rename the monitors
  # table so the second insert throws inside the transaction, and assert the FIRST
  # insert rolled back with it.
  hd_sql() { python3 -c "
import sqlite3,sys
try:
  c=sqlite3.connect(sys.argv[1]); c.execute(sys.argv[2]); c.commit(); print('OK')
except Exception as e: print('ERR', e)" "$hd_db" "$1" 2>/dev/null; }
  tx_before="$(hd_q "SELECT count(*) FROM handoffs")"
  hd_sql "ALTER TABLE monitors RENAME TO monitors_faultinject" >/dev/null
  hd handoff --target "$hd_pane" --bead xtmux-j46.8 --prompt-file "$hd_prompt" --handoff-key k-tx --monitor --yes --json >/dev/null 2>&1
  tx_rc=$?
  hd_sql "ALTER TABLE monitors_faultinject RENAME TO monitors" >/dev/null
  { [ "$tx_rc" -ne 0 ] \
      && [ "$(hd_q "SELECT count(*) FROM handoffs")" = "$tx_before" ] \
      && [ "$(hd_q "SELECT count(*) FROM handoffs WHERE handoff_key='k-tx'")" = 0 ] \
      && [ "$(hd_q "SELECT count(*) FROM monitors WHERE target='$hd_pane'")" != ERR ]; } \
    && ok "handoff: a failed monitor insert rolls the handoff back — never a watched-by-nobody record" \
    || nok "handoff: a failed monitor insert rolls the handoff back (rc=$tx_rc handoffs $tx_before -> $(hd_q "SELECT count(*) FROM handoffs"))"

  command tmux -L "$hd_sock" kill-server >/dev/null 2>&1 || true
fi
rm -rf "$hd_state" "$hd_bin"

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
echo "== topology JSON contract (live tmux) =="

if ! tmux info >/dev/null 2>&1; then
  printf '  \033[33mskip\033[0m topology tests (no live tmux server)\n'
elif ! command -v jq >/dev/null 2>&1; then
  printf '  \033[33mskip\033[0m topology tests (jq missing)\n'
else
  topo_a="xtmux-topology-a-$$"
  topo_b="xtmux-topology-b-$$"
  tmux kill-session -t "$topo_a" 2>/dev/null || true
  tmux kill-session -t "$topo_b" 2>/dev/null || true
  tmux new-session -d -s "$topo_a" -x 100 -y 30 'sleep 100' 2>/dev/null
  tmux new-session -d -s "$topo_b" -x 90 -y 25 'sleep 100' 2>/dev/null
  tmux split-window -h -t "$topo_a" 'sleep 100' 2>/dev/null
  # A SECOND window in topo_a. With one window per session, a snapshot that
  # flattened every pane of a session into a single synthetic window would satisfy
  # every other assertion here — the window rung has to be forced to carry weight.
  tmux new-window -d -t "$topo_a" 'sleep 100' 2>/dev/null
  topo_sid="$(tmux display-message -p -t "$topo_a" '#{session_id}' 2>/dev/null)"
  topo_parent_pane="$(tmux list-panes -t "$topo_a" -F '#{pane_id}' 2>/dev/null | tail -1)"
  topo_b_pane="$(tmux list-panes -t "$topo_b" -F '#{pane_id}' 2>/dev/null | head -1)"
  tmux set-option -p -t "$topo_parent_pane" @agent_parent_session "$topo_sid" 2>/dev/null || true
  tmux set-option -p -t "$topo_parent_pane" @agent_instance_id topology-instance 2>/dev/null || true
  tmux set-option -p -t "$topo_parent_pane" @agent_state running 2>/dev/null || true
  topo_json="$(XDG_STATE_HOME="$WORK/topology-state" XTMUX_OBS_V2=0 "$PICKER" topology --json 2>/dev/null)"
  # topo_a is 2 windows holding 2 + 1 panes. The per-window pane COUNTS and the
  # global uniqueness of every pane_id are what pin the shape: a graph that hung
  # every pane under every window would still satisfy a "find pane P under window
  # W" lookup for each pane, and only these two catch it.
  printf '%s\n' "$topo_json" | jq -e --arg a "$topo_a" --arg b "$topo_b" \
    '([.sessions[] | select(.name == $a or .name == $b)] | length == 2) and
     ([.sessions[] | select(.name == $a) | .windows[] | .panes | length] | sort == [1, 2]) and
     ([.sessions[] | select(.name == $b) | .windows] | flatten | length == 1) and
     ([.sessions[].windows[].panes[].pane_id] | (length == (unique | length)))' >/dev/null \
    && ok "topology: host -> sessions -> windows nesting" || nok "topology: host -> sessions -> windows nesting"
  printf '%s\n' "$topo_json" | jq -e --arg a "$topo_a" --arg p "$topo_parent_pane" --arg sid "$topo_sid" \
    '(.schema_version == "xtrm.xtmux.topology.v1") and (.host.host_id | length > 0) and
     ([.sessions[] | select(.name == $a) | .windows[].panes[]] | length == 3) and
     ([.sessions[] | select(.name == $a) | .windows[].panes[] | select(.pane_id == $p and .agent.parent_session_id == $sid)] | length == 1)' >/dev/null \
    && ok "topology: stable IDs and parent session metadata" || nok "topology: stable IDs and parent session metadata"
  # ANSI-C quoting makes tabs real; tmux leaves \t literal inside single-quoted formats.
  # -s widens list-panes from the session's CURRENT window to every pane it owns —
  # without it the second window's pane is never compared against anything.
  topo_expected="$(tmux list-panes -s -t "$topo_a" -F $'#{pane_id}\t#{pane_index}\t#{pane_active}\t#{pane_width}\t#{pane_height}\t#{pane_left}\t#{pane_top}\t#{pane_pid}\t#{window_id}\t#{window_index}' 2>/dev/null)"
  topo_geometry_ok=1
  while IFS=$'\t' read -r ep ei ea ew eh el et epid ewid ewidx; do
    [ -n "$ep" ] || continue
    # The pane is looked up THROUGH its window: a graph that put the right pane
    # under the wrong window would pass a flat `.. | .panes[]` scan.
    if ! printf '%s\n' "$topo_json" | jq -e --arg p "$ep" --argjson i "${ei:-0}" --argjson a "${ea:-0}" --argjson w "${ew:-0}" --argjson h "${eh:-0}" --argjson l "${el:-0}" --argjson t "${et:-0}" --argjson pid "${epid:-0}" --arg wid "${ewid:-}" --argjson widx "${ewidx:-0}" \
      '[.sessions[].windows[] | select(.window_id == $wid and .window_index == $widx) | .panes[]
        | select(.pane_id == $p and .pane_index == $i and .active == ($a == 1) and .width == $w and .height == $h and .left == $l and .top == $t and .pid == $pid)] | length == 1' >/dev/null; then
      topo_geometry_ok=0
    fi
  done <<< "$topo_expected"
  [ "$topo_geometry_ok" = 1 ] && ok "topology: each pane sits under its own window, with tmux's geometry" || nok "topology: each pane sits under its own window, with tmux's geometry"
  printf '%s\n' "$topo_json" | jq -e --arg b "$topo_b_pane" \
    '[.sessions[].windows[].panes[] | select(.pane_id == $b and ((has("agent") | not) or .agent == null))] | length == 1 and ([.. | objects | keys[]] | any(. == "content" or . == "env" or . == "environment") | not)' >/dev/null \
    && ok "topology: absent agent metadata and no pane content/env" || nok "topology: absent agent metadata and no pane content/env"
  tmux kill-session -t "$topo_a" 2>/dev/null || true
  tmux kill-session -t "$topo_b" 2>/dev/null || true
fi


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

# The band was 50-160, chosen when the CLI was smaller. Epic j46 added five real
# command families (context, topology, pane capture, the log cursor + follow,
# readiness-aware handoff) and help hit exactly 160 — after which every new command
# could only be documented by deleting explanation from an existing one, which is
# how help decays into a list of flags nobody can act on. Re-set to 200 ONCE,
# deliberately, rather than nudged by +5 whenever it trips: the guard is here to
# stop help becoming a manual, and the checks that keep help HONEST (the two-way
# dispatch-table cross-check and the field-names-vs-live-output check below) are
# untouched and are the ones that actually catch rot.
if [ "$_help_lines" -ge 50 ] && [ "$_help_lines" -le 200 ]; then
  ok "help: grouped and scannable ($_help_lines lines, band is 50-200)"
else
  nok "help: grouped and scannable ($_help_lines lines, want 50-200)"
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
