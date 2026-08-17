# feat(nav): session → window → pane topology-correct sidebar + pane location (xtmux-w5i)

## What this changes

The nav picker now models the real tmux topology as three first-class navigation levels:

```
session $N
  └─ window @N
       └─ pane %N
```

instead of the previous flattened `session → pane` model. This is the bounded follow-up
to the existing nav implementation — no runtime redesign, no fzf replacement, no new
persistence authority.

## Summary of changes

- **Machine identity per level**, stable and action-safe:
  - session `s:$N`, window `w:$N:@N`, pane `p:$N:%N`
  - `parse_nav_token` accepts exactly those three forms and rejects
    `w:@17`, `w:$42:coord`, `w:$42:0`, `w:program:@17`, `w:$42:@x` and any
    malformed/control-char variants. Display text never enters the validation path.
- **Live ownership revalidation** before any mutation/navigation: a window token is
  resolved against live tmux, its owning session is compared to the encoded one, and a
  stale/cross-session token fails safely (nil effect).
- **Renderer**: compact mode emits session rows only; expanded mode emits
  session → window → pane. `Tab` toggles compact ↔ expanded topology (not merely pane
  visibility). Window rows: `@17 0:coord  run · 2` — `@window-id` always intact,
  `index:name` truncatable, aggregate state, pane count. Windows are independently
  selectable (go / rename / kill); pane-only actions on a window row emit a bounded
  non-error message instead of guessing.
- **Pane location** is a first-class second line in expanded mode:
  `market-data · docs/research` (repo root → repo; inside repo → `repo · relative`;
  worktree → canonical repo label; no repo → shortened `~/…` path), reusing the
  existing path→git-root cache with zero new git/tmux subprocesses. Full absolute paths
  remain details-only behind `Ctrl-/`.
- **Bounded records (hard requirement of this work)**: per-type visual line budgets
  (session ≤3, window ≤2, pane ≤2) and an explicit record byte bound
  (`NAV_MAX_RECORD_BYTES=4096` + char guard). Pathological KB-size metadata cannot
  create unbounded rows or memory growth; overflow stays available in details.
- **Attention aggregation** through one canonical priority function
  (stale > needs-input > done > running > idle) folded pane → window → session.
- **Current location model**: current pane/window/session markers derived from
  `$TMUX_PANE` through the enumerated inventory (marks only the current rows, never
  inferred from rendered text, independent of fzf selection and running state).
- **Direct navigation**: `nav window-next` / `nav window-prev` invoke the native tmux
  `next-window` / `previous-window` (verified on tmux 3.5a) — no fzf, no git, no
  inventory. `nav back` still returns to the exact previous `%pane-id`.
- **Public surface unchanged**: `list` TSV stays five-field/window-free;
  `topology --json` remains the full structured authority (reused, not redefined).
- **Hot path unchanged structurally**: one bulk `tmux list-panes -a` inventory →
  derive sessions/windows/panes → aggregate → render. Measured tmux subprocess count
  stays 2, warm git stays 0, process-tree probes 0; private-nav bytes stay bounded
  (expanded 1362 B total, max record 227 B on the §29 fixture, bound 4096 B).

## Tests

- `test/nav-contract.sh`: **265 pass / 0 fail** — §29 fixture (aggregation + expanded
  order + compact), §30 machine-id/hostile-char matrix, §31 location, §32 bounded
  records with KB-size pathological metadata, §33 current-location markers, §34
  direct-nav (no fzf/git/preview/renderer). Suite is in the required CI gate
  (`scripts/verify-json-api.sh` run_check `nav-contracts`, and the package.json test
  chain).
- `test/contract.sh`: **292 pass / 0 fail**.
- Full gates: `bash -n`, `bun run typecheck`, `bun run build`, `scripts/verify-json-api.sh`
  (incl. bun test) all green. One full-suite bun run showed load-timeout flakiness
  under host loadavg 50–103 in files untouched by this diff; A/B against clean
  origin/main (451 pass / 0 fail on the same host) and isolated re-runs confirm it is
  environmental, not a regression (details in the pre-PR report).

## Checkpoint

Full §40 pre-PR checkpoint: `.xtrm/reports/2026-08-17-nav-topology-pre-pr.md`
Perf before/after: `.xtrm/reports/2026-08-17-nav-topology-perf.md` (+ baseline and
renderer-after reports).

## Known limitations

- Absolute latency medians were measured under heavy host load; NAV-T7 records the
  method for a quiet-load re-run (structural/byte gates are unaffected).
- The bare `p:%N` shorthand is retained intentionally for the classic bulk-kill path
  (it claims no session; live ownership is the authority).
- The visible attention group label is `urgent`, deliberately narrower than the
  authoritative `attention-next` traversal set (documented §14 option B).

## Merge policy

**This PR is intentionally NOT merged.** The external/web coordinator reviews the
complete PR before merge, per the defining prompt.