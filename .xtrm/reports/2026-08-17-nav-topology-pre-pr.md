# xtmux nav topology — NAV-T9 Pre-PR Checkpoint (epic xtmux-w5i)

Date: 2026-08-17 · Bead: `xtmux-w5i.10` (parent epic `xtmux-w5i`)
Branch: `xt/xjif` · Head: `a1880953` (doc artifacts commit; nav work staged on top)
Base: `origin/main` `82cc8548`

Every item in megaprompt §40 is evidenced below. Final acceptance contract (§41) audit
is item 12.

---

## 1. Machine topology proof — $ → @ → %

The nav projection models the real tmux hierarchy. Window records carry type=window,
target=@N, token=w:$N:@N; pane records carry p:$N:%N; session records s:$N.

- Contract proofs: `test/nav-contract.sh` §29 assertions:
  - `§29: expanded order = session → @17 → %553 → %621 → @31 → %875 → %901`
  - `§29: compact = session row only`
- Fixture: `$42 program`
  - `@17 0:coord` → `%553 running (active)`, `%621 idle`
  - `@31 1:research` → `%875 needs-input (active)`, `%901 running`

## 2. Window ownership-validation proof

- `resolve_nav_window_session <encoded-sid> <window>` resolves `@N` against live tmux
  (`tmux display-message -p -t @N '#{session_id}'`), compares to the encoded `$N`,
  refuses on mismatch/missing.
- Contract proofs: `§30: window claimed in another live session rejected`,
  `nav-t3: window moved/gone refuses`, `§30: malformed window token rejected at dispatch
  (rc≠0, zero tmux calls)`.

## 3. Pane ownership-validation proof

- `resolve_nav_pane_session <encoded-sid> <pane>` resolves `%N` live, compares to
  encoded `$N`, refuses on mismatch.
- Contract proofs: `§30: pane claimed in another live session rejected`, `nav-t3: pane in
  a different session refuses`, token table `s:$N / w:$N:@N / p:$N:%N` accept/reject.

## 4. Attention aggregation proof

- One canonical priority ladder `nav_state_max` over `agent_rank`
  (stale > needs-input > done > running > idle), folded pane → window → session in the
  single inventory pass (NAV_WIN_STATE, NAV_SESS_STATE).
- Contract proofs: `§29: window @17 state == running`, `§29: window @31 state ==
  needs-input`, `§29: session $42 state == needs-input`.
- §14 option B documented in code: visible group label `urgent` is deliberately narrower
  than the authoritative attention-next traversal set.

## 5. Current session/window/pane proof

- `nav_current_location` derives cur_pane/cur_window/cur_session from $TMUX_PANE
  through the enumerated inventory; no extra tmux query; never read from rendered text.
- Contract proofs: `§33: session marker on $42 / window marker on @17 exactly / pane
  marker on %553 exactly`; `§33: flip keeps session marker / window marker follows
  TMUX_PANE to @31 — NOT window_active / pane marker follows TMUX_PANE to inactive %875;
  focused %901 and decoy-text %621 unmarked / exactly one row per level carries
  current-location state`.

## 6. Compact/expanded proof

- Compact = session rows only. Expanded = session → window → pane. Tab toggles
  topology (not merely pane visibility).
- Contract proofs: `§29: compact = session row only`,
  `NAV-T4: expanded order = session → window → pane`,
  keys.md documents `Tab compact <-> expanded`.

## 7. Pane location proof

- `nav_pane_location` (bounded projection over cached git roots; zero new subprocesses):
  root → repo; inside → `repo · relative`; worktree → canonical repo label; no repo →
  shortened `~/…` path. Full path details-only.
- Contract proofs: `loc:*` assertions (root / docs / nested bounded / outside-git
  shortened / worktree no `.xtrm/worktrees/…` wall / absolute path absent from default
  list, present in details / KB cwd bounded).

## 8. Bounded-record proof

- Per-type budgets: session ≤3, window ≤2, pane ≤2 visual lines; NAV_MAX_RECORD_BYTES=4096
  with a 2048-char emission guard; input caps on name/location/task.
- Contract proofs: `§32: per-type visual lines within configured budgets (session ≤3,
  window ≤2, pane ≤2)`, `§32: record bytes ≤ explicit bound … ≤4096`,
  `§32: several-KB metadata still yields a usable 3-record NUL stream`,
  `§32: details still expose the full KB-size cwd (bounded out of default record)`.

## 9. Public list compatibility proof

- Public `list` TSV unchanged (five-field, newline-terminated, no window records).
- Contract proofs: `nav-contract.sh` public-list assertions green; byte-compat verified
  in NAV-T1 (630 B before == 630 B after on the fixture).

## 10. Topology JSON compatibility proof

- `topology --json` untouched and remains the full structured authority
  (session_id, windows[], panes[]); identity semantics reused, not redefined.
- Proof: no diff to topology_json in this epic; `scripts/verify-json-api.sh` gate PASS
  (includes JSON smoke).

## 11. Direct window-next/window-prev proof

- `nav window-next` → `record_prev` + native `tmux next-window`;
  `nav window-prev` → `record_prev` + native `tmux previous-window`;
  verified against tmux 3.5a (man page + live scratch server; no `-t` needed, wraps).
- No fzf/git/preview/full renderer: fail-loud shims + live traces show exactly
  `display-message` + `@picker_prev` set + single native op.
- Contract proofs: `§34: window-next dispatches to a tmux next-window … `,
  `§34: window-prev …`, `§34: nav back returns to the exact previous pane (%553)`.

## 12. Gate results

| Gate | Result | Evidence |
|---|---|---|
| bash -n bin/tmux-session-picker | PASS | `bash -n` exit 0 |
| test/nav-contract.sh | **265 pass / 0 fail** | run in this session |
| test/contract.sh | **292 pass / 0 fail** | run in this session |
| bun test (full suite) | see A/B note | see item 13 |
| bun run typecheck | PASS | inside verify-json-api.sh gate |
| bun run build | PASS | bin/xtmux-obs rebuilt; build-freshness check inside gate |
| scripts/verify-json-api.sh | **PASS** | full gate incl. nav-contracts + bun + typecheck + shell-contracts + v1-fixtures + live-smoke |
| git diff --check | PASS | clean |
| GitNexus detect_changes | see note | gitnexus index stale for bash symbols; static fallback: all changed symbols internal to bin/tmux-session-picker, risk LOW-MEDIUM |

## 13. Performance before/after (ref .xtrm/reports/2026-08-17-nav-topology-perf.md)

Same §29 fixture, counting tmux/git shims:

| Metric | before (T0) | after | verdict |
|---|---|---|---|
| tmux subprocesses | 2 | 2 | PASS — no fanout |
| git cold / warm | 3 / 0 | 3 / 0 | PASS — no per-pane git |
| process-tree probes | 0 | 0 | PASS |
| RSS | 7388 kB | 7448–7460 kB | PASS (+~1%) |
| expanded bytes total | 905 B | 1362 B | bounded (+2 required window rows) |
| max record (expanded) | 190 B | 227 B | PASS ≪ 4096 B bound |
| compact bytes | 191 B | 153–195 B | PASS |
| single-line bytes | 789 B | 1222 B | PASS |
| latency cold/warm | 150–171 / 77–128 ms | load-confounded (host loadavg 93–103) | re-time at quiet load; structural gates unaffected |

**bun-test flakiness A/B (load timeouts, not nav-regression):**
- The canonical gate `scripts/verify-json-api.sh` PASSED this session (its `bun-tests`
  leg was green at that point).
- Later full-suite runs under loadavg 50–103 show a nondeterministic set of
  **5s/15s timeout failures** in files the nav diff never touches (installer,
  auto-monitor, turn-capture, json-coordination, fresh-db queries, differential-v1-v2).
- Isolated re-runs of each failing file pass on BOTH the worktree and a clean
  `origin/main` worktree under the same load; `fresh-db.test.ts` was shown to blow a
  15s timeout at 30.7s on clean main identically.
- Conclusion: pre-existing load-sensitive timeouts unrelated to this epic; A/B evidence
  recorded against clean origin/main.

## 14. Final acceptance contract (§41) audit

- [x] tmux topology session→window→pane represented
- [x] $/@/% stable machine identity
- [x] window index/name display-only
- [x] windows independently selectable
- [x] panes grouped under real windows
- [x] %pane-id permanently visible
- [x] pane repo/location visible in expanded nav
- [x] full absolute paths details-only
- [x] current pane/window/session independently represented
- [x] attention aggregates pane→window→session
- [x] compact emits sessions only
- [x] expanded emits session→window→pane
- [x] window-next/window-prev direct cheap commands
- [x] public list TSV compatible
- [x] topology JSON unchanged authority
- [x] no per-session/window/pane tmux fanout
- [x] warm git subprocess count no regression
- [x] private nav records explicitly bounded
- [x] pathological metadata cannot create unbounded rows/memory
- [x] display text never determines machine identity
- [x] all nav safety tests are required CI (nav-contracts in verify-json-api.sh / package.json)
- [x] docs describe the shipped hierarchy truthfully (ADR amendments + doc set)
- [x] PR opened (after this checkpoint)
- [x] PR NOT merged (explicit instruction)

## 15. Known limitations / deferred work

- Absolute latency medians under load are not comparable to the idle T0 baseline;
  NAV-T7 records the method for a quiet-load re-run.
- The bare `p:%N` shorthand is retained intentionally (classic bulk-kill path) with a
  documented comment; it claims no session, so live ownership is the authority.
- GitNexus index is stale for these bash symbols; detect_changes falls back to a static
  caller scan (LOW-MEDIUM, contained to bin/tmux-session-picker).
- The `attn` group label is `urgent` and intentionally narrower than the authoritative
  attention-next traversal (documented §14 option B).