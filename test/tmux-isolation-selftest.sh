#!/usr/bin/env bash
# Isolation self-test for test/contract.sh (XTMUX-492).
#
# CLAIM UNDER TEST: contract.sh never creates, kills or types into a session on
# the server named by the TMUX it inherits. That is the failure of 2026-11-26:
# a suite started inside a live tmux session resolved its tmux clients from the
# inherited TMUX, so bare `tmux kill-session` / `send-keys` / `set-option` calls
# hit the operator's server.
#
# METHOD. This script owns a DECOY server on a private socket and runs the whole
# contract suite with TMUX and TMUX_PANE pointing at that decoy, exactly as a
# live session would. If any part of the suite honoured the inherited TMUX, the
# decoy's session list, its pane list or its panes' contents would change. All
# three are compared before and after, so the assertion is on observable state,
# not on the suite's own opinion of itself.
#
# The decoy holds two sessions: one idle (`sleep`), and one running `cat` so
# keystrokes sent to "the current pane" would echo into captured pane text
# instead of vanishing.
#
# A NEGATIVE CONTROL runs first: a deliberately non-hermetic tmux call with the
# same inherited TMUX must be DETECTED by the same comparison. Without it, a
# comparison that can never fail would pass this test too.
#
# Run: bash test/tmux-isolation-selftest.sh
# The decoy and every tmux call here name their socket explicitly (-S), so this
# script is itself safe to run inside a live tmux session.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v tmux >/dev/null 2>&1; then
  printf 'SKIP tmux-isolation: tmux not installed\n'
  exit 0
fi

pass=0
fail=0
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass + 1)); }
nok() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }

decoy_dir="$(mktemp -d "${TMPDIR:-/tmp}/xtmux-isolation-decoy.XXXXXX")"
decoy_sock="$decoy_dir/decoy"
suite_log="$decoy_dir/contract.log"
cleanup() {
  # Explicit -S: never resolved from an inherited TMUX.
  tmux -S "$decoy_sock" kill-server >/dev/null 2>&1 || true
  rm -rf "$decoy_dir"
}
trap cleanup EXIT INT TERM

echo "== tmux isolation self-test (XTMUX-492) =="

if ! tmux -S "$decoy_sock" -f /dev/null new-session -d -s decoy-keep 'sleep 3600' 2>/dev/null; then
  printf 'SKIP tmux-isolation: cannot start the decoy server\n'
  exit 0
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
  printf 'SKIP tmux-isolation: the decoy server has no pane or pid\n'
  exit 0
fi

before="$(decoy_snapshot)"
if [ -z "$before" ]; then
  printf 'SKIP tmux-isolation: the decoy snapshot is empty\n'
  exit 0
fi

# --- negative control: an inherited TMUX must be visible to this comparison ---
env TMUX="$decoy_tmux" TMUX_PANE="$decoy_pane" tmux new-session -d -s isolation-probe 'sleep 30' 2>/dev/null
control="$(decoy_snapshot)"
tmux -S "$decoy_sock" kill-session -t isolation-probe >/dev/null 2>&1 || true
restored="$(decoy_snapshot)"
if [ "$control" != "$before" ] && [ "$restored" = "$before" ]; then
  ok "negative control: an inherited TMUX reaches the decoy, and the comparison notices"
else
  nok "negative control: an inherited TMUX did not change the decoy (comparison is vacuous)"
fi

# --- the suite under test -----------------------------------------------------
started="$(date +%s)"
env TMUX="$decoy_tmux" TMUX_PANE="$decoy_pane" bash "$HERE/contract.sh" >"$suite_log" 2>&1
suite_rc=$?
elapsed=$(( $(date +%s) - started ))

after="$(decoy_snapshot)"
if [ "$after" = "$before" ]; then
  ok "contract.sh left the decoy server's sessions, panes and pane contents unchanged (${elapsed}s)"
else
  nok "contract.sh changed the decoy server"
  diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | sed -n '1,40p' >&2
fi

if tmux -S "$decoy_sock" list-sessions >/dev/null 2>&1; then
  ok "the decoy server survived the run"
else
  nok "the decoy server is gone: the suite reached and killed an inherited server"
fi

# The suite must actually have run: an early exit would satisfy every comparison
# above while proving nothing.
suite_tally="$(grep -E '^== [0-9]+ pass, [0-9]+ fail ==' "$suite_log" | tail -1)"
suite_pass="$(printf '%s\n' "$suite_tally" | sed -n 's/^== \([0-9]*\) pass.*/\1/p')"
if [ -n "$suite_pass" ] && [ "$suite_pass" -gt 0 ]; then
  ok "contract.sh ran to its summary: ${suite_tally#== }"
else
  nok "contract.sh printed no summary (exit $suite_rc); log tail:"
  tail -20 "$suite_log" >&2
fi

printf '== %s pass, %s fail ==\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
