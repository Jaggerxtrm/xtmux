# performance audit — 2026-06-29

baseline measured on 11 sessions / 21 panes / 9 distinct paths / ~7 repos.

## baseline

| path | time | spawns |
|---|---|---|
| `list all` (default) | ~1.0–1.4 s | 33 git + 33 timeout + 2 tmux |
| `list all` (`TMUX_PICKER_AGENT=1`) | ~1.6–2.4 s | + capture-pane per agent pane |
| `preview session` | ~260–340 ms | 8 tmux + 4 git |
| `git-pane-status.sh` (per repo) | ~60–80 ms | 4–5 git |

## root causes (by impact)

1. **no caching across invocations** — every open / reload / preview is a fresh
   bash process that re-resolves all git roots and re-runs `git status`. highest
   perceived-latency lever.
2. **`git-pane-status.sh` spawned 4–5 git processes per repo** — `rev-parse
   --show-toplevel`, `status --porcelain=v2`, `rev-parse --git-dir`,
   `rev-list --count refs/stash`, plus a redundant toplevel.
3. **redundant toplevel re-resolve** — the picker resolves the root, then passed
   it to the status script, which ran `rev-parse --show-toplevel` again.
4. **preview fired 8 tmux + 4 git spawns** — 3 separate `display-message`, two
   unscoped `list-panes -a | awk` (scanned all sessions to count one), no git-root
   cache in the pane loop.
5. **agent-state inference** (`TMUX_PICKER_AGENT=1`) added ~0.5–0.8 s with no
   per-pass caching.

## ruled out (verified by measurement, not intuition)

- the `timeout` wrapper — stubbing it to `exec "$@"` produced no measurable change.
- `rev-parse` itself (~4 ms each).
- locale / sort / per-row `>>`.

## fixes applied

| # | fix | effect |
|---|---|---|
| 1 | TTL cache for `list` output (`TMUX_PICKER_CACHE_TTL`, default 3 s); `Ctrl-r` bypasses via `TMUX_PICKER_NO_CACHE=1` | warm reload **~650–1000 ms → ~20 ms** |
| 2 | batch `git-pane-status.sh`: one `rev-parse --show-toplevel --git-dir`; stash `rev-list` guarded behind ref/reflog existence | per-repo **~60 ms → ~38 ms** |
| 3 | `TMUX_GIT_TOPLEVEL` fast path — caller-supplied root skips the redundant `rev-parse` | −7 spawns list-wide |
| 4 | preview: one scoped `list-panes -s -t <sid>`; 3 `display-message` → 1; pane count derived from the scoped call | preview **~300 ms → ~95 ms**, tmux 8 → 5 |
| 5 | local git-root cache in the preview pane loop | preview −(P × ~4 ms) |
| 6 | agent-state inference benefits from the warm cache (#1) | warm path cached |

## results

| path | before | after |
|---|---|---|
| `list` cold (1st open) | ~1.0–1.4 s | ~0.62–0.73 s |
| `list` warm (reload / filter switch / reopen) | ~0.65–1.0 s | ~20 ms |
| `preview session` | ~260–340 ms | ~75–110 ms |
| git spawns per repo | 4–5 | 2–3 |
| status-line script output | — | byte-identical on all test paths incl. worktrees |

## bonus correctness fix

`git-pane-status.sh` left `GIT_DIR` **relative** (`.git`), so the
rebase/merge/pick/revert/bisect op-detection file tests ran against the caller's
cwd and never triggered. now resolved against the toplevel — op detection works.

## tradeoffs / notes

- the stash fork-guard is neutralized in workspaces where every repo has a stash
  (the guard only saves a fork on stash-free repos). still correct: worktree
  stashes (common dir) are handled via the derived `<repo>/.git` path.
- cache staleness window = `TMUX_PICKER_CACHE_TTL` (3 s default); `Ctrl-r` always
  force-rebuilds. planned: invalidate via `session-created`/`session-closed`
  set-hooks so new sessions appear instantly without shrinking the TTL.

## cache correctness fix (xtmux-rib.17) — 2026-06-30

### the regression

the TTL cache shipped in the initial import (`list)` cached the entire rendered
`build_list` output, default 3 s) **froze agent-derived state**:

- `sess_attn` — the sort rank computed from `@agent_state` (line ~340) → ordering was stale for the TTL window.
- `state_badge` — the `[WAIT]/[RUN]/[DONE]` badges (line ~254) → badges were stale.
- `list waiting` / `list running` — used the **same** cache file pattern → the attention filters could show "no waiting" right after a pane flipped to `needs-input`.

wiring accurate `@agent_state` hooks (xtmux-rib.2) would have been pointless while the cache hid the effect.

### rule (from operator review)

> aggressive caching on git-root/status (expensive, near-static). **never** on
> agent state — always fresh, or TTL ≤ ~1s.

tmux 3.5a has **no** `option-changed` hook, so invalidation on `set -p @agent_state`
isn't possible — the fix had to be structural.

### the fix: split the cache along the cost axis

- **cached (TTL `TMUX_PICKER_GIT_CACHE_TTL`, default 30 s):** a persistent git
  table `path→root, root→status` under `${TMPDIR:-/tmp}/tmux-picker-cache-<uid>/git-table`.
  these dominate cold build time (~0.5 s+ of `git status` + `rev-parse`) and change rarely.
- **always fresh:** one `tmux list-panes -a -F ... #{@agent_state}` query per call
  (~5 ms) drives `normalize_agent_state`, `state_badge`, `sess_attn` rank, the
  final sort, and the `waiting`/`running` filters.

`Ctrl-r` (`TMUX_PICKER_NO_CACHE=1`) now bypasses the **git** cache (forces full
re-resolve) rather than refreshing a list snapshot. `attn-jump`/`attn_list` were
already cache-immune (direct `tmux list-panes`) and remain so.

### results

| path | stale-cache (regression) | after split (correct) | after REPLY refactor |
|---|---|---|---|
| `list` cold (git-table miss) | ~0.65 s | ~0.85 s | **~0.48 s** |
| `list` warm (git-table hit, **state fresh**) | ~20 ms (stale) | ~0.5 s (correct) | **~0.12 s (correct)** |
| `ctrl-r` (no cache) | ~0.65 s | ~0.85 s | ~0.88 s (git-bound) |
| `@agent_state` → badge lag | up to 3 s | **immediate** | **immediate** |
| `waiting`/`running` filter freshness | up to 3 s stale | **always fresh** | **always fresh** |
| git calls in warm `list` | 0 (cached output) | **0** (git-table hit) | **0** |
| tmux calls in `list` | 2 | 2 | 2 |

### honest comparison vs the pre-audit baseline

the pre-audit picker rebuilt everything every call (~1.0–1.4 s always). the
stale-cache version delivered ~20 ms warm but at the cost of correctness. the
split-cache fix restored correctness and kept cold-path git caching. the later
REPLY refactor removed hot-loop subshell overhead, bringing the correct warm
path to ~122 ms without caching agent-derived output.

### why no rendered-output cache?

rendered-output caching freezes badges, attention sort, and the `waiting` / `running`
filters. the correct invariant is: cache git/static data only; read and render
agent state live. with the REPLY refactor the correct warm path is already below
the usual perception threshold (~200 ms), so a staleness-prone rendered cache is
not worth it.
