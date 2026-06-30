#!/usr/bin/env bash
# xtmux contract tests. Run: ./test/contract.sh  (regen: --regen)
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
GOLDEN="$HERE/golden"
STATUS="$ROOT/scripts/git-pane-status.sh"
PICKER="$ROOT/bin/tmux-session-picker"
AGENT_STATE="$ROOT/scripts/agent-state.sh"
. "$HERE/lib/fixtures.sh"

pass=0
fail=0
failed=""

ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass+1)); }
nok()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); failed="$failed\n  - $1"; }
assert_eq() { # assert_eq <name> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else
    nok "$1"; printf '      expected: %s\n      actual:   %s\n' "$2" "$3"
  fi
}
assert_golden() { # assert_golden <name> <actual-file> <golden-file>
  if diff -u "$3" "$2" >/tmp/xt.diff.$$ 2>&1; then ok "$1"; else
    nok "$1"; sed 's/^/      /' </tmp/xt.diff.$$ | head -25
  fi
  rm -f /tmp/xt.diff.$$
}
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
    TMUX_PANE="$target" "$AGENT_STATE" off >/dev/null 2>&1 || true
  else
    printf '  \033[33mskip\033[0m agent-state pane write (no panes)\n'
  fi
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
    case "$t" in session|pane) ;; *) nok "row type '$t'"; shape_ok=0; break;; esac
  done <<< "$rows"
  [ "$shape_ok" = 1 ] && ok "TSV 5-col shape"

  nonempty=1
  while IFS=$'\t' read -r t sid name target rest; do
    [ -n "$t" ] || continue
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
printf '== %s pass, %s fail ==\n' "$pass" "$fail"
[ "$fail" -gt 0 ] && { printf 'FAILED:%s\n' "$failed"; exit 1; }
exit 0
