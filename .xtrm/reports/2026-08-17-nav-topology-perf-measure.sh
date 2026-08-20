#!/usr/bin/env bash
# NAV-T7 (bead xtmux-w5i.8) — deterministic performance + byte measurement.
#
# Re-uses the baseline (NAV-T0) fixture + method so before/after numbers are
# comparable: the §29 fixture recorded in test/nav-contract.sh (1 session //
# 2 windows // 4 panes), emulated under counting tmux/git shims on PATH,
# picker cache/state isolated under a per-run TMPDIR, TMUX_PICKER_NO_CACHE=1
# for cold and the persisted git cache for warm.
#
# Two cursor variants:
#   A) collapsed  — all pane cwds == one real git repo (NAV-T0 §8.1 "one
#      distinct root"; reproduces cold git = 3 / warm git = 0).
#   B) verbatim   — pane cwds are subdirs of that repo, byte-for-byte the
#      inventory blocks in test/nav-contract.sh (the §29 perf corpus).
#
# Re-run: bash .xtrm/reports/2026-08-17-nav-topology-perf-measure.sh
# Output: prints the same metric table NAV-T7 records in
#         .xtrm/reports/2026-08-17-nav-topology-perf.md
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PICKER="$ROOT/bin/tmux-session-picker"
REAL_GIT="$(command -v git)"           # resolved before shims go on PATH
REAL_TMUX="$(command -v tmux 2>/dev/null || true)"

FIX="$(mktemp -d "${TMPDIR:-/tmp}/xtmux-nav-perf.XXXXXX")"
trap 'rm -rf "$FIX"' EXIT
mkdir -p "$FIX/bin" "$FIX/logs" "$FIX/repo"
REPO="$FIX/repo"

# ---- real git repo: one seed commit, no stash (cold status = 2 git calls) --
(
  cd "$REPO" || exit 1
  "$REAL_GIT" init -q
  "$REAL_GIT" config user.email perf@xtmux.test
  "$REAL_GIT" config user.name perf
  printf 'seed\n' > README.md
  "$REAL_GIT" add README.md
  "$REAL_GIT" commit -qm seed
) || { echo "fixture git init failed" >&2; exit 1; }

# ---- counting shims --------------------------------------------------------
cat > "$FIX/bin/tmux" <<'SHIM'
#!/usr/bin/env bash
printf 'c\n' >> "${XTMUX_NAV_PERF_TMUXCNT:-/dev/null}"
printf '%s\n' "${*//$'\n'/\\n}" >> "${XTMUX_NAV_PERF_TMUXLOG:-/dev/null}"
case "$1" in
  list-sessions) cat "${XTMUX_NAV_PERF_SESS:-/dev/null}" ;;
  list-panes)    cat "${XTMUX_NAV_PERF_PANES:-/dev/null}" ;;
esac
exit 0
SHIM

cat > "$FIX/bin/git" <<'SHIM'
#!/usr/bin/env bash
printf 'c\n' >> "${XTMUX_NAV_PERF_GITCNT:-/dev/null}"
printf '%s\n' "$*" >> "${XTMUX_NAV_PERF_GITLOG:-/dev/null}"
exec "${XTMUX_NAV_PERF_REALGIT:?}" "$@"
SHIM

# process-tree probes must never fire on this fixture (state comes from
# @agent_state; session name is not sp-*). Log + fail loudly if they do.
for _probe in pgrep ps; do
  cat > "$FIX/bin/$_probe" <<SHIM
#!/usr/bin/env bash
printf 'c\n' >> "\${XTMUX_NAV_PERF_PROBECNT:-/dev/null}"
echo "FORBIDDEN probe: $_probe \$*" >> "\${XTMUX_NAV_PERF_PROBELOG:-/dev/null}"
exit 99
SHIM
done
chmod +x "$FIX/bin/"*

# seed picker state (filter=all, mode=expanded) — realistic forced-refresh
# precondition; also keeps list-active-nav exit 0 on an empty state dir.
seed_state() { # seed_state <tmpdir>
  local sd="$1/tmux-picker-state-${UID:-$(id -u)}"
  mkdir -p "$sd" 2>/dev/null
  printf 'all\n' > "$sd/filter" 2>/dev/null || true
  printf 'expanded\n' > "$sd/list-mode" 2>/dev/null || true
}

# ---- §29 fixture rows (verbatim inventory blocks from test/nav-contract.sh) -
# session row (5 fields): sid sname pane_id pane_current_path session_activity
# pane rows (16 fields, NAV-T1/T4 extended): sid window_id window_index
# window_name window_active pane_id pane_index pane_active pane_current_command
# pane_current_path @agent_state pane_pid @agent_bead @agent_task
# @agent_parent_session @agent_last_transition
emit_rows() { # emit_rows <variant=A|B> — writes $FIX/tmux-sessions / tmux-panes
  local v="${1:-A}"
  if [ "$v" = B ]; then
    # verbatim §29 corpus: per-pane cwds are subdirs of the one repo
    printf '%b\n' "\$42\tprogram\t%553\t$REPO/coord\t1000" > "$FIX/tmux-sessions"
    printf '%b\n' \
      "\$42\t@17\t0\tcoord\t0\t%553\t0\t1\tclaude\t$REPO/coord\trunning\t553\t-\t-\t-\t-" \
      "\$42\t@17\t0\tcoord\t0\t%621\t1\t0\tbash\t$REPO/scripts\tidle\t621\t-\t-\t-\t-" \
      "\$42\t@31\t1\tresearch\t0\t%875\t0\t1\tpi\t$REPO/research\tneeds-input\t875\t-\t-\t-\t-" \
      "\$42\t@31\t1\tresearch\t0\t%901\t1\t0\tclaude\t$REPO/reviews\trunning\t901\t-\t-\t-\t-" \
      > "$FIX/tmux-panes"
  else
    # A: collapsed — one distinct pane path (NAV-T0 §8.1), cold git = 3
    printf '%b\n' "\$42\tprogram\t%553\t$REPO\t1000" > "$FIX/tmux-sessions"
    printf '%b\n' \
      "\$42\t@17\t0\tcoord\t0\t%553\t0\t1\tclaude\t$REPO\trunning\t553\t-\t-\t-\t-" \
      "\$42\t@17\t0\tcoord\t0\t%621\t1\t0\tbash\t$REPO\tidle\t621\t-\t-\t-\t-" \
      "\$42\t@31\t1\tresearch\t0\t%875\t0\t1\tpi\t$REPO\tneeds-input\t875\t-\t-\t-\t-" \
      "\$42\t@31\t1\tresearch\t0\t%901\t1\t0\tclaude\t$REPO\trunning\t901\t-\t-\t-\t-" \
      > "$FIX/tmux-panes"
  fi
}

# ---- run helpers -----------------------------------------------------------
# run_one <outfile> <tmpdir> <args...> -> latency ms in REPLY
run_one() {
  local out="$1" td="$2"; shift 2
  : > "$FIX/logs/tmux"; : > "$FIX/logs/git"; : > "$FIX/logs/probe"
  : > "$FIX/logs/tmux.cnt"; : > "$FIX/logs/git.cnt"; : > "$FIX/logs/probe.cnt"
  local t0 t1 pin=""
  [ -n "${XTMUX_NAV_PERF_PIN:-}" ] && pin=(taskset -c "$XTMUX_NAV_PERF_PIN")
  t0=$(date +%s%N)
  PATH="$FIX/bin:$PATH" TMPDIR="$td" LC_ALL=C \
    XTMUX_NAV_PERF_TMUXLOG="$FIX/logs/tmux" XTMUX_NAV_PERF_TMUXCNT="$FIX/logs/tmux.cnt" \
    XTMUX_NAV_PERF_GITLOG="$FIX/logs/git" XTMUX_NAV_PERF_GITCNT="$FIX/logs/git.cnt" \
    XTMUX_NAV_PERF_PROBELOG="$FIX/logs/probe" XTMUX_NAV_PERF_PROBECNT="$FIX/logs/probe.cnt" \
    XTMUX_NAV_PERF_REALGIT="$REAL_GIT" \
    XTMUX_NAV_PERF_SESS="$FIX/tmux-sessions" \
    XTMUX_NAV_PERF_PANES="$FIX/tmux-panes" \
    "${pin[@]}" "$PICKER" "$@" > "$out" 2> "$FIX/logs/err" || { echo "run failed: $*" >&2; cat "$FIX/logs/err" >&2; }
  t1=$(date +%s%N)
  REPLY=$(( (t1 - t0) / 1000000 ))
}

counts() { # counts -> prints "tmux N | git M | probes K" from current logs
  printf 'tmux=%s git=%s probes=%s' \
    "$(wc -l < "$FIX/logs/tmux.cnt")" \
    "$(wc -l < "$FIX/logs/git.cnt")" \
    "$(wc -l < "$FIX/logs/probe.cnt")"
}

# byte_run <td> <args...> — captures the private-nav NUL stream to
# $FIX/nav-out.nul with the counting shims wired in
byte_run() {
  local td="$1"; shift
  PATH="$FIX/bin:$PATH" TMPDIR="$td" LC_ALL=C \
    XTMUX_NAV_PERF_TMUXLOG="$FIX/logs/tmux" XTMUX_NAV_PERF_TMUXCNT="$FIX/logs/tmux.cnt" \
    XTMUX_NAV_PERF_GITLOG="$FIX/logs/git" XTMUX_NAV_PERF_GITCNT="$FIX/logs/git.cnt" \
    XTMUX_NAV_PERF_PROBELOG="$FIX/logs/probe" XTMUX_NAV_PERF_PROBECNT="$FIX/logs/probe.cnt" \
    XTMUX_NAV_PERF_REALGIT="$REAL_GIT" \
    XTMUX_NAV_PERF_SESS="$FIX/tmux-sessions" \
    XTMUX_NAV_PERF_PANES="$FIX/tmux-panes" \
    "$PICKER" "$@" > "$FIX/nav-out.nul" 2>/dev/null
}

bytes_of() { # bytes_of <nav-file> -> prints "total records maxrec session window pane"
  python3 - "$1" <<'PY'
import sys
data = open(sys.argv[1], 'rb').read()
recs = data.split(b'\0')
n = len(recs) - 1 if data.endswith(b'\0') else len([r for r in recs if r])
maxr = max((len(r) for r in recs if r), default=0)
types = {}
for r in recs:
    if not r:
        continue
    t = r.split(b'\t', 1)[0].decode('utf-8', 'replace')
    types[t] = types.get(t, 0) + 1
print(len(data), n, maxr, types.get('session', 0), types.get('window', 0), types.get('pane', 0))
PY
}

sample() { # sample <label> <tmpdir> <n> <args...> -> latency samples + counts
  local label="$1" td="$2" n="$3"; shift 3
  local -a samples=()
  local i ms
  for i in $(seq 1 "$n"); do
    run_one "$FIX/logs/last.out" "$td" "$@"
    ms="$REPLY"
    samples+=("$ms")
  done
  # counts from the final (representative) run of the sample
  printf '%-22s %s ms  [%s]  %s\n' "$label" "$(IFS=,; echo "${samples[*]}")" "$(counts)" "${*}"
}

echo "== NAV-T7 perf fixture (NAV-T0 method, same §29 inventory) =="
echo "fixture: 1 session / 2 windows / 4 panes ; repo=$REPO"
echo "loadavg: $(cut -d' ' -f1-3 /proc/loadavg) (cores: $(nproc))"
[ -n "${XTMUX_NAV_PERF_PIN:-}" ] && echo "pinned: cpu$XTMUX_NAV_PERF_PIN (taskset -c $XTMUX_NAV_PERF_PIN)"

# ---------------- variant A: collapsed (baseline-comparable) ----------------
emit_rows A
echo
echo "== variant A (collapsed cwds -> one distinct git root; = NAV-T0 §8.1) =="
echo "(commands: list-nav all expanded | list-nav all sessions-only |"
echo " list-nav-single all expanded | list-active-nav all expanded)"
echo

TMPA1="$(mktemp -d "${TMPDIR:-/tmp}/xtmux-nav-perf-cold.XXXXXX")"
TMPA2="$(mktemp -d "${TMPDIR:-/tmp}/xtmux-nav-perf-warm.XXXXXX")"
seed_state "$TMPA2"
seed_state "$TMPA1"

echo "--- latency (cold: fresh TMPDIR + TMUX_PICKER_NO_CACHE=1) ---"
: > "$FIX/logs/tmux"
for i in 1 2 3; do
  td="$(mktemp -d "${TMPDIR:-/tmp}/xtmux-nav-perf-cold.XXXXXX")"
  run_one "$FIX/logs/last.out" "$td" list-nav all expanded
  samples+=("$REPLY"); echo "cold list/nav          sample $i: ${REPLY} ms  [$(counts)]"
done
unset samples

export TMUX_PICKER_NO_CACHE=0
echo "--- latency (warm: cache primed, same TMPDIR, TTL valid) ---"
td2="$TMPA2"
# prime each warm op so the TTL is fresh, then sample
for op in "list-nav all expanded|warm nav" "list-active-nav all expanded|forced refresh" "list-nav all sessions-only|compact (toggle from)" "list-nav all expanded|expanded (toggle to)"; do
  cmd="${op%%|*}"; label="${op##*|}"
  run_one "$FIX/logs/last.out" "$td2" $cmd >/dev/null   # prime
  : > "$FIX/logs/git"  # reuse same TMPDIR after prime; reset git counter
  for i in 1 2 3; do
    run_one "$FIX/logs/last.out" "$td2" $cmd
    echo "warm ${label} sample $i: ${REPLY} ms  [$(counts)]"
  done
done

echo "--- warm control: same-load pre-epic analog (public TSV, same inventory) ---"
for i in 1 2 3; do
  run_one "$FIX/logs/last.out" "$td2" list all expanded
  echo "warm control (list) sample $i: ${REPLY} ms  [$(counts)]"
done

echo "--- cold one-line fallback (nav single) ---"
for i in 1 2 3; do
  td="$(mktemp -d "${TMPDIR:-/tmp}/xtmux-nav-perf-cold.XXXXXX")"
  TMUX_PICKER_NO_CACHE=1 run_one "$FIX/logs/last.out" "$td" list-nav-single all expanded
  echo "cold single sample $i: ${REPLY} ms  [$(counts)]"
done

echo
echo "--- subprocess call logs (structural gate) ---"
emit_rows A
td="$(mktemp -d "${TMPDIR:-/tmp}/xtmux-nav-perf-cold.XXXXXX")"
TMUX_PICKER_NO_CACHE=1 run_one "$FIX/logs/last.out" "$td" list-nav all expanded
echo "cold list-nav:"
sed 's/^/  tmux| /' "$FIX/logs/tmux"
sed 's/^/  git | /' "$FIX/logs/git"
[ -s "$FIX/logs/probe" ] && { echo "  PROBES (must be empty):"; cat "$FIX/logs/probe"; } \
  || echo "  process-tree probes: none"

# warm counts across every op (TTL is short; re-prime then sample once)
for op in "list-nav all expanded" "list-active-nav all expanded" "list-nav all sessions-only" "list-nav-single all expanded"; do
  run_one "$FIX/logs/last.out" "$td2" $op >/dev/null
done
echo "warm combined ops (4):"

echo "--- RSS (pick one cold list-nav, /proc VmRSS poll, NAV-T0 method) ---"
td="$(mktemp -d "${TMPDIR:-/tmp}/xtmux-nav-perf-cold.XXXXXX")"
: > "$FIX/logs/tmux"; : > "$FIX/logs/git"; : > "$FIX/logs/probe"
: > "$FIX/logs/tmux.cnt"; : > "$FIX/logs/git.cnt"; : > "$FIX/logs/probe.cnt"
PATH="$FIX/bin:$PATH" TMPDIR="$td" LC_ALL=C TMUX_PICKER_NO_CACHE=1 \
  XTMUX_NAV_PERF_TMUXLOG="$FIX/logs/tmux" XTMUX_NAV_PERF_TMUXCNT="$FIX/logs/tmux.cnt" \
  XTMUX_NAV_PERF_GITLOG="$FIX/logs/git" XTMUX_NAV_PERF_GITCNT="$FIX/logs/git.cnt" \
  XTMUX_NAV_PERF_PROBELOG="$FIX/logs/probe" XTMUX_NAV_PERF_PROBECNT="$FIX/logs/probe.cnt" \
  XTMUX_NAV_PERF_REALGIT="$REAL_GIT" \
  XTMUX_NAV_PERF_SESS="$FIX/tmux-sessions" \
  XTMUX_NAV_PERF_PANES="$FIX/tmux-panes" \
  "$PICKER" list-nav all expanded > "$FIX/logs/rss.out" 2>/dev/null &
_rss_pid=$!
_rss_max=0
while kill -0 "$_rss_pid" 2>/dev/null; do
  _v="$(awk '/^VmRSS:/{print $2}' "/proc/$_rss_pid/status" 2>/dev/null || true)"
  [ -n "$_v" ] && [ "$_v" -gt "$_rss_max" ] && _rss_max=$_v
  sleep 0.005
done
wait "$_rss_pid"
echo "RSS (max sampled): ${_rss_max} kB   [$(counts)]"

echo
echo "--- emitted private-nav bytes (NUL-delimited nav projection) ---"
# warm, fixture A (same as NAV-T0 byte measurement)
td="$(mktemp -d "${TMPDIR:-/tmp}/xtmux-nav-perf-warm.XXXXXX")"
seed_state "$td"
run_one "$FIX/logs/last.out" "$td" list-nav all expanded  >/dev/null
byte_run "$td" list-nav all expanded
echo "expanded A: $(bytes_of "$FIX/nav-out.nul")  (total records maxrec session window pane)"
# determinism: second capture must be byte-identical
byte_run "$td" list-nav all expanded
cp "$FIX/nav-out.nul" "$FIX/nav-out2.nul"
if cmp -s "$FIX/nav-out.nul" "$FIX/nav-out2.nul"; then
  echo "determinism: two cold-identical warm captures byte-identical"
else
  echo "DETERMINISM FAIL: byte captures differ"
fi
byte_run "$td" list-nav all sessions-only
echo "compact  A: $(bytes_of "$FIX/nav-out.nul")  (total records maxrec session window pane)"
byte_run "$td" list-nav-single all expanded
echo "single   A: $(bytes_of "$FIX/nav-out.nul")  (total records maxrec session window pane)"

# ---------------- variant B: verbatim §29 corpus (contract-test rows) -------
emit_rows B
echo
echo "== variant B (verbatim §29 inventory blocks, subdir cwds) =="
td="$(mktemp -d "${TMPDIR:-/tmp}/xtmux-nav-perf-warm.XXXXXX")"
seed_state "$td"
byte_run "$td" list-nav all expanded
echo "expanded B: $(bytes_of "$FIX/nav-out.nul")  (total records maxrec session window pane)"
byte_run "$td" list-nav all sessions-only
echo "compact  B: $(bytes_of "$FIX/nav-out.nul")  (total records maxrec session window pane)"
run_one "$FIX/logs/last.out" "$td" list-nav all expanded >/dev/null
echo "warm counts B (list-nav):  $(counts)"
td="$(mktemp -d "${TMPDIR:-/tmp}/xtmux-nav-perf-cold.XXXXXX")"
TMUX_PICKER_NO_CACHE=1 run_one "$FIX/logs/last.out" "$td" list-nav all expanded >/dev/null
echo "cold counts B (list-nav):  $(counts)"
sed 's/^/  git | /' "$FIX/logs/git"

echo
echo "measurement commands (NAV-T9 re-run):"
echo "  bash $0   (this script)"
echo "  cold    : PATH=$FIX/bin:\$PATH TMPDIR=<fresh> TMUX_PICKER_NO_CACHE=1 $PICKER list-nav all expanded"
echo "  warm    : same, TMPDIR reused + cache primed (TTL ${TMUX_PICKER_GIT_CACHE_TTL:-30}s)"
echo "  bytes   : capture stdout of list-nav/list-nav-single; NUL-delimited records"