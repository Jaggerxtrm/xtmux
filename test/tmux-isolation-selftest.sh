#!/usr/bin/env bash
# Isolation self-test for test/contract.sh (XTMUX-492).
#
# CLAIM UNDER TEST: contract.sh never creates, kills or types into a session on a
# server it did not create itself. Two ways in are covered, one per mode:
#
#   mode 1 - inherited TMUX. A suite started inside a live tmux session inherits
#            TMUX and TMUX_PANE, and tmux resolves its socket from TMUX first.
#   mode 2 - inherited TMUX_TMPDIR. With TMUX unset, a bare `tmux` client (the
#            picker, scripts/agent-state.sh, scripts/xtmux-monitor.sh) resolves
#            $TMUX_TMPDIR/tmux-<uid>/default. If the suite inherits a caller's
#            TMUX_TMPDIR instead of replacing it, those clients reach the
#            caller's server, which in a live session is the operator's.
#
# METHOD. Each mode owns a DECOY server holding two sessions: one idle (`sleep`)
# and one running `cat`, so keystrokes sent to "the current pane" echo into
# captured pane text instead of vanishing. contract.sh then runs with exactly
# one of TMUX or TMUX_TMPDIR pointing at that decoy. If any part of the suite
# honoured the inherited value, the decoy's session list, its pane list (with the
# @agent_state option the suite writes) or its panes' contents would change. All
# three are compared before and after, so the assertion is on observable state,
# not on the suite's own opinion of itself.
#
# Each mode runs a NEGATIVE CONTROL first: one deliberately non-hermetic tmux
# call that honours the inherited value must be DETECTED by the same comparison.
# Without it, a comparison that can never fail would pass this test too.
#
# Neither mode derails the suite's own server: mode 1 leaves the suite a private
# TMUX_TMPDIR it does not use, mode 2 leaves it only a TMUX_TMPDIR to replace.
#
# Run: bash test/tmux-isolation-selftest.sh
# Every decoy call here names its socket (-S, or -L under the decoy's own
# TMUX_TMPDIR), so this script is itself safe to run inside a live tmux session.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pass=0
fail=0
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass + 1)); }
nok() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }

# A SKIP is neither a pass nor a silent no-op. CI reads a green job as "the claim
# held", and its log is uploaded only on failure, so a skip that exits 0 would
# vanish. On the non-fatal path a skip therefore prints a line the gate can grep
# and lands in the job summary when GitHub provides one. Under
# XTMUX_SELFTEST_REQUIRE_TMUX=1 - the CI gate sets it, because on a hosted runner
# tmux is installed and a skip can only mean the decoy was not proven - the same
# condition is a FAILURE that prints FAIL and exits 1, with no SKIP line.
skip() {
  # Fatal path prints FAIL alone: a run that greps the log for the benign
  # "SKIP tmux-isolation:" line must not find one on a run that failed the gate.
  if [ "${XTMUX_SELFTEST_REQUIRE_TMUX:-0}" = 1 ]; then
    printf '\033[31mFAIL\033[0m tmux-isolation: skipping is not allowed here (%s)\n' "$1" >&2
    exit 1
  fi
  printf 'SKIP tmux-isolation: %s\n' "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf 'xtmux-isolation-selftest: SKIP - %s\n' "$1" >>"$GITHUB_STEP_SUMMARY" 2>/dev/null || true
  fi
  exit 0
}

# Defined after skip(): a missing tmux is a skip, and it must be reported the
# same way as every other skip in this script.
command -v tmux >/dev/null 2>&1 || skip 'tmux not installed'

decoy_dir="$(mktemp -d "${TMPDIR:-/tmp}/xtmux-isolation-decoy.XXXXXX")"
decoy_sock="$decoy_dir/decoy"
# Mode 2's decoy IS the default socket of a directory the suite does not own.
default_dir="$(mktemp -d "${TMPDIR:-/tmp}/xtmux-isolation-default.XXXXXX")"
# Mode 2's decoy socket, named by full path. Never reach it as
# `TMUX_TMPDIR="$default_dir" tmux -L default`: when that directory is gone, tmux
# silently falls back to /tmp/tmux-<uid>/default, the operator's live server.
# XTMUX-495: on 2026-11-27 a SIGTERM ran the old cleanup (which deleted
# $default_dir) without exiting; the script went on, and the final cleanup's
# `tmux -L default kill-server` killed the live server. Twice.
default_sock="$default_dir/tmux-$(id -u)/default"
mkdir -m 700 "$default_dir/tmux-$(id -u)"
cleanup() {
  # Explicit -S with full paths only: never resolved from TMUX or TMUX_TMPDIR.
  tmux -S "$decoy_sock" kill-server >/dev/null 2>&1 || true
  tmux -S "$default_sock" kill-server >/dev/null 2>&1 || true
  rm -rf "$decoy_dir" "$default_dir"
}
trap cleanup EXIT
# A signal must END the run. A trap that cleans up and returns lets the script
# continue with its private directories deleted.
trap 'trap - EXIT; cleanup; exit 143' INT TERM HUP
# Abort before any call that relies on $default_dir existing.
require_default_dir() {
  [ -d "$default_dir" ] || { printf '\033[31mFAIL\033[0m tmux-isolation: %s is gone; refusing to call tmux\n' "$default_dir" >&2; exit 1; }
}

echo "== tmux isolation self-test (XTMUX-492) =="

# --- mode 1: a decoy reached through an inherited TMUX ------------------------
if ! tmux -S "$decoy_sock" -f /dev/null new-session -d -s decoy-keep 'sleep 3600' 2>/dev/null; then
  skip 'cannot start the decoy server'
fi
tmux -S "$decoy_sock" new-session -d -s decoy-cat -x 100 -y 20 'cat'

decoy_pane="$(tmux -S "$decoy_sock" list-panes -s -t decoy-cat -F '#{pane_id}' | head -1)"
decoy_server_pid="$(tmux -S "$decoy_sock" display-message -p '#{pid}')"
decoy_tmux="$decoy_sock,$decoy_server_pid,0"

# Snapshot of everything a stray client could change: sessions, panes (with the
# agent options the suite writes) and each pane's visible text.
decoy_snapshot() {
  tmux -S "$decoy_sock" list-sessions -F 'session #{session_id} #{session_name}' 2>/dev/null
  tmux -S "$decoy_sock" list-panes -a -F 'pane #{session_name} #{window_id} #{pane_id} #{pane_index} #{@agent_state}' 2>/dev/null
  local p
  for p in $(tmux -S "$decoy_sock" list-panes -a -F '#{pane_id}' 2>/dev/null); do
    printf 'content %s\n' "$p"
    tmux -S "$decoy_sock" capture-pane -p -t "$p" 2>/dev/null
  done
}

if [ -z "$decoy_pane" ] || [ -z "$decoy_server_pid" ]; then
  skip 'the decoy server has no pane or pid'
fi

before="$(decoy_snapshot)"
if [ -z "$before" ]; then
  skip 'the decoy snapshot is empty'
fi

# --- mode 1 control: an inherited TMUX must be visible to this comparison -----
env TMUX="$decoy_tmux" TMUX_PANE="$decoy_pane" tmux new-session -d -s isolation-probe 'sleep 30' 2>/dev/null
control="$(decoy_snapshot)"
tmux -S "$decoy_sock" kill-session -t isolation-probe >/dev/null 2>&1 || true
restored="$(decoy_snapshot)"
if [ "$control" != "$before" ] && [ "$restored" = "$before" ]; then
  ok "mode 1 control: an inherited TMUX reaches the decoy, and the comparison notices"
else
  nok "mode 1 control: an inherited TMUX did not change the decoy (comparison is vacuous)"
fi

# --- mode 1: the suite under test --------------------------------------------
suite_log="$decoy_dir/contract.log"
started="$(date +%s)"
env TMUX="$decoy_tmux" TMUX_PANE="$decoy_pane" bash "$HERE/contract.sh" >"$suite_log" 2>&1
suite_rc=$?
elapsed=$(( $(date +%s) - started ))

after="$(decoy_snapshot)"
if [ "$after" = "$before" ]; then
  ok "mode 1: with an inherited TMUX, contract.sh left the decoy's sessions, panes and pane contents unchanged (${elapsed}s)"
else
  nok "mode 1: with an inherited TMUX, contract.sh changed the decoy server"
  diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | sed -n '1,40p' >&2
fi

if tmux -S "$decoy_sock" list-sessions >/dev/null 2>&1; then
  ok "mode 1: the decoy server survived the run"
else
  nok "mode 1: the decoy server is gone: the suite reached and killed an inherited server"
fi

# The suite must actually have run: an early exit would satisfy every comparison
# above while proving nothing.
suite_tally="$(grep -E '^== [0-9]+ pass, [0-9]+ fail ==' "$suite_log" | tail -1)"
suite_pass="$(printf '%s\n' "$suite_tally" | sed -n 's/^== \([0-9]*\) pass.*/\1/p')"
if [ -n "$suite_pass" ] && [ "$suite_pass" -gt 0 ]; then
  ok "mode 1: contract.sh ran to its summary: ${suite_tally#== }"
else
  nok "mode 1: contract.sh printed no summary (exit $suite_rc); log tail:"
  tail -20 "$suite_log" >&2
fi

# --- mode 2: a decoy that IS the default socket of an inherited TMUX_TMPDIR ---
dtmux() { require_default_dir; env -u TMUX -u TMUX_PANE tmux -S "$default_sock" "$@"; }

if ! dtmux -f /dev/null new-session -d -s ddecoy-keep 'sleep 3600' 2>/dev/null; then
  skip 'cannot start the default-socket decoy server'
fi
dtmux new-session -d -s ddecoy-cat -x 100 -y 20 'cat'

ddecoy_sock="$(dtmux display-message -p '#{socket_path}' 2>/dev/null)"
ddecoy_snapshot() {
  dtmux list-sessions -F 'session #{session_id} #{session_name}' 2>/dev/null
  dtmux list-panes -a -F 'pane #{session_name} #{window_id} #{pane_id} #{pane_index} #{@agent_state}' 2>/dev/null
  local p
  for p in $(dtmux list-panes -a -F '#{pane_id}' 2>/dev/null); do
    printf 'content %s\n' "$p"
    dtmux capture-pane -p -t "$p" 2>/dev/null
  done
}

dbefore="$(ddecoy_snapshot)"
if [ -z "$ddecoy_sock" ] || [ -z "$dbefore" ]; then
  skip 'the default-socket decoy is not usable'
fi

# --- mode 2 control: an inherited TMUX_TMPDIR must be visible too -------------
require_default_dir; env -u TMUX -u TMUX_PANE TMUX_TMPDIR="$default_dir" tmux new-session -d -s isolation-probe2 'sleep 30' 2>/dev/null
dcontrol="$(ddecoy_snapshot)"
dtmux kill-session -t isolation-probe2 >/dev/null 2>&1 || true
drestored="$(ddecoy_snapshot)"
if [ "$dcontrol" != "$dbefore" ] && [ "$drestored" = "$dbefore" ]; then
  ok "mode 2 control: an inherited TMUX_TMPDIR reaches the decoy's default socket, and the comparison notices"
else
  nok "mode 2 control: an inherited TMUX_TMPDIR did not change the decoy (comparison is vacuous)"
fi

# --- mode 2: the suite under test --------------------------------------------
suite2_log="$default_dir/contract.log"
started="$(date +%s)"
require_default_dir; env -u TMUX -u TMUX_PANE TMUX_TMPDIR="$default_dir" bash "$HERE/contract.sh" >"$suite2_log" 2>&1
suite2_rc=$?
elapsed2=$(( $(date +%s) - started ))

dafter="$(ddecoy_snapshot)"
if [ "$dafter" = "$dbefore" ]; then
  ok "mode 2: with only an inherited TMUX_TMPDIR, contract.sh left that server's sessions, panes and pane contents unchanged (${elapsed2}s)"
else
  nok "mode 2: contract.sh created, killed or typed into a session on the inherited TMUX_TMPDIR's default socket"
  diff <(printf '%s\n' "$dbefore") <(printf '%s\n' "$dafter") | sed -n '1,40p' >&2
fi

if dtmux list-sessions >/dev/null 2>&1; then
  ok "mode 2: the default-socket decoy server survived the run"
else
  nok "mode 2: the default-socket decoy server is gone"
fi

suite2_tally="$(grep -E '^== [0-9]+ pass, [0-9]+ fail ==' "$suite2_log" | tail -1)"
suite2_pass="$(printf '%s\n' "$suite2_tally" | sed -n 's/^== \([0-9]*\) pass.*/\1/p')"
if [ -n "$suite2_pass" ] && [ "$suite2_pass" -gt 0 ]; then
  ok "mode 2: contract.sh ran to its summary: ${suite2_tally#== }"
else
  nok "mode 2: contract.sh printed no summary (exit $suite2_rc); log tail:"
  tail -20 "$suite2_log" >&2
fi

# Zero assertions is a skip, not a green run - but a run in which every
# assertion failed is a failure, never a skip. Test the failure exit first, or
# pass=0 with fail>0 takes the skip path and exits 0 under a log full of FAIL.
printf '== %s pass, %s fail ==\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
[ "$pass" -gt 0 ] || skip 'no assertion ran'
