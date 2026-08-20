# feat(nav): session → window → pane topology-correct sidebar + pane location

> **DO NOT MERGE — external/web coordinator final review.**

This file is the durable source for PR #108's architectural summary. It deliberately does not hard-code a transient head SHA or CI status; use the live PR checks for exact-head gate state.

## What this changes

`xtmux nav` now models tmux's real hierarchy as first-class navigation entities:

```text
session $N
  ↳ window @N
      ↳ pane %N
```

Stable tmux object identities remain `$session`, `@window`, `%pane`. Structural occurrence identity is the hierarchy path, so a linked window/pane may appear under multiple sessions without being globally deduplicated. Private action tokens remain machine-only: `s:$N`, `w:$sid:@wid`, `p:$sid:%pid`; display text is never parsed for routing or mutation.

## Pane location

Expanded nav keeps `%pane-id` permanently visible and adds bounded filesystem context inline. A pane at a repo root renders the repo label; an in-repo cwd renders filesystem-style `repo/path` with deep middles elided; worktrees use the canonical parent-repo label; non-git paths become bounded `~/…` or trailing-path projections. Full absolute cwd remains details-only.

Pane rows are exactly one visual line (`NAV_PANE_LINES=1`). Width priority is `%pane-id` > runtime > exact state > repo/path > task. Records remain explicitly bounded.

## Topology and current location

The picker derives session → window → pane topology from the existing bulk pane inventory. Linked windows are modeled as `$sid|@wid` occurrences and pane placement as `$sid|@wid|%pid`. Current session/window/pane follows the invoking client's actual session plus `$TMUX_PANE`, not first enumeration order or display state.

State aggregates through one canonical priority: pane → window → session. Window rows show stable `@window-id`, truncatable `index:name`, aggregate state, and pane count. Compact mode emits sessions only; expanded mode emits session → window → pane.

## Navigation correctness

Cross-session window navigation validates the encoded `$sid/@wid` occurrence, records the exact previous pane, switches the invoking client to the target session, and selects the exact window. `nav back` restores the previous exact session+pane.

Pane occurrence validation does **not** construct `session:%pane`. That tmux target form is ambiguous because `%N` is parsed in the window position and may fall back to the session's current pane. For encoded `p:$sid:%pane`, action-time validation instead enumerates that session's panes once (`list-panes -s -t "$sid" -F '#{pane_id}'`) and requires exact `%pane_id` membership. This accepts valid non-current panes and linked occurrences while rejecting foreign/stale claims.

Direct `nav next|prev|window-next|window-prev|attention-next|attention-prev|back` remains outside the picker renderer. Window-next/window-prev use native tmux window traversal.

## Fuzzy ancestry without per-keystroke live rebuilds

Ordinary fzf filtering must not orphan a pane from its window/session. The final implementation solves this without rebuilding live tmux topology on every query character:

1. initial nav open builds one normal flat NUL-delimited live snapshot;
2. `nav_snapshot_project_stream` derives an ancestry-bearing snapshot from those same bytes, preserving fields 1–5 byte-for-byte and changing only display field 6;
3. fzf query changes use `nav-snapshot-view` to switch between the two local files — empty query → flat browse tree, non-empty query → ancestry projection;
4. explicit refresh, structured filters, topology-mode changes, and mutating actions use `nav-snapshot-refresh` to rebuild one fresh flat snapshot and derive its matching ancestry snapshot.

Therefore ordinary typing performs 0 tmux / 0 git / 0 process-probe inventory calls. Live state still refreshes on explicit state-changing/reload operations.

## Real tmux regressions

`test/nav-real-tmux.sh` is wired into the required `scripts/verify-json-api.sh` gate and covers:

- cross-session window go/back with a real attached client;
- linked-window occurrences with different per-session indices;
- current occurrence following the attached client;
- linked pane occurrences, including a valid pane deliberately made **non-current** before validation/jump, plus foreign occurrence rejection;
- real fzf filtering over the ancestry projection.

The deterministic nav contract also verifies snapshot identity preservation, bounded records, location projection, compact/expanded topology, machine-token safety, and zero tmux/git calls on the per-keystroke snapshot-view path.

## Performance contract

Final one-line fixture evidence recorded in `docs/perf-audit.md` and the final remediation report:

- expanded private nav: 1420 B total / 7 NUL records / 226 B max record (89 B ANSI-stripped max);
- normal live refresh: 3 tmux calls total (2 bulk inventory + 1 bounded client-session lookup), warm git 0, process probes 0;
- ordinary fzf query changes: 0 tmux / 0 git / 0 process probes;
- no per-session, per-window, or per-pane tmux/git fanout;
- public `xtmux list` TSV and `topology --json` contracts remain unchanged.

## CI robustness remediations retained in the branch

The workstream also root-caused three gate failures encountered while making the nav regressions required-CI quality:

- root workspace/lockfile wiring for `packages/xtmux-view` / `beautiful-mermaid`;
- cold-state `picker_state_read` guard for a missing state file under `set -e`;
- `TERM=xterm-256color` for the real attached tmux client on TERM-less CI runners.

These are regression-guarded. The live PR checks are authoritative for the current head.

## Retained boundaries

- tmux remains topology authority;
- fzf remains the v1 navigator;
- no new daemon/database or persistence authority;
- classic picker remains available as rollback;
- private nav transport stays separate from public list/JSON surfaces;
- machine identity never comes from rendered names, paths, tasks, window indexes, or fzf text.

> **DO NOT MERGE — external/web coordinator final review.**
