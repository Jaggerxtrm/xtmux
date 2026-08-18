# feat(nav): session → window → pane topology-correct sidebar + pane location

**Head:** `<final head on xt/xjif — see PR #108>` (branch `xt/xjif`)
**Base:** `main` · **CI:** analyze, smoke, test, CodeQL, pr-review-gate — green.

> **DO NOT MERGE — external/web coordinator final review.**

## What this changes

The nav picker now models tmux's real hierarchy as three first-class navigation
levels:

```
session $N
  ↳ window @N
      ↳ pane %N
```

replacing the earlier flattened `session → pane` model. This is the bounded
follow-up to the existing nav implementation — no runtime redesign, no fzf
replacement, no new persistence authority.

## Identity: stable objects vs structural occurrences

Two distinct notions of identity:

- **Stable tmux object identity**: session `$N`, window `@N`, pane `%N` —
  operator-visible, stable where tmux guarantees them.
- **Structural occurrence identity** (used for linked windows): a window linked
  into more than one session participates in more than one occurrence.

```
session occurrence       $sid
window occurrence        $sid | @wid
pane occurrence          $sid | @wid | %pid
```

A window `@W` linked into sessions A and B is modeled as two independent
occurrences `$A|@W` and `$B|@W`, each with its own per-session index, name,
pane count, and children — never globally deduped by `%pane`/`@window`. Hidden
action tokens carry the occurrence: `s:$N`, `w:$sid:@wid`, `p:$sid:%pid`.
`parse_nav_token` accepts exactly those forms and rejects `w:@17`, `w:$42:coord`,
`w:$42:0`, `w:program:@17`, `w:$42:@x`, trailing/control text. Display text
never enters the validation or routing path.

## Current location is client-aware and occurrence-correct

`current_session` comes from the invoking client's actual session; `current_pane`
is `$TMUX_PANE` validated against the occurrence inventory; `current_window` is
the occurrence containing that pane inside that session. For a linked window,
the current marker follows the attached client's session (A vs B), not first
inventory match — via a single bounded client-scoped query (explicitly allowed
by review). Display/fzf state is never location truth.

## Cross-session navigation moves the invoking client

`nav-go w:$B:@W` validates `$B` exists and contains the `@W` occurrence, records
the client's exact current `$session:%pane`, then `switch-client` to `$B` and
selects the exact `@W`. `nav back` restores the exact prior session and pane.

## One-line pane contract

`NAV_PANE_LINES=1`: every pane renders on exactly ONE bounded visual line with
the filesystem-style location inline. Width priority: `%pane-id` > runtime >
exact state > repo/path > task. Task yields first; then location; `%pane-id`,
runtime and exact state always survive. No continuation lines.

## Filesystem-style location

`/work/market-data` → `market-data`; `/work/market-data/docs` →
`market-data/docs`; deep paths middle-elided `market-data/…/jct5k/regression`;
linked worktree root/bin → canonical repo label; non-git under `$HOME` →
`~/…`. Full absolute cwd is details-inspector-only. No new git subprocess on
the hot path.

## Hierarchy and palette

- Single `↳` ancestry glyph for all window and pane rows, invariant to sibling
  position (no `├ └ ▸ ●`). Session keeps `▎` for current.
- Restrained professional palette: neutral primary; one desaturated cool accent
  for current/focus/pointer; one desaturated amber attention for
  wait/needs-input/stale/urgent; restrained red only for hard failure.
  `run`/`done`/`idle` are neutral (NO rainbow / green/blue lifecycle coloring);
  no bold.

## Real isolated tmux regressions (hermetic, required CI gate)

`test/nav-real-tmux.sh` (24 pass, 0 fail) on an isolated `tmux -L` server with a
real attached client:
- **TEST A** cross-session window go/back: client A→B→`@W`, then `nav back` to
  exact original pane.
- **TEST B** linked window: same `@W`/`%P` render as both `A|@W|%P` and
  `B|@W|%P`, per-session index/count/placement, both occurrences action-valid,
  foreign pair rejected.
- **TEST C** current occurrence follows the attached client (flips A↔B for one
  linked window; fails under first-match location).

## Contract/gates

- `test/nav-contract.sh` — **292 pass / 0 fail**
- `test/contract.sh` — **292 pass / 0 fail**
- `bun test` — **451 pass / 0 fail**
- `typecheck`, `build`, `scripts/verify-json-api.sh`, `git diff --check` — green
- bash -n clean against `bin/tmux-session-picker` and every test file

## Performance (hermetic §29 fixture, finalized head)

Expanded private-nav: **1420 B total / 7 records / max record 226 B** (89 B
ANSI-stripped; 1 session + 2 windows + 4 panes, every pane one NUL record).
Subprocess counts: **tmux = 3** (2 bulk inventory: `list-sessions`,
`list-panes -a`; + 1 bounded client-scoped `display-message -p #{session_id}`
for occurrence-correct current location), **warm git = 0**, **process probes
= 0**. No per-window/session/pane fanout. Public `xtmux list` TSV and
`topology --json` unchanged.

## Retained invariants

tmux remains topology authority; fzf remains navigator; classic picker remains
a rollback path; no new daemon/database; bounded records enforced (session ≤3,
window ≤2, pane ==1 visual lines; pathological several-KB metadata stays
bounded, machine tokens intact).

---

> **DO NOT MERGE — external/web coordinator final review.**
