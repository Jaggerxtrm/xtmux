#!/usr/bin/env bash
# xtmux nav contract tests — TDD reds for xtmux-rib.23 (NAV-1 machine-safe
# records/action tokens), xtmux-rib.25 (NAV-3 nav verbs + attention cycle), and
# xtmux-rib.27 (nav safety contracts). Run: bash test/nav-contract.sh
#
# EXPECTED STATE: this file FAILS while the nav production slices are
# unimplemented; every FAIL names the missing implementation. It deliberately
# contains NO production behavior — the assertions below are the contract the
# implementation must satisfy.
#
# Isolation: no live tmux server is touched. Picker FUNCTIONS are sourced and
# driven under a tmux() override; picker SUBPROCESSES that would call tmux are
# run with a fake `tmux` shim first on PATH. All state lives under WORK.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PICKER="$ROOT/bin/tmux-session-picker"
. "$HERE/lib/harness.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/xtmux-nav-contract.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
harness_init "$WORK/results.tsv"

# Same extraction as test/contract.sh: source everything before the top-level
# dispatch. New nav helpers must be defined before the dispatch to be visible.
fn_file="$WORK/picker-functions.sh"
awk '/^case "\$\{1:-\}" in/{exit} {print}' "$PICKER" > "$fn_file"
# shellcheck source=/dev/null
. "$fn_file"
# sourcing the picker imports its strict mode; this suite uses only set -u.
set +e
set +o pipefail
set -u

# require_fn <fn> <label> — clean red for a not-yet-implemented production
# helper: FAILs explicitly ("missing implementation"), never as a typo/NOOP.
require_fn() {
  if declare -F "$1" >/dev/null 2>&1; then
    ok "$2"
    return 0
  fi
  nok "$2"
  printf '      missing implementation: %s() not defined in %s (define it before the top-level dispatch)\n' "$1" "$PICKER"
  return 1
}

# Fake `tmux` for picker subprocess invocations: logs every call, captures the
# command-prompt run-shell payload, never talks to a real server.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/tmux" <<'SHIM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${XTMUX_TMUX_LOG:-/dev/null}"
case "$1" in
  command-prompt|confirm-before) printf '%s\n' "$*" >> "${XTMUX_TMUX_PROMPT:-/dev/null}" ;;
esac
exit 0
SHIM
chmod +x "$WORK/bin/tmux"

echo
echo "== nav: dispatch, help, and --json classification (xtmux-rib.23/.25) =="
# NAV-3 requires one discoverable command family: nav next|prev|attention-next|
# attention-prev|back. Today `nav` is an unknown command (exit 2), so the
# dispatch arm, its help, and its JSON classification are all missing.
nav_verbs='next prev attention-next attention-prev back'

"$PICKER" nav help >"$WORK/nav-help.out" 2>&1
_nav_rc=$?
if [ "$_nav_rc" -eq 0 ]; then
  ok "nav help: dispatches (exit 0)"
else
  nok "nav help: dispatches (exit 0, got $_nav_rc — nav has no dispatcher yet)"
  printf '      output: %s\n' "$(head -1 "$WORK/nav-help.out")"
fi

_nav_missing=''
for _v in $nav_verbs; do
  grep -qF -- "$_v" "$WORK/nav-help.out" || _nav_missing="$_nav_missing $_v"
done
if [ -z "$_nav_missing" ]; then
  ok "nav help: lists every verb ($nav_verbs)"
else
  nok "nav help: lists every verb (missing:$_nav_missing)"
fi

# The top-level command reference must advertise the family too (help-honesty
# contract, xtmux-rib.25: "Preserve the 50-200-line help honesty contract").
"$PICKER" help >"$WORK/help.out" 2>&1
if grep -qF 'nav ' "$WORK/help.out"; then
  ok "help: advertises the nav family"
else
  nok "help: advertises the nav family (help_text mentions no nav line)"
fi

# nav next must reach the dispatcher and drive native tmux ordering
# (switch-client -n), never the picker UI. Subprocess + fake-tmux shim.
: > "$WORK/tmux.log"
PATH="$WORK/bin:$PATH" XTMUX_TMUX_LOG="$WORK/tmux.log" "$PICKER" nav next >/dev/null 2>&1
if grep -q 'switch-client' "$WORK/tmux.log" && grep -q -- '-n' "$WORK/tmux.log"; then
  ok "nav next: dispatches to a tmux switch-client -n"
else
  nok "nav next: dispatches to a tmux switch-client -n (no switch-client call captured)"
  printf '      tmux calls: %s\n' "$(tr '\n' ';' < "$WORK/tmux.log" 2>/dev/null)"
fi
(
  tmux() { printf '%s\n' "$*"; }
  record_prev() { printf 'record-prev\n'; }
  nav_session_cycle prev
) > "$WORK/nav-prev.calls"
if grep -q '^record-prev$' "$WORK/nav-prev.calls" && grep -q '^switch-client -p$' "$WORK/nav-prev.calls"; then
  ok "nav prev: records previous target and uses native switch-client -p"
else
  nok "nav prev: records previous target and uses native switch-client -p"
fi
(
  tmux() { [ "$1" = display-message ] && printf '$7\t%%7\n'; }
  attn_cycle_target() { printf '$8\t%%8\n'; }
  record_prev() { printf 'record:%s:%s\n' "$1" "$2"; }
  jump_to_target() { printf 'jump:%s:%s:%s\n' "$1" "$2" "$3"; }
  nav_attention_cycle next
  nav_attention_cycle prev
) > "$WORK/nav-attention.calls"
if [ "$(grep -c '^record:\$7:%7$' "$WORK/nav-attention.calls")" -eq 2 ] \
  && [ "$(grep -c '^jump:pane:\$8:%8$' "$WORK/nav-attention.calls")" -eq 2 ]; then
  ok "nav attention: next/prev reuse live cycle target and exact pane jump"
else
  nok "nav attention: next/prev reuse live cycle target and exact pane jump"
fi
(
  tmux() { [ "$1" = show ] && printf '$9:%%9\n'; }
  jump_to_target() { printf 'jump:%s:%s:%s\n' "$1" "$2" "$3"; }
  jump_back
) > "$WORK/nav-back.calls"
assert_eq "nav back: reuses saved previous target" 'jump:pane:$9:%9' "$(cat "$WORK/nav-back.calls")"
_direct_src="$(awk '/^nav_session_cycle\(\)|^nav_attention_cycle\(\)|^jump_back\(\)/{f=1} f{print} f&&/^}/{f=0}' "$fn_file")"
if ! printf '%s\n' "$_direct_src" | grep -Eq 'build_list|git |fzf|preview_'; then
  ok "nav direct verbs: no list renderer, git, fzf, or preview enrichment"
else
  nok "nav direct verbs: no list renderer, git, fzf, or preview enrichment"
fi

# nav is interactive-only in the documented command matrix. Like the existing
# interactive commands, --json must use the standard unsupported refusal.
_nav_json="$( "$PICKER" nav --json 2>&1 >/dev/null )"
_nav_json_rc=$?
_nav_json_code="$(printf '%s' "$_nav_json" | grep -o '"code":"[^"]*"' | head -1 | sed 's/.*://; s/"//g')"
if [ "$_nav_json_rc" -ne 0 ] && [ "$_nav_json_code" = 'XTMUX_JSON_UNSUPPORTED' ]; then
  ok "nav --json: refused as interactive-only (XTMUX_JSON_UNSUPPORTED)"
else
  nok "nav --json: refused as interactive-only (got rc=$_nav_json_rc code=$_nav_json_code)"
  printf '      stderr: %s\n' "$_nav_json"
fi

echo
echo "== attention presets: waiting selects needs-input, running includes running (xtmux-rib.23/.25) =="
# build_list ranks panes via agent_rank: stale=0 needs-input=1 done=2 running=3.
# The waiting preset must select needs-input panes (not stale only) and the
# running preset must include actually-running panes. Today the guards are
# `waiting -> rank==0` and `running -> rank<=2`, so the two include-assertions
# below are RED: waiting drops needs-input, running drops running.
(
  TMUX_PICKER_NO_CACHE=1
  XTMUX_AGENT_STALE_AFTER=1s
  tmux() {
    case "$1" in
      list-sessions)
        # %b so the stub data's \t becomes a real tab (read -F splits on tabs)
        printf '%b\n' \
          '$WAIT\tWAIT\t%11\t'"$WORK"'/nowhere\t1000' \
          '$RUN\tRUN\t%12\t'"$WORK"'/nowhere\t1000' \
          '$STALE\tSTALE\t%13\t'"$WORK"'/nowhere\t1000' \
          '$IDLE\tIDLE\t%14\t'"$WORK"'/nowhere\t1000'
        ;;
      list-panes)
        printf '%b\n' \
          '$WAIT\t0\tw0\t%11\t0\t0\tbash\t'"$WORK"'/nowhere\tneeds-input\t999991\t-\t-\t-\t-' \
          '$RUN\t0\tw0\t%12\t0\t0\tbash\t'"$WORK"'/nowhere\trunning\t999992\t-\t-\t-\t-' \
          '$STALE\t0\tw0\t%13\t0\t0\tbash\t'"$WORK"'/nowhere\tworking\t999993\t-\t-\t-\t2000-01-01 00:00:00' \
          '$IDLE\t0\tw0\t%14\t0\t0\tbash\t'"$WORK"'/nowhere\t-\t999994\t-\t-\t-\t-'
        ;;
      *) return 1 ;;
    esac
  }
  build_list waiting > "$WORK/attn-wait.out" 2>/dev/null
  build_list running > "$WORK/attn-run.out" 2>/dev/null
)
if grep -qF $'\tWAIT\t' "$WORK/attn-wait.out"; then
  ok "preset waiting: includes a needs-input pane"
else
  nok "preset waiting: includes a needs-input pane (rank 1 excluded — guard is stale-only)"
fi
if grep -qF $'\tSTALE\t' "$WORK/attn-wait.out"; then
  ok "preset waiting: still includes a stale pane"
else
  nok "preset waiting: still includes a stale pane"
fi
if grep -qF $'\tRUN\t' "$WORK/attn-wait.out"; then
  nok "preset waiting: excludes a running pane"
else
  ok "preset waiting: excludes a running pane"
fi
if grep -qF $'\tRUN\t' "$WORK/attn-run.out"; then
  ok "preset running: includes an actually-running pane"
else
  nok "preset running: includes an actually-running pane (rank 3 excluded)"
fi
if grep -qF $'\tIDLE\t' "$WORK/attn-run.out"; then
  nok "preset running: excludes idle/unknown sessions"
else
  ok "preset running: excludes idle/unknown sessions"
fi

echo
echo "== action tokens: display text never becomes identity (xtmux-rib.23) =="
# NAV-1 record format pinned by the ADR and these tests:
#   <type>\t<sid>\t<sname>\t<target>\t<action-token>\t<display>
# field 6 is presentation-only and may contain spaces, newlines and shell
# metacharacters. Field 5 is the ONLY action input. nav_row_fields <row> sets
# REPLY='type\tsid\ttarget\ttoken' without parsing the display text.
# Implementation note: the picker runs under set -euo pipefail, and a
# NUL-delimited read (`read -r -d ''`) returns 1 at EOF with no NUL — the
# parser must tolerate that (|| true), or the whole CLI aborts mid-row.
require_fn nav_row_fields "nav-row: parser helper exists" && {
  nav_row_fields $'session\t$S1\talpha\t$S1\ts:$S1\tplain display'
  assert_eq "nav-row: benign row yields exact identity + token" $'session\t$S1\t$S1\ts:$S1' "$REPLY"

  nav_row_fields $'session\t$S1\talpha\t$S1\ts:$S1\t$(whoami); rm -rf /tmp/x; `id`; "quoted"; Δ unicode'
  assert_eq "nav-row: metachar display cannot shift identity" $'session\t$S1\t$S1\ts:$S1' "$REPLY"

  nav_row_fields $'pane\t$S2\tbeta\t%42\tp:$S2:%42\tline one\nline two\nline three'
  assert_eq "nav-row: newline display keeps identity + token" $'pane\t$S2\t%42\tp:$S2:%42' "$REPLY"

  _long="$(printf 'x%.0s' {1..500})"
  nav_row_fields "$(printf 'session\t$S3\tgamma\t$S3\ts:$S3\t%s' "$_long")"
  assert_eq "nav-row: 500-char display keeps identity" $'session\t$S3\t$S3\ts:$S3' "$REPLY"
}

require_fn parse_nav_token "nav-token: strict parser exists" && {
  parse_nav_token 's:$42'
  assert_eq "nav-token: session token" $'session\t$42\t' "$REPLY"
  parse_nav_token 'p:$42:%17'
  assert_eq "nav-token: paired pane token" $'pane\t$42\t%17' "$REPLY"
  parse_nav_token 'p:%17'
  assert_eq "nav-token: bare pane token" $'pane\t-\t%17' "$REPLY"
  for _bad in 's:%17' 's:$1:$2' 's:alpha' 'p:$42' 'p:%17:$42' 'p:$42:%x' $'s:$42\trow'; do
    if parse_nav_token "$_bad"; then
      nok "nav-token: rejects malformed $_bad"
    else
      ok "nav-token: rejects malformed $_bad"
    fi
  done
}

# Bulk consumption through the real CLI: the NAV-1 transport hands the
# handler per-row ACTION TOKENS (each argv element is one row's token, so
# display text never rides into the command). Today a bare token is parsed as
# a row whose TYPE is the token ($S1 is not session|pane), so nothing is
# killed: the token contract is missing. (The old `{+}` space-joined blob is
# exactly the coupling NAV-1 removes — display and fields are indistinguishable
# inside it, which is why tokens must travel separately.)
_r1=$'session\t$S1\talpha\t$S1\tone; touch /tmp/xtmux-evil'
: > "$WORK/bulk-calls"
PATH="$WORK/bin:$PATH" XTMUX_TMUX_LOG="$WORK/tmux.log" XTMUX_TMUX_PROMPT="$WORK/bulk-calls" \
  "$PICKER" bulk-kill 's:$1' 's:$2' >/dev/null 2>&1
if grep -qF '$1' "$WORK/bulk-calls" && grep -qF '$2' "$WORK/bulk-calls"; then
  ok "bulk-kill: consumes action tokens for every selected row"
else
  nok "bulk-kill: consumes action tokens for every selected row (token argv is ignored today)"
  printf '      payload: %s\n' "$(head -1 "$WORK/bulk-calls")"
fi

# A complete rendered row is not a valid bulk-action token. Reject it rather
# than parsing visual text, even when its hidden-looking prefix is plausible.
: > "$WORK/bulk-calls"
PATH="$WORK/bin:$PATH" XTMUX_TMUX_LOG="$WORK/tmux.log" XTMUX_TMUX_PROMPT="$WORK/bulk-calls" \
  "$PICKER" bulk-kill "$_r1" >/dev/null 2>&1
if [ ! -s "$WORK/bulk-calls" ]; then
  ok "bulk-kill: rejects complete rendered rows"
else
  nok "bulk-kill: rejects complete rendered rows"
fi
if grep -q 'evil' "$WORK/bulk-calls"; then
  nok "bulk-kill: hostile display never reaches the kill payload"
else
  ok "bulk-kill: hostile display never reaches the kill payload"
fi

# Validation is all-or-nothing: one malformed token must prevent a partial kill.
: > "$WORK/bulk-calls"
PATH="$WORK/bin:$PATH" XTMUX_TMUX_LOG="$WORK/tmux.log" XTMUX_TMUX_PROMPT="$WORK/bulk-calls" \
  "$PICKER" bulk-kill 's:$1' 's:%17' >/dev/null 2>&1
if [ ! -s "$WORK/bulk-calls" ]; then
  ok "bulk-kill: malformed selection prevents partial action"
else
  nok "bulk-kill: malformed selection prevents partial action"
fi
(
  tmux() {
    if [ "$1" = has-session ] && [ "${3:-}" = '$2' ]; then return 1; fi
    printf '%s\n' "$*" >> "$WORK/stale-bulk-calls"
  }
  : > "$WORK/stale-bulk-calls"
  bulk_kill 's:$1' 's:$2' >/dev/null 2>&1
  printf '%s' "$?" > "$WORK/stale-bulk-rc"
)
if [ "$(cat "$WORK/stale-bulk-rc")" -ne 0 ] && ! grep -q 'kill-' "$WORK/stale-bulk-calls"; then
  ok "bulk-kill: stale session prevents partial action"
else
  nok "bulk-kill: stale session prevents partial action"
fi

state_tmp="$WORK/state-tmp"; mkdir -p "$state_tmp"
TMPDIR="$state_tmp" "$PICKER" filter-preset waiting
assert_eq "filter preset: survives nav reload state" "waiting> " "$(TMPDIR="$state_tmp" "$PICKER" prompt-label)"
TMPDIR="$state_tmp" "$PICKER" filter-preset all
assert_eq "filter preset: all clears persisted state" "all> " "$(TMPDIR="$state_tmp" "$PICKER" prompt-label)"

# nav Enter records the previous target before it jumps.
require_fn nav_go "nav-go: action-token entrypoint exists" && {
  (
    record_prev() { printf 'prev\n'; }
    jump_to_target() { printf 'jump:%s:%s:%s\n' "$1" "$2" "$3"; }
    nav_go 's:$42'
  ) > "$WORK/nav-go-order"
  assert_eq "nav-go: records previous target before jump" $'prev\njump:session:$42:$42' "$(cat "$WORK/nav-go-order")"
}

# Prompt text is passed as a literal send-keys argv; tmux never reparses it.
(
  tmux() { printf '%s\n' "$*" >> "$WORK/message-tmux"; }
  prompt_line() { REPLY="apostrophe' ; \$(touch $WORK/message-pwned) ; \`id\`"; }
  : > "$WORK/message-tmux"
  act_on_target pane '$42' '%17' message
)
if grep -q 'command-prompt\|run-shell' "$WORK/message-tmux" || [ -e "$WORK/message-pwned" ]; then
  nok "message action: apostrophe/metacharacters stay literal"
else
  ok "message action: apostrophe/metacharacters stay literal"
fi
if grep -q '^send-keys -t %17 -l -- ' "$WORK/message-tmux" && [ "$(wc -l < "$WORK/message-tmux")" -eq 2 ]; then
  ok "message action: literal send plus separate Enter"
else
  nok "message action: literal send plus separate Enter"
fi
(
  tmux() {
    case "$1" in
      display-message) printf 'old-name\n' ;;
      *) printf '%s\n' "$*" >> "$WORK/rename-tmux" ;;
    esac
  }
  prompt_line() { REPLY="rename' ; \$(touch $WORK/rename-pwned) ; \`id\`"; }
  : > "$WORK/rename-tmux"
  rename_target session '$42' '$42'
)
if [ ! -e "$WORK/rename-pwned" ] && grep -q '^rename-session -t \$42 rename' "$WORK/rename-tmux"; then
  ok "rename action: apostrophe/metacharacters stay literal"
else
  nok "rename action: apostrophe/metacharacters stay literal"
fi

echo
echo "== multiline fzf: semantic capability probe + deterministic one-line fallback (xtmux-rib.23) =="
# The probe must not determine capability by RUNNING fzf's search engine
# (--filter) — that is circular. It may read `fzf --version`/`--help`.
require_fn fzf_multiline_probe "fzf probe: fzf_multiline_probe() exists" && {
  fzf_multiline_probe; _p1="$REPLY"
  fzf_multiline_probe; _p2="$REPLY"
  case "$_p1" in
    on|off|classic) ok "fzf probe: returns on|off|classic (got $_p1)" ;;
    *) nok "fzf probe: returns on|off|classic (got '$_p1')" ;;
  esac
  [ "$_p1" = "$_p2" ] && ok "fzf probe: deterministic across calls" || nok "fzf probe: deterministic across calls"
  if command -v fzf >/dev/null && command -v script >/dev/null && command -v cmp >/dev/null; then
    assert_eq "fzf probe: supported installed fixture proves multiline semantics" on "$(_fzf_multiline_probe_run "$(command -v fzf)")"
  fi
}
require_fn display_fallback "fzf fallback: display_fallback() exists" && {
  _multi=$'line one\nline two\nline three'
  display_fallback "$_multi"; _f1="$REPLY"
  # grep cannot detect newlines (a lone-newline pattern matches any line);
  # case-glob on the real newline byte instead.
  case "$_f1" in
    *$'\n'*) nok "fzf fallback: collapses newlines to one line" ;;
    *) ok "fzf fallback: collapses newlines to one line" ;;
  esac
  display_fallback "$_multi"; _f2="$REPLY"
  [ "$_f1" = "$_f2" ] && ok "fzf fallback: deterministic" || nok "fzf fallback: deterministic"
  display_fallback 'single line'
  assert_eq "fzf fallback: single-line text unchanged" 'single line' "$REPLY"
}
if command -v fzf >/dev/null && command -v script >/dev/null && command -v cmp >/dev/null; then
  cat > "$WORK/hanging-fzf" <<'EOF'
#!/bin/sh
sleep 30
EOF
  chmod +x "$WORK/hanging-fzf"
  _probe_started=$SECONDS
  assert_eq "fzf probe: hung binary times out to classic" classic "$(_fzf_multiline_probe_run "$WORK/hanging-fzf")"
  [ $((SECONDS - _probe_started)) -lt 8 ] && ok "fzf probe: timeout is bounded" || nok "fzf probe: timeout is bounded"

  _forged="$WORK/forged-cache"; mkdir -p "$_forged"
  _bin="$(command -v fzf)"; _ver="$(fzf --version 2>/dev/null | head -1)"; _identity="$(stat -Lc '%d:%i:%s:%Y' "$_bin")"
  printf '%s\non\n' "probe-v2 $_bin $_ver $_identity" > "$_forged/fzf-multiline"
  ln -s "$_forged" "$WORK/tmux-picker-state-${UID:-$(id -u)}"
  (
    _fzf_multiline_probe_run() { printf 'classic\n'; }
    TMPDIR="$WORK" fzf_multiline_probe
    printf '%s' "$REPLY"
  ) > "$WORK/symlink-probe"
  assert_eq "fzf probe: symlink cache cannot bypass semantic probe" classic "$(cat "$WORK/symlink-probe")"
fi
_attack_tmp="$WORK/state-attack"; mkdir -p "$_attack_tmp"
_attack_dir="$_attack_tmp/tmux-picker-state-${UID:-$(id -u)}"; mkdir -m 700 "$_attack_dir"
printf 'untouched' > "$WORK/state-victim"
ln -s "$WORK/state-victim" "$_attack_dir/filter"
TMPDIR="$_attack_tmp" "$PICKER" filter-preset waiting >/dev/null 2>&1 || true
assert_eq "picker state: filter symlink cannot truncate target" untouched "$(cat "$WORK/state-victim")"
# source guard: the probe implementation must never invoke --filter.
_probe_src="$(awk '/^fzf_multiline_probe\(\)/{f=1;next} f&&/^}/{f=0} f{print}' "$fn_file")"
if [ -n "$_probe_src" ] && ! printf '%s\n' "$_probe_src" | grep -q -- '--filter'; then
  ok "fzf probe: implementation never uses --filter"
else
  nok "fzf probe: implementation never uses --filter (missing, or the probe runs fzf search)"
fi

echo
echo "== attention cycle: wrap, current-not-listed, empty (xtmux-rib.25) =="
# attn_cycle_target <next|prev> <current_pane> -> prints 'sid<TAB>pane' of the
# target in attn_list order (rank asc, activity desc), or nothing on empty.
# Reuses attn_list; must not enrich git/preview. Stub pane set: %1 needs-input
# (rank 1), %2 done (rank 2); %3 running is excluded by attn_list's rank<=2.
require_fn attn_cycle_target "attn cycle: attn_cycle_target() exists" && {
  (
    tmux() {
      case "$1" in
        list-panes)
          # %b: \t must become a real tab for attn_list's read to split on
          printf '%b\n' \
            '$A\tWAIT\t%1\tbash\t1000\tneeds-input\t99001\t-' \
            '$B\tDONE\t%2\tbash\t1000\tdone\t99002\t-' \
            '$C\tRUN\t%3\tbash\t1000\trunning\t99003\t-'
          ;;
        *) return 1 ;;
      esac
    }
    attn_cycle_target next '%1' > "$WORK/cycle-next1.out"
    attn_cycle_target next '%2' > "$WORK/cycle-next2.out"
    attn_cycle_target next '%9' > "$WORK/cycle-next9.out"
    attn_cycle_target prev '%9' > "$WORK/cycle-prev9.out"
  )
  assert_eq "attn cycle: next from first pane" $'$B\t%2' "$(cat "$WORK/cycle-next1.out")"
  assert_eq "attn cycle: next wraps from last pane" $'$A\t%1' "$(cat "$WORK/cycle-next2.out")"
  assert_eq "attn cycle: current not listed -> next picks first" $'$A\t%1' "$(cat "$WORK/cycle-next9.out")"
  assert_eq "attn cycle: current not listed -> prev picks last" $'$B\t%2' "$(cat "$WORK/cycle-prev9.out")"

  (
    tmux() { case "$1" in list-panes) return 0 ;; *) return 1 ;; esac; }
    attn_cycle_target next '%9' > "$WORK/cycle-empty.out" 2>/dev/null
    printf '%s' "$?" > "$WORK/cycle-empty.rc"
  )
  if [ ! -s "$WORK/cycle-empty.out" ] && [ "$(cat "$WORK/cycle-empty.rc")" = 0 ]; then
    ok "attn cycle: empty attention is a non-error (no target, exit 0)"
  else
    nok "attn cycle: empty attention is a non-error (no target, exit 0)"
  fi
}

echo
echo "== renderer helpers: bounded width + current marker (xtmux-rib.23/.27) =="
# fit_width <text> <width> -> REPLY. Unchanged when it fits; otherwise
# truncated to exactly <width> characters, ending with a single ellipsis.
# Character-safe (never splits a multi-byte UTF-8 char). Widths 32/44/60 are
# the pinned narrow-layout band from xtmux-rib.27.
require_fn fit_width "renderer: fit_width() exists" && {
  fit_width 'hello world' 32
  assert_eq "fit_width: short text unchanged" 'hello world' "$REPLY"
  fit_width 'hello world' 0
  assert_eq "fit_width: zero width is empty" '' "$REPLY"

  _w32="$(printf 'a%.0s' {1..32})"
  fit_width "$_w32" 32
  assert_eq "fit_width: exact-width boundary unchanged" "$_w32" "$REPLY"

  _w33="$(printf 'a%.0s' {1..33})"; _want="${_w33:0:31}…"
  fit_width "$_w33" 32
  assert_eq "fit_width: 33 chars at width 32" "$_want" "$REPLY"

  _w45="$(printf 'a%.0s' {1..45})"; _want="${_w45:0:43}…"
  fit_width "$_w45" 44
  assert_eq "fit_width: 45 chars at width 44" "$_want" "$REPLY"

  _w61="$(printf 'a%.0s' {1..61})"; _want="${_w61:0:59}…"
  fit_width "$_w61" 60
  assert_eq "fit_width: 61 chars at width 60" "$_want" "$REPLY"

  fit_width 'héllo wörld' 5
  assert_eq "fit_width: multi-byte chars never split" 'héll…' "$REPLY"
}
# current_marker <row-id> <current-id> -> REPLY='▶' when the row IS the current
# session/pane, else a single space (keeps columns aligned).
require_fn nav_pane_context "renderer: pane context helper exists" && {
  nav_pane_context - - /repo/sub /repo
  assert_eq "renderer: absent metadata sentinel falls back to path" sub "$REPLY"
}
require_fn current_marker "renderer: current_marker() exists" && {
  current_marker '%1' '%1'; assert_eq "current marker: current pane" '▶' "$REPLY"
  current_marker '%2' '%1'; assert_eq "current marker: other pane" ' ' "$REPLY"
  current_marker '$1' '$1'; assert_eq "current marker: current session" '▶' "$REPLY"
  current_marker '$2' '$1'; assert_eq "current marker: other session" ' ' "$REPLY"
}

for _route_case in on off classic; do
  (
    fzf_multiline_probe() { REPLY="$_route_case"; }
    nav_route
    printf '%s' "$REPLY"
  ) > "$WORK/route-$_route_case"
done
assert_eq "nav route: multiline capability" multiline "$(cat "$WORK/route-on")"
assert_eq "nav route: one-line fallback" oneline "$(cat "$WORK/route-off")"
assert_eq "nav route: classic fallback" classic "$(cat "$WORK/route-classic")"
cat > "$WORK/nav-list-stub" <<'EOF'
#!/usr/bin/env bash
printf '%s' "$1" > "${NAV_STUB_LOG:-/dev/null}"
if [ "${NAV_SPECIALIST:-0}" = 1 ]; then
  printf 'session\t$1\tone\t$1\ts:$1\t  one\0session\t$2\ttwo\t$2\ts:$2\t── specialists ──\n▶ two\0'
else
  printf 'session\t$1\tone\t$1\ts:$1\t  one\0session\t$2\ttwo\t$2\ts:$2\t▶ two\0'
fi
EOF
chmod +x "$WORK/nav-list-stub"
(
  nav_route() { REPLY=multiline; }
  fzf() { printf '%s\n' "$*" > "$WORK/nav-fzf-args"; cat >/dev/null; }
  self="$WORK/nav-list-stub"
  NAV_STUB_LOG="$WORK/nav-stub-command" pick_nav
)
if grep -q 'load:pos(2)' "$WORK/nav-fzf-args"; then
  ok "nav reveal: initial selection positions on current marker"
else
  nok "nav reveal: initial selection positions on current marker"
fi
assert_eq "nav filter: initial list uses persisted filter state" list-active-nav "$(cat "$WORK/nav-stub-command")"
(
  nav_route() { REPLY=multiline; }
  fzf() { printf '%s\n' "$*" > "$WORK/nav-specialist-fzf-args"; cat >/dev/null; }
  self="$WORK/nav-list-stub"
  NAV_SPECIALIST=1 pick_nav
)
if grep -q 'load:pos(2)' "$WORK/nav-specialist-fzf-args"; then
  ok "nav reveal: specialist preamble does not hide current marker"
else
  nok "nav reveal: specialist preamble does not hide current marker"
fi

# Integrated private transport: shared inventory -> bounded NUL cards/tokens.
(
  session_meta() { printf '%b\n' '$42\talpha\x07bell\x08back\x1fbeta\x1egamma\x1bdelta\t%17\t'"$WORK"'/none\t1000'; }
  pane_meta() { printf '%b\n' '$42\t0\tw0\t%17\t0\t1\tbash\t'"$WORK"'/none\tneeds-input\t999991\tbead.1\ta bounded task\t-\t-'; }
  TMUX_PANE='%17' XTMUX_NAV_WIDTH=32 TMUX_PICKER_NO_CACHE=1 build_list all expanded nav multi
) > "$WORK/nav-records"
_count=0; _session_seen=0; _pane_seen=0; _header_seen=0; _wide=0; _framing_clean=1
while IFS= read -r -d '' _record; do
  _count=$((_count + 1))
  IFS=$'\t' read -r _type _sid _name _target _token _first <<< "$_record"
  _prefix="$_type"$'\t'"$_sid"$'\t'"$_name"$'\t'"$_target"$'\t'"$_token"$'\t'
  _display="${_record#"$_prefix"}"
  case "$_record" in *$'\x07'*|*$'\x08'*|*$'\x1f'*|*$'\x1e'*|*$'\x1b'*) _framing_clean=0 ;; esac
  case "$_type" in
    session)
      [ "$_token" = 's:$42' ] && _session_seen=1
      case "$_display" in '▶ '*) ;; *) _session_seen=0 ;; esac
      ;;
    pane) [ "$_token" = 'p:$42:%17' ] && _pane_seen=1 ;;
    header) _header_seen=1 ;;
  esac
  while IFS= read -r _visual; do [ "${#_visual}" -le 32 ] || _wide=1; done <<< "$_display"
done < "$WORK/nav-records"
[ "$_count" -eq 2 ] && ok "nav records: two NUL records remain distinct" || nok "nav records: two NUL records remain distinct"
[ "$_session_seen" -eq 1 ] && ok "nav records: session token and current marker" || nok "nav records: session token and current marker"
[ "$_pane_seen" -eq 1 ] && ok "nav records: pane token exact" || nok "nav records: pane token exact"
[ "$_header_seen" -eq 0 ] && ok "nav records: no selectable header" || nok "nav records: no selectable header"
[ "$_wide" -eq 0 ] && ok "nav records: every visual line bounded at 32" || nok "nav records: every visual line bounded at 32"
[ "$_framing_clean" -eq 1 ] && ok "nav records: internal control delimiters sanitized" || nok "nav records: internal control delimiters sanitized"

(
  session_meta() { printf '%b\n' '$42\talpha\t%17\t'"$WORK"'/none\t1000'; }
  pane_meta() { printf '%b\n' '$42\t0\tw0\t%17\t0\t1\tbash\t'"$WORK"'/none\tneeds-input\t999991\tbead.1\ta bounded task\t-\t-'; }
  TMUX_PANE='%999' XTMUX_NAV_WIDTH=44 TMUX_PICKER_NO_CACHE=1 build_list all expanded nav single
) > "$WORK/nav-single"
_single_newline=0; _false_marker=0
while IFS= read -r -d '' _record; do
  IFS=$'\t' read -r _type _sid _name _target _token _first <<< "$_record"
  _prefix="$_type"$'\t'"$_sid"$'\t'"$_name"$'\t'"$_target"$'\t'"$_token"$'\t'
  _display="${_record#"$_prefix"}"
  case "$_display" in *$'\n'*) _single_newline=1 ;; esac
  case "$_display" in '▶ '*) _false_marker=1 ;; esac
done < "$WORK/nav-single"
[ "$_single_newline" -eq 0 ] && ok "nav fallback: one-line records contain no newline" || nok "nav fallback: one-line records contain no newline"
[ "$_false_marker" -eq 0 ] && ok "nav marker: unverifiable TMUX_PANE omitted" || nok "nav marker: unverifiable TMUX_PANE omitted"

# Installed tmux format substitutions neutralize tabs/newlines before TSV framing.
_sock="xtmux-nav-meta-$$"
_meta_dir="$WORK/meta"$'\n'$'tab\tpath'
mkdir -p "$_meta_dir"
command tmux -L "$_sock" -f /dev/null new-session -d -s nav-meta -c "$_meta_dir"
_meta_pane="$(command tmux -L "$_sock" display-message -p -t nav-meta '#{pane_id}')"
command tmux -L "$_sock" rename-window -t "$_meta_pane" $'window\nname\ttab'
command tmux -L "$_sock" set-option -p -t "$_meta_pane" @agent_task $'task\nline\ttab'
(
  tmux() { command tmux -L "$_sock" "$@"; }
  session_meta
  pane_meta
) > "$WORK/meta.tsv"
command tmux -L "$_sock" kill-server
_meta_lines="$(wc -l < "$WORK/meta.tsv")"
_meta_bad="$(awk -F '\t' 'NR==1&&NF!=5{bad=1} NR==2&&NF!=14{bad=1} END{print bad+0}' "$WORK/meta.tsv")"
[ "$_meta_lines" -eq 2 ] && [ "$_meta_bad" -eq 0 ] && ok "metadata framing: control characters cannot create records" || nok "metadata framing: control characters cannot create records"

harness_summary
exit $?
