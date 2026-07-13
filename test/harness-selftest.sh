#!/usr/bin/env bash
# Meta-test for lib/harness.sh (xtmux-d0a.19).
#
# The bug this guards: a failing test inside a `( ... )` subshell used to print
# FAIL and increment nothing, so `smoke` — a REQUIRED status check — reported
# "0 fail" and exited 0 while printing failures. Making today's symptom go away
# is not proof; this asserts the property directly.
#
# Asserts, by running real suites end to end:
#   1. a failure in a SUBSHELL fails the suite (non-zero exit) and is named
#   2. the tally counts it
#   3. the FAILED list names exactly what printed FAIL — no phantoms, no omissions
#   4. an all-passing suite still exits 0 (the harness does not just always fail)
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

selftest_pass=0
selftest_fail=0
sok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; selftest_pass=$((selftest_pass + 1)); }
snok() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; selftest_fail=$((selftest_fail + 1)); }

echo "== harness self-test (xtmux-d0a.19) =="

# ---------------------------------------------------------------------------
# A suite whose ONLY failure happens inside a subshell — the exact shape of the
# rename tests, which scope a `tmux()` override and so must run in one.
cat >"$WORK/failing-suite.sh" <<EOF
set -u
. "$HERE/lib/harness.sh"
harness_init "$WORK/failing.tsv"
ok "passes in the parent"
(
  # a subshell, exactly like the rename contract block
  nok "fails inside a subshell"
  ok "also passes inside a subshell"
)
harness_summary
exit \$?
EOF

out="$(bash "$WORK/failing-suite.sh" 2>&1)"
status=$?

[ "$status" -ne 0 ] \
  && sok "a subshell failure fails the suite (exit $status)" \
  || snok "a subshell failure fails the suite (exit $status, expected non-zero)"

printf '%s' "$out" | grep -q '== 2 pass, 1 fail ==' \
  && sok "the tally counts the subshell failure (2 pass, 1 fail)" \
  || { snok "the tally counts the subshell failure"; printf '%s\n' "$out" | sed 's/^/      /'; }

printf '%s' "$out" | grep -q -- '- fails inside a subshell' \
  && sok "the FAILED list names the subshell failure" \
  || snok "the FAILED list names the subshell failure"

# no phantoms, no omissions: the FAILED list must equal what printed FAIL
printed="$(printf '%s' "$out" | sed -E 's/\x1b\[[0-9;]*m//g' | awk '/^  FAIL /{sub(/^  FAIL +/, ""); print}' | sort)"
listed="$(printf '%s' "$out" | sed -n '/^FAILED:/,$p' | sed -E 's/^  - //' | tail -n +2 | sort)"
if [ "$printed" = "$listed" ] && [ -n "$printed" ]; then
  sok "FAILED list == the tests that printed FAIL (no phantoms, no omissions)"
else
  snok "FAILED list == the tests that printed FAIL"
  printf '      printed: %s\n      listed:  %s\n' "$printed" "$listed"
fi

# ---------------------------------------------------------------------------
# And the harness must not simply always fail: an all-passing suite exits 0.
cat >"$WORK/passing-suite.sh" <<EOF
set -u
. "$HERE/lib/harness.sh"
harness_init "$WORK/passing.tsv"
ok "parent"
( ok "subshell" )
harness_summary
exit \$?
EOF

pout="$(bash "$WORK/passing-suite.sh" 2>&1)"
pstatus=$?
if [ "$pstatus" -eq 0 ] && printf '%s' "$pout" | grep -q '== 2 pass, 0 fail =='; then
  sok "an all-passing suite still exits 0 and counts subshell passes"
else
  snok "an all-passing suite still exits 0 (exit $pstatus)"
  printf '%s\n' "$pout" | sed 's/^/      /'
fi

echo
printf '== %s pass, %s fail ==\n' "$selftest_pass" "$selftest_fail"
[ "$selftest_fail" -gt 0 ] && exit 1
exit 0
