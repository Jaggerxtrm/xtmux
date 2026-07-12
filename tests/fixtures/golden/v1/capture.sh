#!/usr/bin/env bash
# V1 golden capture for the monitor / telemetry / audit surfaces (PRD §20).
#
#   capture.sh            regenerate goldens in this directory
#   capture.sh --check    re-capture and diff against the committed goldens
#
# Everything runs against a private tmux server (TMUX_TMPDIR) and a private
# TMPDIR/event log, so the goldens do not depend on the operator's live
# sessions. Volatile tokens (ids, pids, epochs, paths) go through normalize.sed.
set -uo pipefail

here="$(cd -- "$(dirname -- "$0")" && pwd)"
repo="$(cd -- "$here/../../../.." && pwd)"
picker="$repo/bin/tmux-session-picker"
mode="${1:-write}"

sandbox="$(mktemp -d)"
trap 'TMUX_TMPDIR="$sandbox/tmux" tmux kill-server 2>/dev/null; rm -rf "$sandbox"' EXIT

export TMUX_TMPDIR="$sandbox/tmux"
export TMPDIR="$sandbox/tmp"
export XTMUX_EVENT_LOG_FILE="$sandbox/events.jsonl"
mkdir -p "$TMUX_TMPDIR" "$TMPDIR"
unset TMUX  # do not inherit the capturing pane

out="$sandbox/out"; mkdir -p "$out"

emit() { # emit <name> — normalize stdin into $out/<name>.golden
  sed -f "$here/normalize.sed" > "$out/$1.golden"
}
journal_since() { # journal_since <lineno> — journal lines added after <lineno>
  tail -n "+$(( $1 + 1 ))" "$XTMUX_EVENT_LOG_FILE" 2>/dev/null || true
}
journal_len() { wc -l < "$XTMUX_EVENT_LOG_FILE" 2>/dev/null || echo 0; }

# ---------------------------------------------------------------- tmux fixture
# Every fixture session lives in the sandbox, never in the caller's checkout —
# otherwise the operator's dirty count and worktree path leak into the goldens.
mkfixrepo() { # mkfixrepo <dir> [dirty]
  git init -q -b main "$1"
  git -C "$1" -c user.email=g@x -c user.name=g commit -q --allow-empty -m init
  [ "${2:-}" = dirty ] && : > "$1/uncommitted"
  return 0
}
mkfixrepo "$sandbox/wt-clean"          # shared by two sessions: shared-worktree
mkfixrepo "$sandbox/wt-dirty" dirty    # dirty-worktree
mkdir -p "$sandbox/plain" "$sandbox/gone"

main_pane="$(tmux new-session -d -P -F '#{pane_id}' -s golden-main -c "$sandbox/wt-clean" -x 200 -y 50)"
tmux set-option -p -t "$main_pane" @agent_state idle
tmux set-option -p -t "$main_pane" @agent_bead xtmux-golden
work_pane="$(tmux new-session -d -P -F '#{pane_id}' -s golden-work -c "$sandbox/wt-clean" -x 200 -y 50)"
tmux set-option -p -t "$work_pane" @agent_state working  # no @agent_bead: agent-pane-without-bead
tmux new-session -d -s sp-executor-golden -c "$sandbox/wt-dirty" -x 200 -y 50  # stale-specialist + dirty
tmux new-session -d -s tmp-badname -c "$sandbox/plain" -x 200 -y 50            # naming-convention
tmux new-session -d -s golden-gone -c "$sandbox/gone" -x 200 -y 50             # missing-path
rmdir "$sandbox/gone"

# ------------------------------------------------------------------- monitors
# monitor-agent on a *working* pane: monitor stays alive and pollable.
"$picker" monitor-agent golden-work --timeout 30m --interval 60s 2>&1 | emit monitor-agent
sleep 1
"$picker" monitor-list 2>&1 | emit monitor-list
mid="$("$picker" monitor-list 2>/dev/null | head -1 | cut -f2)"
"$picker" monitor-kill "$mid" 2>&1 | emit monitor-kill
"$picker" monitor-list 2>&1 | emit monitor-list-empty

# monitor-agent on an *idle* pane: monitor-run reaches the done terminal state.
n="$(journal_len)"
"$picker" monitor-agent golden-main --timeout 30m --interval 1s >/dev/null 2>&1
sleep 2
journal_since "$n" | grep -o '"type":"monitor\.[a-z]*"' | emit monitor-done-journal

# monitor-kill on an unknown id: error path (stderr + exit status).
"$picker" monitor-kill no-such-monitor >"$out/.mk" 2>&1; rc=$?
{ cat "$out/.mk"; printf 'exit=%s\n' "$rc"; } | emit monitor-kill-unknown

# ------------------------------------------------------------------ telemetry
gitrepo="$sandbox/repo"
git init -q -b main "$gitrepo"
git -C "$gitrepo" -c user.email=g@x -c user.name=g commit -q --allow-empty -m init
cd "$gitrepo" || exit 1

n="$(journal_len)"
"$picker" telemetry git -- rev-parse --abbrev-ref HEAD >"$out/.t" 2>&1; rc=$?
{ cat "$out/.t"; printf 'exit=%s\n' "$rc"; journal_since "$n"; } | emit telemetry-git-ok

n="$(journal_len)"
"$picker" telemetry git -- rev-parse --verify no-such-ref >"$out/.t" 2>&1; rc=$?
{ printf 'exit=%s\n' "$rc"; journal_since "$n"; } | emit telemetry-git-fail

n="$(journal_len)"
"$picker" telemetry git -- commit --allow-empty -m golden >/dev/null 2>&1; rc=$?
{ printf 'exit=%s\n' "$rc"; journal_since "$n"; } | emit telemetry-git-commit

n="$(journal_len)"
"$picker" telemetry bd -- --version >/dev/null 2>&1; rc=$?
{ printf 'exit=%s\n' "$rc"; journal_since "$n"; } | emit telemetry-bd

n="$(journal_len)"
"$picker" telemetry gh -- --version >/dev/null 2>&1; rc=$?
{ printf 'exit=%s\n' "$rc"; journal_since "$n"; } | emit telemetry-gh

"$picker" telemetry >"$out/.t" 2>&1; rc=$?
{ cat "$out/.t"; printf 'exit=%s\n' "$rc"; } | emit telemetry-usage
cd "$repo" || exit 1

# ---------------------------------------------------------------------- audit
# Sort: audit walks `dashboard expanded`, whose row order is tmux-enumeration
# dependent; the finding set is what the contract fixes, not the emission order.
"$picker" audit 2>&1 | sort | emit audit

# --------------------------------------------------------------------- verify
rm -f "$out"/.mk "$out"/.t
status=0
if [ "$mode" = --check ]; then
  for f in "$out"/*.golden; do
    if ! diff -u "$here/$(basename "$f")" "$f"; then
      printf 'GOLDEN DRIFT: %s\n' "$(basename "$f")" >&2
      status=1
    fi
  done
  [ "$status" = 0 ] && printf 'v1 goldens: OK (%s files)\n' "$(ls "$out" | wc -l)"
else
  cp "$out"/*.golden "$here/"
  printf 'wrote %s goldens to %s\n' "$(ls "$out" | wc -l)" "$here"
fi
exit "$status"
