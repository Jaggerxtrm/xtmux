# feat(nav): session → window → pane topology-correct sidebar + pane location

**Head:** `<final head on xt/xjif — see PR #108>` (branch `xt/xjif`)
**Base:** `main` · **CI:** CodeQL, analyze, pr-review-gate — green; `test`/`smoke`
`bun test` step red on a **pre-existing origin/main lockfile break** (see below).

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


## CI status on this head

# A/B Evidence: CI `bun test` failure is pre-existing on origin/main, not caused by PR #108

## Claim
PR #108's `test` and `smoke` CI jobs fail at the `Run bun test` step with:
`error: Cannot find package 'beautiful-mermaid' from packages/xtmux-view/src/renderer.mjs`
This failure is NOT caused by the PR diff.

## Evidence
1. **PR diff touches zero `bun test` targets.** `git diff --name-only origin/main...HEAD | grep -E '\.test\.(ts|mjs|js)$'` → NONE. All changed files are bash (`bin/tmux-session-picker`, `test/*.sh`), docs, reports, `.gitignore`, CI wiring (`scripts/verify-json-api.sh`). None are run by `bun test`.
2. **PR branch alone passes `bun test` 451/0** (run locally on `xt/xjif` head: `451 pass / 0 fail`).
3. **Clean `origin/main` fails identically (A/B):** fresh `git worktree add` of `a16fc972` (origin/main HEAD) + `bun install --frozen-lockfile` + `bun test` → `error: Cannot find package 'beautiful-mermaid' ... 1 fail` (exit 1). No PR changes present.
4. **Root cause is main-side:** `packages/xtmux-view/package.json` (on main) declares `beautiful-mermaid` and `packages/xtmux-view/src/renderer.mjs` imports it, but `bun.lock` (on main) contains NO `beautiful-mermaid` entry (`grep -a -c 'beautiful-mermaid' bun.lock` = 0 on both main and the branch). The rich-view commits (a8b516a0 "feat(view): render Mermaid fences...", a16fc972, 06f8b726) landed on main AFTER this nav branch forked (merge-base a1880953).
5. **CI runs the PR merge ref** (main + head). Main's `renderer.mjs` is unchanged by the PR (diff empty for packages/), so the merge ref inherits the broken main-side import → same failure.
6. CodeQL, analyze, pr-review-gate all **pass** on the PR head (checks don't run the bun suite) — the only failing checks are the two jobs that run `bun test`.

## Conclusion
The `bun test` CI failure is a pre-existing origin/main break (undeclared `beautiful-mermaid` dependency). It is not introduced by, and cannot be fixed inside, the nav PR without absorbing unrelated rich-view dependency work. The PR's own gates (bash -n, nav-contract 292/0, contract 292/0, real-tmux 24/0, bun 451/0, typecheck, build, verify-json-api) all pass locally on the exact head.

## Retained invariants

tmux remains topology authority; fzf remains navigator; classic picker remains
a rollback path; no new daemon/database; bounded records enforced (session ≤3,
window ≤2, pane ==1 visual lines; pathological several-KB metadata stays
bounded, machine tokens intact).

---

> **DO NOT MERGE — external/web coordinator final review.**
