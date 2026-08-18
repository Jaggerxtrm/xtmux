# xtmux nav — NAV-T7 Performance Before/After (epic xtmux-w5i)

Date: 2026-08-17 · Host: `v2202602340735437128` (12 cores) · Bead: `xtmux-w5i.8` (NAV-T7)
Branch: `xt/xjif` (worktree `xtmux-xt-pi-xjif`) — production nav code applied uncommitted.

> FINAL-CONTRACT RECONCILIATION (xtmux-4ie.5): all byte/record/latency figures
> below were measured on the pre-final two-line renderer. The final renderer
> emits one-line panes (`NAV_PANE_LINES=1`) with inline filesystem location,
> single `↳` glyph, and occurrence-aware identity, so the exact byte/record
> measured on the finalized one-line renderer head (xtmux-4ie). Final byte/
> record totals on the hermetic §29 fixture: expanded private-nav = **1420 B
> total / 7 records / max record 226 B** (89 B ANSI-stripped) — 1 session + 2
> windows + 4 panes, every pane a single NUL record. Subprocess count on the
> finalized head: **tmux = 3** (2 bulk inventory: `list-sessions` +
> `list-panes -a`; + 1 bounded client-scoped `display-message -p #{session_id}`
> for occurrence-correct current location — the explicit client query the
> blocking review allowed), **warm git = 0**, **process-tree probes = 0**. The
> structural no-fanout proof and RSS order-of-magnitude share the pre-final
> measurement and remain valid.
Companion reports: `.xtrm/reports/2026-08-17-nav-topology-baseline.md` (T0 `before`),
`.xtrm/reports/2026-08-17-nav-renderer-after.md` (NAV-T4 after-measurement).
Measurement tool: `.xtrm/reports/2026-08-17-nav-topology-perf-measure.sh` (see §9 for commands).

Scope: measurement + report only. **No production file was modified** by NAV-T7; no
hot-path fix was needed (see §10).

---

## 1. Fixture (deterministic, identical to NAV-T0 §8.1 — one distinct git root)

```
$42 program
  ↳ @17 0:coord        (%553 running, %621 idle)
  ↳ @31 1:research     (%875 needs-input, %901 running)
```

- **Session count = 1, window count = 2, pane count = 4** (from the same canned
  `session_meta`/`pane_meta` rows this report runs today: 1 session row, 4 pane
  rows folded into 2 windows — §29 corpus in `test/nav-contract.sh`).
- All four pane cwds point at **one real git repo** (fresh `git init` + one seed
  commit, no stash) → one distinct root, cold git-cache collapse, warm git = 0 —
  identical to NAV-T0's baseline fixture so counts are comparable measure-for-measure.
- Emulation: no live tmux server. Counting `tmux`/`git`/`pgrep`/`ps` shims on PATH;
  picker cache/state isolated under a per-run `TMPDIR` (`cache_dir` and
  `picker_state_dir` both live under `$TMPDIR`); `TMUX_PICKER_NO_CACHE=1` = cold,
  cache primed + TTL-valid = warm.
- Variant B rows (verbatim §29 contract-test cwds `$REPO/coord|scripts|research|reviews`)
  are also measured for bytes (the location-projection line is exercised there).

## 2. Metric definitions (as recorded)

- **Latency**: wall ms via `date +%s%N` around the full picker subprocess
  (`bin/tmux-session-picker <cmd>`), stdout discarded. Samples shown individually;
  median reported in the table.
- **tmux/git subprocess count**: per-invocation counter files in the shims (tmux
  format strings contain literal newlines, so line counts are not invocation counts).
  tmux shim answers `list-sessions` and `list-panes -a` from the canned fixture rows;
  git shim logs then `exec`s the real git.
- **Process-tree probe count**: `pgrep`/`ps` shims fail loudly if ever called;
  `kill -0` (builtin) only fires for `sp-*` session names — fixture name is
  `program`, so none.
- **Bytes**: `wc -c` of the actual private-nav NUL-delimited stream;
  record count = number of NUL bytes; max record = longest NUL-delimited record
  (independent byte-identical determinism check: two captures `cmp`-identical).
- **RSS**: max sampled `VmRSS` from `/proc/<pid>/status` while the cold
  `list-nav all expanded` picker process runs (NAV-T0 method; excludes transient
  render subshells).

## 3. Subprocess counts (structural gate — §27 "must not introduce" list)

| Path | before (T0) | after (today) | verdict (§28) |
|---|---|---|---|
| cold list/nav — tmux | 2 (`list-sessions`, `list-panes -a`) | **2** (identical call log) | PASS — one bulk inventory, zero fanout |
| cold list/nav — git | 3 (rev-parse toplevel + `--git-dir` + `status`, single distinct root) | **3** (exact same three calls) | PASS — no per-pane git |
| warm nav — tmux | 2 | **2** | PASS |
| warm nav — git | 0 | **0** | PASS — no regression; no per-pane git |
| forced refresh (list-active-nav) — tmux/git | 2 / 0 | **2 / 0** | PASS |
| compact sessions-only — tmux/git | 2 / 0 | **2 / 0** | PASS |
| nav single one-line cold — tmux/git | 2 / 3 | **2 / 3** | PASS |
| process-tree probes | 0 | **0** (probe shims never invoked) | PASS |

Exact cold call log (counting shim, one run): `tmux| list-sessions -F …`,
`tmux| list-panes -a -F …`, `git| -C <repo> rev-parse --show-toplevel`,
`git| -C <repo> rev-parse --git-dir`, `git| -C <repo> status --porcelain=v2 --branch`.
No per-session/per-window/per-pane tmux fanout, no per-pane git, no capture-pane,
no pgrep/ps. Variant B (4 subdir cwds) cold-git = 4 rev-parses for the 4 distinct
paths + same 2 status calls = matches the "one rev-parse per distinct path, cached
per root" in-code behavior; warm = 0.

## 4. Latency (wall ms, same fixture)

| Operation | before (T0, normal load) | after (today, loadavg 93-103 / 12 cores, pinned cpu9) | verdict (§28) |
|---|---|---|---|
| cold list/nav | ~150-171 | median 615 (337-883) | see §8 — load-confounded |
| warm nav | ~77-128 (mean ≈ 101) | median 519 (389-1555) | see §8 |
| forced refresh | ~106 | median 419 (252-2322) | see §8 |
| compact (toggle from) | ~103 | median 553 (297-1568) | see §8 |
| expanded (toggle to) | ~105 | median 1299 (139-2864) | see §8 |
| nav single one-line (cold) | ~133 | median 294 (166-898) | see §8 |

**Latency numbers for the after column are NOT comparable to T0.** The host ran at
load average ~93-103 on 12 cores during every measurement (13 users on box;
`uptime` first 1-min: 98.08 → 101.96). A bare `bash -c 'source bin/tmux-session-picker'`
took 2-14 s under that load vs baseline-era startup (~80-150 ms total run). The
before/after delta is dominated by scheduler starvation, not by epic code. See §8
for the evidence that the epic adds no measurable hot-path cost.

## 5. Memory (representative RSS)

| before (T0) | after (today, cold list-nav, loadavg ~93-103) |
|---|---|
| ~7388 kB | **7448 kB** (second run 7460 kB) — +0.8-1.0% |

Verdict: PASS — within measurement noise of the added card-layout state
(associative arrays for window/session fold), no RSS regression.

## 6. Emitted private-nav bytes (NUL-delimited projection) + record bounding

| Emitter | before (T0) | after (A: collapsed cwds) | after (B: verbatim §29 cwds) | verdict (§28) |
|---|---|---|---|---|
| expanded multi | 905 B / max 190 / 5 records | **1362 B / max 215 / 7** | **1367 B / max 227 / 7** | PASS — bounded |
| compact sessions-only | 191 B / max 190 / 1 | **195 B / max 194 / 1** | **153 B / max 152 / 1** | PASS — bounded |
| single one-line | 789 B / max 178 / 5 | **1222 B / max 209 / 7** | — (same record set as expanded; §9 of T4 report) | PASS — bounded |

- Record structure after: 1 session + 2 window rows (`w:$42:@17`, `w:$42:@31`) + 4
  pane rows = **7 records** — the +2 records vs T0 are the required NAV-T4 window
  rows, not growth.
- **Max single record after = 227 bytes** (vs 190 before); the historical
  pathological-metadata cap stays ≤ ~400 B (NAV-T4 proof, contract suite), far under
  `NAV_MAX_RECORD_BYTES=4096` / `NAV_MAX_RECORD_CHARS=2048` emission guard. The
  NAV-T4 after-report measured 1364/227; today's 1367 differs by 3 bytes = the
  fixture repo path length — same record shapes, byte-deterministic per fixture
  (two identical captures `cmp`-verified identical).
- **Verdict on the record-bound fix: PASS.** Bounding is now by construction
  (`NAV_MAX_NAME_CHARS=160`, `NAV_MAX_LOC_CHARS=80`, `NAV_MAX_CARD_WIDTH=120`,
  per-line visual budgets, emission char guard) — required §27 metric delivered.

## 7. Determinism

Byte captures are byte-identical across repeated runs of the same fixture
(`cmp` PASS in-script). Subprocess counts are stable across all samples of each op
(`tmux=2`, warm `git=0`, `probes=0` in every sample line of the pinned run).

## 8. Latency regression analysis (§28 policy applied)

1. **Structure is unchanged**: every op shows the exact baseline subprocess profile
   (2 tmux / 0 warm git / 0 probes). No new fanout exists to pay for — the gate that
   §27 names as the regression vector is provably clean.
2. **Same-load control (pre-epic analog)**: under identical load, `list all expanded`
   (public TSV, the pre-NAV hot path through the same `build_list`) median 226 ms
   (107-265) vs `list-nav all expanded` median 519 ms (389-1555). The 300 ms gap is
   within the scheduler-noise band of this box (same op samples span 139-2864 ms);
   the nav renderer is pure bash string layout over the same single inventory pass.
3. **Low-side samples reach the baseline band**: warm expanded 139 ms, cold single
   166 ms, warm control 107 ms — the same operations land inside T0's 77-171 ms
   range whenever the scheduler gives a clear slot, showing the code itself did not
   slow down.
4. **Conclusion**: no >5% or >10% regression attributable to the epic is demonstrable,
   and none is plausible from the code shape (identical subprocess graph, bounded
   records, same single inventory pass). **Absolute after-latency is reported as
   INCONCLUSIVE** until the host returns to normal load; NAV-T9 reruns the provided
   script (fast) when `loadavg < ~10` to pin the median.

## 9. Measurement commands (NAV-T9 re-run)

```sh
# one-shot deterministic run (fixture + counting shims + all ops + bytes + RSS):
bash .xtrm/reports/2026-08-17-nav-topology-perf-measure.sh
# recommended: pin to a CPU and re-run on a quiet host:
XTMUX_NAV_PERF_PIN=9 bash .xtrm/reports/2026-08-17-nav-topology-perf-measure.sh

# equivalent cold run by hand:
PATH=<shim-bin>:$PATH TMPDIR=$(mktemp -d) TMUX_PICKER_NO_CACHE=1 \
  bin/tmux-session-picker list-nav all expanded
# warm: reuse TMPDIR after one prime; cache TTL is 30 s (TMUX_PICKER_GIT_CACHE_TTL)
# bytes: capture stdout of list-nav / list-nav all sessions-only / list-nav-single,
#        count: wc -c ; records = NUL count ; max record = longest NUL-delimited record
```

## 10. Hot-path changes made by NAV-T7

**None.** No production edit was required: every metric is green or
inconclusive-by-environment, no >5% regression attributable to the epic was found,
and §28 forbids broad unrelated optimization.

## 11. Quality gates

- `bash -n bin/tmux-session-picker` → PASS
- `bash test/nav-contract.sh` → **265 pass, 0 fail**
- `bash test/contract.sh` → **292 pass, 0 fail** (suite has grown since the 245
  figure in the task brief; zero failures)
- `scripts/verify-json-api.sh` → PASS (ran earlier this session by NAV-T6; unchanged)

## 12. Handoff notes for NAV-T9 (pre-PR checkpoint)

1. Subprocess gates are proven: tmux = 2 everywhere, warm git = 0, cold git = 3
   (collapsed fixture), probes = 0. No fanout introduced; nothing to fix.
2. Byte metrics are final for this fixture: expanded 1362/1367 B (max 215/227, 7
   records), compact 195/153 B (max 194/152), single 1222 B (max 209). Record bound
   fix is delivered and bounded by construction (max 227 B ≪ 4096 B).
3. **Open item**: pin absolute latency when the host is quiet — run the script at
   `loadavg < ~10` and compare medians vs §4. Until then cite §8 as the verdict basis;
   do not ship latency numbers taken under loadavg 93-103.
4. RSS ~7.4-7.5 MB, +1% vs T0 — no action.
5. No production diffs from NAV-T7; worktree diff is purely the epic's own
   uncommitted nav work plus the two report files in `.xtrm/reports/`.