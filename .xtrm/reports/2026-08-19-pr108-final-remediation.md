# PR #108 — final web-coordinator remediation evidence

Date: 2026-08-20
Integration code head before this evidence-only commit: `d007c3a212cfa1f9705e2bb1ce4ddd16de7983fe`
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

`test/nav-real-tmux.sh` makes the linked `%P` valid but deliberately non-current
in session A before TEST D validates and jumps it, so the regression fails under
the retired `session:%pane` strategy.

## P1 — fuzzy ancestry without per-keystroke live rebuilds

On initial nav open, xtmux performs the ordinary live `list-active-nav` (or
`list-active-nav-single`) projection once. From those exact NUL records it
derives a second ancestry-preserving snapshot. Fields 1–5 remain byte-identical;
only display field 6 gains the session/window ancestor cards.

fzf `change` reloads from the two local snapshot files through
`nav-snapshot-view`: empty query -> flat browse tree; non-empty query -> ancestry
projection. The per-query path performs no tmux/git/process inventory work.

Explicit refresh, structured filter, topology-mode change, and mutating actions
use `nav-snapshot-refresh`: rebuild one fresh flat live snapshot, derive ancestry
from those same bytes, replace both snapshot files, and emit the correct view.

`test/nav-contract.sh` proves snapshot identity preservation and that the
per-keystroke snapshot-view path performs zero tmux/git calls.

## Final dispatch/help reconciliation

The snapshot refresh helper is an intentional picker-internal command. Its
initial dispatch arm was accidentally left at column 0, while the repository's
help-honesty contract recognizes top-level commands by the established two-space
case-arm convention. The implementation was therefore present but the contract
reported `nav-snapshot-refresh` as a documented phantom command.

The final code head normalizes both internal arms to the standard dispatch shape:

```text
  nav-snapshot-view)
    ...
    ;;
  nav-snapshot-refresh)
    ...
    ;;
```

No navigation semantics changed. The normal full gate is authoritative for the
resulting shell/help contract.

## Documentation/performance reconciliation

- fzf borderless chrome reserve is documented as 4 cells, matching implementation.
- fzf selection pointer is documented as `>`, matching launcher configuration.
- pane location wording is reconciled to filesystem-style `repo/path`.
- the final ADR carries the same values as README/keys/launcher.
- performance audit records the finalized one-line fixture numbers:
  1420 B / 7 records / 226 B max record (89 B ANSI-stripped max), with normal
  live refresh at 3 tmux calls, warm git 0, process probes 0; ordinary query
  changes are 0 tmux / 0 git / 0 process probes.

## Scope cleanup

- temporary coordinator trigger/sentinel files are absent;
- the temporary standalone `pr108-final-patch.yml` is absent;
- `.github/workflows/ci.yml` is restored to the repository's normal `test` +
  `smoke` definition;
- `.gitignore` and the pre-existing xtmux-view acceptance report match current
  `main` and are no longer reverse-diffs in this nav PR;
- the durable PR body source is `.xtrm/reports/2026-08-17-nav-topology-pr-body.md`
  and deliberately does not hard-code transient CI state.

## Gate protocol

This evidence-only commit exists specifically to trigger the normal exact-head
GitHub checks after the action-authored integration commit. GitHub does not
recursively trigger workflows from a `GITHUB_TOKEN` push.

Do not infer final merge approval from this document alone. The exact-head
`test`, `smoke`, CodeQL/analyze, and `pr-review-gate` checks are authoritative,
and PR #108 remains intentionally unmerged pending the final external review.
