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
  # deterministic live read so callers recording the previous target
  # (record_prev) or validating owned windows can run end-to-end.
  display-message) printf '$9\t%%9\n' ;;
esac
exit 0
SHIM
chmod +x "$WORK/bin/tmux"
# Fake `git`/`fzf` that FAIL LOUDLY: the nav verbs (§21) must never reach
# them; any invocation is a regression of the direct-nav guarantee.
for _fbm in git fzf; do
  cat > "$WORK/bin/$_fbm" <<SHIM
#!/usr/bin/env bash
echo "FORBIDDEN: $_fbm \$*" >> "${XTMUX_TMUX_LOG:-/dev/null}"
exit 99
SHIM
  chmod +x "$WORK/bin/$_fbm"
done

# nav_current_location resolves the current session from the INVOKING CLIENT
# (one bounded display-message #{session_id}). Sourced-function fixtures default
# the client into $42; any subsection that needs different tmux behavior defines
# its own tmux() and shadows this default. build_list nav subsections use it;
# subprocess tests use the PATH shims above, never this function.
tmux() {
  case "$*" in
    *'#{session_id}'*) printf '$42\n' ;;
    *) return 0 ;;
  esac
}

echo
echo "== nav: dispatch, help, and --json classification (xtmux-rib.23/.25) =="
# NAV-3 requires one discoverable command family: nav next|prev|attention-next|
# attention-prev|back. Today `nav` is an unknown command (exit 2), so the
# dispatch arm, its help, and its JSON classification are all missing.
nav_verbs='next prev window-next window-prev attention-next attention-prev back'

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
_direct_src="$(awk '/^nav_session_cycle\(\)|^nav_window_cycle\(\)|^nav_attention_cycle\(\)|^jump_back\(\)/{f=1} f{print} f&&/^}/{f=0}' "$fn_file")"
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

# NAV-T5: window-next/window-prev must reach the dispatcher and invoke the
# NATIVE tmux next-window/previous-window operations (verified syntax against
# tmux 3.5a: no -t needed — current client's session, wraps around; [-a] is
# alert-jump and is NOT used). The fake git/fzf shims above fail loudly if the
# verbs ever touch them.
: > "$WORK/tmux.log"
PATH="$WORK/bin:$PATH" XTMUX_TMUX_LOG="$WORK/tmux.log" "$PICKER" nav window-next >/dev/null 2>&1
if grep -q '^next-window$' "$WORK/tmux.log"; then
  ok "nav window-next: dispatches to a tmux next-window (native op)"
else
  nok "nav window-next: dispatches to a tmux next-window (log: $(tr '\n' ';' < "$WORK/tmux.log" 2>/dev/null))"
fi
if grep -q 'FORBIDDEN' "$WORK/tmux.log"; then
  nok "nav window-next: never touches git/fzf (got $(grep FORBIDDEN "$WORK/tmux.log" | tr '\n' ';'))"
else
  ok "nav window-next: never touches git/fzf"
fi
: > "$WORK/tmux.log"
PATH="$WORK/bin:$PATH" XTMUX_TMUX_LOG="$WORK/tmux.log" "$PICKER" nav window-prev >/dev/null 2>&1
if grep -q '^previous-window$' "$WORK/tmux.log"; then
  ok "nav window-prev: dispatches to a tmux previous-window (native op)"
else
  nok "nav window-prev: dispatches to a tmux previous-window (log: $(tr '\n' ';' < "$WORK/tmux.log" 2>/dev/null))"
fi
if grep -q 'FORBIDDEN' "$WORK/tmux.log"; then
  nok "nav window-prev: never touches git/fzf (got $(grep FORBIDDEN "$WORK/tmux.log" | tr '\n' ';'))"
else
  ok "nav window-prev: never touches git/fzf"
fi
# Neither verb may build the inventory (no list-panes/list-sessions) — §21
# "do not enumerate every session". The two runs above each leave exactly the
# record_prev pair (display-message, set) plus the native op.
if [ "$(grep -c '^list-' "$WORK/tmux.log" 2>/dev/null)" -eq 0 ] \
  && [ "$(grep -c '^next-window$\|^previous-window$' "$WORK/tmux.log")" -eq 1 ] \
  && [ "$(grep -c '^set -g @picker_prev' "$WORK/tmux.log")" -eq 1 ]; then
  ok "nav window: records previous exact pane, no inventory enumeration (single native op)"
else
  nok "nav window: records previous exact pane, no inventory enumeration (log: $(tr '\n' ';' < "$WORK/tmux.log" 2>/dev/null))"
fi
# Hosted wiring: record_prev fires BEFORE the native op for both verbs, and a
# following `back` jumps to the exact saved pane token (p:%sid:%pane).
(
  tmux() { printf '%s\n' "$*"; }
  record_prev() { printf 'record-prev\n'; }
  nav_window_cycle next
  nav_window_cycle prev
) > "$WORK/nav-window.calls"
if [ "$(grep -c '^record-prev$' "$WORK/nav-window.calls")" -eq 2 ] \
  && grep -q '^next-window$' "$WORK/nav-window.calls" \
  && grep -q '^previous-window$' "$WORK/nav-window.calls"; then
  ok "nav window: record precedes native next-window/previous-window for next and prev"
else
  nok "nav window: record precedes native next-window/previous-window (got: $(tr '\n' ';' < "$WORK/nav-window.calls"))"
fi
(
  tmux() {
    case "$1" in
      display-message) printf '$42\t%%553\n' ;;  # record_prev's live read
      set) : ;;                                   # @picker_prev write
      show) printf '$42:%%553\n' ;;               # jump_back's read
      next-window|previous-window) printf '%s\n' "$1" ;;
    esac
  }
  jump_to_target() { printf 'jump:%s:%s:%s\n' "$1" "$2" "$3"; }
  record_prev
  nav_window_cycle next
  jump_back
) > "$WORK/nav-window-back.calls"
assert_eq "nav back after window-next: returns to the exact previous pane" 'next-window
jump:pane:$42:%553' "$(cat "$WORK/nav-window-back.calls")"

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
          '$WAIT\t@1\t0\tw0\t0\t%11\t0\t0\tbash\t'"$WORK"'/nowhere\tneeds-input\t999991\t-\t-\t-\t-' \
          '$RUN\t@2\t0\tw0\t0\t%12\t0\t0\tbash\t'"$WORK"'/nowhere\trunning\t999992\t-\t-\t-\t-' \
          '$STALE\t@3\t0\tw0\t0\t%13\t0\t0\tbash\t'"$WORK"'/nowhere\tworking\t999993\t-\t-\t-\t2000-01-01 00:00:00' \
          '$IDLE\t@4\t0\tw0\t0\t%14\t0\t0\tbash\t'"$WORK"'/nowhere\t-\t999994\t-\t-\t-\t-'
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
  parse_nav_token 'w:$42:@17'
  assert_eq "nav-token: window token" $'window\t$42\t@17' "$REPLY"
  parse_nav_token 'p:$42:%553'
  assert_eq "nav-token: paired pane token" $'pane\t$42\t%553' "$REPLY"
  parse_nav_token 'p:%17'
  assert_eq "nav-token: bare pane token" $'pane\t-\t%17' "$REPLY"
  for _bad in 's:%17' 's:$1:$2' 's:alpha' 'p:$42' 'p:%17:$42' 'p:$42:%x' 'p:$42:@17' 's:$42:@17' \
    'w:@17' 'w:$42:coord' 'w:$42:0' 'w:program:@17' 'w:$42:@x' 'w:$42:%17' \
    'w: $42:@17' 'w:$42:@17 ' $'w:$42:@17\trow' $'w:$42:@17\n' $'s:$42\trow'; do
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


# ---- NAV-T3: w:$N:@N token ownership, nav_go window, window actions (xtmux-w5i.4) ----
echo
echo "== NAV-T3: window tokens, ownership, nav_go window, window actions (xtmux-w5i.4) =="
require_fn resolve_nav_window_session "nav-t3: resolve_nav_window_session() exists" && {
  (
    tmux() {
      case "$*" in
        *'@17'*) printf '$42\t@17\n' ;;
        *'@31'*) printf '$99\n' ;;
        *) return 1 ;;
      esac
    }
    resolve_nav_window_session '$42' '@17'; printf 'match rc=%s reply=%s\n' "$?" "$REPLY"
    resolve_nav_window_session '$42' '@31'; printf 'moved rc=%s\n' "$?"
    resolve_nav_window_session '$42' '@88'; printf 'gone rc=%s\n' "$?"
    resolve_nav_window_session '' '@17'; printf 'encodedless rc=%s reply=%s\n' "$?" "$REPLY"
  ) > "$WORK/t3-own.out"
  _l1="$(sed -n '1p' "$WORK/t3-own.out")"
  assert_eq "nav-t3: window ownership match resolves the live session" 'match rc=0 reply=$42' "$_l1"
  if [ "$(sed -n '2p' "$WORK/t3-own.out")" = 'moved rc=1' ] && [ "$(sed -n '3p' "$WORK/t3-own.out")" = 'gone rc=1' ]; then
    ok "nav-t3: window moved/gone refuses (nonzero, no partial state)"
  else
    nok "nav-t3: window moved/gone refuses (nonzero, no partial state)"
  fi
  assert_eq "nav-t3: bare window token resolves live owner (nothing to compare)" 'encodedless rc=0 reply=$42' "$(sed -n '4p' "$WORK/t3-own.out")"
  (
  tmux() {
    case "$*" in
      *'list-panes -s -t $71'*) printf '%%111\n%%553\n' ;;
      *'list-panes -s -t $42'*) printf '%%777\n' ;;
      *) printf '$99\n' ;;
    esac
  }
  resolve_nav_pane_session '$71' '%553'; printf 'pane-match rc=%s\n' "$?"
  resolve_nav_pane_session '$42' '%553'; printf 'pane-mismatch rc=%s\n' "$?"
) > "$WORK/t3-pane-own.out"
  assert_eq "nav-t3: pane ownership match" 'pane-match rc=0' "$(sed -n '1p' "$WORK/t3-pane-own.out")"
  assert_eq "nav-t3: pane in a different session refuses" 'pane-mismatch rc=1' "$(sed -n '2p' "$WORK/t3-pane-own.out")"
}

# nav_go window: validate @N -> record previous exact pane -> select exact @N.
(
  tmux() { [ "$1" = display-message ] && printf '$42\t@17\n'; }
  record_prev() { printf 'prev\n'; }
  jump_to_target() { printf 'jump:%s:%s:%s\n' "$1" "$2" "$3"; }
  nav_go 'w:$42:@17'
) > "$WORK/t3-navgo-win.ok"
assert_eq "nav-t3: nav_go window records previous then selects exact @N" $'prev\njump:window:$42:@17' "$(cat "$WORK/t3-navgo-win.ok")"
# stale record: the window's live owning session no longer matches the claim.
(
  tmux() { [ "$1" = display-message ] && printf '$99\n'; }
  record_prev() { printf 'prev\n'; }
  jump_to_target() { printf 'jump:%s:%s:%s\n' "$1" "$2" "$3"; }
  nav_go 'w:$42:@17'
) > "$WORK/t3-navgo-win.stale" 2>&1
printf '%s' "$?" > "$WORK/t3-navgo-win.stale.rc"
if [ "$(cat "$WORK/t3-navgo-win.stale.rc")" -ne 0 ] && [ ! -s "$WORK/t3-navgo-win.stale" ]; then
  ok "nav-t3: stale window record fails safely (no prev record, no jump)"
else
  nok "nav-t3: stale window record fails safely (no prev record, no jump)"
fi
# window moved to a different session refuses the same way.
(
  tmux() { case "$*" in *'@17'*) printf '$99\n' ;; *) printf 'x\n' ;; esac; }
  record_prev() { printf 'prev\n'; }
  jump_to_target() { printf 'jump:%s:%s:%s\n' "$1" "$2" "$3"; }
  nav_go 'w:$42:@17'
) > "$WORK/t3-navgo-win.moved" 2>&1
printf '%s' "$?" > "$WORK/t3-navgo-win.moved.rc"
if [ "$(cat "$WORK/t3-navgo-win.moved.rc")" -ne 0 ] && [ ! -s "$WORK/t3-navgo-win.moved" ]; then
  ok "nav-t3: window in a different session refused (moved window)"
else
  nok "nav-t3: window in a different session refused (moved window)"
fi
# the real jump primitive selects the exact @window_id (shim logs the command).
: > "$WORK/t3-win-jump.log"
(
  export PATH="$WORK/bin:$PATH"
  export XTMUX_TMUX_LOG="$WORK/t3-win-jump.log"
  jump_to_target window '$42' '@17'
)
if grep -q 'switch-client -t $42' "$WORK/t3-win-jump.log" && grep -q 'select-window -t @17' "$WORK/t3-win-jump.log"; then
  ok "nav-t3: jump to window moves the client to the session and selects the exact @N"
else
  nok "nav-t3: jump to window moves the client and selects exact @N (got $(tr '\n' ';' < "$WORK/t3-win-jump.log"))"
fi

# Window actions: ownership gate first; kill/rename target the exact @N.
require_fn nav_act "nav-t3: window action dispatcher exists" && {
  : > "$WORK/t3-win-kill.log"
  (
    tmux() {
      case "$1" in
        display-message) printf '%s\n' "$*" >> "$WORK/t3-win-kill.log"; case "$*" in *'#{window_id}'*) printf '$42\t@17\n' ;; *'#{session_id}'*) printf '$42\n' ;; *) printf '?\n' ;; esac ;;
        *) printf '%s\n' "$*" >> "$WORK/t3-win-kill.log" ;;
      esac
    }
    nav_act 'w:$42:@17' kill
  )
  if grep -q 'kill-window -t @17' "$WORK/t3-win-kill.log" && ! grep -q 'kill-pane\|kill-session' "$WORK/t3-win-kill.log"; then
    ok "nav-t3: kill on a window row confirms kill-window -t @N"
  else
    nok "nav-t3: kill on a window row confirms kill-window -t @N (got $(tr '\n' ';' < "$WORK/t3-win-kill.log"))"
  fi
  : > "$WORK/t3-win-rename.log"
  (
    tmux() {
      case "$1" in
        display-message) printf '%s\n' "$*" >> "$WORK/t3-win-rename.log"; case "$*" in *'#{window_id}'*) printf '$42\t@17\n' ;; *'#{session_id}'*) printf '$42\n' ;; *'#W'*) printf "hostile ; \$(rm -rf /tmp/x) ; \`id\` ; \"quoted\" ; Δ\n" ;; *) printf '?\n' ;; esac ;;
        *) printf '%s\n' "$*" >> "$WORK/t3-win-rename.log" ;;
      esac
    }
    prompt_line() { REPLY="new name' ; \$(touch $WORK/rename-win-pwned) ; \`id\`"; }
    nav_act 'w:$42:@17' rename
  )
  if grep -q '^rename-window -t @17 ' "$WORK/t3-win-rename.log"     && [ ! -e "$WORK/rename-win-pwned" ]     && ! grep -q 'rename-window -t \$42' "$WORK/t3-win-rename.log"; then
    ok "nav-t3: rename on a window row renames exact @N, hostile name stays literal"
  else
    nok "nav-t3: rename on a window row renames exact @N, hostile name stays literal (got $(tr '\n' ';' < "$WORK/t3-win-rename.log"))"
  fi
  # pane-only action on a window row: bounded non-error message, no silent pane act.
  : > "$WORK/t3-win-paneonly.log"
  (
    tmux() {
      case "$1" in
        display-message) printf '%s\n' "$*" >> "$WORK/t3-win-paneonly.log"; case "$*" in *'#{window_id}'*) printf '$42\t@17\n' ;; *'#{session_id}'*) printf '$42\n' ;; *) printf '?\n' ;; esac ;;
        *) printf '%s\n' "$*" >> "$WORK/t3-win-paneonly.log" ;;
      esac
    }
    nav_act 'w:$42:@17' approve
  ) >/dev/null 2>&1
  if grep -q 'riga finestra' "$WORK/t3-win-paneonly.log"     && ! grep -q 'send-keys' "$WORK/t3-win-paneonly.log"     && ! grep -q 'kill-\|interrupt' "$WORK/t3-win-paneonly.log"; then
    ok "nav-t3: pane-only action on a window row emits a bounded message only"
  else
    nok "nav-t3: pane-only action on a window row emits a bounded message only (got $(tr '\n' ';' < "$WORK/t3-win-paneonly.log"))"
  fi
}

# Subprocess path: the fake tmux shim cannot prove window ownership, so a
# window token through nav-act must refuse with no destructive side effect.
: > "$WORK/t3-subprocess.log"
PATH="$WORK/bin:$PATH" XTMUX_TMUX_LOG="$WORK/t3-subprocess.log" "$PICKER" nav-act 'w:$42:@17' kill >/dev/null 2>&1
if [ ! -s "$WORK/t3-subprocess.log" ] || grep -q 'kill-window\|kill-pane\|kill-session' "$WORK/t3-subprocess.log"; then
  nok "nav-t3: subprocess nav-act on unprovable window token refuses (kill never emitted)"
else
  ok "nav-t3: subprocess nav-act on unprovable window token refuses (kill never emitted)"
fi

# bulk-kill accepts window tokens with the same ownership gate; the confirm
# chain carries kill-window -t @N, never a pane/session guess.
: > "$WORK/t3-bulkwin.log"
(
  tmux() {
    case "$1" in
      display-message) case "$*" in *'#{window_id}'*) printf '$42\t@17\n' ;; *'#{session_id}'*) printf '$42\n' ;; *) printf '?\n' ;; esac ;;
      *) printf '%s\n' "$*" >> "$WORK/t3-bulkwin.log" ;;
    esac
  }
  bulk_kill 'w:$42:@17'
)
if grep -q 'kill-window -t @17' "$WORK/t3-bulkwin.log" && ! grep -q 'kill-pane\|kill-session' "$WORK/t3-bulkwin.log"; then
  ok "nav-t3: bulk-kill on window tokens confirms kill-window -t @N"
else
  nok "nav-t3: bulk-kill on window tokens confirms kill-window -t @N (got $(tr '\n' ';' < "$WORK/t3-bulkwin.log"))"
fi
# a stale window token aborts the whole bulk selection (all-or-nothing, as with
# panes): nothing may be killed on partial validation.
: > "$WORK/t3-bulkwin-stale.log"
(
  tmux() {
    case "$1" in
      display-message) case "$*" in *'@17'*) printf '$99\n' ;; *) printf '?\n' ;; esac ;;
      *) printf '%s\n' "$*" >> "$WORK/t3-bulkwin-stale.log" ;;
    esac
  }
  bulk_kill 'w:$42:@17'
) >/dev/null 2>&1
printf '%s' "$?" > "$WORK/t3-bulkwin-stale.rc"
if [ "$(cat "$WORK/t3-bulkwin-stale.rc")" -ne 0 ] && [ ! -s "$WORK/t3-bulkwin-stale.log" ]; then
  ok "nav-t3: stale window token prevents partial bulk kill"
else
  nok "nav-t3: stale window token prevents partial bulk kill"
fi

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
  assert_eq "renderer: absent metadata never exposes a path" '' "$REPLY"
  nav_pane_context bead.42 'session:nav-redesign' /repo/sub /repo
  assert_eq "renderer: pane task is the default human context" 'nav redesign' "$REPLY"
  nav_pane_context bead.42 - /repo/sub /repo
  assert_eq "renderer: bead is the bounded task fallback" 'bead.42' "$REPLY"
}
require_fn nav_branch_label "renderer: concise branch helper exists" && {
  nav_branch_label 'feature/nav-sidebar_redesign-for-terminal-users'
  assert_eq "renderer: branch context is humanized and never cut" 'nav sidebar redesign for terminal users' "$REPLY"
}
require_fn nav_wrap_text "renderer: wrap helper exists" && {
  nav_wrap_text 'alpha beta gamma delta epsilon' 10
  assert_eq "renderer: wrap preserves every character" "$(printf 'alpha beta\ngamma\ndelta\nepsilon')" "$REPLY"
  nav_wrap_text 'supercalifragilistic' 5
  assert_eq "renderer: wrap hard-splits overlong words" "$(printf 'super\ncalif\nragil\nistic')" "$REPLY"
  nav_wrap_text 'short' 32
  assert_eq "renderer: wrap leaves short text alone" 'short' "$REPLY"
}
require_fn nav_session_context "renderer: session context helper exists" && {
  nav_session_context /repo/core 'core  feature/nav-sidebar-redesign +2   /repo/core' '12m' 1
  assert_eq "renderer: default session context keeps concise branch and terse status" 'core · nav sidebar redesign · +2 · shared' "$REPLY"
}
_strip_nav_ansi() { printf '%s' "$1" | sed -E $'s/\x1b\\[[0-9;]*m//g'; }
# _nav_acc <raw-display> -> 0 when the row carries the nav ACCENT truecolor
# (38;2;104;168;196). The current window/pane is distinguished by ACCENT
# styling on the ↳ glyph and @/%id (PART V/§33), never by a ▸/● glyph, so the
# §33/T4/occ markers are detected by presence of the accent code in the raw
# (unstripped) display. Distinguishable from the amber ATTENTION code
# (205;165;95) and the muted role codes.
_nav_acc() { case "$1" in *'38;2;104;168;196'*) return 0 ;; *) return 1 ;; esac; }
require_fn nav_session_card "renderer: session hierarchy card exists" && {
  XTMUX_NAV_WIDTH=60 nav_session_card '▎' alpha needs-input '12m' 'core · nav sidebar redesign' multi
  _plain="$(_strip_nav_ansi "$REPLY")"
  _line1="$(printf '%s\n' "$_plain" | sed -n '1p')"
  _line2="$(printf '%s\n' "$_plain" | sed -n '2p')"
  case "$_line1" in '▎ alpha  12m  urgent wait') ok "renderer: age and state stay adjacent to session identity" ;; *) nok "renderer: age and state stay adjacent to session identity" ;; esac
  assert_eq "renderer: repo and branch form the only default context line" '    core · nav sidebar redesign' "$_line2"
}
_nav_nows() { printf '%s' "$1" | tr -d '\n[:space:]'; }
require_fn nav_pane_card "renderer: pane hierarchy row exists" && {
  XTMUX_NAV_WIDTH=60 nav_pane_card '↳' '%42' claude running 'session:nav-redesign' running multi
  _plain="$(_strip_nav_ansi "$REPLY")"
  case "$_plain" in *$'\n'*) nok "renderer: pane renders on exactly ONE visual line (§19/§20/NAV_PANE_LINES=1)" ;; *) ok "renderer: pane renders on exactly ONE visual line (§19/§20/NAV_PANE_LINES=1)" ;; esac
  case "$_plain" in *'%42'*'claude  active  run  session:nav-redesign') ok "renderer: one-line row order %id > runtime > state > task (§16)" ;; *) nok "renderer: one-line row order (got '$_plain')" ;; esac
  XTMUX_NAV_WIDTH=32 nav_pane_card '↳' '%1234' prime-agent done '' done multi
  _plain="$(_strip_nav_ansi "$REPLY")"
  _over=0
  while IFS= read -r _vl; do [ "${#_vl}" -le 32 ] || _over=1; done <<< "$_plain"
  [ "$_over" -eq 0 ] && ok "renderer: every pane line fits the minimum drawer width" || nok "renderer: every pane line fits the minimum drawer width"
  case "$(printf '%s' "$_plain" | tr -d '[:space:]')" in *'↳%1234prime-agentother'*) ok "renderer: runtime wins over exact state at minimum width (§16 priority)" ;; *) nok "renderer: runtime wins over exact state at minimum width (§16 priority)" ;; esac
  _pane_lines=$(printf '%s\n' "$_plain" | grep -c .)
  [ "$_pane_lines" -eq 1 ] && ok "renderer: pane card is exactly ONE visual line (§19/§20/NAV_PANE_LINES=1)" || nok "renderer: pane card one visual line (§19, got $_pane_lines)"
  XTMUX_NAV_WIDTH=24 nav_pane_card '↳' '%1234' prime-agent done 'a-very-long-task-name-here' done multi
  _plain="$(_strip_nav_ansi "$REPLY")"
  _over=0
  while IFS= read -r _vl; do [ "${#_vl}" -le 24 ] || _over=1; done <<< "$_plain"
  [ "$_over" -eq 0 ] && ok "renderer: narrow physical drawer stays within usable width" || nok "renderer: narrow physical drawer stays within usable width"
  case "$(printf '%s' "$_plain" | tr -d '[:space:]')" in *'↳%1234prime-agento'*) ok "renderer: %id + full runtime + group survive; state/task compact (§16/§20)" ;; *) nok "renderer: %id + full runtime + group survive; state/task compact (§16/§20)" ;; esac
  _pane_lines=$(printf '%s\n' "$_plain" | grep -c .)
  [ "$_pane_lines" -eq 1 ] && ok "renderer: narrow pane card stays one visual line (§19)" || nok "renderer: narrow pane card one line (§19, got $_pane_lines)"
}
require_fn nav_window_card "renderer: window hierarchy row exists" && {
  XTMUX_NAV_WIDTH=60 nav_window_card '↳' '@17' '0:coord' run 2 multi
  _plain="$(_strip_nav_ansi "$REPLY")"
  case "$_plain" in '↳ @17  0:coord  run · 2') ok "renderer: window row shows @id + index:name + state + count (§15)" ;; *) nok "renderer: window row shows @id + index:name + state + count (§15)" ;; esac
  XTMUX_NAV_WIDTH=24 nav_window_card ' ' "@9999" '0:'"$(printf 'x%.0s' {1..60})" wait 2 multi
  _plain="$(_strip_nav_ansi "$REPLY")"
  case "$_plain" in *'@9999'*) ok "renderer: @window-id never truncated" ;; *) nok "renderer: @window-id never truncated" ;; esac
  _over=0
  while IFS= read -r _vl; do [ "${#_vl}" -le 24 ] || _over=1; done <<< "$_plain"
  [ "$_over" -eq 0 ] && ok "renderer: window row bounded at narrow width" || nok "renderer: window row bounded at narrow width"
}
require_fn nav_session_card "renderer: session wrap coverage exists" && {
  XTMUX_NAV_WIDTH=32 nav_session_card ' ' 'an-extremely-long-session-name-that-must-wrap' running '2m' 'a-long-repo-name · a very long humanized branch description' multi
  _plain="$(_strip_nav_ansi "$REPLY")"
  _sess_lines=$(printf '%s\n' "$_plain" | grep -c .)
  [ "$_sess_lines" -le 3 ] && ok "renderer: session card bounded at 3 visual lines (§19)" || nok "renderer: session card bounded at 3 visual lines (§19, got $_sess_lines)"
  case "$_plain" in *'…'*) ok "renderer: overflow is ellipsized, never kept unbounded" ;; *) nok "renderer: overflow is ellipsized, never kept unbounded" ;; esac
  _nows="$(printf '%s' "$_plain" | tr -d '[:space:]')"
  case "$_nows" in *'an-extremely-l'*'a-long-repo-name'*) ok "renderer: session identity and context survive the budget" ;; *) nok "renderer: session identity and context survive the budget" ;; esac
  _over=0
  while IFS= read -r _vl; do [ "${#_vl}" -le 32 ] || _over=1; done <<< "$_plain"
  [ "$_over" -eq 0 ] && ok "renderer: every session line fits the usable width" || nok "renderer: every session line fits the usable width"
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
printf '%s' "${XTMUX_NAV_WIDTH:-}" > "${NAV_STUB_WIDTH_LOG:-/dev/null}"
if [ "${NAV_SPECIALIST:-0}" = 1 ]; then
  printf 'session\t$1\tone\t$1\ts:$1\t  one\0session\t$2\ttwo\t$2\ts:$2\t── specialists ──\n▎ two\0'
else
  printf 'session\t$1\tone\t$1\ts:$1\t  one\0session\t$2\ttwo\t$2\ts:$2\t▎ two\0'
fi
EOF
chmod +x "$WORK/nav-list-stub"
(
  nav_route() { REPLY=multiline; }
  fzf() { printf '%s\n' "$*" > "$WORK/nav-fzf-args"; cat >/dev/null; }
  self="$WORK/nav-list-stub"
  XTMUX_NAV_WIDTH=40 NAV_STUB_LOG="$WORK/nav-stub-command" NAV_STUB_WIDTH_LOG="$WORK/nav-stub-width" pick_nav
)
if grep -q 'load:pos(2)' "$WORK/nav-fzf-args"; then
  ok "nav reveal: initial selection positions on current marker"
else
  nok "nav reveal: initial selection positions on current marker"
fi
if grep -q -- '--preview-window=hidden,bottom,7,wrap,follow' "$WORK/nav-fzf-args"; then
  ok "nav details: inspector is hidden until explicit toggle"
else
  nok "nav details: inspector is hidden until explicit toggle"
fi
if grep -q -- '--header= xtmux nav · state groups · type to filter ' "$WORK/nav-fzf-args"; then
  ok "nav chrome: compact title and search hint use fzf header"
else
  nok "nav chrome: compact title and search hint use fzf header"
fi
if grep -qF '?:change-preview(' "$WORK/nav-fzf-args" && grep -qF ')+show-preview' "$WORK/nav-fzf-args"; then
  ok "nav help: ? explicitly reveals the hidden details pane"
else
  nok "nav help: ? explicitly reveals the hidden details pane"
fi
# §36 wiring: ordinary typing uses the explicit live query projection.
# The snapshot helper remains only for the atomic explicit-refresh handoff.
if grep -qF "change:reload-sync(" "$WORK/nav-fzf-args" && grep -qF "nav-snapshot-view --live multi '{q}'" "$WORK/nav-fzf-args" && ! grep -qF "list-active-nav-chain '{q}'" "$WORK/nav-fzf-args"; then
  ok "nav chrome: query change rebuilds live ancestry (no rendered-state cache)"
else
  nok "nav chrome: query change is not wired to the live projection"
fi
if grep -qF "nav-snapshot-refresh" "$WORK/nav-fzf-args"; then
  ok "nav chrome: explicit reload/filter/mode actions refresh both snapshots"
else
  nok "nav chrome: explicit live refresh path is not snapshot-aware"
fi
(
  nav_route() { REPLY=oneline; }
  fzf() { printf '%s\n' "$*" > "$WORK/nav-fzf-args-oneline"; cat >/dev/null; }
  self="$WORK/nav-list-stub"
  XTMUX_NAV_WIDTH=40 pick_nav
)
if grep -qF "nav-snapshot-view --live single '{q}'" "$WORK/nav-fzf-args-oneline" && ! grep -qF "list-active-nav-single-chain '{q}'" "$WORK/nav-fzf-args-oneline"; then
  ok "nav chrome: oneline fallback also uses the live query projection"
else
  nok "nav chrome: oneline fallback is not wired to the live projection"
fi
assert_eq "nav filter: initial list uses persisted filter state" list-active-nav "$(cat "$WORK/nav-stub-command")"
assert_eq "nav width: fzf selection chrome is reserved" 36 "$(cat "$WORK/nav-stub-width")"
_width_narrow="$(XTMUX_NAV_WIDTH=32 nav_reserve_fzf_width; printf '%s' "$XTMUX_NAV_WIDTH")"
assert_eq "nav width: narrow physical drawers reserve chrome without widening" 28 "$_width_narrow"
_width_default="$(unset XTMUX_NAV_WIDTH; COLUMNS=52 nav_reserve_fzf_width; printf '%s' "$XTMUX_NAV_WIDTH")"
assert_eq "nav width: unset override reserves chrome from terminal columns" 48 "$_width_default"
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
  pane_meta() { printf '%b\n' '$42\t@100\t0\tw0\t0\t%17\t0\t1\tbash\t'"$WORK"'/none\tneeds-input\t999991\tbead.1\ta bounded task\t-\t-'; }
  TMUX_PANE='%17' XTMUX_NAV_WIDTH=32 TMUX_PICKER_NO_CACHE=1 build_list all expanded nav multi
) > "$WORK/nav-records"
_count=0; _session_seen=0; _window_seen=0; _pane_seen=0; _header_seen=0; _wide=0; _framing_clean=1
while IFS= read -r -d '' _record; do
  _count=$((_count + 1))
  IFS=$'\t' read -r _type _sid _name _target _token _first <<< "$_record"
  _prefix="$_type"$'\t'"$_sid"$'\t'"$_name"$'\t'"$_target"$'\t'"$_token"$'\t'
  _display="${_record#"$_prefix"}"
  _plain_display="$(_strip_nav_ansi "$_display")"
  case "$_plain_display" in *$'\x07'*|*$'\x08'*|*$'\x1f'*|*$'\x1e'*|*$'\x1b'*) _framing_clean=0 ;; esac
  case "$_type" in
    session)
      [ "$_token" = 's:$42' ] && _session_seen=1
      case "$_plain_display" in '▎ '*|*$'\n''▎ '*) ;; *) _session_seen=0 ;; esac
      ;;
    window)
      if [ "$_token" = 'w:$42:@100' ] && [ "$_sid" = '$42' ] && [ "$_target" = '@100' ]; then
        _window_seen=1; _wins_tokens+="$_token "
        [ "$_name" = '0:w0' ] && _window_label=1
      fi
      ;;
    pane) [ "$_token" = 'p:$42:%17' ] && _pane_seen=1 ;;
    header) _header_seen=1 ;;
  esac
  while IFS= read -r _visual; do [ "${#_visual}" -le 32 ] || _wide=1; done <<< "$_plain_display"
done < "$WORK/nav-records"
[ "$_count" -eq 3 ] && ok "nav records: session/window/pane NUL records remain distinct" || nok "nav records: session/window/pane NUL records remain distinct (got $_count)"
[ "$_session_seen" -eq 1 ] && ok "nav records: session token and current marker" || nok "nav records: session token and current marker"
[ "$_window_seen" -eq 1 ] && ok "nav records: window token exact (w:\$42:@100)" || nok "nav records: window token exact"
[ "${_window_label:-0}" -eq 1 ] && ok "nav records: window row carries the presentation index:name label" || nok "nav records: window row carries the presentation index:name label"
[ "$_pane_seen" -eq 1 ] && ok "nav records: pane token exact" || nok "nav records: pane token exact"
[ "$_header_seen" -eq 0 ] && ok "nav records: no selectable header" || nok "nav records: no selectable header"
[ "$_wide" -eq 0 ] && ok "nav records: every visual line bounded at 32" || nok "nav records: every visual line bounded at 32"
[ "$_framing_clean" -eq 1 ] && ok "nav records: internal control delimiters sanitized" || nok "nav records: internal control delimiters sanitized"
# order proof: session -> window -> pane must hold in the emitted stream
_expected_order='session window pane'; _actual_order=''
while IFS= read -r -d '' _record; do
  IFS=$'\t' read -r _type _ __ <<< "$_record"
  _actual_order+="$_type "
done < "$WORK/nav-records"
_actual_order="${_actual_order% }"
[ "$_actual_order" = "$_expected_order" ] && ok "nav records: session -> window -> pane topology order" || nok "nav records: session -> window -> pane topology order (got '$_actual_order')"

# Visual grouping uses existing pane state only: attention, active, then other.
(
  session_meta() {
    printf '%b\n' \
      '$1\tstale-session\t%1\t'"$HOME"'/space/a1\t1000' \
      '$2\twait-session\t%2\t'"$HOME"'/space/a2\t1000' \
      '$3\tdone-session\t%3\t'"$HOME"'/space/a3\t1000' \
      '$4\trun-session\t%4\t'"$HOME"'/space/a4\t1000' \
      '$5\tidle-session\t%5\t'"$HOME"'/space/a5\t1000'
  }
  pane_meta() {
    printf '%b\n' \
      '$1\t@1\t0\tw\t0\t%1\t0\t1\tclaude\t'"$HOME"'/space/a1\tstale\t1\t-\t-\t-\t-' \
      '$2\t@2\t0\tw\t0\t%2\t0\t1\tclaude\t'"$HOME"'/space/a2\tneeds-input\t2\t-\t-\t-\t-' \
      '$3\t@3\t0\tw\t0\t%3\t0\t1\tclaude\t'"$HOME"'/space/a3\tdone\t3\t-\t-\t-\t-' \
      '$4\t@4\t0\tw\t0\t%4\t0\t1\tclaude\t'"$HOME"'/space/a4\trunning\t4\t-\t-\t-\t-' \
      '$5\t@5\t0\tw\t0\t%5\t0\t1\tbash\t'"$HOME"'/space/a5\t-\t5\t-\t-\t-'
  }
  XTMUX_NAV_WIDTH=72 TMUX_PICKER_NO_CACHE=1 build_list all expanded nav multi
) > "$WORK/nav-groups"
_group_order=''; _group_text=''; _path_leak=0; _durable_groups=1
while IFS= read -r -d '' _record; do
  IFS=$'\t' read -r _type _sid _name _target _token _first <<< "$_record"
  _prefix="$_type"$'\t'"$_sid"$'\t'"$_name"$'\t'"$_target"$'\t'"$_token"$'\t'
  _display="${_record#"$_prefix"}"
  _plain="$(_strip_nav_ansi "$_display")"
  if [ "$_type" = session ]; then _group_order+="${_group_order:+ }$_name"; _group_text+="$_plain"$'\n'; fi
  if [ "$_type" = session ]; then
    case "$_name:$_plain" in
      stale-session:*urgent*|wait-session:*urgent*|run-session:*active*|done-session:*other*|idle-session:*other*) ;;
      *) _durable_groups=0 ;;
    esac
  fi
  case "$_plain" in *"$WORK"*|*"$HOME"*|*'/secret'*|*'none'*) _path_leak=1 ;; esac
done < "$WORK/nav-groups"
assert_eq "nav grouping: attention then active then other" 'stale-session wait-session run-session done-session idle-session' "$_group_order"
[ "$_durable_groups" -eq 1 ] && ok "nav grouping: every independently filtered record retains its group label" || nok "nav grouping: every independently filtered record retains its group label"
[ "$_path_leak" -eq 0 ] && ok "nav default: pane paths stay behind details" || nok "nav default: pane paths stay behind details"

(
  session_meta() { printf '%b\n' '$42\talpha\t%17\t'"$WORK"'/none\t1000'; }
  pane_meta() { printf '%b\n' '$42\t@100\t0\tw0\t0\t%17\t0\t1\tbash\t'"$WORK"'/none\tneeds-input\t999991\tbead.1\ta bounded task\t-\t-'; }
  TMUX_PANE='%999' XTMUX_NAV_WIDTH=44 TMUX_PICKER_NO_CACHE=1 build_list all expanded nav single
) > "$WORK/nav-single"
_single_newline=0; _false_marker=0
while IFS= read -r -d '' _record; do
  IFS=$'\t' read -r _type _sid _name _target _token _first <<< "$_record"
  _prefix="$_type"$'\t'"$_sid"$'\t'"$_name"$'\t'"$_target"$'\t'"$_token"$'\t'
  _display="${_record#"$_prefix"}"
  case "$_display" in *$'\n'*) _single_newline=1 ;; esac
  case "$_display" in '▎ '*|*$'\n''▎ '*) _false_marker=1 ;; esac
done < "$WORK/nav-single"
[ "$_single_newline" -eq 0 ] && ok "nav fallback: one-line records contain no newline" || nok "nav fallback: one-line records contain no newline"
[ "$_false_marker" -eq 0 ] && ok "nav marker: unverifiable TMUX_PANE omitted" || nok "nav marker: unverifiable TMUX_PANE omitted"

# NAV-T3: hostile window name/index cannot affect identity or action dispatch
# (§30). The window label is presentation only; the token/target stay machine
# exact and the action targets the @N, never text.
(
  session_meta() { printf '%b\n' '$25\thostile-session\t%553\t'"$WORK"'/none\t1000'; }
  pane_meta() {
    printf '%b\n'       '$25\t@100\t0\tw0; rm -rf /tmp/x; `id`; "quoted"; Δ unicode\t0\t%17\t0\t1\tbash\t'"$WORK"'/none\tneeds-input\t999991\t-\t-\t-\t-'       '$25\t@100\t0\tw0\t0\t%18\t0\t1\tbash\t'"$WORK"'/none\tidle\t999992\t-\t-\t-\t-'       '$25\t@31\t1\t1:research\t0\t%19\t0\t1\tpi\t'"$WORK"'/none\tdone\t999993\t-\t-\t-\t-'
  }
  TMUX_PANE='%17' XTMUX_NAV_WIDTH=32 TMUX_PICKER_NO_CACHE=1 build_list all expanded nav multi
) > "$WORK/t3-hostile-records"
_t3_hw=0; _t3_hw2=0; _t3_win_tokens=''; _t3_ctrl=0; _t3_wide=0; _t3_pwned_probe=0
while IFS= read -r -d '' _record; do
  IFS=$'\t' read -r _type _sid _name _target _token _first <<< "$_record"
  [ "$_type" = window ] || continue
  _t3_win_tokens+="$_token "
  [ "$_token" = 'w:$25:@100' ] && _t3_hw=1
  [ "$_token" = 'w:$25:@31' ] && _t3_hw2=1
  _prefix="$_type"$'\t'"$_sid"$'\t'"$_name"$'\t'"$_target"$'\t'"$_token"$'\t'
  _display="${_record#"$_prefix"}"
  _plain="$(_strip_nav_ansi "$_display")"
  case "$_plain" in *[[:cntrl:]]*) _t3_ctrl=1 ;; esac
  while IFS= read -r _vl; do [ "${#_vl}" -le 32 ] || _t3_wide=1; done <<< "$_plain"
done < "$WORK/t3-hostile-records"
[ "$_t3_hw" -eq 1 ] && [ "$_t3_hw2" -eq 1 ] && ok "nav-t3: hostile window name keeps token identity exact (w:\$25:@100 / :@31)" || nok "nav-t3: hostile window name keeps token identity exact (got '$_t3_win_tokens')"
[ "$_t3_ctrl" -eq 0 ] && ok "nav-t3: hostile window name is control-sanitized in display" || nok "nav-t3: hostile window name is control-sanitized in display"
[ "$_t3_wide" -eq 0 ] && ok "nav-t3: hostile window label stays bounded (presentation only)" || nok "nav-t3: hostile window label stays bounded"
# the emitted window token drives the action to the exact @N, never the text.
: > "$WORK/t3-hostile-kill.log"
(
  tmux() {
    case "$1" in
      display-message) printf '%s\n' "$*" >> "$WORK/t3-hostile-kill.log"; case "$*" in *'#{window_id}'*) printf '$25\t@100\n' ;; *'#{session_id}'*) printf '$25\n' ;; *) printf '?\n' ;; esac ;;
      *) printf '%s\n' "$*" >> "$WORK/t3-hostile-kill.log" ;;
    esac
  }
  nav_act 'w:$25:@100' kill
)
if grep -q 'kill-window -t @100' "$WORK/t3-hostile-kill.log" && ! grep -q 'kill-pane\|kill-session\|send-keys' "$WORK/t3-hostile-kill.log"; then
  ok "nav-t3: hostile window name cannot redirect the kill target"
else
  nok "nav-t3: hostile window name cannot redirect the kill target (got $(tr '\n' ';' < "$WORK/t3-hostile-kill.log"))"
fi
# a hostile index string (presentation) also cannot touch the token.
(
  session_meta() { printf '%b\n' '$26\tidx-session\t%553\t'"$WORK"'/none\t1000'; }
  pane_meta() { printf '%b\n' '$26\t@77\t0\t$(touch '"$WORK"'/t3-index-pwned); `id`; "q"; Δ\t0\t%553\t0\t1\tbash\t'"$WORK"'/none\tidle\t999991\t-\t-\t-\t-'; }
  TMUX_PANE='%553' XTMUX_NAV_WIDTH=32 TMUX_PICKER_NO_CACHE=1 build_list all expanded nav multi
) > "$WORK/t3-hostile-index-records"
_t3_hi=0
while IFS= read -r -d '' _record; do
  IFS=$'\t' read -r _type _sid _name _target _token _first <<< "$_record"
  [ "$_type" = window ] && [ "$_token" = 'w:$26:@77' ] && _t3_hi=1
done < "$WORK/t3-hostile-index-records"
if [ "$_t3_hi" -eq 1 ] && [ ! -e "$WORK/t3-index-pwned" ]; then
  ok "nav-t3: hostile index string is presentation-only; token/target stay machine exact"
else
  nok "nav-t3: hostile index string is presentation-only; token/target stay machine exact"
fi

# nav help documents the machine token grammar and window actions.
"$PICKER" nav help > "$WORK/t3-nav-help.out" 2>&1
if grep -qF 'w:$N:@N' "$WORK/t3-nav-help.out" && grep -qF 'p:$N:%N' "$WORK/t3-nav-help.out" && grep -qF 'rename window' "$WORK/t3-nav-help.out"; then
  ok "nav-t3: nav help documents window token grammar and window actions"
else
  nok "nav-t3: nav help documents window token grammar and window actions"
fi

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
_meta_bad="$(awk -F '\t' 'NR==1&&NF!=5{bad=1} NR==2&&NF!=16{bad=1} END{print bad+0}' "$WORK/meta.tsv")"
[ "$_meta_lines" -eq 2 ] && [ "$_meta_bad" -eq 0 ] && ok "metadata framing: control characters cannot create records" || nok "metadata framing: control characters cannot create records"


echo
echo "== NAV-T2: canonical state aggregation + current location (xtmux-w5i.3) =="
# fixture (prompt 29): $42 program — @17 0:coord (%553 running, %621 idle),
# @31 1:research (%875 needs-input, %901 running).
require_fn nav_state_max "NAV-T2: canonical priority exists" && {
  nav_state_max running idle
  assert_eq "NAV-T2: @17 window = running beats idle (14)" running "$REPLY"
  nav_state_max needs-input running
  assert_eq "NAV-T2: @31 window = needs-input beats running (14)" needs-input "$REPLY"
  nav_state_max running needs-input
  assert_eq "NAV-T2: session folds windows: needs-input beats running (14)" needs-input "$REPLY"
  nav_state_max stale needs-input
  assert_eq "NAV-T2: stale is the strongest canonical state" stale "$REPLY"
  nav_state_max done running
  assert_eq "NAV-T2: done outranks running in the canonical order" done "$REPLY"
}

# Current location: TMUX_PANE honoured only when the inventory enumerated it.
# current pane %553 -> current window @17 -> current session $42 (prompt 13).
require_fn build_nav_inventory "NAV-T2: inventory helper exists" && require_fn nav_current_location "NAV-T2: current-location helper exists" && {
  # here-string, not a pipe: the inventory must be declared associative in THIS
  # shell so nav_current_location can read it (pipe = subshell, declare lost).
  build_nav_inventory <<'INVEOF'
$42	@17	0	0:coord	0	%553	0	1	claude	/coord	running	553	-	-	-	-
$42	@17	0	0:coord	0	%621	1	0	bash	/scripts	idle	621	-	-	-	-
$42	@31	1	1:research	0	%875	0	1	pi	/research	needs-input	875	-	-	-	-
$42	@31	1	1:research	0	%901	1	0	claude	/reviews	running	901	-	-	-	-
INVEOF
  TMUX_PANE='%553' nav_current_location
  assert_eq "NAV-T2: current pane = TMUX_PANE from inventory" '%553' "$cur_pane"
  assert_eq "NAV-T2: current window derived from inventory" '@17' "$cur_window"
  assert_eq "NAV-T2: current session derived from inventory" '$42' "$cur_session"
  TMUX_PANE='%999' nav_current_location
  if [ -z "$cur_pane" ] && [ -z "$cur_window" ] && [ -z "$cur_session" ]; then
    ok "NAV-T2: unenumerated TMUX_PANE is never current"
  else
    nok "NAV-T2: unenumerated TMUX_PANE is never current (got $cur_pane/$cur_window/$cur_session)"
  fi
}

# ---- occurrence identity: a window LINKED into two sessions stays two rows ----
# The same @W/%%P appears in $A (index 0) and $B (index 3). The projection must
# preserve BOTH occurrences (per-session index/count/pane placement), never
# collapse to a first-seen map. Stable object ids (@/%) are kept; only the key
# is the hierarchy path.
(
  build_nav_inventory <<'LINKFIX'
$A	@W	0	w0	0	%P	0	1	bash	/x	idle	1	-	-	-	-
$B	@W	3	w3	0	%P	0	1	bash	/x	idle	1	-	-	-	-
$B	@W	3	w3	0	%Q	1	0	bash	/x2	idle	2	-	-	-	-
LINKFIX
  printf 'countA=%s countB=%s\n' "${NAV_WIN_COUNT['$A|@W']:-EMPTY}" "${NAV_WIN_COUNT['$B|@W']:-EMPTY}"
  printf 'swA=%s swB=%s\n' "${NAV_SESS_WINDOWS['$A']:-EMPTY}" "${NAV_SESS_WINDOWS['$B']:-EMPTY}"
  printf 'idxA=%s idxB=%s\n' "${NAV_WIN_INDEX['$A|@W']:-EMPTY}" "${NAV_WIN_INDEX['$B|@W']:-EMPTY}"
  printf 'panA=%s panB=%s paneA=%s paneB=%s\n' \
    "${NAV_PANE_WIN['$A|%P']:-EMPTY}" "${NAV_PANE_WIN['$B|%P']:-EMPTY}" \
    "${NAV_PANE_WIN['$A|%Q']:-EMPTY}" "${NAV_PANE_WIN['$B|%Q']:-EMPTY}"
  # client in B then in A: current must follow the ATTACHED session, not first row.
  tmux() { case "$*" in *'#{session_id}'*) printf '%b\n' '$B' ;; *) return 0 ;; esac; }
  TMUX_PANE='%P' nav_current_location
  printf 'curB=%s:%s:%s\n' "$cur_session" "$cur_window" "$cur_pane"
  tmux() { case "$*" in *'#{session_id}'*) printf '%b\n' '$A' ;; *) return 0 ;; esac; }
  TMUX_PANE='%P' nav_current_location
  printf 'curA=%s:%s:%s\n' "$cur_session" "$cur_window" "$cur_pane"
) > "$WORK/occ-proj"
_occ_ok=1
for _exp in 'countA=1 countB=2' 'swA=@W swB=@W' 'idxA=0 idxB=3' 'panA=@W panB=@W paneA=EMPTY paneB=@W' 'curB=$B:@W:%P' 'curA=$A:@W:%P'; do
  grep -qF "$_exp" "$WORK/occ-proj" || { _occ_ok=0; printf '      missing: %s\n' "$_exp"; }
done
[ "$_occ_ok" -eq 1 ] && ok "NAV-occ: linked window @W keeps BOTH occurrences (A index 0 count1, B index 3 count2)" || nok "NAV-occ: linked window occurrence projection"

# End-to-end render: client attached to B => ▎/▸/● markers land ONLY on the B
# occurrence; the A occurrence of the same @W/%%P carries no current marker.
(
  session_meta() { printf '%b\n' '$A\talp\t%P\t/x\t1000' '$B\tbet\t%P\t/x\t1000'; }
  pane_meta() { printf '%b\n' \
    '$A\t@W\t0\tw0\t0\t%P\t0\t1\tbash\t/x\tidle\t1\t-\t-\t-\t-' \
    '$B\t@W\t3\tw3\t0\t%P\t0\t1\tbash\t/x\tidle\t1\t-\t-\t-\t-' ; }
  tmux() { case "$*" in *'#{session_id}'*) printf '%b\n' '$B' ;; *) return 0 ;; esac; }
  TMUX_PANE='%P' XTMUX_NAV_WIDTH=40 TMUX_PICKER_NO_CACHE=1 build_list all expanded nav multi
) > "$WORK/occ-render"
_occB_mark=0; _occA_mark=0; _occAtoken=0; _occBtoken=0
while IFS= read -r -d '' _record; do
  IFS=$'\t' read -r _type _sid _name _target _token _first <<< "$_record"
  _prefix="$_type"$'\t'"$_sid"$'\t'"$_name"$'\t'"$_target"$'\t'"$_token"$'\t'
  _display="${_record#"$_prefix"}"
  _plain="$(_strip_nav_ansi "$_display")"
  case "$_type:$_token" in
    'window:w:$B:@W')   _nav_acc "$_display" && _occB_mark=1 ;;
    'window:w:$A:@W')   _nav_acc "$_display" && _occA_mark=1 ;;
    'pane:p:$B:%P')     _nav_acc "$_display" && _occBtoken=1 ;;
    'pane:p:$A:%P')     _nav_acc "$_display" && _occAtoken=1 ;;
  esac
done < "$WORK/occ-render"
if [ "$_occB_mark" -eq 1 ] && [ "$_occA_mark" -eq 0 ] && [ "$_occBtoken" -eq 1 ] && [ "$_occAtoken" -eq 0 ]; then
  ok "NAV-occ: client in B marks only the B occurrence of linked @W/%%P (A unmarked)"
else
  nok "NAV-occ: client-aware linked marker (Bwin=$_occB_mark Awin=$_occA_mark Bpane=$_occBtoken Apane=$_occAtoken)"
fi


# End-to-end: build_list folds pane -> window -> session on the fixture; the
# session card must show the aggregated needs-input (attn + wait), not running.
(
  session_meta() { printf '%b\n' '$42\tprogram\t%553\t'"$WORK"'/coord\t1000'; }
  pane_meta() {
    printf '%b\n' \
      '$42\t@17\t0\t0:coord\t0\t%553\t0\t1\tclaude\t'"$WORK"'/coord\trunning\t553\t-\t-\t-\t-' \
      '$42\t@17\t0\t0:coord\t0\t%621\t1\t0\tbash\t'"$WORK"'/scripts\tidle\t621\t-\t-\t-\t-' \
      '$42\t@31\t1\t1:research\t0\t%875\t0\t1\tpi\t'"$WORK"'/research\tneeds-input\t875\t-\t-\t-\t-' \
      '$42\t@31\t1\t1:research\t0\t%901\t1\t0\tclaude\t'"$WORK"'/reviews\trunning\t901\t-\t-\t-\t-'
  }
  TMUX_PANE='%553' XTMUX_NAV_WIDTH=60 TMUX_PICKER_NO_CACHE=1 build_list all expanded nav multi
) > "$WORK/nav-t2-records"
_t2_attn=0; _t2_wait=0; _t2_run=0; _t2_sess_seen=0
while IFS= read -r -d '' _record; do
  IFS=$'\t' read -r _type _sid _name _target _token _first <<< "$_record"
  [ "$_type" = session ] || continue
  [ "$_token" = 's:$42' ] || continue
  _t2_sess_seen=1
  _prefix="$_type"$'\t'"$_sid"$'\t'"$_name"$'\t'"$_target"$'\t'"$_token"$'\t'
  _display="${_record#"$_prefix"}"
  _plain="$(_strip_nav_ansi "$_display")"
  case "$_plain" in *urgent*) _t2_attn=1 ;; esac
  case "$_plain" in *wait*) _t2_wait=1 ;; esac
  case "$_plain" in *run*) _t2_run=1 ;; esac
  break
done < "$WORK/nav-t2-records"
[ "$_t2_sess_seen" -eq 1 ] && ok "NAV-T2: fixture session card emitted" || nok "NAV-T2: fixture session card emitted"
[ "$_t2_attn" -eq 1 ] && [ "$_t2_wait" -eq 1 ] && ok 'NAV-T2: session $42 aggregates to needs-input through windows (14/29)' || nok 'NAV-T2: session $42 aggregates to needs-input through windows (14/29)'
[ "$_t2_run" -eq 0 ] && ok "NAV-T2: dominant pane wins (session not labelled running)" || nok "NAV-T2: dominant pane wins (session not labelled running)"


echo
echo "== NAV-T4: compact/expanded topology, window+pane rows, location, bounded records (xtmux-w5i.5) =="
# §29 fixture: $42 program — @17 0:coord (%553 running, %621 idle),
# @31 1:research (%875 needs-input, %901 running). Expanded must emit
# session -> @17 -> %553 -> %621 -> @31 -> %875 -> %901; compact emits the
# session only (§5/§29). Window rows are compact and independently selectable
# (§15); pane rows keep %pane-id and add the bounded location line (§3/§16).
(
  session_meta() { printf '%b\n' '$42\tprogram\t%553\t'"$WORK"'/coord\t1000'; }
  pane_meta() {
    printf '%b\n' \
      '$42\t@17\t0\tcoord\t0\t%553\t0\t1\tclaude\t'"$WORK"'/coord\trunning\t553\t-\t-\t-\t-' \
      '$42\t@17\t0\tcoord\t0\t%621\t1\t0\tbash\t'"$WORK"'/scripts\tidle\t621\t-\t-\t-\t-' \
      '$42\t@31\t1\tresearch\t0\t%875\t0\t1\tpi\t'"$WORK"'/research\tneeds-input\t875\t-\t-\t-\t-' \
      '$42\t@31\t1\tresearch\t0\t%901\t1\t0\tclaude\t'"$WORK"'/reviews\trunning\t901\t-\t-\t-\t-'
  }
  TMUX_PANE='%553' XTMUX_NAV_WIDTH=60 TMUX_PICKER_NO_CACHE=1 build_list all expanded nav multi
) > "$WORK/t4-expanded"
(
  session_meta() { printf '%b\n' '$42\tprogram\t%553\t'"$WORK"'/coord\t1000'; }
  pane_meta() {
    printf '%b\n' \
      '$42\t@17\t0\tcoord\t0\t%553\t0\t1\tclaude\t'"$WORK"'/coord\trunning\t553\t-\t-\t-\t-' \
      '$42\t@17\t0\tcoord\t0\t%621\t1\t0\tbash\t'"$WORK"'/scripts\tidle\t621\t-\t-\t-\t-' \
      '$42\t@31\t1\tresearch\t0\t%875\t0\t1\tpi\t'"$WORK"'/research\tneeds-input\t875\t-\t-\t-\t-' \
      '$42\t@31\t1\tresearch\t0\t%901\t1\t0\tclaude\t'"$WORK"'/reviews\trunning\t901\t-\t-\t-\t-'
  }
  TMUX_PANE='%553' XTMUX_NAV_WIDTH=60 TMUX_PICKER_NO_CACHE=1 build_list all sessions-only nav multi
) > "$WORK/t4-compact"
(
  session_meta() { printf '%b\n' '$42\tprogram\t%553\t'"$WORK"'/coord\t1000'; }
  pane_meta() {
    printf '%b\n' \
      '$42\t@17\t0\tcoord\t0\t%553\t0\t1\tclaude\t'"$WORK"'/coord\trunning\t553\t-\t-\t-\t-' \
      '$42\t@31\t1\tresearch\t0\t%875\t0\t1\tpi\t'"$WORK"'/research\tneeds-input\t875\t-\t-\t-\t-'
  }
  TMUX_PANE='%553' XTMUX_NAV_WIDTH=60 TMUX_PICKER_NO_CACHE=1 build_list all expanded nav single
) > "$WORK/t4-single"

_t4_exp_order=''; _t4_win_disp=''; _t4_pane_ids=''; _t4_cur_markers=''; _t4_loc_ok=1; _t4_path_leak=0
while IFS= read -r -d '' _record; do
  IFS=$'\t' read -r _type _sid _name _target _token _first <<< "$_record"
  _prefix="$_type"$'\t'"$_sid"$'\t'"$_name"$'\t'"$_target"$'\t'"$_token"$'\t'
  _display="${_record#"$_prefix"}"
  _plain="$(_strip_nav_ansi "$_display")"
  _t4_exp_order+="${_t4_exp_order:+ }$_token"
  case "$_type" in
    window) case "$_plain" in *'@17'*'0:coord'*'run'*'2') _t4_win_disp=1 ;; esac
            case "$_plain" in *$'\n'*) _t4_win_disp=0 ;; esac ;;
    pane)   _t4_pane_ids+="$_target "
            case "$_plain" in *$'\n'*'market-data'*|*$'\n'*) case "$_plain" in *$'\n'*) _t4_loc_line=1 ;; *) ;; esac ;; esac
            case "$_plain" in *"$WORK"*) _t4_path_leak=1 ;; esac ;;
  esac
  case "$_type:$_token" in
    'session:s:$42') case "$_plain" in '▎ '*) _t4_cur_markers+="sess " ;; esac ;;
    'window:w:$42:@17') _nav_acc "$_display" && _t4_cur_markers+="win " ;;
    'window:w:$42:@31') _nav_acc "$_display" && _t4_cur_markers+="WIN-LEAK " ;;
    'pane:p:$42:%553')  _nav_acc "$_display" && _t4_cur_markers+="pane " ;;
    'pane:p:$42:%621'|'pane:p:$42:%875'|'pane:p:$42:%901') _nav_acc "$_display" && _t4_cur_markers+="PANE-LEAK " ;;
  esac
done < "$WORK/t4-expanded"
_t4_exp_ok=1
case "$_t4_exp_order" in
  's:$42 w:$42:@17 p:$42:%553 p:$42:%621 w:$42:@31 p:$42:%875 p:$42:%901') ;;
  *) _t4_exp_ok=0 ;;
esac
_t4_compact_count=0; _t4_compact_only=0
while IFS= read -r -d '' _record; do
  _t4_compact_count=$((_t4_compact_count + 1))
  case "$_record" in 'session'*'s:$42'*) _t4_compact_only=1 ;; esac
done < "$WORK/t4-compact"
_t4_single_newline=0
while IFS= read -r -d '' _record; do
  IFS=$'\t' read -r _type _sid _name _target _token _first <<< "$_record"
  _prefix="$_type"$'\t'"$_sid"$'\t'"$_name"$'\t'"$_target"$'\t'"$_token"$'\t'
  _display="${_record#"$_prefix"}"
  case "$_display" in *$'\n'*) _t4_single_newline=1 ;; esac
done < "$WORK/t4-single"

[ "$_t4_exp_ok" -eq 1 ] && ok "NAV-T4: expanded emits session -> @17 -> %553 -> %621 -> @31 -> %875 -> %901 (§29)" || nok "NAV-T4: expanded topology order (§29, got '$_t4_exp_order')"
[ "$_t4_compact_count" -eq 1 ] && [ "$_t4_compact_only" -eq 1 ] && ok "NAV-T4: compact emits the session only (§5)" || nok "NAV-T4: compact emits the session only (got $_t4_compact_count records)"
[ "${_t4_win_disp:-0}" -eq 1 ] && ok "NAV-T4: window row shows @id + index:name + state + count (§15)" || nok "NAV-T4: window row shows @id + index:name + state + count (§15)"
case "$_t4_pane_ids" in *'%553'*'%621'*'%875'*'%901'*) ok "NAV-T4: every pane row carries its %pane-id" ;; *) nok "NAV-T4: every pane row carries its %pane-id (got '$_t4_pane_ids')" ;; esac
[ "$_t4_path_leak" -eq 0 ] && ok "NAV-T4: default list never shows the absolute pane path" || nok "NAV-T4: default list never shows the absolute pane path"
[ "${_t4_cur_markers% }" = 'sess win pane' ] && ok "NAV-T4: current markers only on current session/window/pane (§13)" || nok "NAV-T4: current markers only on current rows (got '$_t4_cur_markers')"
[ "$_t4_single_newline" -eq 0 ] && ok "NAV-T4: one-line fallback has no newlines; %pane-id survives (§20)" || nok "NAV-T4: one-line fallback has no newlines (§20)"

# Pane location projections (§3/§31): root -> repo; inside -> repo · rel;
# nested bounded; outside git -> shortened user-relative; worktree -> canonical
# repo label, never a .xtrm/worktrees/... wall. No subprocess: the helper only
# consumes the pane cwd + the git root the caller already resolved.
require_fn nav_pane_location "NAV-T4: nav_pane_location() exists" && {
  nav_pane_location '/work/market-data' '/work/market-data'
  assert_eq "loc: pane at repo root -> canonical repo" 'market-data' "$REPLY"
  nav_pane_location '/work/market-data/docs' '/work/market-data'
  assert_eq "loc: pane at repo/docs -> filesystem repo/path (PART VII)" 'market-data/docs' "$REPLY"
  nav_pane_location '/work/market-data/src/coordinator/jct5k/regression' '/work/market-data'
  assert_eq "loc: deep path elides the middle, keeps repo prefix + trailing" 'market-data/…/jct5k/regression' "$REPLY"
  nav_pane_location "$HOME/space/alpha" ''
  case "$REPLY" in '~'*) ok "loc: no repo -> ~-relative shortened path (§31)" ;; *) nok "loc: no repo -> ~-relative shortened path (got '$REPLY')" ;; esac
  case "$REPLY" in *"$HOME"*) nok "loc: no-repo never emits the absolute HOME path" ;; *) ok "loc: no-repo never emits the absolute HOME path" ;; esac
  # worktree: a fake repo with a linked-worktree path; the label is the parent
  # repo, the relative part never exposes .xtrm/worktrees/<slug>
  _wt_root="$WORK/wtrepo"
  mkdir -p "$_wt_root/.git" "$_wt_root/.xtrm/worktrees/xtmux-xjif/bin" 2>/dev/null
  nav_pane_location "$_wt_root/.xtrm/worktrees/xtmux-xjif/bin" "$_wt_root/.xtrm/worktrees/xtmux-xjif"
  case "$REPLY" in 'wtrepo/bin') ok "loc: worktree -> canonical repo/path (PART VII)" ;; *) nok "loc: worktree -> canonical repo label (got '$REPLY')" ;; esac
  nav_pane_location "$_wt_root/.xtrm/worktrees/xtmux-xjif" "$_wt_root/.xtrm/worktrees/xtmux-xjif"
  assert_eq "loc: pane at worktree root -> repo label only" 'wtrepo' "$REPLY"
  # §31: the canonical label must never leak the internal worktree wall.
  nav_pane_location "$_wt_root/.xtrm/worktrees/xtmux-xjif/bin" "$_wt_root/.xtrm/worktrees/xtmux-xjif"
  case "$REPLY" in
    *'.xtrm/worktrees/'*) nok "loc: worktree label never leaks a .xtrm/worktrees/… wall (got '$REPLY')" ;;
    *) ok "loc: worktree label never leaks a .xtrm/worktrees/… wall" ;;
  esac
  _long="$(printf 'x%.0s' {1..3000})"
  nav_pane_location "/work/repo/$_long" '/work/repo'
  [ "${#REPLY}" -le 80 ] && ok "loc: KB-size cwd stays bounded (§31/§32)" || nok "loc: KB-size cwd stays bounded (len=${#REPLY})"
}

# Bounded records with pathological metadata (§32): several-KB session name,
# window name, task and cwd must not grow rows or records past the explicit
# per-type line budgets or the byte bound; overflow stays out of the record but
# the field-3 cap must not leak into action identity (tokens stay exact).
(
  _t4_long="$(printf 'L%.0s' {1..3000})"
  session_meta() { printf '%b\n' '$47\t'"$_t4_long"'\t%1\t'"$WORK"'/p\t1000'; }
  pane_meta() {
    printf '%b\n' \
      '$47\t@7\t0\t'"$_t4_long"'\t0\t%1\t0\t1\t'"$_t4_long"'\t'"$WORK"'/'"$_t4_long"'\tneeds-input\t1\t-\t'"$_t4_long"'\t-\t-'
  }
  TMUX_PANE='%999' XTMUX_NAV_WIDTH=44 TMUX_PICKER_NO_CACHE=1 build_list all expanded nav multi
) > "$WORK/t4-pathologic"
_t4_pl_records=0; _t4_pl_over_line=0; _t4_pl_over_bytes=0; _t4_pl_ident=0
while IFS= read -r -d '' _record; do
  _t4_pl_records=$((_t4_pl_records + 1))
  # field 6 = presentation display (never contains tabs: control-cleaned); the
  # per-line budget is measured after ANSI removal, exactly like visual width
  _display="$(printf '%s' "$_record" | cut -f6- -d $'\t')"
  _plain_display="$(_strip_nav_ansi "$_display")"
  while IFS= read -r _vl; do [ "${#_vl}" -le 44 ] || _t4_pl_over_line=1; done <<< "$_plain_display"
  case "$_record" in *'s:$47'*|*'w:$47:@7'*|*'p:$47:%1'*) _t4_pl_ident=1 ;; esac
  _pl_bytes=$(LC_ALL=C awk '{ n+=length($0)+1 } END { print n+0 }' <<< "$_record")
  [ "$_pl_bytes" -le 4096 ] || _t4_pl_over_bytes=1
done < "$WORK/t4-pathologic"
[ "$_t4_pl_records" -eq 3 ] && [ "$_t4_pl_ident" -eq 1 ] && ok "NAV-T4: pathological metadata keeps exact machine tokens (s/w/p)" || nok "NAV-T4: pathological metadata keeps exact machine tokens"
[ "$_t4_pl_over_bytes" -eq 0 ] && ok "NAV-T4: record byte bound enforced with KB-size metadata (≤4096) (§19/§32)" || nok "NAV-T4: record byte bound enforced with KB-size metadata"
[ "$_t4_pl_over_line" -eq 0 ] && ok "NAV-T4: pathological lines never exceed the visual budget" || nok "NAV-T4: pathological lines never exceed the visual budget"
require_fn nav_enforce_bounded "NAV-T4: record emission guard exists (§19)" && {
  _gb_rec='pane'$'\t''$42'$'\t''prog'$'\t''%1'$'\t''p:$42:%1'$'\t'"$(printf 'x%.0s' {1..10000})"
  nav_enforce_bounded "$_gb_rec"
  [ "${#REPLY}" -le 2048 ] && ok "NAV-T4: emission guard caps an over-long display record (≤ NAV_MAX_RECORD_CHARS)" || nok "NAV-T4: emission guard caps an over-long display record"
  IFS=$'\t' read -r _gt _gs _gn _gtg _gtk _gd <<< "$REPLY"
  [ "$_gtk" = 'p:$42:%1' ] && ok "NAV-T4: guard preserves machine fields verbatim" || nok "NAV-T4: guard preserves machine fields verbatim (got '$_gtk')"
}
require_fn nav_line_budget "NAV-T4: per-type line budgets exist (§19)" && {
  nav_line_budget session; assert_eq "NAV-T4: session budget = 3" 3 "$REPLY"
  nav_line_budget window;  assert_eq "NAV-T4: window budget = 2" 2 "$REPLY"
  nav_line_budget pane;    assert_eq "NAV-T4: pane budget = 1 (NAV_PANE_LINES=1)" 1 "$REPLY"
}

# Filtering keeps hierarchy ancestry (§23): a waiting-match keeps its whole
# session subtree (session + window + pane), a non-matching session disappears
# entirely — no orphan %pane or @window row without its session.
(
  session_meta() {
    printf '%b\n' \
      '$42\tprogram\t%553\t'"$WORK"'/coord\t1000' \
      '$99\tidle-proj\t%88\t'"$WORK"'/np\t1000'
  }
  pane_meta() {
    printf '%b\n' \
      '$42\t@17\t0\tcoord\t0\t%553\t0\t1\tclaude\t'"$WORK"'/coord\trunning\t553\t-\t-\t-\t-' \
      '$42\t@31\t1\tresearch\t0\t%875\t0\t1\tpi\t'"$WORK"'/research\tneeds-input\t875\t-\t-\t-\t-' \
      '$99\t@5\t0\tw\t0\t%88\t0\t1\tbash\t'"$WORK"'/np\t-\t88\t-\t-\t-\t-'
  }
  TMUX_PANE='%999' XTMUX_NAV_WIDTH=60 TMUX_PICKER_NO_CACHE=1 build_list waiting expanded nav multi
) > "$WORK/t4-filter"
_t4_filter_ok=1; _t4_filter_session=0
while IFS= read -r -d '' _record; do
  IFS=$'\t' read -r _type _sid _name _target _token _first <<< "$_record"
  case "$_sid" in
    '$99'*) _t4_filter_ok=0 ;;
    '$42'*) case "$_type" in session) _t4_filter_session=1 ;; window|pane) ;; *) _t4_filter_ok=0 ;; esac ;;
    *) _t4_filter_ok=0 ;;
  esac
done < "$WORK/t4-filter"
if [ "$_t4_filter_ok" -eq 1 ] && [ "$_t4_filter_session" -eq 1 ]; then
  ok "NAV-T4: waiting filter keeps session+window+pane ancestry, drops non-matches wholesale (§23)"
else
  nok "NAV-T4: waiting filter keeps ancestry with no orphans (§23)"
fi

# Details mode (§18): window rows get their own details projection — @id,
# index, name, active, pane count, aggregate state — and the pane details keep
# the full absolute path (default list shows only the bounded projection).
require_fn preview_window_row "NAV-T4: window details projection exists" && {
  (
    tmux() {
      if [ "$1" = list-panes ]; then
        printf '%b\n' \
          '@17\t0\tcoord\t0\t%553\t0\t1\tclaude\t'"$WORK"'/coord/realfull/path\t80\t24\t0\t0\tneeds-input\t553\t-\ttask x\t-\t-'
      fi
      return 0
    }
    preview_window_row '$42' 'program' '@17'
  ) > "$WORK/t4-win-details"
  if grep -qF 'WINDOW' "$WORK/t4-win-details" && grep -qF '@17' "$WORK/t4-win-details" \
    && grep -qF 'panes' "$WORK/t4-win-details" && grep -qF 'coord' "$WORK/t4-win-details"; then
    ok "NAV-T4: window details show @id/index/name/panes/state (§18)"
  else
    nok "NAV-T4: window details show @id/index/name/panes/state (§18)"
  fi
  if grep -qF "$WORK"'/coord/realfull/path' "$WORK/t4-win-details"; then
    ok "NAV-T4: details expose the full pane path (absent from the default list)"
  else
    nok "NAV-T4: details expose the full pane path"
  fi
  case "$(sed -n '1p' "$WORK/t4-win-details")" in WINDOW) ok "NAV-T4: preview routes window rows to the window details" ;; *) nok "NAV-T4: preview routes window rows to the window details" ;; esac
}

echo
# ════════ NAV-T6 (xtmux-w5i.7): §29 fixture states, §30 machine-id, §32 bounded,
# §33 current-location, §34 direct-nav at subprocess level ── consolidated named
# assertions matching the prompt §29-§34 bullet lists. Existing green assertions
# from NAV-T1..T5 stay untouched above; these add the missing named proofs.

# ---- §29: named state assertions for the exact §29 fixture ----
# t4-expanded/t4-compact above were produced from the §29 fixture
# ($42 program — @17 0:coord running/idle, @31 1:research needs-input/running,
# current pane %553). The window/session cards carry the canonical aggregated
# states via nav_state_tag (running -> 'run', needs-input -> 'wait').
_t29_win17=0; _t29_win31=0; _t29_sess=0
while IFS= read -r -d '' _record; do
  IFS=$'\t' read -r _type _sid _name _target _token _first <<< "$_record"
  _prefix="$_type"$'\t'"$_sid"$'\t'"$_name"$'\t'"$_target"$'\t'"$_token"$'\t'
  _plain="$(_strip_nav_ansi "${_record#"$_prefix"}")"
  case "$_type:$_token" in
    'window:w:$42:@17') case "$_plain" in *'run'*) _t29_win17=1 ;; esac ;;
    'window:w:$42:@31') case "$_plain" in *'wait'*) _t29_win31=1 ;; esac ;;
    'session:s:$42')    case "$_plain" in *'wait'*) _t29_sess=1 ;; esac ;;
  esac
done < "$WORK/t4-expanded"
[ "$_t29_win17" -eq 1 ] && ok "§29: window @17 state == running (running beats idle)" || nok "§29: window @17 state == running (window card lacks the run badge)"
[ "$_t29_win31" -eq 1 ] && ok "§29: window @31 state == needs-input (needs-input beats running)" || nok "§29: window @31 state == needs-input (window card lacks the wait badge)"
[ "$_t29_sess" -eq 1 ] && ok "§29: session \$42 state == needs-input (strongest window wins)" || nok "§29: session \$42 state == needs-input (session card lacks the wait badge)"
# expanded order and compact re-asserted under the §29 bullet names (same files,
# no extra inventory runs — the definitive order proof stays in NAV-T4).
_t29_order=''
while IFS= read -r -d '' _record; do
  IFS=$'\t' read -r _type _sid _name _target _token _first <<< "$_record"
  _t29_order+="${_t29_order:+ }$_token"
done < "$WORK/t4-expanded"
_t29_exp_ok=1
case "$_t29_order" in
  's:$42 w:$42:@17 p:$42:%553 p:$42:%621 w:$42:@31 p:$42:%875 p:$42:%901') ;;
  *) _t29_exp_ok=0 ;;
esac
[ "$_t29_exp_ok" -eq 1 ] && ok "§29: expanded order = session → @17 → %553 → %621 → @31 → %875 → %901" || nok "§29: expanded order wrong (got '$_t29_order')"
_t29_cc=0; _t29_cs=0
while IFS= read -r -d '' _record; do
  _t29_cc=$((_t29_cc + 1))
  case "$_record" in 'session'*'s:$42'*) _t29_cs=1 ;; esac
done < "$WORK/t4-compact"
[ "$_t29_cc" -eq 1 ] && [ "$_t29_cs" -eq 1 ] && ok "§29: compact = session row only" || nok "§29: compact = session row only (got $_t29_cc records)"

# ---- §30: machine-id acceptance + ownership refusal at the subprocess dispatcher ----
# A dedicated tmux shim answers the deterministic calls the nav verbs make:
# display-message returns '$42\t%553' for EVERY probe (owned-window/pane queries
# read their first field, '$42'), list-panes returns the attention fixture, show
# answers the saved previous target. git/fzf shims fail loudly (FORBIDDEN, exit
# 99). The same shim dir is reused by the §34 subprocess assertions below.
mkdir -p "$WORK/bin-attn"
cat > "$WORK/bin-attn/tmux" <<'ATTNSHIM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${XTMUX_TMUX_LOG:-/dev/null}"
case "$1" in
  display-message)
    # current-target read ends with #{pane_id} (2 fields); window pair probe
    # carries #{window_id} (2 fields); owner probes query #{session_id} only.
    case "$*" in
      *'#{pane_id}'*) printf '%b\n' '$42\t%553' ;;
      *'#{window_id}'*) printf '%b\n' '$42\t@17' ;;
      *) printf '$42\n' ;;
    esac
    ;;
  list-panes)
    case "$*" in
      *'#{session_name}'*) printf '%b\n' \
          '$42\tprogram\t%901\tpi\t2000\tneeds-input\t901\t-' \
          '$42\tprogram\t%553\tclaude\t1000\tneeds-input\t553\t-' \
          '$42\tprogram\t%875\tpi\t500\tdone\t875\t-' ;;
      *) printf '%s\n' '%901' '%553' '%875' ;;
    esac
    ;;
  show) printf '%b\n' '$42:%553' ;;
esac
exit 0
ATTNSHIM
chmod +x "$WORK/bin-attn/tmux"
for _fbm in git fzf; do
  cat > "$WORK/bin-attn/$_fbm" <<SHIM
#!/usr/bin/env bash
echo "FORBIDDEN: $_fbm \$*" >> "\${XTMUX_TMUX_LOG:-/dev/null}"
exit 99
SHIM
  chmod +x "$WORK/bin-attn/$_fbm"
done
# A session whose owner probes all answer '$99': paired tokens encoded with $42
# must be refused before record_prev or any jump.
mkdir -p "$WORK/bin-mismatch"
cat > "$WORK/bin-mismatch/tmux" <<'MISSHIM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${XTMUX_TMUX_LOG:-/dev/null}"
case "$1" in
  display-message)
    case "$*" in
      *'#{pane_id}'*) printf '%b\n' '$99\t%553' ;;
      *'#{window_id}'*) printf '%b\n' '$99\t@17' ;;
      *) printf '$99\n' ;;
    esac
    ;;
esac
exit 0
MISSHIM
chmod +x "$WORK/bin-mismatch/tmux"

: > "$WORK/t30-accept.log"
PATH="$WORK/bin-attn:$PATH" XTMUX_TMUX_LOG="$WORK/t30-accept.log" "$PICKER" nav-go 's:$42' >/dev/null 2>&1
_t30_rc=$?
if [ "$_t30_rc" -eq 0 ] && grep -qF 'switch-client -t $42' "$WORK/t30-accept.log" \
  && ! grep -qF 'select-window\|select-pane' "$WORK/t30-accept.log"; then
  ok "§30: s:\$42 accepted -> native switch-client -t \$42"
else
  nok "§30: s:\$42 accepted (rc=$_t30_rc, log: $(tr '\n' ';' < "$WORK/t30-accept.log"))"
fi
if grep -qF 'set -g @picker_prev $42:%553' "$WORK/t30-accept.log"; then
  ok "§30: session nav-go records the exact previous pane before switching"
else
  nok "§30: session nav-go records the exact previous pane before switching"
fi
: > "$WORK/t30-win.log"
PATH="$WORK/bin-attn:$PATH" XTMUX_TMUX_LOG="$WORK/t30-win.log" "$PICKER" nav-go 'w:$42:@17' >/dev/null 2>&1
_t30_rc=$?
if [ "$_t30_rc" -eq 0 ] && grep -qF 'switch-client -t $42' "$WORK/t30-win.log" \
  && grep -qF 'select-window -t @17' "$WORK/t30-win.log"; then
  ok "§30: w:\$42:@17 accepted after live ownership match -> switch-client + select-window -t @17"
else
  nok "§30: w:\$42:@17 accepted (rc=$_t30_rc, log: $(tr '\n' ';' < "$WORK/t30-win.log"))"
fi
: > "$WORK/t30-pane.log"
PATH="$WORK/bin-attn:$PATH" XTMUX_TMUX_LOG="$WORK/t30-pane.log" "$PICKER" nav-go 'p:$42:%553' >/dev/null 2>&1
_t30_rc=$?
if [ "$_t30_rc" -eq 0 ] && grep -qF 'select-pane -t %553' "$WORK/t30-pane.log"; then
  ok "§30: p:\$42:%553 accepted after live ownership match -> select-pane -t %553"
else
  nok "§30: p:\$42:%553 accepted (rc=$_t30_rc, log: $(tr '\n' ';' < "$WORK/t30-pane.log"))"
fi
# malformed window tokens are structural: rejected BEFORE any tmux call.
: > "$WORK/t30-mal.log"
PATH="$WORK/bin-attn:$PATH" XTMUX_TMUX_LOG="$WORK/t30-mal.log" "$PICKER" nav-go 'w:$42:coord' >/dev/null 2>&1
_t30_rc=$?
if [ "$_t30_rc" -ne 0 ] && [ ! -s "$WORK/t30-mal.log" ]; then
  ok "§30: malformed window token rejected at dispatch (rc≠0, zero tmux calls)"
else
  nok "§30: malformed window token rejected at dispatch (rc=$_t30_rc, log: $(tr '\n' ';' < "$WORK/t30-mal.log"))"
fi
# moved/stale and cross-session owners refuse at the dispatcher before any
# record_prev or jump (subprocess mirror of the hosted NAV-T3 proofs).
: > "$WORK/t30-moved.log"
PATH="$WORK/bin-mismatch:$PATH" XTMUX_TMUX_LOG="$WORK/t30-moved.log" "$PICKER" nav-go 'w:$42:@17' >/dev/null 2>&1
_t30_rc=$?
if [ "$_t30_rc" -ne 0 ] && ! grep -qF 'select-window\|switch-client\|set -g' "$WORK/t30-moved.log"; then
  ok "§30: window claimed in another live session rejected (no jump, no prev record)"
else
  nok "§30: window claimed in another live session rejected (rc=$_t30_rc, log: $(tr '\n' ';' < "$WORK/t30-moved.log"))"
fi
: > "$WORK/t30-panemoved.log"
PATH="$WORK/bin-mismatch:$PATH" XTMUX_TMUX_LOG="$WORK/t30-panemoved.log" "$PICKER" nav-go 'p:$42:%553' >/dev/null 2>&1
_t30_rc=$?
if [ "$_t30_rc" -ne 0 ] && ! grep -qF 'select-pane\|switch-client\|set -g' "$WORK/t30-panemoved.log"; then
  ok "§30: pane claimed in another live session rejected (no jump, no prev record)"
else
  nok "§30: pane claimed in another live session rejected (rc=$_t30_rc, log: $(tr '\n' ';' < "$WORK/t30-panemoved.log"))"
fi

# §30 hostile display set — quotes, semicolons, $(), backticks, Unicode in the
# session/window/pane PRESENTATION fields. Identity stays machine-exact and the
# hostile text must never EXECUTE (pwn markers) nor ride into a tmux action.
(
  _p1="$WORK/t30-a"; _p2="$WORK/t30-b"; _p3="$WORK/t30-c"; _p4="$WORK/t30-d"
  _h_sess="hostile; \$(touch $_p1) ; \`touch $_p2\` ; \"dq\" ; 'sq' ; Δ"
  _h_win="win; \$(touch $_p3) ; \`touch $_p4\` ; reload; \"wq\" ; λ"
  _h_task="task; \$(touch $_p4) ; \`id\` ; \"tq\" ; Ω"
  session_meta() { printf '%b\n' '$26\t'"$_h_sess"'\t%553\t'"$WORK"'/none\t1000'; }
  pane_meta() {
    printf '%b\n' \
      '$26\t@100\t0\t'"$_h_win"'\t0\t%553\t0\t1\tclaude\t'"$WORK"'/none\tneeds-input\t553\t-\t'"$_h_task"'\t-\t-'
  }
  TMUX_PANE='%553' XTMUX_NAV_WIDTH=44 TMUX_PICKER_NO_CACHE=1 build_list all expanded nav multi
) > "$WORK/t30-hostile"
_t30_tok_ok=1; _t30_ctrl=0; _t30_count=0
while IFS= read -r -d '' _record; do
  _t30_count=$((_t30_count + 1))
  IFS=$'\t' read -r _type _sid _name _target _token _first <<< "$_record"
  case "$_type:$_target:$_token" in
    'session:$26:s:$26'|'window:@100:w:$26:@100'|'pane:%553:p:$26:%553') ;;
    *) _t30_tok_ok=0 ;;
  esac
  _prefix="$_type"$'\t'"$_sid"$'\t'"$_name"$'\t'"$_target"$'\t'"$_token"$'\t'
  _plain="$(_strip_nav_ansi "${_record#"$_prefix"}")"
  # structural card newlines are renderer-owned (legit); any OTHER control byte
  # from hostile display text must not survive into the record.
  case "${_plain//$'\n'/ }" in *[[:cntrl:]]*) _t30_ctrl=1 ;; esac
done < "$WORK/t30-hostile"
[ "$_t30_count" -eq 3 ] && [ "$_t30_tok_ok" -eq 1 ] && ok "§30: hostile display keeps every token machine-exact (s/w/p)" || nok "§30: hostile display keeps every token machine-exact (count=$_t30_count tokens_ok=$_t30_tok_ok)"
[ "$_t30_ctrl" -eq 0 ] && ok "§30: hostile display is control-sanitized in output" || nok "§30: hostile display is control-sanitized in output"
if [ ! -e "$WORK/t30-a" ] && [ ! -e "$WORK/t30-b" ] && [ ! -e "$WORK/t30-c" ] && [ ! -e "$WORK/t30-d" ]; then
  ok "§30: \$(...) and backtick display text never executes"
else
  nok "§30: \$(...) and backtick display text never executes"
fi
# dispatch under hostile display: actions on the exact emitted tokens never use
# the text (the tmux argv log must contain no rendered display content).
: > "$WORK/t30-dispatch.log"
(
  # nav_go's jump uses `exec tmux`, which bypasses function overrides, so the
  # fake shim must be on PATH for the jump while tmux() serves the probes.
  export PATH="$WORK/bin:$PATH" XTMUX_TMUX_LOG="$WORK/t30-dispatch.log"
  tmux() {
    printf '%s\n' "$*" >> "$WORK/t30-dispatch.log"
    case "$*" in
      *'list-panes -s -t $26'*) printf '%%553\n' ;;
      *'#{pane_id}'*) printf '$26\t%%553\n' ;;
      *'-t '*) printf '$26\n' ;;
      *) printf '\n' ;;
    esac
  }
  nav_go 'p:$26:%553'
  nav_go 's:$26'
) >/dev/null 2>&1
if grep -qF 'select-pane -t %553' "$WORK/t30-dispatch.log" && grep -qF 'switch-client -t $26' "$WORK/t30-dispatch.log" \
  && ! grep -qF 'hostile;\|win;\|task;asdf' "$WORK/t30-dispatch.log"; then
  ok "§30: nav-go under hostile display dispatches to exact machine ids, never the text"
else
  nok "§30: nav-go under hostile display (log: $(tr '\n' ';' < "$WORK/t30-dispatch.log"))"
fi
if declare -F nav_row_fields >/dev/null 2>&1 && declare -F nav_window_label >/dev/null 2>&1; then
  nav_row_fields $'pane\t$26\tprog\t%553\tp:$26:%553\tline one\t"q"; $(id); `id`; Δ\tline three'
  assert_eq "§30: tab+newline-laden display keeps exact machine identity" $'pane\t$26\t%553\tp:$26:%553' "$REPLY"
  XTMUX_NAV_WIDTH=60 nav_window_label '0' $'hostile\n\ttab\tname\t`id`; $(touch '"$WORK"'/t30-e)'
  case "$REPLY" in
    *[[:cntrl:]]*) nok "§30: window label neutralizes tabs/newlines (presentation only)" ;;
    *) ok "§30: window label neutralizes tabs/newlines (presentation only)" ;;
  esac
fi

# ---- §32: per-type visual budgets + stream usability on the pathological records ----
# t4-pathologic: session name / window name / runtime / agent task / cwd ALL
# several KB. Budgets are PER TYPE (session 3, window 2, pane 2). The record
# byte bound is already asserted above; these add the per-type line budgets and
# the fzf-stream usability facts.
_t32_lines_ok=1; _t32_count=0; _t32_headers_ok=1; _t32_ident_ok=1
while IFS= read -r -d '' _record; do
  _t32_count=$((_t32_count + 1))
  IFS=$'\t' read -r _type _sid _name _target _token _first <<< "$_record"
  case "$_type:$_token" in
    'session:s:$47'|'window:w:$47:@7'|'pane:p:$47:%1') ;;
    *) _t32_ident_ok=0 ;;
  esac
  _prefix="$_type"$'\t'"$_sid"$'\t'"$_name"$'\t'"$_target"$'\t'"$_token"$'\t'
  _display="${_record#"$_prefix"}"
  _plain="$(_strip_nav_ansi "$_display")"
  nav_line_budget "$_type"; _budget="$REPLY"
  _lines="$(printf '%s\n' "$_plain" | grep -c . || true)"
  [ -n "$_lines" ] && [ "$_lines" -le "$_budget" ] || _t32_lines_ok=0
  _head="$(printf '%s' "$_record" | head -1)"
  _nf="$(printf '%s' "$_head" | awk -F '\t' '{print NF}')"
  [ "$_nf" -eq 6 ] || _t32_headers_ok=0
done < "$WORK/t4-pathologic"
[ "$_t32_count" -eq 3 ] && ok "NAV-T6 §32: several-KB metadata still yields a usable 3-record NUL stream (fzf --read0)" || nok "NAV-T6 §32: stream round-trip length ($_t32_count)"
[ "$_t32_headers_ok" -eq 1 ] && ok "NAV-T6 §32: every record keeps its 6-field machine header (type/sid/name/target/token/display)" || nok "NAV-T6 §32: 6-field machine header broken (fzf would mis-frame)"
[ "$_t32_ident_ok" -eq 1 ] && ok "NAV-T6 §32: pathological metadata cannot corrupt action identity (s/w/p tokens exact)" || nok "NAV-T6 §32: pathological metadata corrupted a token"
[ "$_t32_lines_ok" -eq 1 ] && ok "NAV-T6 §32: per-type visual lines within configured budgets (session ≤3, window ≤2, pane ≤1)" || nok "NAV-T6 §32: a pathological record exceeded its per-type line budget"
# details still expose the full semantic value: the window preview emits the raw
# KB-size cwd verbatim even though the default record had to bound it.
_l32="$(printf 'L%.0s' {1..3000})"
(
  tmux() {
    case "$1" in
      list-panes) printf '%b\n' "@7\t0\t${_l32}\t0\t%1\t0\t1\tclaude\t$WORK/${_l32}\t80\t24\t0\t0\tneeds-input\t1\t-\t-\t-\t-" ;;
    esac
    return 0
  }
  preview_window_row '$47' 'prog' '@7'
) > "$WORK/t32-details"
if grep -qF "$WORK/$_l32" "$WORK/t32-details"; then
  ok "NAV-T6 §32: details still expose the full KB-size cwd (bounded out of the default record)"
else
  nok "NAV-T6 §32: details still expose the full KB-size cwd"
fi
# the pathological pane token drives the exact %1 jump — identity is the token.
: > "$WORK/t32-navgo.log"
(
  export PATH="$WORK/bin:$PATH" XTMUX_TMUX_LOG="$WORK/t32-navgo.log"
  tmux() {
    case "$1" in
      list-panes) printf '%%1\n' ;;
      display-message) printf '%s\n' "$*" >> "$WORK/t32-navgo.log"; printf '$47\t%%1\n' ;;
      *) printf '%s\n' "$*" >> "$WORK/t32-navgo.log" ;;
    esac
  }
  nav_go 'p:$47:%1'
) >/dev/null 2>&1
if grep -qF 'select-pane -t %1' "$WORK/t32-navgo.log" && ! grep -qF 'select-pane -t $47' "$WORK/t32-navgo.log"; then
  ok "NAV-T6 §32: pathological token typo-proof — nav-go targets the exact %1 pane"
else
  nok "NAV-T6 §32: nav-go pathological token (log: $(tr '\n' ';' < "$WORK/t32-navgo.log"))"
fi

# ---- §33: current-location markers — TMUX_PANE + inventory, never text/focus ----
# Direction 1: current pane %553 on the §29 fixture (t4-expanded ran with
# TMUX_PANE=%553). The session keeps a literal '▎' marker; the current window
# and pane are distinguished by the ACCENT truecolor on the uniform '↳' glyph
# and @/%id (PART V/§33), detected here via _nav_acc on the raw display. The
# accent code is distinguishable from the amber ATTENTION and muted roles.
_t33_first() { # REPLY = first non-space glyph of the first display line
  local line="${1:-}"
  REPLY="${line%%$'\n'*}"
  REPLY="${REPLY#"${REPLY%%[![:space:]]*}"}"
}
_t33_sess=0; _t33_w17=0; _t33_w31=0; _t33_p553=0; _t33_p_other=0
while IFS= read -r -d '' _record; do
  IFS=$'\t' read -r _type _sid _name _target _token _first <<< "$_record"
  _prefix="$_type"$'\t'"$_sid"$'\t'"$_name"$'\t'"$_target"$'\t'"$_token"$'\t'
  _display="${_record#"$_prefix"}"
  _plain="$(_strip_nav_ansi "$_display")"
  _t33_first "$_plain"
  case "$_type:$_token" in
    'session:s:$42')            case "$REPLY" in '▎'*) _t33_sess=1 ;; esac ;;
    'window:w:$42:@17')         _nav_acc "$_display" && _t33_w17=1 ;;
    'window:w:$42:@31')         _nav_acc "$_display" && _t33_w31=1 ;;
    'pane:p:$42:%553')          _nav_acc "$_display" && _t33_p553=1 ;;
    'pane:p:$42:%621'|'pane:p:$42:%875'|'pane:p:$42:%901') _nav_acc "$_display" && _t33_p_other=1 ;;
  esac
done < "$WORK/t4-expanded"
[ "$_t33_sess" -eq 1 ] && ok "§33: session marker on \$42 (given current pane %553)" || nok "§33: session marker missing on \$42"
[ "$_t33_w17" -eq 1 ] && [ "$_t33_w31" -eq 0 ] && ok "§33: current window marker on @17 exactly (never @31)" || nok "§33: current window marker (w17=$_t33_w17 w31=$_t33_w31)"
[ "$_t33_p553" -eq 1 ] && [ "$_t33_p_other" -eq 0 ] && ok "§33: current pane marker on %553 exactly (621/875/901 plain branch glyphs)" || nok "§33: current pane marker leak (p553=$_t33_p553 other=$_t33_p_other)"
# Direction 2 — the flip: SAME names and focus fields, only TMUX_PANE changes.
# The fixture deliberately CONTRADICTS focus so any focus/text inference lights
# the wrong row: window @17 has window_active=1 while the current pane lives in
# @31; pane %901 has pane_active=1 while the current pane %875 is inactive.
# Decoy marker glyphs ride INSIDE non-current task text to prove markers are
# positional (leading glyph), never textual.
(
  session_meta() { printf '%b\n' '$42\tprogram\t%553\t'"$WORK"'/coord\t1000'; }
  pane_meta() {
    printf '%b\n' \
      '$42\t@17\t0\t0:coord\t1\t%553\t0\t1\tclaude\t'"$WORK"'/coord\trunning\t553\t-\t-\t-\t-' \
      '$42\t@17\t0\t0:coord\t1\t%621\t1\t0\tbash\t'"$WORK"'/scripts\tidle\t621\t-\tdecoy ● text\t-\t-' \
      '$42\t@31\t1\t1:research\t0\t%875\t0\t0\tpi\t'"$WORK"'/research\tneeds-input\t875\t-\t-\t-\t-' \
      '$42\t@31\t1\t1:research\t0\t%901\t1\t1\tclaude\t'"$WORK"'/reviews\trunning\t901\t-\tdecoy ▸ text\t-\t-'
  }
  TMUX_PANE='%875' XTMUX_NAV_WIDTH=60 TMUX_PICKER_NO_CACHE=1 build_list all expanded nav multi
) > "$WORK/t33-flip"
_t33f_sess=0; _t33f_w31=0; _t33f_w17=0; _t33f_p875=0; _t33f_p901=0; _t33f_p621=0
_t33f_mk_c=0; _t33f_mk_w=0; _t33f_mk_p=0
while IFS= read -r -d '' _record; do
  IFS=$'\t' read -r _type _sid _name _target _token _first <<< "$_record"
  _prefix="$_type"$'\t'"$_sid"$'\t'"$_name"$'\t'"$_target"$'\t'"$_token"$'\t'
  _display="${_record#"$_prefix"}"
  _plain="$(_strip_nav_ansi "$_display")"
  _t33_first "$_plain"
  case "$REPLY" in '▎'*) _t33f_mk_c=$((_t33f_mk_c + 1)) ;; esac
  case "$_type" in
    window) _nav_acc "$_display" && _t33f_mk_w=$((_t33f_mk_w + 1)) ;;
    pane)   _nav_acc "$_display" && _t33f_mk_p=$((_t33f_mk_p + 1)) ;;
  esac
  case "$_type:$_token" in
    'session:s:$42')    case "$REPLY" in '▎'*) _t33f_sess=1 ;; esac ;;
    'window:w:$42:@31') _nav_acc "$_display" && _t33f_w31=1 ;;
    'window:w:$42:@17') _nav_acc "$_display" && _t33f_w17=1 ;;
    'pane:p:$42:%875')  _nav_acc "$_display" && _t33f_p875=1 ;;
    'pane:p:$42:%901')  _nav_acc "$_display" && _t33f_p901=1 ;;
    'pane:p:$42:%621')  _nav_acc "$_display" && _t33f_p621=1 ;;
  esac
done < "$WORK/t33-flip"
[ "$_t33f_sess" -eq 1 ] && ok "§33: flip keeps the session marker on \$42" || nok "§33: flip session marker lost"
[ "$_t33f_w31" -eq 1 ] && [ "$_t33f_w17" -eq 0 ] && ok "§33: window marker follows TMUX_PANE to @31 — NOT window_active (focused @17 unmarked)" || nok "§33: window marker follow (w31=$_t33f_w31 w17=$_t33f_w17)"
[ "$_t33f_p875" -eq 1 ] && [ "$_t33f_p901" -eq 0 ] && [ "$_t33f_p621" -eq 0 ] && ok "§33: pane marker follows TMUX_PANE to inactive %875; focused %901 and decoy-text %621 unmarked" || nok "§33: pane marker follow (p875=$_t33f_p875 p901=$_t33f_p901 p621=$_t33f_p621)"
[ "$_t33f_mk_c" -eq 1 ] && [ "$_t33f_mk_w" -eq 1 ] && [ "$_t33f_mk_p" -eq 1 ] && ok "§33: exactly one row per level carries current-location state (no other row)" || nok "§33: marker counts (c=$_t33f_mk_c w=$_t33f_mk_w p=$_t33f_mk_p)"

# ---- §34: direct verbs at subprocess level (attention projection, back, wiring) ----
# bin-attn (created above) serves display-message ($42,%553), the attention
# list-panes fixture, and the saved-previous show. Every call is logged; git/fzf
# fail loudly as FORBIDDEN. Attention canonical order (rank asc, activity desc):
# %901 needs-input(act 2000), %553 needs-input(act 1000) = current, %875 done.
# So attention-next from %553 -> %875 and attention-prev -> %901.
: > "$WORK/t34-next.log"
PATH="$WORK/bin-attn:$PATH" XTMUX_TMUX_LOG="$WORK/t34-next.log" "$PICKER" nav attention-next >/dev/null 2>&1
if grep -qF 'select-pane -t %875' "$WORK/t34-next.log" && grep -qF 'set -g @picker_prev $42:%553' "$WORK/t34-next.log"; then
  ok "§34: attention-next jumps to the canonical next attention target (%875) and records the exact previous pane"
else
  nok "§34: attention-next subprocess (log: $(tr '\n' ';' < "$WORK/t34-next.log"))"
fi
if grep -qF 'FORBIDDEN' "$WORK/t34-next.log" || grep -qF 'preview' "$WORK/t34-next.log"; then
  nok "§34: attention-next never invokes fzf/git or preview enrichment"
else
  ok "§34: attention-next never invokes fzf/git or preview enrichment"
fi
if ! grep -q 'list-sessions' "$WORK/t34-next.log"; then
  ok "§34: attention-next uses the single attention projection — no session inventory, no renderer"
else
  nok "§34: attention-next enumerates sessions or runs the full renderer"
fi
: > "$WORK/t34-prev.log"
PATH="$WORK/bin-attn:$PATH" XTMUX_TMUX_LOG="$WORK/t34-prev.log" "$PICKER" nav attention-prev >/dev/null 2>&1
if grep -qF 'select-pane -t %901' "$WORK/t34-prev.log" && grep -qF 'set -g @picker_prev $42:%553' "$WORK/t34-prev.log"; then
  ok "§34: attention-prev jumps to the canonical previous attention target (%901), same wiring"
else
  nok "§34: attention-prev subprocess (log: $(tr '\n' ';' < "$WORK/t34-prev.log"))"
fi
if grep -qF 'FORBIDDEN' "$WORK/t34-prev.log"; then
  nok "§34: attention-prev never invokes fzf/git"
else
  ok "§34: attention-prev never invokes fzf/git"
fi
# back: exact previous pane purely through tmux show + the jump primitive.
: > "$WORK/t34-back.log"
PATH="$WORK/bin-attn:$PATH" XTMUX_TMUX_LOG="$WORK/t34-back.log" "$PICKER" nav back >/dev/null 2>&1
if grep -qF 'select-pane -t %553' "$WORK/t34-back.log" && grep -qF 'switch-client -t $42' "$WORK/t34-back.log" \
  && ! grep -qF 'FORBIDDEN' "$WORK/t34-back.log"; then
  ok "§34: nav back returns to the exact previous pane (%553) with no fzf/git"
else
  nok "§34: nav back subprocess (log: $(tr '\n' ';' < "$WORK/t34-back.log"))"
fi
# back with no saved target: bounded non-error, message only, no jump.
mkdir -p "$WORK/bin-back0"
cat > "$WORK/bin-back0/tmux" <<'BACK0'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${XTMUX_TMUX_LOG:-/dev/null}"
exit 0
BACK0
chmod +x "$WORK/bin-back0/tmux"
: > "$WORK/t34-back0.log"
PATH="$WORK/bin-back0:$PATH" XTMUX_TMUX_LOG="$WORK/t34-back0.log" "$PICKER" nav back >/dev/null 2>&1
_t34_rc=$?
if [ "$_t34_rc" -eq 0 ] && ! grep -qF 'select-pane\|switch-client' "$WORK/t34-back0.log"; then
  ok "§34: nav back with no saved target is a bounded non-error (no jump attempted)"
else
  nok "§34: nav back no-target (rc=$_t34_rc, log: $(tr '\n' ';' < "$WORK/t34-back0.log"))"
fi
# next/prev record-wiring at subprocess level: the shared shim answers the live
# current-target read deterministically ($9/%9), so the record_prev write must
# precede the native op and no enumeration/fzf/git may appear.
: > "$WORK/t34-np.log"
PATH="$WORK/bin:$PATH" XTMUX_TMUX_LOG="$WORK/t34-np.log" "$PICKER" nav next >/dev/null 2>&1
_ln_set="$(grep -nF 'set -g @picker_prev $9:%9' "$WORK/t34-np.log" | head -1 | cut -d: -f1)"
_ln_sw="$(grep -nF 'switch-client -n' "$WORK/t34-np.log" | head -1 | cut -d: -f1)"
if [ -n "$_ln_set" ] && [ -n "$_ln_sw" ] && [ "$_ln_set" -lt "$_ln_sw" ]; then
  ok "§34: nav next records the exact previous pane BEFORE native switch-client -n (subprocess)"
else
  nok "§34: nav next record wiring (log: $(tr '\n' ';' < "$WORK/t34-np.log"))"
fi
if ! grep -qF 'FORBIDDEN' "$WORK/t34-np.log" && ! grep -q 'list-' "$WORK/t34-np.log"; then
  ok "§34: nav next is a single native op — no fzf/git, no inventory"
else
  nok "§34: nav next leaks fzf/git or enumerates (log: $(tr '\n' ';' < "$WORK/t34-np.log"))"
fi
: > "$WORK/t34-pp.log"
PATH="$WORK/bin:$PATH" XTMUX_TMUX_LOG="$WORK/t34-pp.log" "$PICKER" nav prev >/dev/null 2>&1
_ln_set="$(grep -nF 'set -g @picker_prev $9:%9' "$WORK/t34-pp.log" | head -1 | cut -d: -f1)"
_ln_sw="$(grep -nF 'switch-client -p' "$WORK/t34-pp.log" | head -1 | cut -d: -f1)"
if [ -n "$_ln_set" ] && [ -n "$_ln_sw" ] && [ "$_ln_set" -lt "$_ln_sw" ] && ! grep -qF 'FORBIDDEN' "$WORK/t34-pp.log"; then
  ok "§34: nav prev records previous exact pane before native switch-client -p (subprocess)"
else
  nok "§34: nav prev record wiring (log: $(tr '\n' ';' < "$WORK/t34-pp.log"))"
fi


echo
echo "== xtmux-4ie.4: semantic palette, width-priority, sibling-invariance =="
# SEMANTIC PALETTE (PART VIII). Assertions are role-based — they never
# hardcode an arbitrary RGB literal except to prove the few fixed semantic
# separations (neutral != attention != accent). The strong rainbow guard:
# run/done/idle must share ONE neutral muted role, so recoloring any
# lifecycle state to green/blue/rainbow breaks these assertions immediately.
# A style code SGR helper extracts the 38;2;R;G;B parameter from a styled
# reply so tests compare roles, not raw escape bytes.
_nav_scode() { printf '%s' "$1" | grep -oE '38;2;[0-9]+;[0-9]+;[0-9]+' | head -1; }
if declare -F nav_style >/dev/null 2>&1; then
  nav_style run X; _p_run="$REPLY"; _p_run_c="$(_nav_scode "$REPLY")"
  nav_style done X; _p_done_c="$(_nav_scode "$REPLY")"
  nav_style idle X; _p_idle="$REPLY"; _p_idle_c="$(_nav_scode "$REPLY")"
  nav_style runtime X; _p_neutral_c="$(_nav_scode "$REPLY")"
  nav_style wait X; _p_wait_c="$(_nav_scode "$REPLY")"
  nav_style needs-input X; _p_ni_c="$(_nav_scode "$REPLY")"
  nav_style stale X; _p_stale_c="$(_nav_scode "$REPLY")"
  nav_style urgent X; _p_urg_c="$(_nav_scode "$REPLY")"
  nav_style current X; _p_cur_c="$(_nav_scode "$REPLY")"
  nav_style accent X; _p_acc_c="$(_nav_scode "$REPLY")"

  [ -n "$_p_run_c" ] && [ "$_p_run_c" = "$_p_idle_c" ] && [ "$_p_run_c" = "$_p_done_c" ] \
    && ok "palette: run/done/idle share ONE neutral lifecycle role (no green/blue differentiation)" \
    || nok "palette: run/done/idle share ONE neutral lifecycle role (run=$_p_run_c done=$_p_done_c idle=$_p_idle_c)"
  [ "$_p_run_c" = "$_p_neutral_c" ] && ok "palette: lifecycle neutral == runtime/secondary muted role" || nok "palette: lifecycle neutral diverges from the muted secondary role"
  case "$_p_run_c" in "$_p_wait_c"|"$_p_cur_c") nok "palette: lifecycle neutral must be neither attention nor accent" ;; *) ok "palette: lifecycle neutral is distinct from attention and accent roles" ;; esac

  [ -n "$_p_wait_c" ] && [ "$_p_wait_c" = "$_p_ni_c" ] && [ "$_p_wait_c" = "$_p_stale_c" ] && [ "$_p_wait_c" = "$_p_urg_c" ] \
    && ok "palette: urgent/wait/needs-input/stale share ONE attention role" \
    || nok "palette: urgent/wait/needs-input/stale share ONE attention role (wait=$_p_wait_c ni=$_p_ni_c stale=$_p_stale_c urgent=$_p_urg_c)"
  case "$_p_wait_c" in "$_p_neutral_c"|"$_p_cur_c") nok "palette: attention role must be distinct from neutral and accent" ;; *) ok "palette: attention role is distinct from neutral and accent" ;; esac

  [ -n "$_p_cur_c" ] && [ "$_p_cur_c" = "$_p_acc_c" ] \
    && ok "palette: current/focus share ONE accent role" \
    || nok "palette: current/focus share ONE accent role (cur=$_p_cur_c accent=$_p_acc_c)"
  case "$_p_cur_c" in "$_p_neutral_c"|"$_p_wait_c") nok "palette: accent role must be distinct from neutral and attention" ;; *) ok "palette: accent role is distinct from neutral and attention" ;; esac

  # No bold anywhere in the semantic palette (SGR parameter list never holds a
  # bare 1, a 1;..., or a ;1 trailing segment).
  _p_bold=0
  for _p_reply in "$_p_run" "$_p_idle" "$(nav_style wait X; printf '%s' "$REPLY")" "$(nav_style current X; printf '%s' "$REPLY")"; do
    case "$_p_reply" in *'[1;'*|*';1m'*|*'[1m'*) _p_bold=1 ;; esac
  done
  [ "$_p_bold" -eq 0 ] && ok "palette: no bold escapes anywhere in the semantic palette" || nok "palette: a bold SGR escape leaked into the palette"
fi

# WIDTH PRIORITY (PART XVI / §16/§20): with a repo/path location and a long
# task on one one-line pane card, prove the yield order — task elides first,
# then repo/path truncates, while %pane-id, runtime and exact state survive.
if declare -F nav_pane_card >/dev/null 2>&1 && declare -F _strip_nav_ansi >/dev/null 2>&1; then
  _wp_task="$(printf 'tasksegment%.0s' {1..40})"   # long, over the card
  XTMUX_NAV_WIDTH=60 nav_pane_card '↳' '%1234' 'claude-deploy' 'done' "$_wp_task" done multi 'market-data/src' 0
  _wp60="$(_strip_nav_ansi "$REPLY")"
  XTMUX_NAV_WIDTH=44 nav_pane_card '↳' '%1234' 'claude-deploy' 'done' "$_wp_task" done multi 'market-data/src' 0
  _wp44="$(_strip_nav_ansi "$REPLY")"
  XTMUX_NAV_WIDTH=28 nav_pane_card '↳' '%1234' 'claude-deploy' 'done' "$_wp_task" done multi 'market-data/src' 0
  _wp28="$(_strip_nav_ansi "$REPLY")"
  _wp_oneline=1
  for _wp_card in "$_wp60" "$_wp44" "$_wp28"; do
    case "$_wp_card" in *$'\n'*) _wp_oneline=0 ;; esac
  done
  [ "$_wp_oneline" -eq 1 ] && ok "width: pane card stays ONE line at every width (60/44/28)" || nok "width: pane card broke into multiple visual lines"

  # comfortable width: only task truncates; repo/path, state, runtime, id intact.
  case "$_wp60" in
    *'%1234'*) ok "width: %pane-id survives at comfortable width" ;; *) nok "width: %pane-id lost at width 60 (got '$_wp60')" ;; esac
  case "$_wp60" in
    *'claude-deploy'*) ok "width: runtime survives at comfortable width" ;; *) nok "width: runtime lost at width 60" ;; esac
  case "$_wp60" in
    *'done'*) ok "width: exact state survives at comfortable width" ;; *) nok "width: exact state lost at width 60" ;; esac
  case "$_wp60" in
    *'market-data/src'*) ok "width: repo/path survives at comfortable width" ;; *) nok "width: repo/path lost at width 60 (got '$_wp60')" ;; esac
  case "$_wp60" in
    *"$_wp_task"*) nok "width: overlong task never kept unbounded" ;; *) ok "width: overlong task elides first while everything else is intact" ;; esac

  # narrow width: location now truncates but exact state + runtime + id survive.
  case "$_wp44" in
    *'market-data/src'*) nok "width: repo/path must truncate before exact state" ;; *) ok "width: repo/path truncates at 44 while state survives" ;; esac
  case "$_wp44" in
    *'…'*) ok "width: repo/path keeps a bounded ellipsized head when it yields" ;; *) nok "width: truncated repo/path head missing (got '$_wp44')" ;; esac
  case "$_wp44" in
    *'done'*) ok "width: exact state survives even as repo/path truncates" ;; *) nok "width: exact state dropped before repo/path (priority violation, got '$_wp44')" ;; esac
  case "$_wp44" in
    *'%1234'*) ok "width: %pane-id survives as location yields" ;; *) nok "width: %pane-id lost at width 44" ;; esac
  case "$_wp44" in
    *'claude-deploy'*) ok "width: runtime survives as location yields" ;; *) nok "width: runtime lost at width 44" ;; esac

  # extreme width: state/location/task all gone; only %pane-id + runtime remain.
  case "$_wp28" in
    *'%1234'*) ok "width: %pane-id survives at extreme width" ;; *) nok "width: %pane-id lost at extreme width (got '$_wp28')" ;; esac
  case "$_wp28" in
    *'claude-deploy'*) ok "width: runtime survives at extreme width" ;; *) nok "width: runtime lost at extreme width" ;; esac
  case "$_wp28" in
    *'done'*) nok "width: exact state must yield before runtime at the extreme" ;; *) ok "width: exact state yields before runtime at the extreme" ;; esac

  # every line stays within its usable width across the band
  _wp_wideline=0
  for _wp_pair in "60:$_wp60" "44:$_wp44" "28:$_wp28"; do
    _wp_w="${_wp_pair%%:*}"; _wp_txt="${_wp_pair#*:}"
    while IFS= read -r _wp_vl; do [ "${#_wp_vl}" -le "$_wp_w" ] || _wp_wideline=1; done <<< "$_wp_txt"
  done
  [ "$_wp_wideline" -eq 0 ] && ok "width: every rendered line is bounded by its usable width" || nok "width: a rendered line exceeded its usable width"
fi

# SIBLING-POSITION INVARIANCE (§13/§33): the ancestry glyph is UNIFORMLY '↳'
# — it never mutates into '├'/'└'/'╰' based on whether a pane/window is the
# first, last, or only sibling of its parent. Drive the real renderer over a
# two-pane window + ranged sibling positions and assert every window/pane row
# still carries the literal '↳' glyph and no box-drawing fork ever appears.
(
  session_meta() { printf '%b\n' '$42\tprogram\t%553\t'"$WORK"'/coord\t1000'; }
  pane_meta() {
    printf '%b\n' \
      '$42\t@17\t0\tcoord\t0\t%553\t0\t1\tclaude\t'"$WORK"'/coord\trunning\t553\t-\t-\t-\t-' \
      '$42\t@17\t0\tcoord\t0\t%621\t1\t0\tbash\t'"$WORK"'/scripts\tidle\t621\t-\t-\t-\t-' \
      '$42\t@31\t1\tresearch\t0\t%875\t0\t1\tpi\t'"$WORK"'/research\tneeds-input\t875\t-\t-\t-\t-' \
      '$42\t@31\t1\tresearch\t0\t%901\t1\t0\tclaude\t'"$WORK"'/reviews\trunning\t901\t-\t-\t-\t-'
  }
  TMUX_PANE='%621' XTMUX_NAV_WIDTH=60 TMUX_PICKER_NO_CACHE=1 build_list all expanded nav multi
) > "$WORK/sibling"
_sib_ok=1; _sib_rows=0; _sib_fork=0
while IFS= read -r -d '' _record; do
  IFS=$'\t' read -r _sib_type _sid _name _target _token _first <<< "$_record"
  case "$_sib_type" in window|pane)
      _sib_rows=$((_sib_rows + 1))
      _prefix="$_sib_type"$'\t'"$_sid"$'\t'"$_name"$'\t'"$_target"$'\t'"$_token"$'\t'
      _sib_plain="$(_strip_nav_ansi "${_record#"$_prefix"}")"
      case "$_sib_plain" in
        *'├'*|*'└'*|*'╰'*|*'┌'*|*'╭'*) _sib_fork=1 ;;
      esac
      case "$_sib_plain" in *'↳'*) ;; *) _sib_ok=0 ;; esac
      ;;
  esac
done < "$WORK/sibling"
[ "$_sib_rows" -gt 0 ] && [ "$_sib_ok" -eq 1 ] \
  && ok "sibling-invariance: every window/pane row keeps the '↳' glyph" \
  || nok "sibling-invariance: a window/pane row lost its '↳' glyph"
[ "$_sib_fork" -eq 0 ] \
  && ok "sibling-invariance: glyph never forks into ├/└/╰ at any sibling position" \
  || nok "sibling-invariance: a box-drawing fork replaced '↳'"

# ---- §36: ancestry-preserving fuzzy projection ----
# Ordinary fzf filtering drops every non-matching record, so a flat pane row
# loses its window and session the moment a query matches it. The chain
# projection (fzf `change` reload, list-active-nav-chain) keeps fields 1-5
# byte-identical while the display carries the full session -> window -> pane
# chain: a pane match retains parent window + session, a window match retains
# its parent session, and every action token still targets the matched node.
echo
echo "== §36: ancestry-preserving fuzzy projection =="
_s36_fixture() {
  session_meta() {
    printf '%b\n' \
      '$42\talpha\t%17\t'"$WORK"'/a\t1000' \
      '$43\tbeta\t%18\t'"$WORK"'/b\t1000'
  }
  pane_meta() {
    # %875/@31 occur in BOTH sessions: the linked-window occurrence case.
    printf '%b\n' \
      '$42\t@17\t0\tcoord\t0\t%553\t0\t1\tclaude\t'"$WORK"'/a\trunning\t553\t-\t-\t-\t-' \
      '$42\t@17\t0\tcoord\t0\t%621\t1\t0\tbash\t'"$WORK"'/a\tidle\t621\t-\t-\t-\t-' \
      '$42\t@31\t1\tresearch\t0\t%875\t0\t1\tpi\t'"$WORK"'/a\tneeds-input\t875\t-\t-\t-\t-' \
      '$43\t@31\t1\tresearch\t0\t%875\t0\t1\tpi\t'"$WORK"'/a\tneeds-input\t875\t-\t-\t-\t-'
  }
}
(
  _s36_fixture
  TMUX_PANE='%621' XTMUX_NAV_WIDTH=60 TMUX_PICKER_NO_CACHE=1 build_list all expanded nav multi
) > "$WORK/s36-flat"
(
  _s36_fixture
  TMUX_PANE='%621' XTMUX_NAV_WIDTH=60 TMUX_PICKER_NO_CACHE=1 build_list all expanded nav multi chain
) > "$WORK/s36-chain"
_s36_nflat=0; _s36_nchain=0
while IFS= read -r -d '' _r; do _s36_nflat=$((_s36_nflat+1)); done < "$WORK/s36-flat"
while IFS= read -r -d '' _r; do _s36_nchain=$((_s36_nchain+1)); done < "$WORK/s36-chain"
[ "$_s36_nflat" -eq 9 ] && [ "$_s36_nchain" -eq "$_s36_nflat" ] \
  && ok "§36: chain re-projects every record (same count, no dropped nodes)" \
  || nok "§36: chain record count diverges (flat=$_s36_nflat chain=$_s36_nchain)"

nav_snapshot_project_stream "$WORK/s36-flat" multi > "$WORK/s36-snapshot-chain"
if cmp -s "$WORK/s36-chain" "$WORK/s36-snapshot-chain"; then
  ok "§36: snapshot projection is byte-identical to chain semantics"
else
  nok "§36: snapshot projection diverges from chain semantics"
fi
mkdir -p "$WORK/bin-snapshot"
for _cmd in tmux git; do
  cat > "$WORK/bin-snapshot/$_cmd" <<SHIM
#!/usr/bin/env bash
echo "FORBIDDEN $_cmd \$*" >> "$WORK/s36-snapshot-calls"
exit 99
SHIM
  chmod +x "$WORK/bin-snapshot/$_cmd"
done
cp "$WORK/s36-flat" "$WORK/xtmux-nav.flat.s36"
cp "$WORK/s36-snapshot-chain" "$WORK/xtmux-nav.chain.s36"
: > "$WORK/s36-snapshot-calls"
TMPDIR="$WORK" PATH="$WORK/bin-snapshot:$PATH" "$PICKER" nav-snapshot-view \
  "$WORK/xtmux-nav.flat.s36" "$WORK/xtmux-nav.chain.s36" '%875' > "$WORK/s36-snapshot-query"
if [ ! -s "$WORK/s36-snapshot-calls" ] && cmp -s "$WORK/s36-snapshot-query" "$WORK/s36-snapshot-chain"; then
  ok "§36: atomic snapshot handoff reads local files without tmux/git calls"
else
  nok "§36: atomic snapshot handoff touched live state ($(tr '\n' ';' < "$WORK/s36-snapshot-calls"))"
fi
TMPDIR="$WORK" PATH="$WORK/bin-snapshot:$PATH" "$PICKER" nav-snapshot-view \
  "$WORK/xtmux-nav.flat.s36" "$WORK/xtmux-nav.chain.s36" '' > "$WORK/s36-snapshot-empty"
cmp -s "$WORK/s36-snapshot-empty" "$WORK/s36-flat" \
  && ok "§36: empty query returns flat browse snapshot verbatim" \
  || nok "§36: empty snapshot query diverged from flat browse view"

# fields 1-5 (machine identity + token) byte-identical and same order
_s36_identity_ok=1; _s36_session_same=1
exec 3< "$WORK/s36-flat" 4< "$WORK/s36-chain"
while IFS= read -r -d '' _f <&3 && IFS= read -r -d '' _c <&4; do
  _fh=''; _ch=''; _fr="$_f"; _cr="$_c"
  for _i in 1 2 3 4 5; do
    _ff="${_fr%%$'\t'*}"; _cf="${_cr%%$'\t'*}"
    [ "$_ff" = "$_cf" ] || _s36_identity_ok=0
    _fr="${_fr#*$'\t'}"; _cr="${_cr#*$'\t'}"
  done
  case "$_f" in
    session*) [ "$_fr" = "$_cr" ] || _s36_session_same=0 ;;
  esac
done
exec 3<&- 4<&-
[ "$_s36_identity_ok" -eq 1 ] && ok "§36: fields 1-5 (identity + action token) stay byte-identical" || nok "§36: chain altered machine identity fields"
[ "$_s36_session_same" -eq 1 ] && ok "§36: session records unchanged (a session has no ancestors)" || nok "§36: session records changed under chain"
# window chain: parent session line above the window card, occurrence-specific
_s36_w42=$(while IFS= read -r -d '' _r; do case "$_r" in window*$'\t''w:$42:@31'$'\t'*) printf '%s' "$_r" ;; esac; done < "$WORK/s36-chain")
_s36_w43=$(while IFS= read -r -d '' _r; do case "$_r" in window*$'\t''w:$43:@31'$'\t'*) printf '%s' "$_r" ;; esac; done < "$WORK/s36-chain")
_s36_w42_plain="$(_strip_nav_ansi "${_s36_w42#*$'\t'w:\$42:@31$'\t'}")"
_s36_w43_plain="$(_strip_nav_ansi "${_s36_w43#*$'\t'w:\$43:@31$'\t'}")"
case "$_s36_w42_plain" in *alpha*@31*) ok "§36: window match retains parent session" ;; *) nok "§36: window chain lost its parent session" ;; esac
case "$_s36_w43_plain" in *beta*) ok "§36: linked-window occurrence carries its own session ancestor" ;; *) nok "§36: linked-window occurrence ancestry wrong" ;; esac
# pane chain: session + window + pane; occurrence-specific for the linked pane
_s36_p42=''; _s36_p43=''
while IFS= read -r -d '' _r; do
  case "$_r" in
    *p:'$42:%875'*) _s36_p42="$_r" ;;
    *p:'$43:%875'*) _s36_p43="$_r" ;;
  esac
done < "$WORK/s36-chain"
_s36_p42_disp="$(_strip_nav_ansi "${_s36_p42#*p:\$42:%875$'\t'}")"
_s36_p43_disp="$(_strip_nav_ansi "${_s36_p43#*p:\$43:%875$'\t'}")"
_s36_p42_lines=$(printf '%s' "$_s36_p42_disp" | wc -l)
[ "$_s36_p42_lines" -ge 2 ] \
  && ok "§36: pane match retains parent window + session (multi-line chain)" \
  || nok "§36: pane chain collapsed to $_s36_p42_lines lines"
case "$_s36_p42_disp" in *alpha*@31*%875*) ok "§36: pane chain reads session -> window -> pane in order" ;; *) nok "§36: pane chain order wrong" ;; esac
case "$_s36_p43_disp" in *beta*@31*%875*) ok "§36: linked-pane occurrence chain names its own session" ;; *) nok "§36: linked-pane occurrence chain wrong ancestor" ;; esac
# single-line fallback: bounded one-line chain, still ancestry-bearing
(
  _s36_fixture
  TMUX_PANE='%621' XTMUX_NAV_WIDTH=60 TMUX_PICKER_NO_CACHE=1 build_list all expanded nav single chain
) > "$WORK/s36-single"
_s36_single_ok=1; _s36_single_lines=0
while IFS= read -r -d '' _r; do
  case "$_r" in
    pane*%875*)
      _s36_single_lines=$((_s36_single_lines+1))
      _d="${_r#*$'\t'}"; _d="${_d#*$'\t'}"; _d="${_d#*$'\t'}"; _d="${_d#*$'\t'}"; _d="${_d#*$'\t'}"
      _dp="$(_strip_nav_ansi "$_d")"
      case "$_dp" in *$'\n'*) _s36_single_ok=0 ;; esac
      case "$_dp" in *alpha*%875*|*beta*%875*) ;; *) _s36_single_ok=0 ;; esac
      ;;
  esac
done < "$WORK/s36-single"
[ "$_s36_single_lines" -eq 2 ] && [ "$_s36_single_ok" -eq 1 ] \
  && ok "§36: oneline fallback keeps one bounded ancestry line per pane" \
  || nok "§36: oneline chain malformed (lines=$_s36_single_lines ok=$_s36_single_ok)"
# dispatcher level: empty query re-emits the flat tree verbatim; any active
# query re-emits chains. git exits nonzero (no roots), fzf fails loudly.
mkdir -p "$WORK/bin-chain"
cat > "$WORK/bin-chain/tmux" <<'CHAINSIM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${XTMUX_TMUX_LOG:-/dev/null}"
case "$1" in
  list-sessions) printf '%b\n' '$42\talpha\t%17\t/a\t1000' '$43\tbeta\t%18\t/b\t1000' ;;
  list-panes)
    state="${XTMUX_LIVE_STATE:--}"
    printf '%b\n' '$42\t@17\t0\tcoord\t0\t%553\t0\t1\tclaude\t/a\t-\t553\t-\t-\t-\t-' '$42\t@31\t1\tresearch\t0\t%875\t0\t1\tpi\t/a\t'"$state"'\t875\t-\t-\t-\t-' '$43\t@31\t1\tresearch\t0\t%875\t0\t1\tpi\t/a\t'"$state"'\t875\t-\t-\t-\t-'
    ;;
  display-message) printf '$42\n' ;;
esac
exit 0
CHAINSIM
cat > "$WORK/bin-chain/git" <<'GITSHIM'
#!/usr/bin/env bash
exit 1
GITSHIM
cat > "$WORK/bin-chain/fzf" <<'FZFSHIM'
#!/usr/bin/env bash
echo "FORBIDDEN: fzf $*" >&2
exit 99
FZFSHIM
chmod +x "$WORK/bin-chain/tmux" "$WORK/bin-chain/git" "$WORK/bin-chain/fzf"
# Cold-start guard: the projections must work with an EMPTY picker state
# directory (fresh CI runner / first-use host). Point TMPDIR at a clean dir
# so no ambient state file can mask a missing-file crash.
_s36_tmp="$WORK/tmp-cold"
mkdir -p "$_s36_tmp"
TMPDIR="$_s36_tmp" PATH="$WORK/bin-chain:$PATH" TMUX_PICKER_NO_CACHE=1 "$PICKER" list-active-nav > "$WORK/s36-d-flat" 2>/dev/null
TMPDIR="$_s36_tmp" PATH="$WORK/bin-chain:$PATH" TMUX_PICKER_NO_CACHE=1 "$PICKER" list-active-nav-chain '' > "$WORK/s36-d-empty" 2>/dev/null
TMPDIR="$_s36_tmp" PATH="$WORK/bin-chain:$PATH" TMUX_PICKER_NO_CACHE=1 "$PICKER" list-active-nav-chain '%875' > "$WORK/s36-d-query" 2>/dev/null
if [ -s "$WORK/s36-d-flat" ]; then
  ok "§36: dispatcher flat projection is non-empty on a cold state dir"
else
  nok "§36: dispatcher flat projection is non-empty on a cold state dir (picker emitted nothing)"
fi
if cmp -s "$WORK/s36-d-flat" "$WORK/s36-d-empty"; then
  ok "§36: empty query re-emits the flat tree verbatim (browse view preserved)"
else
  nok "§36: empty-query chain diverges from the flat tree"
fi
_s36_dq_nl=0
while IFS= read -r -d '' _r; do
  case "$_r" in pane*) _d="${_r#*$'\t'}"; _d="${_d#*$'\t'}"; _d="${_d#*$'\t'}"; _d="${_d#*$'\t'}"; _d="${_d#*$'\t'}"; case "$_d" in *$'\n'*) _s36_dq_nl=$((_s36_dq_nl+1)) ;; esac ;; esac
done < "$WORK/s36-d-query"
[ "$_s36_dq_nl" -ge 2 ] \
  && ok "§36: active query re-emits ancestry chains at the dispatcher" \
  || nok "§36: dispatcher did not switch to chains (multiline panes=$_s36_dq_nl flat_bytes=$(wc -c < "$WORK/s36-d-flat") empty_bytes=$(wc -c < "$WORK/s36-d-empty") query_bytes=$(wc -c < "$WORK/s36-d-query") query_head=$(head -c 80 "$WORK/s36-d-query" | tr '\0' '|'))"
# Live query regression: two consecutive change projections must observe a
# pane-state transition. Each attached-client reload retains the bounded
# three-call topology shape (list-sessions, list-panes, current-session query).
: > "$WORK/s36-live.calls"
TMPDIR="$_s36_tmp" PATH="$WORK/bin-chain:$PATH" TMUX_PANE='%553' XTMUX_TMUX_LOG="$WORK/s36-live.calls" XTMUX_LIVE_STATE=running "$PICKER" nav-snapshot-view --live multi '%875' > "$WORK/s36-live-running" 2>/dev/null
TMPDIR="$_s36_tmp" PATH="$WORK/bin-chain:$PATH" TMUX_PANE='%553' XTMUX_TMUX_LOG="$WORK/s36-live.calls" XTMUX_LIVE_STATE=needs-input "$PICKER" nav-snapshot-view --live multi '%875' > "$WORK/s36-live-wait" 2>/dev/null
_s36_live_running="$(_strip_nav_ansi "$(tr '\0' '\n' < "$WORK/s36-live-running")")"
_s36_live_wait="$(_strip_nav_ansi "$(tr '\0' '\n' < "$WORK/s36-live-wait")")"
_s36_live_run_seen=0; _s36_live_wait_seen=0
case "$_s36_live_running" in *run*) _s36_live_run_seen=1 ;; esac
case "$_s36_live_wait" in *wait*) _s36_live_wait_seen=1 ;; esac
_s36_live_calls="$(wc -l < "$WORK/s36-live.calls" | tr -d ' ')"
if [ "$_s36_live_run_seen" -eq 1 ] && [ "$_s36_live_wait_seen" -eq 1 ] && [ "$_s36_live_calls" -eq 6 ] && ! cmp -s "$WORK/s36-live-running" "$WORK/s36-live-wait"; then
  ok "§36: query reload observes live agent-state changes (3 bounded tmux calls each)"
else
  nok "§36: live query freshness/call shape (run=$_s36_live_run_seen wait=$_s36_live_wait_seen calls=$_s36_live_calls)"
fi

# real fuzzy-query behavior: feed chain records to fzf --filter and prove the
# surviving records carry the ancestors. Gated on a multiline-capable fzf.
if command -v fzf >/dev/null 2>&1; then
  TMUX_PICKER_NO_CACHE=1 fzf_multiline_probe; _s36_route="$REPLY"
else
  _s36_route='none'
fi
if [ "$_s36_route" = on ]; then
  fzf --read0 --delimiter=$'\t' --with-nth=6 --filter='%875' < "$WORK/s36-chain" > "$WORK/s36-fuzzy" 2>/dev/null
  _s36_fz="$(_strip_nav_ansi "$(cat "$WORK/s36-fuzzy")")"
  case "$_s36_fz" in *alpha*@31*%875*) _a=1 ;; *) _a=0 ;; esac
  case "$_s36_fz" in *beta*@31*%875*) _b=1 ;; *) _b=0 ;; esac
  [ "${_a:-0}" -eq 1 ] && [ "${_b:-0}" -eq 1 ] \
    && ok "§36: fuzzy pane query returns both linked occurrences, each with its ancestry" \
    || nok "§36: fuzzy pane query lost an occurrence or its ancestry (alpha=${_a:-0} beta=${_b:-0})"
  fzf --read0 --delimiter=$'\t' --with-nth=6 --filter='coord' < "$WORK/s36-chain" > "$WORK/s36-fuzzy-w" 2>/dev/null
  _s36_fzw="$(_strip_nav_ansi "$(cat "$WORK/s36-fuzzy-w")")"
  case "$_s36_fzw" in *alpha*@17*%553*) ok "§36: fuzzy window query retains the session and reaches its panes" ;; *) nok "§36: fuzzy window query lost ancestry" ;; esac
else
  ok "§36: real-fzf fuzzy assertions skipped (no multiline-capable fzf on this host)"
fi

harness_summary
exit $?
