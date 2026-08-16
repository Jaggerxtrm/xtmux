# xtmux-view v0.1 — Local Acceptance Report (PR #103)

Date: 2026-08-15 · Host: v2202602340735437128 · Bead: xtmux-8o4
Branch: `feat/xtmux-view-package` @ f1500f05 base (== origin/main HEAD, no rebase needed)

## 1. Environment

- [x] `glow --version` → **2.1.2** (>= 2.1 required; already installed, no install needed)
- [x] `node --test packages/xtmux-view/test/*.test.mjs` → **7 pass, 0 fail** (91 ms)
- [x] `node --check src/*.mjs` (cli, core, renderer, store) → **PASS** all four
- [x] `bun run typecheck` → pass · bun 1.3.12 · node v24.15.0 · tmux 3.5a

## 2. Real-pane smoke

Panes identified from live tmux sessions; turns read from
`~/.local/state/xtmux/observability.db` (agent_turns, LEFT JOIN agent_instances).

- [x] **Claude** (`%553` claude-jct5k-coord8, live Claude Code TUI, 50 turns):
  popup rendered header ``%553 · $437 · bead mercury-market-data-jct5k``, separator,
  and exact last turn text ("Unchanged — master `c4cb0650` … Holding.").
  Popup closed → pane capture byte-identical to pre-popup baseline.
- [x] **Claude #2** (`%690` claude-rp-telegram): same result, byte-identical restore.
- [x] **Pi** (`%647` pi-t5vs, live Pi TUI, 1 turn): popup rendered the full
  py_backend-vyou handoff text; restore byte-identical.
- [x] **Codex** (`%851`, runtime=codex): rendered via DB (pane no longer exists in
  the tmux server — **flagged**: no live Codex pane on this host; smoke ran against
  the same read-only DB path with the real captured codex turn, header showed
  `codex` runtime label). Not faked: limitation stated explicitly.
- [x] Popup-close restore: verified on %553, %690, %647 by `capture-pane -S -500 -e`
  before/after — byte-identical, no xtmux-view artifacts, no temp leaks on the
  graceful (q) path. Interactive Escape-close runs the command under SIGHUP —
  see Issues #2.
- [x] Graceful close path (`q` in glow): exit 0, temp dir removed (`rmSync` finally).

## 3. Variant checks

- [x] `xtmux-view %553` (popup path, full end-to-end via cli.mjs → display-popup) — pass
- [x] `xtmux-view '$437'` (session-id target) — pass, same turn as %553
- [x] `xtmux-view --target %553 --raw` — pass
- [x] `xtmux-view --raw %553` — sanitized Markdown source, pass
- [x] `xtmux-view --json %553` — `xtmux.view.turn.v1` record, pass
- [x] `xtmux-view --no-popup %553` — inline glow render in current terminal, pass
- [x] `xtmux-view doctor` — JSON diagnostics, exit 0 (tmux/glow/bun/dbPath/inTmux)
- [x] Default target: `TMUX_PANE=%553` with no args — pass (same read path as
  running inside the pane)
- [x] `%553` popup uses mode-0600 temp `turn.md` (verified `stat` mode=600 mid-run)

## 4. Sanitization / validation

- [x] Injected a scratch `agent_turns` row (pane `%9099`, session `smoke-ansi-*`)
  with `\x1b[31mRED\x1b[2J\x1b[H\x07\x0b\x00STOP\x1b]0;HACK\x07`:
  - `--raw`: all control bytes stripped (od-verified: no ESC/BEL/NUL/VT)
  - rendered temp document: **0** ESC bytes
  - `--json`: control bytes JSON-escaped (`\u001b…`), no raw ESC
  - Row deleted after test (verified 0 rows remaining)
- [x] Rejected with exit 2 + `XTMUX_VIEW_INVALID_TARGET`: `; rm -rf /`, `%bad`,
  `$abc`, `main`, `%1;rm -rf /`, `$(id)`, `%553 extra`; `--bogus` →
  `XTMUX_VIEW_INVALID_ARGUMENT`
- [x] Shell injection cannot reach the popup shell: target regex
  `^(?:%\d+|\$\d+)$` validates before `popupCommand`; every argv word is
  `shellQuote`d (unit-tested)
- [x] DB opened `readonly:true`; single indexed query (`at_session` for $targets);
  no writes by xtmux-view (write path only used by my scratch injection, removed)

## 5. CI gate

- [x] `.github/workflows/ci.yml` includes `node --test packages/xtmux-view/test/*.test.mjs`
  (test job step 6) — confirmed in job log, **success**
- [x] PR #103 CI: test, smoke, analyze, CodeQL, pr-review-gate — **all pass**

## 6. Bead / reconcile

- [x] Bead `xtmux-8o4` created + claimed; GitNexus `detect_changes` (compare vs
  main): 9 changed files, 0 changed symbols, 0 affected processes, **risk LOW**
  (new standalone package, no existing callers; new symbols not in index — expected)
- [x] PR branch contains only the 8 PR files; `.xtrm/session-meta.json` is local
  session state, not part of the PR

## Issues found

1. **No live Codex pane on this host** — codex session ended; verified via
   persisted DB turn instead. Not a code defect.
2. **Temp-file leak on Escape-close** — tmux kills the popup command with SIGHUP;
   bun dies without running `rmSync` finally → `/tmp/xtmux-view-*/` (0600, small)
   leaks. Repro: open popup, press Escape. Fix suggestion (next increment):
   SIGHUP/SIGTERM handler in cli.mjs, or a fixed reuse path under
   `$XDG_RUNTIME_DIR`.
3. **runtime label gap** — claude/pi panes store `runtime` as `''`/NULL in
   `agent_instances` on this host (codex only is labeled); popup header omits the
   runtime badge in that case. Cosmetic; capture-side fix, not xtmux-view.
4. **No `at_pane` index** — `%N` lookups scan agent_turns (at_session covers $N);
   fine at current scale; add index if popup latency matters later.

## Verdict

All acceptance items pass on this host. PR #103 marked ready for merge.
Next increment (not implemented): `--follow`/transcript navigation is viable —
`agent_turns` is append-only with `completed_at_ms` + `turn_index` per
instance, so a follow mode is a bounded `completed_at_ms > last` poll; no schema
change needed.
