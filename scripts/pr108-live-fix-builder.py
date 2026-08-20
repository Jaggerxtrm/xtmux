#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one replacement, found {count}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


def append_once(path: str, text: str) -> None:
    target = Path(path)
    current = target.read_text(encoding="utf-8")
    if text.strip() in current:
        return
    if current and not current.endswith("\n"):
        current += "\n"
    target.write_text(current + text, encoding="utf-8")


# Runtime: ordinary fzf query changes must rebuild live rendered state.
replace_once(
    "bin/tmux-session-picker",
    '''# Per-keystroke path: local file read only. Query text selects flat vs
# ancestry snapshot and never reaches tmux/git/eval.
nav_snapshot_view() {
  local flat="${1:-}" chain="${2:-}" query="${3:-}"
  nav_snapshot_path_ok "$flat" || return 1
  nav_snapshot_path_ok "$chain" || return 1
  if [ -n "$query" ]; then cat -- "$chain"; else cat -- "$flat"; fi
}
''',
    '''# Query projection. The fzf change path uses --live so rendered rows, agent
# state, attention order, and waiting/running membership are rebuilt from tmux
# for every query change. File mode remains the atomic handoff used by explicit
# refresh and deterministic projection tests; it is not the interactive query
# path.
nav_snapshot_view() {
  if [ "${1:-}" = '--live' ]; then
    local lines="${2:-}" query="${3:-}" spec list_mode projection=flat
    case "$lines" in single|multi) ;; *) return 2 ;; esac
    picker_state_read filter || true
    spec="$REPLY"
    read_list_mode; list_mode="$REPLY"
    [ -n "$query" ] && projection=chain
    build_list "$spec" "$list_mode" nav "$lines" "$projection"
    return
  fi

  local flat="${1:-}" chain="${2:-}" query="${3:-}"
  nav_snapshot_path_ok "$flat" || return 1
  nav_snapshot_path_ok "$chain" || return 1
  if [ -n "$query" ]; then cat -- "$chain"; else cat -- "$flat"; fi
}
''',
)

replace_once(
    "bin/tmux-session-picker",
    '''    # Initial open performs one ordinary live projection. Query changes below
    # never return to live inventory; they switch between local snapshots.
''',
    '''    # Initial open is one live projection. Every query change below enters the
    # live projection again; only expensive near-static git metadata may reuse
    # its cache. Explicit refresh/filter/mode actions still replace both handoff
    # files atomically for deterministic highlight tracking.
''',
)

replace_once(
    "bin/tmux-session-picker",
    '''    lchain="$self_q nav-snapshot-view $flat_q $chain_q '{q}'"
''',
    '''    lchain="$self_q nav-snapshot-view --live $lines '{q}'"
''',
)

replace_once(
    "bin/tmux-session-picker",
    '''  nav-snapshot-view)
  shift
  [ "$#" -eq 3 ] || die_usage "nav-snapshot-view requires <flat> <chain> <query>"
  nav_snapshot_view "$@"
  exit $?
  ;;
nav-snapshot-refresh)
  shift
  [ "$#" -eq 5 ] || die_usage "nav-snapshot-refresh requires <flat> <chain> <single|multi> <active|all|waiting|running> <query>"
  nav_snapshot_refresh "$@"
  exit $?
  ;;
''',
    '''  nav-snapshot-view)
    shift
    case "${1:-}" in
      --live) [ "$#" -eq 3 ] || die_usage "nav-snapshot-view --live requires <single|multi> <query>" ;;
      *) [ "$#" -eq 3 ] || die_usage "nav-snapshot-view requires <flat> <chain> <query>" ;;
    esac
    nav_snapshot_view "$@"
    exit $?
    ;;
  nav-snapshot-refresh)
    shift
    [ "$#" -eq 5 ] || die_usage "nav-snapshot-refresh requires <flat> <chain> <single|multi> <active|all|waiting|running> <query>"
    nav_snapshot_refresh "$@"
    exit $?
    ;;
''',
)

# Contracts: assert the live runtime path, preserve the local atomic helper test,
# and prove a state transition is visible between consecutive query reloads.
replace_once(
    "test/nav-contract.sh",
    '''# §36 wiring: ordinary typing switches between prebuilt local snapshots.
# No query character may invoke list-active-nav-chain/build_list.
if grep -qF "change:reload-sync(" "$WORK/nav-fzf-args" \
  && grep -qF "nav-snapshot-view" "$WORK/nav-fzf-args" \
  && ! grep -qF "list-active-nav-chain '{q}'" "$WORK/nav-fzf-args"; then
  ok "nav chrome: query change reads local ancestry snapshot (no live rebuild)"
else
  nok "nav chrome: query change is not snapshot-backed"
fi
''',
    '''# §36 wiring: ordinary typing uses the explicit live query projection.
# The snapshot helper remains only for the atomic explicit-refresh handoff.
if grep -qF "change:reload-sync(" "$WORK/nav-fzf-args" \
  && grep -qF "nav-snapshot-view --live multi '{q}'" "$WORK/nav-fzf-args" \
  && ! grep -qF "list-active-nav-chain '{q}'" "$WORK/nav-fzf-args"; then
  ok "nav chrome: query change rebuilds live ancestry (no rendered-state cache)"
else
  nok "nav chrome: query change is not wired to the live projection"
fi
''',
)

replace_once(
    "test/nav-contract.sh",
    '''if grep -qF "nav-snapshot-view" "$WORK/nav-fzf-args-oneline" \
  && ! grep -qF "list-active-nav-single-chain '{q}'" "$WORK/nav-fzf-args-oneline"; then
  ok "nav chrome: oneline fallback also uses the local snapshot source"
else
  nok "nav chrome: oneline fallback is not snapshot-backed"
fi
''',
    '''if grep -qF "nav-snapshot-view --live single '{q}'" "$WORK/nav-fzf-args-oneline" \
  && ! grep -qF "list-active-nav-single-chain '{q}'" "$WORK/nav-fzf-args-oneline"; then
  ok "nav chrome: oneline fallback also uses the live query projection"
else
  nok "nav chrome: oneline fallback is not wired to the live projection"
fi
''',
)

replace_once(
    "test/nav-contract.sh",
    '''if [ ! -s "$WORK/s36-snapshot-calls" ] && cmp -s "$WORK/s36-snapshot-query" "$WORK/s36-snapshot-chain"; then
  ok "§36: per-keystroke snapshot view performs zero tmux/git calls"
else
  nok "§36: per-keystroke snapshot view touched live state ($(tr '\\n' ';' < "$WORK/s36-snapshot-calls"))"
fi
''',
    '''if [ ! -s "$WORK/s36-snapshot-calls" ] && cmp -s "$WORK/s36-snapshot-query" "$WORK/s36-snapshot-chain"; then
  ok "§36: atomic snapshot handoff reads local files without tmux/git calls"
else
  nok "§36: atomic snapshot handoff touched live state ($(tr '\\n' ';' < "$WORK/s36-snapshot-calls"))"
fi
''',
)

replace_once(
    "test/nav-contract.sh",
    '''cat > "$WORK/bin-chain/tmux" <<'CHAINSIM'
#!/usr/bin/env bash
case "$1" in
  list-sessions) printf '%b\\n' '$42\\talpha\\t%17\\t/a\\t1000' '$43\\tbeta\\t%18\\t/b\\t1000' ;;
  list-panes) printf '%b\\n' \\
    '$42\\t@17\\t0\\tcoord\\t0\\t%553\\t0\\t1\\tclaude\\t/a\\t-\\t553\\t-\\t-\\t-\\t-' \\
    '$42\\t@31\\t1\\tresearch\\t0\\t%875\\t0\\t1\\tpi\\t/a\\t-\\t875\\t-\\t-\\t-\\t-' \\
    '$43\\t@31\\t1\\tresearch\\t0\\t%875\\t0\\t1\\tpi\\t/a\\t-\\t875\\t-\\t-\\t-\\t-' ;;
  display-message) printf '$42\\n' ;;
esac
exit 0
CHAINSIM
''',
    '''cat > "$WORK/bin-chain/tmux" <<'CHAINSIM'
#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${XTMUX_TMUX_LOG:-/dev/null}"
case "$1" in
  list-sessions) printf '%b\\n' '$42\\talpha\\t%17\\t/a\\t1000' '$43\\tbeta\\t%18\\t/b\\t1000' ;;
  list-panes)
    state="${XTMUX_LIVE_STATE:--}"
    printf '%b\\n' \\
      '$42\\t@17\\t0\\tcoord\\t0\\t%553\\t0\\t1\\tclaude\\t/a\\t-\\t553\\t-\\t-\\t-\\t-' \\
      '$42\\t@31\\t1\\tresearch\\t0\\t%875\\t0\\t1\\tpi\\t/a\\t'"$state"'\\t875\\t-\\t-\\t-\\t-' \\
      '$43\\t@31\\t1\\tresearch\\t0\\t%875\\t0\\t1\\tpi\\t/a\\t'"$state"'\\t875\\t-\\t-\\t-\\t-'
    ;;
  display-message) printf '$42\\n' ;;
esac
exit 0
CHAINSIM
''',
)

replace_once(
    "test/nav-contract.sh",
    '''# real fuzzy-query behavior: feed chain records to fzf --filter and prove the
''',
    '''# Live query regression: two consecutive change projections must observe a
# pane-state transition. Each attached-client reload retains the bounded
# three-call topology shape (list-sessions, list-panes, current-session query).
: > "$WORK/s36-live.calls"
TMPDIR="$_s36_tmp" PATH="$WORK/bin-chain:$PATH" TMUX_PANE='%553' \
  XTMUX_TMUX_LOG="$WORK/s36-live.calls" XTMUX_LIVE_STATE=running \
  "$PICKER" nav-snapshot-view --live multi '%875' > "$WORK/s36-live-running" 2>/dev/null
TMPDIR="$_s36_tmp" PATH="$WORK/bin-chain:$PATH" TMUX_PANE='%553' \
  XTMUX_TMUX_LOG="$WORK/s36-live.calls" XTMUX_LIVE_STATE=needs-input \
  "$PICKER" nav-snapshot-view --live multi '%875' > "$WORK/s36-live-wait" 2>/dev/null
_s36_live_running="$(_strip_nav_ansi "$(tr '\\0' '\\n' < "$WORK/s36-live-running")")"
_s36_live_wait="$(_strip_nav_ansi "$(tr '\\0' '\\n' < "$WORK/s36-live-wait")")"
_s36_live_run_seen=0; _s36_live_wait_seen=0
case "$_s36_live_running" in *run*) _s36_live_run_seen=1 ;; esac
case "$_s36_live_wait" in *wait*) _s36_live_wait_seen=1 ;; esac
_s36_live_calls="$(wc -l < "$WORK/s36-live.calls" | tr -d ' ')"
if [ "$_s36_live_run_seen" -eq 1 ] && [ "$_s36_live_wait_seen" -eq 1 ] \
  && [ "$_s36_live_calls" -eq 6 ] && ! cmp -s "$WORK/s36-live-running" "$WORK/s36-live-wait"; then
  ok "§36: query reload observes live agent-state changes (3 bounded tmux calls each)"
else
  nok "§36: live query freshness/call shape (run=$_s36_live_run_seen wait=$_s36_live_wait_seen calls=$_s36_live_calls)"
fi

# real fuzzy-query behavior: feed chain records to fzf --filter and prove the
''',
)

# Performance documentation must describe the shipped live-query behavior.
replace_once(
    "docs/perf-audit.md",
    '''A normal live refresh uses **3 tmux calls total**: the existing two bulk
inventory calls (`list-sessions`, `list-panes -a`) plus one bounded
client-scoped `display-message` used only to place the occurrence-correct
current marker; warm git remains 0 and process probes remain 0. Ordinary
fzf query changes execute **0 tmux / 0 git / 0 process-probe calls**: the
launcher derives one ancestry projection from the initial flat snapshot
and switches between the two local NUL files until an explicit refresh,
filter/mode change, or mutating action asks for fresh live state.
''',
    '''A normal live projection uses **3 tmux calls total**: the existing two bulk
inventory calls (`list-sessions`, `list-panes -a`) plus one bounded
client-scoped `display-message` used only to place the occurrence-correct
current marker. Ordinary fzf query changes use that same fixed-cost live
projection: **3 tmux / 0 warm git / 0 process-probe calls per reload**. This
deliberately rereads pane options and current client location so badges,
attention ordering, and waiting/running membership cannot stale while the
operator types. An active query changes only the ancestry presentation; fields
1–5 remain byte-identical.
''',
)

# ADR parity: topology scope, occurrence validation, command family, and width.
replace_once(
    "docs/design/adr/adr001-xtmux-nav.md",
    "**Decision scope:** local tmux session/pane navigation and picker presentation",
    "**Decision scope:** local tmux session/window/pane navigation and picker presentation",
)

replace_once(
    "docs/design/adr/adr001-xtmux-nav.md",
    '''(`s:$N`, `w:$N:@N`, `p:$N:%N`) and revalidates ownership against live tmux
before mutation (window → its live owning session; pane → its live session).
''',
    '''(`s:$N`, `w:$N:@N`, `p:$N:%N`) and revalidates the encoded occurrence
against live tmux before mutation (the encoded session must contain the exact
`@window` or `%pane` occurrence).
''',
)

replace_once(
    "docs/design/adr/adr001-xtmux-nav.md",
    '''xtmux nav next
xtmux nav prev
xtmux nav attention-next
''',
    '''xtmux nav next
xtmux nav prev
xtmux nav window-next
xtmux nav window-prev
xtmux nav attention-next
''',
)

replace_once(
    "docs/design/adr/adr001-xtmux-nav.md",
    '''`next` and `prev` wrap native tmux session order.

`attention-next` and `attention-prev` cycle the existing xtmux attention ordering.
''',
    '''`next` and `prev` wrap native tmux session order.

`window-next` and `window-prev` wrap native tmux window order within the invoking
client's current session.

`attention-next` and `attention-prev` cycle the existing xtmux attention ordering.
''',
)

replace_once(
    "docs/design/adr/adr001-xtmux-nav.md",
    "subtracts eight cells for fzf border/selection chrome before bounding rows.",
    "subtracts four cells for borderless fzf selection chrome before bounding rows.",
)

# Repository hygiene.
append_once(
    ".gitignore",
    '''
# bv (beads viewer) local config and caches
.bv/
''',
)
for obsolete in (
    ".xtrm/pr108-final-ci-trigger",
    ".xtrm/pr108-sentinel.txt",
):
    Path(obsolete).unlink(missing_ok=True)

print("pr108 live-query patch applied")
