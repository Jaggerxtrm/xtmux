#!/usr/bin/env bash
# Shared assertion harness for the shell test suites.
#
# Why this exists (xtmux-d0a.19): the counters used to be shell variables, so a
# nok() inside a `( ... )` subshell printed FAIL and incremented nothing. The
# rename tests live in a subshell (they scope a `tmux()` override), so they
# failed on EVERY run — locally and on CI — while the suite exited 0. A required
# status check that reports "0 fail" while printing FAIL protects nothing.
#
# The fix is to stop counting in variables. Every result is appended to one
# record file, and the tally, the FAILED list, and the exit status are all
# derived from that one file. A subshell's append survives, and the printed
# failures and the summary cannot disagree, because they are the same records.
#
# harness_init <file>   start a run (truncates the record file)
# ok <name> / nok <name>
# assert_eq <name> <expected> <actual>
# assert_golden <name> <actual-file> <golden-file>
# harness_summary       print "== N pass, M fail ==" (+ FAILED list); returns 1 if any failed

harness_init() {
  HARNESS_RESULTS="${1:?harness_init <results-file>}"
  : >"$HARNESS_RESULTS"
}

# Records are TAB-separated so a name can contain spaces. Appends from a
# subshell land in the same file — that is the whole point.
_harness_record() { printf '%s\t%s\n' "$1" "$2" >>"$HARNESS_RESULTS"; }

ok() {
  printf '  \033[32mok\033[0m   %s\n' "$1"
  _harness_record PASS "$1"
}

nok() {
  printf '  \033[31mFAIL\033[0m %s\n' "$1"
  _harness_record FAIL "$1"
}

assert_eq() { # assert_eq <name> <expected> <actual>
  if [ "$2" = "$3" ]; then
    ok "$1"
  else
    nok "$1"
    printf '      expected: %s\n      actual:   %s\n' "$2" "$3"
  fi
}

assert_golden() { # assert_golden <name> <actual-file> <golden-file>
  local diff_out
  diff_out="$(mktemp)"
  if diff -u "$3" "$2" >"$diff_out" 2>&1; then
    ok "$1"
  else
    nok "$1"
    sed 's/^/      /' <"$diff_out" | head -25
  fi
  rm -f "$diff_out"
}

harness_summary() {
  local pass fail
  pass="$(grep -c '^PASS' "$HARNESS_RESULTS" 2>/dev/null || true)"
  fail="$(grep -c '^FAIL' "$HARNESS_RESULTS" 2>/dev/null || true)"
  [ -n "$pass" ] || pass=0
  [ -n "$fail" ] || fail=0

  echo
  printf '== %s pass, %s fail ==\n' "$pass" "$fail"
  if [ "$fail" -gt 0 ]; then
    # Named from the same records as the count, so the list can never disagree
    # with the tally the way it used to.
    printf 'FAILED:\n'
    grep '^FAIL' "$HARNESS_RESULTS" | cut -f2- | sed 's/^/  - /'
    return 1
  fi
  return 0
}
