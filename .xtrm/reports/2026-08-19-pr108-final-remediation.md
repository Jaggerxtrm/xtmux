# PR #108 — final web-coordinator remediation evidence

Date: 2026-08-19
Integration code head before this evidence-only commit: `dfdfe278ee29d263effeb6d442de0af909657411`
PR: #108
State: OPEN / intentionally unmerged

## P1 — valid non-current pane occurrence validation

The nav action path no longer constructs `session:%pane` to validate `p:$sid:%pane`.
That target form is ambiguous in tmux because `%pane` is parsed in the window
position and may fall back to the session's current pane.

The final resolver performs one action-time, session-scoped membership read:

```sh
tmux list-panes -s -t "$encoded" -F '#{pane_id}'
```

and requires an exact `%pane_id` row. This accepts a valid non-current pane and
each real linked-window occurrence while rejecting foreign/stale claims. It is
not part of the picker hot path.

`test/nav-real-tmux.sh` now makes the linked `%P` valid but non-current in
session A before TEST D validates and jumps it, so the regression fails under
the retired `session:%pane` strategy.

## P1 — fuzzy ancestry without per-keystroke live rebuilds

On initial nav open, xtmux performs the ordinary live `list-active-nav` (or
`list-active-nav-single`) projection once. From those exact NUL records it
derives a second ancestry-preserving snapshot in-process. Fields 1–5 remain
byte-identical; only display field 6 gains the session/window ancestor cards.

fzf `change` now reloads from the two local snapshot files through
`nav-snapshot-view`: empty query -> flat browse tree; non-empty query -> ancestry
projection. The per-query path performs no tmux/git/fzf inventory work.

Explicit refresh, structured filter, topology-mode change, and mutating actions
use `nav-snapshot-refresh`: rebuild one fresh flat live snapshot, derive ancestry
from those same bytes, replace both snapshot files, and emit the correct view.

`test/nav-contract.sh` proves the snapshot projection is byte-identical to the
existing ancestry-chain semantics and that the per-keystroke snapshot command
performs zero tmux/git calls.

## Documentation/performance reconciliation

- fzf borderless chrome reserve documented as 4 cells, matching implementation.
- fzf selection pointer documented as `>`, matching launcher configuration.
- pane location wording reconciled to filesystem-style `repo/path`.
- performance audit now records the finalized one-line fixture numbers:
  1420 B / 7 records / 226 B max record, with normal live refresh at 3 tmux
  calls, warm git 0, process probes 0; ordinary query changes are 0 tmux / 0 git
  / 0 process probes.

## Cleanup

Temporary web-coordinator workflow files, trigger files, and patch script were
removed before the integration commit. `.github/workflows/ci.yml` is restored to
the repository's normal two-job `test` + `smoke` definition.

## Gate

This evidence-only commit exists specifically to trigger the normal exact-head
GitHub checks after the action-authored integration commit (GitHub does not
recursively trigger workflows from a `GITHUB_TOKEN` push). Do not infer final
approval from this document alone; the PR body/review comment is updated only
after the exact-head standard checks complete.
