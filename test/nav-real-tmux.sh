#!/usr/bin/env bash
# test/nav-real-tmux.sh — real isolated tmux-server regression for the nav epic
# (bead xtmux-4ie.3).
#
# Proves the three P1 topology behaviors against a REAL tmux server on an
# ISOLATED socket and a REAL attached client, not mocked argv logs:
#
#   TEST A  cross-session window go/back: a real client attached to A at the
#           exact pane PA is moved by the real `picker nav-go w:$B:@W` path
#           (resolve -> record_prev -> jump_to_target window -> `switch-client
#           -t $B \; select-window -t @W`) onto session B with @W current, then
#           `picker jump-back` returns it to session A at the EXACT pane PA.
#
#   TEST B  linked-window occurrences: one window @W (pane %P) is linked into a
#           second session B at a DIFFERENT index. The real build_nav_inventory
#           projection over real `list-panes -a` output renders BOTH
#           occurrences ($A|@W and $B|@W) with correct per-session index / pane
#           placement / count, stable %P/@W identity, and both `w:$A:@W` /
#           `w:$B:@W` pairs independently actionable (a foreign pair rejected).
#
#   TEST C  linked-window current occurrence: the current-location markers
#           track the ACTUALLY ATTACHED client session (A then B) for the SAME
#           linked @W/%P, proving current location is occurrence-correct and
#           never a first-%pane-match in the inventory, and only ONE occurrence
#           is current at a time.
#
# Hermetic: the driver process forces every tmux call onto $SOCK (override);
# pane-side drivers run under the attached client's own TMUX env, which is the
# isolated server (started with `-f /dev/null` so the operator's ~/.tmux.conf
# is never read). The operator's default server is never addressed. Cleanup
# traps kill the isolated server, terminate the attach client, and remove the
# temp dir on EXIT/INT/TERM. capture-pane output is used only for incidentals,
# never as navigation authority.
#
# Determinism: every pane we type into runs a minimal `bash read`-loop (EVAL)
# instead of an interactive shell, so send-keys executes one line of `bash
# <file>` deterministically with no prompt race; the running process is a child
# of the attached client, so its bare `tmux switch-client` targets that client.
#
# Requires: bash, tmux, util-linux `script`. Run: bash test/nav-real-tmux.sh
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PICKER="$ROOT/bin/tmux-session-picker"
. "$HERE/lib/harness.sh"

# ---------------------------------------------------------------------------
# Hermeticity guard + graceful skip where the host cannot run a real server.
# ---------------------------------------------------------------------------
if ! command -v tmux >/dev/null 2>&1 || ! command -v script >/dev/null 2>&1; then
  printf '== nav-real-tmux: SKIP (tmux or util-linux script unavailable) ==\n'
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/xtmux-nav-real.XXXXXX")"
SOCK="$WORK/tmux.sock"
CLIENT_PIDS=''
CLIENT_TARGETS=''
RESULT="$WORK/result"
harness_init "$WORK/results"

# The driver process must NEVER address the operator's server. Every tmux call
# from this shell is forced onto $SOCK. The operator's own $TMUX env var is
# ignored here; it only ever reaches the attached clients whose server is the
# isolated socket.
tmux() { command tmux -S "$SOCK" "$@"; }

_sweep_attach() {
  # Reap any remaining `script` wrapper (and its tmux attach child) bound to
  # THIS run's socket, so failures/retries cannot orphan a client onto a
  # stale socket across runs. Scoped to the unique socket path.
  pkill -TERM -f "script -qec.*$SOCK" 2>/dev/null || true
  sleep 0.1
  pkill -KILL -f "script -qec.*$SOCK" 2>/dev/null || true
}

_kill_clients() {
  local c
  for c in $CLIENT_TARGETS; do
    command tmux -S "$SOCK" kill-client -t "$c" 2>/dev/null || true
  done
  if [ -n "$CLIENT_PIDS" ]; then
    # shellcheck disable=SC2086
    kill $CLIENT_PIDS 2>/dev/null || true
  fi
  _sweep_attach
  CLIENT_PIDS=''
  CLIENT_TARGETS=''
}

_cleanup() {
  trap - EXIT INT TERM
  _kill_clients
  if [ -n "${SOCK:-}" ]; then
    command tmux -S "$SOCK" kill-server 2>/dev/null || true
  fi
  rm -rf -- "$WORK"
}
trap _cleanup EXIT INT TERM

# Source the real picker FUNCTIONS (everything before the top-level dispatch)
# so TEST B/C drive the production projection, not a re-implementation. This is
# the same extraction nav-contract.sh uses.
fn_file="$WORK/picker-functions.sh"
awk '/^case "\$\{1:-\}" in/{exit} {print}' "$PICKER" > "$fn_file"
# shellcheck source=/dev/null
. "$fn_file"
# sourcing imports the picker's strict mode; this suite uses only set -u.
set +e
set +o pipefail

# Deterministic pane shell: read one line, eval it. Every window we type into
# uses this, so send-keys never races an interactive prompt. The `|| sleep`
# branch keeps the loop alive on EOF, so a detached EVAL window (or one whose
# sole client detaches) never closes and takes the session with it. Defined as
# a file in $WORK to avoid shell-quoting gymnastics.
EVAL_CMD="bash '$WORK/eval.sh'"

# The exact first-8-field index the picker's own build_nav_inventory reads from
# real `list-panes -a` (fields beyond pane_id are discarded by the function).
NAV_PANE_FMT=$'#{session_id}\t#{window_id}\t#{window_index}\t#{s/\n/ /:#{s/\t/ /:window_name}}\t#{window_active}\t#{pane_id}\t#{pane_index}\t#{pane_active}'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# start a real attached client on session $1 (background pty via `script`).
# Sets REPLY to the client target; returns 0 once attached to $1.
start_client() {
  local sess="$1" c i attempt=0 n_attempt=3 try_pids='' last_log=''
  while [ "$attempt" -lt "$n_attempt" ]; do
    attempt=$(( attempt + 1 ))
    last_log="$WORK/c$RANDOM.log"
    # CI runners have no TERM in the job environment; tmux attach refuses a
    # terminal it cannot query, so pin a known-good terminal type for the
    # attached client.
    TERM=xterm-256color script -qec "tmux -S '$SOCK' attach-session -t '$sess'" /dev/null >"$last_log" 2>&1 &
    try_pids="$try_pids $!"
    i=0
    while [ "$i" -lt 150 ]; do
      c="$(tmux list-clients -F '#{client_name}' 2>/dev/null | head -1)"
      if [ -n "$c" ] && [ "$(tmux display-message -p -t "$c" '#{client_session}' 2>/dev/null)" = "$sess" ]; then
        REPLY="$c"; CLIENT_PIDS="$CLIENT_PIDS $try_pids"; CLIENT_TARGETS="$CLIENT_TARGETS $c"; return 0
      fi
      sleep 0.1; i=$(( i + 1 ))
    done
    # this attempt produced no client; reap its script processes so a slow
    # later attach cannot orphan a real client onto a stale socket.
    # shellcheck disable=SC2086
    kill $try_pids 2>/dev/null || true
    _sweep_attach
    try_pids=''
  done
  printf 'start_client timeout after %d attempts: clients=[%s]\n' "$n_attempt" \
    "$(tmux list-clients -F '#{client_name}->#{client_session}' 2>/dev/null | tr '\n' ' ')" >&2
  [ -f "$last_log" ] && { printf 'attach log (%s):\n' "$last_log" >&2; head -5 "$last_log" >&2; }
  REPLY=''
  return 1
}

# wait_file <file> <needle> <timeout-tenths> — bounded wait for a result file.
wait_file() {
  local f="$1" needle="$2" t="${3:-80}" i=0
  while [ "$i" -lt "$t" ]; do
    if [ -f "$f" ] && grep -qF -- "$needle" "$f" 2>/dev/null; then return 0; fi
    sleep 0.1; i=$(( i + 1 ))
  done
  return 1
}

# run_in_client <client> <script-file>: execute a bash driver file in the
# attached client's active (EVAL) pane; it inherits the isolated TMUX env so
# the picker/functions act on the isolated server with that client current.
run_in_client() {
  tmux send-keys -t "$1" "bash '$2'; echo RUN_DONE=$? >> '$RESULT'" Enter
}

# Create the deterministic pane shell used by every client-facing window.
cat > "$WORK/eval.sh" <<'EVALSH'
#!/usr/bin/env bash
while :; do
  IFS= read -r line || { sleep 0.1; continue; }
  eval "$line" 2>/dev/null
done
EVALSH
chmod +x "$WORK/eval.sh"

echo
echo "== TEST A: cross-session window go/back (real client) =="

# A and B both run EVAL so every pane the client lands on is a deterministic
# read-loop (PA = A's single pane; @W = B's single window).
tmux -f /dev/null new-session -d -s A "$EVAL_CMD"
tmux new-session -d -s B "$EVAL_CMD"

AID="$(tmux display-message -p -t A '#{session_id}')"
BID="$(tmux display-message -p -t B '#{session_id}')"
PA="$(tmux display-message -p -t A '#{pane_id}')"
WID="$(tmux list-windows -t B -F '#{window_id}' | tail -1)"

if ! start_client A; then
  nok "TEST A: could not attach a real client to session A"
  harness_summary; exit 1
fi
CLIENT_A="$REPLY"

assert_eq "A1: client attached to session A" "$AID" "$(tmux display-message -p -t "$CLIENT_A" '#{session_id}')"

# Drive the REAL picker nav-go path inside the attached client.
cat > "$WORK/go.sh" <<EOF
cd /tmp
"$PICKER" nav-go 'w:$BID:$WID'
echo GO_RC=\$? >> "$RESULT"
EOF
: > "$RESULT"
run_in_client "$CLIENT_A" "$WORK/go.sh"
wait_file "$RESULT" 'GO_RC=' || nok "TEST A: nav-go did not complete"
assert_eq \
  "A2: after nav-go the client is attached to session B" \
  "$BID" "$(tmux display-message -p -t "$CLIENT_A" '#{session_id}')"
assert_eq \
  "A3: after nav-go the client current window is the exact @W" \
  "$WID" "$(tmux display-message -p -t "$CLIENT_A" '#{window_id}')"
assert_eq \
  "A4: nav-go recorded the previous exact pane (\$A:\$PA)" \
  "$AID:$PA" "$(tmux show -gv @picker_prev 2>/dev/null)"

# Drive the REAL picker jump-back path (the `nav back` verb).
cat > "$WORK/back.sh" <<EOF
cd /tmp
"$PICKER" jump-back
echo BACK_RC=\$? >> "$RESULT"
EOF
: > "$RESULT"
run_in_client "$CLIENT_A" "$WORK/back.sh"
wait_file "$RESULT" 'BACK_RC=' || nok "TEST A: jump-back did not complete"
assert_eq \
  "A5: after nav back the client is attached to session A" \
  "$AID" "$(tmux display-message -p -t "$CLIENT_A" '#{session_id}')"
assert_eq \
  "A6: after nav back the client returns to the EXACT pane PA" \
  "$PA" "$(tmux display-message -p -t "$CLIENT_A" '#{pane_id}')"

# ---------------------------------------------------------------------------
# TEST B + C share one linked setup on a fresh server.
# ---------------------------------------------------------------------------
echo
echo "== TEST B: linked-window occurrences (real list-panes -a) =="

# Fresh test topology on the SAME isolated server: tear down the TEST A
# attach client(s) cleanly (kill-client so no orphan survives), drop the
# A/B sessions it used, and keep the server + cleanup trap.
_kill_clients
command tmux -S "$SOCK" kill-session -t A 2>/dev/null || true
command tmux -S "$SOCK" kill-session -t B 2>/dev/null || true
CLIENT_A=''

tmux new-session -d -s A "$EVAL_CMD"
tmux new-session -d -s B "$EVAL_CMD"

AID="$(tmux display-message -p -t A '#{session_id}')"
BID="$(tmux display-message -p -t B '#{session_id}')"
WID="$(tmux list-windows -t A -F '#{window_id}' | head -1)"
P="$(tmux display-message -p -t A '#{pane_id}')"
A_IDX="$(tmux display-message -p -t A '#{window_index}')"

# Link A's window @W into session B at a DIFFERENT index (5). base-index is 0
# (-f /dev/null), A's window sits at index 0, so 5 is guaranteed distinct.
if ! tmux link-window -s "A:$WID" -t B:5 >/dev/null 2>&1; then
  nok "TEST B: link-window failed (could not create second occurrence)"
  harness_summary; exit 1
fi

rows="$(tmux list-panes -a -F "$NAV_PANE_FMT")"
build_nav_inventory <<< "$rows"

# Both structural occurrences render.
if [ -n "${NAV_WIN_INDEX["$AID|$WID"]:-}" ]; then
  ok "B1: occurrence \$A|\@W renders"
else
  nok "B1: occurrence \$A|\@W missing from inventory"
fi
if [ -n "${NAV_WIN_INDEX["$BID|$WID"]:-}" ]; then
  ok "B2: occurrence \$B|\@W renders"
else
  nok "B2: occurrence \$B|\@W missing from inventory (pane already seen must not hide the second winlink)"
fi

# Correct per-session window index, and they differ.
assert_eq "B3: A occurrence carries A's live window index" \
  "$A_IDX" "${NAV_WIN_INDEX["$AID|$WID"]}"
assert_eq "B4: B occurrence carries the different linked index (5)" \
  "5" "${NAV_WIN_INDEX["$BID|$WID"]}"
if [ "${NAV_WIN_INDEX["$AID|$WID"]:-}" != "${NAV_WIN_INDEX["$BID|$WID"]:-}" ]; then
  ok "B5: the two occurrences have distinct per-session window indexes"
else
  nok "B5: per-session window indexes are not distinct (link did not keep different indexes)"
fi

# Per-session pane placement / count.
if [ "${NAV_WIN_PANES["$AID|$WID"]:-}" = "$P" ] && [ "${NAV_WIN_COUNT["$AID|$WID"]:-}" -eq 1 ]; then
  ok "B6: A occurrence owns pane $P (count 1)"
else
  nok "B6: A occurrence pane placement/count wrong (panes=[${NAV_WIN_PANES["$AID|$WID"]:-}] count=${NAV_WIN_COUNT["$AID|$WID"]:-})"
fi
if [ "${NAV_WIN_PANES["$BID|$WID"]:-}" = "$P" ] && [ "${NAV_WIN_COUNT["$BID|$WID"]:-}" -eq 1 ]; then
  ok "B7: B occurrence owns pane $P (count 1)"
else
  nok "B7: B occurrence pane placement/count wrong (panes=[${NAV_WIN_PANES["$BID|$WID"]:-}] count=${NAV_WIN_COUNT["$BID|$WID"]:-})"
fi

# Stable machine identity: the SAME @W / %P object ids under both occurrences,
# and neither disappeared because %P was already seen.
if [ "${NAV_PANE_WIN["$AID|$P"]:-}" = "$WID" ] && [ "${NAV_PANE_WIN["$BID|$P"]:-}" = "$WID" ]; then
  ok "B8: %P maps to @W in BOTH sessions (identity stable, neither occurrence lost)"
else
  nok "B8: %P occurrence mapping not stable across sessions"
fi

# Both pairs independently actionable (resolve proves the session+window PAIR).
REPLY=''
if resolve_nav_window_session "$AID" "$WID" && [ "$REPLY" = "$AID" ]; then
  ok "B9: w:\$A:@W validates (pair resolves to session A)"
else
  nok "B9: w:\$A:@W failed validate_nav_window_session"
fi
REPLY=''
if resolve_nav_window_session "$BID" "$WID" && [ "$REPLY" = "$BID" ]; then
  ok "B10: w:\$B:@W validates (pair resolves to session B)"
else
  nok "B10: w:\$B:@W failed validate_nav_window_session"
fi
# A foreign (non-owner) pairing must be rejected, not silently accepted.
REPLY=''
if resolve_nav_window_session "\$999" "$WID"; then
  nok "B11: a foreign session+@W pair was NOT rejected"
else
  ok "B11: a foreign session+@W pair is rejected (pair, not bare @id, is authoritative)"
fi

# ---------------------------------------------------------------------------
echo
echo "== TEST C: linked-window current occurrence follows the attached client =="

# Pane-side current-location probe (real picker functions, real list-panes -a,
# real client context). Runs in the client's EVAL pane.
cat > "$WORK/cloc.sh" <<'PANEEOF'
. "$WORK_PICKER_FUNCS"
set +e
set +o pipefail
rows="$(tmux list-panes -a -F $'#{session_id}\t#{window_id}\t#{window_index}\t#{s/\n/ /:#{s/\t/ /:window_name}}\t#{window_active}\t#{pane_id}\t#{pane_index}\t#{pane_active}')"
build_nav_inventory <<< "$rows"
nav_current_location
printf 'cur_session=%s cur_window=%s cur_pane=%s\n' "$cur_session" "$cur_window" "$cur_pane" > "$WORK_RESULT"
PANEEOF
# sed: inject the worker's literal paths into the pane-side driver.
sed -e "s|\$WORK_PICKER_FUNCS|$fn_file|" -e "s|\$WORK_RESULT|$RESULT|" "$WORK/cloc.sh" > "$WORK/cloc.run.sh"

if ! start_client A; then
  nok "TEST C: could not attach a real client to session A"
  harness_summary; exit 1
fi
CLIENT_C="$REPLY"

# The client is attached to A at the linked @W (A's only window is the linked
# one). Only the A occurrence must be current now.
: > "$RESULT"
run_in_client "$CLIENT_C" "$WORK/cloc.run.sh"
wait_file "$RESULT" 'cur_session=' || nok "TEST C: current-location probe did not run"
read -r c_session c_window c_pane < <(sed -n 's/^cur_session=\([^ ]*\) cur_window=\([^ ]*\) cur_pane=\([^ ]*\)$/\1 \2 \3/p' "$RESULT" | tail -1)

assert_eq "C1: with client attached to A, only A occurrence is current" "$AID" "$c_session"
assert_eq "C2: ... and current window is the linked @W" "$WID" "$c_window"
assert_eq "C3: ... and current pane is the linked %P" "$P" "$c_pane"
if [ "$c_session" != "$BID" ]; then
  ok "C4: session B is NOT current while the client is attached to A"
else
  nok "C4: session B reported current while client is attached to A (first-match bug)"
fi

# Point session B at the linked @W, then move the SAME client to B. The exact
# same @W/%P are current, but the marker must flip to B.
tmux select-window -t "B:$WID" >/dev/null 2>&1
tmux switch-client -c "$CLIENT_C" -t B
: > "$RESULT"
run_in_client "$CLIENT_C" "$WORK/cloc.run.sh"
wait_file "$RESULT" 'cur_session=' || nok "TEST C: second current-location probe did not run"
read -r c_session c_window c_pane < <(sed -n 's/^cur_session=\([^ ]*\) cur_window=\([^ ]*\) cur_pane=\([^ ]*\)$/\1 \2 \3/p' "$RESULT" | tail -1)

assert_eq "C5: after switch, only B occurrence is current" "$BID" "$c_session"
assert_eq "C6: ... same linked @W is current in B" "$WID" "$c_window"
if [ "$c_session" != "$AID" ]; then
  ok "C7: session A is NOT current after the client moved to B"
else
  nok "C7: session A still reported current after client moved to B (current markers do not track the attached client)"
fi

# ---------------------------------------------------------------------------
echo
echo "== TEST D: linked-window PANE occurrences validate and act per occurrence =="

# A third session C that does NOT own %P: its p:$C:%P claim must be rejected,
# not accepted via tmux's silent fallback to C's current pane.
tmux new-session -d -s C "$EVAL_CMD"
CID="$(tmux display-message -p -t C '#{session_id}')"

# Make %P a valid but NON-CURRENT pane in session A. This specifically
    # catches tmux's session:%pane parse/fallback trap.
    tmux new-window -d -t A:8 "$EVAL_CMD"
    A_OTHER="$(tmux display-message -p -t A:8 '#{pane_id}')"
    tmux select-window -t A:8
    assert_eq "D0: fixture makes %P a valid but NON-CURRENT pane in A" \
      "$A_OTHER" "$(tmux display-message -p -t A '#{pane_id}')"
    if [ "$A_OTHER" != "$P" ]; then
      ok "D0b: non-current regression fixture uses a different pane"
    else
      nok "D0b: non-current regression fixture accidentally reused %P"
    fi

REPLY=''
if resolve_nav_pane_session "$AID" "$P" && [ "$REPLY" = "$AID" ]; then
  ok "D1: p:\$A:%P validates (occurrence resolves to session A)"
else
  nok "D1: p:\$A:%P failed occurrence validation"
fi
REPLY=''
if resolve_nav_pane_session "$BID" "$P" && [ "$REPLY" = "$BID" ]; then
  ok "D2: p:\$B:%P validates (the LINKED occurrence is independently real)"
else
  nok "D2: p:\$B:%P failed occurrence validation (linked occurrence lost)"
fi
REPLY=''
if resolve_nav_pane_session "$CID" "$P"; then
  nok "D3: p:\$C:%P was NOT rejected (bare-%pane fallback accepted a foreign session)"
else
  ok "D3: p:\$C:%P is rejected (session+pane pair, not bare %id, is authoritative)"
fi

# Real cross-session pane action on each occurrence. The client ends TEST C
# attached to B; driving p:$A:%P must move it to session A at the EXACT %P.
cat > "$WORK/gopane.sh" <<EOF
cd /tmp
"$PICKER" nav-go 'p:$AID:$P'
echo GOPANE_RC=\$? >> "$RESULT"
EOF
: > "$RESULT"
run_in_client "$CLIENT_C" "$WORK/gopane.sh"
wait_file "$RESULT" 'GOPANE_RC=' || nok "TEST D: nav-go p:\$A:%P did not complete"
assert_eq "D4: nav-go p:\$A:%P moves the client onto session A" \
  "$AID" "$(tmux display-message -p -t "$CLIENT_C" '#{session_id}')"
assert_eq "D5: ... and lands on the exact pane %P" \
  "$P" "$(tmux display-message -p -t "$CLIENT_C" '#{pane_id}')"

cat > "$WORK/gopaneb.sh" <<EOF
cd /tmp
"$PICKER" nav-go 'p:$BID:$P'
echo GOPANEB_RC=\$? >> "$RESULT"
EOF
: > "$RESULT"
run_in_client "$CLIENT_C" "$WORK/gopaneb.sh"
wait_file "$RESULT" 'GOPANEB_RC=' || nok "TEST D: nav-go p:\$B:%P did not complete"
assert_eq "D6: nav-go p:\$B:%P moves the SAME pane occurrence back to session B" \
  "$BID" "$(tmux display-message -p -t "$CLIENT_C" '#{session_id}')"

# The foreign claim must fail safely: nonzero rc, client and pane unmoved.
cat > "$WORK/gopanec.sh" <<EOF
cd /tmp
"$PICKER" nav-go 'p:$CID:$P'
echo GOPANEC_RC=\$? >> "$RESULT"
EOF
: > "$RESULT"
run_in_client "$CLIENT_C" "$WORK/gopanec.sh"
wait_file "$RESULT" 'GOPANEC_RC=' || nok "TEST D: nav-go p:\$C:%P did not complete"
assert_eq "D7: foreign p:\$C:%P refuses with nonzero rc" \
  'GOPANEC_RC=1' "$(grep -o 'GOPANEC_RC=[0-9]*' "$RESULT" | tail -1)"
assert_eq "D8: ... and the client never left session B" \
  "$BID" "$(tmux display-message -p -t "$CLIENT_C" '#{session_id}')"

# ---------------------------------------------------------------------------
echo
echo "== TEST E: fuzzy query retains ancestry (real fzf over the live chain) =="

if command -v fzf >/dev/null 2>&1; then
  TMUX_PICKER_NO_CACHE=1 fzf_multiline_probe; _e_route="$REPLY"
else
  _e_route='none'
fi
if [ "$_e_route" != on ]; then
  ok "TEST E: skipped (no multiline-capable fzf on this host)"
else
  # Pane-side driver: real picker subprocesses under the attached client's
  # isolated TMUX env, real fzf --filter over the live chain projection.
  cat > "$WORK/fuzzy.sh" <<'PANEEOF'
set -u
cd /tmp
"$WORK_PICKER" list-active-nav-chain "$WORK_PANE" > "$WORK_DIR/chain.q" 2>/dev/null
"$WORK_PICKER" list-active-nav            > "$WORK_DIR/flat"   2>/dev/null
"$WORK_PICKER" list-active-nav-chain ''   > "$WORK_DIR/chain.empty" 2>/dev/null
if cmp -s "$WORK_DIR/flat" "$WORK_DIR/chain.empty"; then
  echo 'EMPTY_SAME=yes' >> "$WORK_RESULT"
else
  echo 'EMPTY_SAME=no' >> "$WORK_RESULT"
fi
fzf --read0 --delimiter=$'\t' --with-nth=6 --filter="$WORK_PANE" \
  < "$WORK_DIR/chain.q" 2>/dev/null | sed $'s/\x1b\\[[0-9;]*m//g' > "$WORK_DIR/matched"
grep -qF 'p:$WORK_SESSA:$WORK_PANE' "$WORK_DIR/matched" && echo 'OCC_A=yes' >> "$WORK_RESULT" || echo 'OCC_A=no' >> "$WORK_RESULT"
grep -qF 'p:$WORK_SESSB:$WORK_PANE' "$WORK_DIR/matched" && echo 'OCC_B=yes' >> "$WORK_RESULT" || echo 'OCC_B=no' >> "$WORK_RESULT"
grep -qF 'p:$WORK_SESSC:$WORK_PANE' "$WORK_DIR/matched" && echo 'OCC_FOREIGN=yes' >> "$WORK_RESULT" || echo 'OCC_FOREIGN=no' >> "$WORK_RESULT"
grep -q "$WORK_SESSA_NAME" "$WORK_DIR/matched" && echo 'HAS_A=yes' >> "$WORK_RESULT" || echo 'HAS_A=no' >> "$WORK_RESULT"
grep -q "$WORK_SESSB_NAME" "$WORK_DIR/matched" && echo 'HAS_B=yes' >> "$WORK_RESULT" || echo 'HAS_B=no' >> "$WORK_RESULT"
grep -qF "$WORK_PANE" "$WORK_DIR/matched" && echo 'HAS_PANE=yes' >> "$WORK_RESULT" || echo 'HAS_PANE=no' >> "$WORK_RESULT"
grep -qF "$WORK_WIN" "$WORK_DIR/matched" && echo 'HAS_WIN=yes' >> "$WORK_RESULT" || echo 'HAS_WIN=no' >> "$WORK_RESULT"
echo 'FUZZY_DONE=yes' >> "$WORK_RESULT"
PANEEOF
  sed -e "s|\$WORK_PICKER|$PICKER|g" -e "s|\$WORK_DIR|$WORK|g" -e "s|\$WORK_RESULT|$RESULT|g" \
      -e "s|\$WORK_PANE|$P|g" -e "s|\$WORK_WIN|$WID|g" \
      -e "s|\$WORK_SESSA_NAME|A|g" -e "s|\$WORK_SESSB_NAME|B|g" \
      -e "s|\$WORK_SESSA|$AID|g" -e "s|\$WORK_SESSB|$BID|g" -e "s|\$WORK_SESSC|$CID|g" \
      "$WORK/fuzzy.sh" > "$WORK/fuzzy.run.sh"
  : > "$RESULT"
  run_in_client "$CLIENT_C" "$WORK/fuzzy.run.sh"
  wait_file "$RESULT" 'FUZZY_DONE=' || nok "TEST E: fuzzy driver did not complete"
  assert_eq "E1: empty query re-emits the flat tree verbatim (browse view preserved)" \
    'EMPTY_SAME=yes' "$(grep -o 'EMPTY_SAME=[a-z]*' "$RESULT" | tail -1)"
  _oa="$(grep -o 'OCC_A=[a-z]*' "$RESULT" | tail -1)"; _ob="$(grep -o 'OCC_B=[a-z]*' "$RESULT" | tail -1)"
  _of="$(grep -o 'OCC_FOREIGN=[a-z]*' "$RESULT" | tail -1)"
  if [ "$_oa" = 'OCC_A=yes' ] && [ "$_ob" = 'OCC_B=yes' ]; then
    ok "E2: fuzzy pane query returns BOTH linked occurrences (p:\$A:%P and p:\$B:%P chains)"
  else
    nok "E2: a linked occurrence chain is missing from the fuzzy result ($_oa $_ob)"
  fi
  if [ "$_of" = 'OCC_FOREIGN=no' ]; then
    ok "E2b: no foreign p:\$C:%P occurrence chain exists (fuzzy noise never fabricates occurrences)"
  else
    nok "E2b: a foreign p:\$C:%P chain appeared in the fuzzy result"
  fi
  _ha="$(grep -o 'HAS_A=[a-z]*' "$RESULT" | tail -1)"; _hb="$(grep -o 'HAS_B=[a-z]*' "$RESULT" | tail -1)"
  if [ "$_ha" = 'HAS_A=yes' ] && [ "$_hb" = 'HAS_B=yes' ]; then
    ok "E3: each occurrence retains ITS OWN session ancestor (A and B both present)"
  else
    nok "E3: occurrence ancestry lost ($_ha $_hb)"
  fi
  assert_eq "E4: the matched pane chain retains the pane itself" \
    'HAS_PANE=yes' "$(grep -o 'HAS_PANE=[a-z]*' "$RESULT" | tail -1)"
  assert_eq "E5: the matched pane chain retains its parent window" \
    'HAS_WIN=yes' "$(grep -o 'HAS_WIN=[a-z]*' "$RESULT" | tail -1)"
fi

echo
harness_summary
exit $?
