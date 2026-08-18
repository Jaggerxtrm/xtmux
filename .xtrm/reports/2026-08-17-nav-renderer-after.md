# xtmux nav — NAV-T4 Renderer After-Measurement (epic xtmux-w5i)

Date: 2026-08-17 · Bead: `xtmux-w5i.5` (NAV-T4, IN_PROGRESS) · Branch `xt/xjif`
Companion to `.xtrm/reports/2026-08-17-nav-topology-baseline.md` (the `before`).

> FINAL-CONTRACT RECONCILIATION (xtmux-4ie.5): this report's emitted-byte and
> max-record figures were measured on the pre-final two-line renderer. The final
> renderer emits one-line panes (`NAV_PANE_LINES=1`) with the bounded filesystem
> location appended inline, single `↳` ancestry glyph, and occurrence-aware
> identity; the exact byte/record totals are PENDING re-measurement on the
> finalized head (<!-- filled by coordinator -->). The structural subprocess
> contract (2 tmux / 0 warm git / 0 probes) is unaffected.

## Fixture (§29, byte-identical to the baseline)

```
$42 program
├─ @17 0:coord        (%553 running, %621 idle)
└─ @31 1:research     (%875 needs-input, %901 running)
```

Pane cwds point at one real git repo (fresh `git init` + seed commit) so the warm
git-cache path is real; `tmux`/`git` counting shims on PATH; picker state/cache
isolated under a per-run `TMPDIR`.

## Emitted private-nav bytes + max record (the NAV-T7 `before` → `after` pair)

| Emitter | total bytes | max record | records | baseline (T0) |
|---|---|---|---|---|
| expanded multi | **1364** | **227** | 7 (1 session + 2 windows + 4 panes) | 905 / 190 / 5 |
| compact sessions-only | **150** | **149** | 1 (session only) | 191 / 190 / 1 |
| one-line fallback (single) | **1364** | **227** | 7 | 789 / 178 / 5 |

The delta vs T0 is the two NEW window rows + the bounded pane location
(§3/§15) — the feature itself, not unbounded growth. Record byte bound:
`NAV_MAX_RECORD_BYTES=4096`; max measured record 227 B on this fixture; the
pathological-metadata proof (3000-char session/window name, task, cwd) stays
bounded (≤ ~400 B per record and ≤ 2048 chars emission guard on the pre-final
renderer).

## Subprocess counts (counting shims, unchanged from T0)

| Path | tmux | git | process-tree probes |
|---|---|---|---|
| cold list-nav (cache empty) | 2 (`list-sessions`, `list-panes -a`) | 3 | 0 |
| warm list-nav (cache primed, TTL valid) | 2 | 0 | 0 |
| compact / expanded / single | 2 | 0 (warm) | 0 |

`nav_pane_location` is pure path arithmetic over the already-collected pane cwd
and the existing path→git-root cache: zero added tmux/git subprocesses, zero
filesystem traversal on the hot path. One bulk pane inventory pass unchanged.

## Constants (the §19/§32 explicit budgets)

- `NAV_SESSION_LINES=3`, `NAV_WINDOW_LINES=2`, `NAV_PANE_LINES=1` (final; one-line
  panes with inline filesystem location — measured below with the earlier
  `NAV_PANE_LINES=2` value)
- `NAV_MAX_RECORD_BYTES=4096`, `NAV_MAX_RECORD_CHARS=2048` (emission guard)
- `NAV_MAX_NAME_CHARS=160` (record field-3 cap), `NAV_MAX_LOC_CHARS=80` (location)
- `NAV_MAX_CARD_WIDTH=120` (drawer width hard cap)

## Test results

- `bash -n bin/tmux-session-picker` → pass
- `bash test/nav-contract.sh` → **216 pass, 0 fail** (baseline 178; +38 NAV-T4 proofs)
- `bash test/contract.sh` → **245 pass, 0 fail** (identical to the stashed pre-T4 baseline)

No test deletions; four NAV-2-era renderer assertions were updated to the new
bounded contract (§19 supersedes "every character must remain in the record").
