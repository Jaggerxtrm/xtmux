# xtmux nav topology — NAV-T0 Baseline Report (epic xtmux-w5i)

Date: 2026-08-17 · Host: `v2202602340735437128` · Bead: `xtmux-w5i.1` (parent epic `xtmux-w5i`)
Branch: `xt/xjif` @ `a1880953` (base == `origin/main` `82cc8548`)
Scope: read-only characterization + this one baseline report. No production/test/docs files modified.

This report is the **before** snapshot for the epic's hard performance gate (megaprompt §27)
and NAV-T7's after-comparison. Every metric below is recorded on the §29 deterministic fixture
so NAV-T7 re-measures identically.

---

## 1. Git / tmux state

- [x] `git rev-parse origin/main` → `82cc85489d4607b67410cb303794ed4ccd276f81` (expected `82cc8548`, confirmed)
- [x] `git branch --show-current` → `xt/xjif`
- [x] `git rev-parse HEAD` → `a1880953f2854f38d2fdf95cdc2bcd5adb42e020`
- [x] `git log --oneline -3` →
  - `a1880953 this documentation must land in any next pr`
  - `82cc8548 fix: monotonic capture anchor — same-text earlier records can never absorb a lagging stop (xtmux-gdk post-merge P1) (#107)`
  - `df00b5dd feat(view): consume the response-episode projection instead of LIMIT 1 (xtmux-it6) (#103)`
- [x] `tmux -V` → `tmux 3.5a`
- [x] `git --version` → `git version 2.47.3`
- [x] Active bead(s): `xtmux-w5i.1` (this task, IN_PROGRESS, owner jaggerxtrm) under epic
      `xtmux-w5i` (NAV). Blocks/blocked-by: NAV-T1 `xtmux-w5i.2`, NAV-T7 `xtmux-w5i.8`.

## 2. Current `pane_meta()` field list (bin/tmux-session-picker, line 489)

The bulk inventory is built by one `tmux list-panes -a` call. Exact format line:

```
pane_meta() {
  tmux list-panes -a -F $'#{session_id}\t#{window_index}\t#{s/\n/ /:#{s/\t/ /:window_name}}\t#{pane_id}\t#{pane_index}\t#{pane_active}\t#{s/\n/ /:#{s/\t/ /:pane_current_command}}\t#{s/\n/ /:#{s/\t/ /:pane_current_path}}\t#{?@agent_state,#{s/\n/ /:#{s/\t/ /:@agent_state}},-}\t#{pane_pid}\t#{?@agent_bead,#{s/\n/ /:#{s/\t/ /:@agent_bead}},-}\t#{?@agent_task,#{s/\n/ /:#{s/\t/ /:@agent_task}},-}\t#{?@agent_parent_session,#{s/\n/ /:#{s/\t/ /:@agent_parent_session}},-}\t#{?@agent_last_transition,#{s/\n/ /:#{s/\t/ /:@agent_last_transition}},-}'
}
```

Fields (in order): `session_id, window_index, window_name, pane_id, pane_index, pane_active,
pane_current_command, pane_current_path, @agent_state, pane_pid, @agent_bead, @agent_task,
@agent_parent_session, @agent_last_transition`.

- [x] **window_id present? NO.** The inventory carries `window_index` and `window_name` but NOT
      `#{window_id}` (`@N`).
- [x] **window_active present? NO.** Only `pane_active` is present; there is no `#{window_active}`.

This is exactly the gap NAV-T1 fills (add `window_id` + `window_active` to this projection).

## 3. Current `topology --json` window identity contract (bin/tmux-session-picker, ~2009-2090)

`topology_json()` already consumes **full** window identity in one list-panes pass. Input format
adds `#{window_id}` and `#{window_active}`:

```
tmux list-panes -a -F $'#{session_id}\t#{session_name}\t#{session_created}\t#{session_activity}\t#{session_attached}\t#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{pane_id}\t#{pane_index}\t#{pane_active}...'
```

- [x] Window record (line ~2078): `{"window_id":"%s","window_index":%s,"name":"%s","active":%s,"panes":[...]}` where `window_id` is the tmux `@N` form.
- [x] Exact window JSON field names confirmed: **window_id (`@N`), window_index, name, active, panes**.
- [x] Pane record: `{"pane_id":"%s","pane_index":%s,"active":%s,"width":%s,"height":%s,"left":%s,"top":%s,"pid":%s,"current_command":"%s","current_path":"%s"}`.
- [x] Schema: `"schema_version":"xtrm.xtmux.topology.v1"`.

Note for the epic: `topology --json` already models `$ / @ / %` hierarchy; NAV-T1 mirrors the
window identity into the bulk `pane_meta()` inventory rather than re-deriving it.

## 4. Current `parse_nav_token()` accepted / rejected shapes (line ~3940)

```
# parse_nav_token <token> -> REPLY='type<TAB>sid<TAB>pane'. IDs use tmux's
# immutable machine forms only; names and general tmux target syntax are rejected.
parse_nav_token() {
  local tok="${1:-}"
  REPLY=''
  if [[ "$tok" =~ ^s:(\$[0-9]+)$ ]]; then
    REPLY="session"$'\t'"${BASH_REMATCH[1]}"$'\t'
  elif [[ "$tok" =~ ^p:(\$[0-9]+):(%[0-9]+)$ ]]; then
    REPLY="pane"$'\t'"${BASH_REMATCH[1]}"$'\t'"${BASH_REMATCH[2]}"
  elif [[ "$tok" =~ ^p:(%[0-9]+)$ ]]; then
    REPLY="pane"$'\t-\t'"${BASH_REMATCH[1]}"
  else
    return 1
  fi
}
```

- [x] Accepted today: `s:$N`, `p:$N:%N`, `p:%N`.
- [x] **`w:` is absent** — no window token form exists yet (NAV-T3 adds `w:$N:@N`).

Callers: `nav_act` (line 3131), `nav_go` (line 3967), and an action-safety check (line 5089).

## 5. Current `build_list()` emit modes and record framing (lines 3509-3517)

```
# build_list <spec> [<mode>] [<emit>] [<lines>]
# spec: all|waiting|running, or comma clauses repo:/branch:/cmd:/grep:
# mode: expanded (default) | sessions-only (suppress pane rows)
# emit: tsv (default, public five-field newline TSV) | nav (private
# six-field NUL-delimited records: type<TAB>sid<TAB>name<TAB>target
# <TAB>token<TAB>display<NUL>; token is s:$N / p:$N:%N)
# lines: multi (session primary/context plus one-line panes) | single (bounded one-line cards,
# the fzf-multiline off fallback; same token architecture)
```

- [x] **emit modes: `tsv` (public newline TSV) and `nav` (private NUL-delimited six-field).**
- [x] **Record framing** (exact): `type<TAB>sid<TAB>name<TAB>target<TAB>token<TAB>display<NUL>`.
      Section grouping: `sp-*` sessions are flagged `section=1` and render a
      `header<TAB>\t\t\t  specialists  ...` header on the public TSV only (suppressed in nav).
      Row budgets: `name_width` capped at 22; fzf card regions bounded per §NAV-2; nav records are
      the only NUL-terminated stream.

Concrete emitters:
- session: `printf 'session\t%s\t%s\t%s\ts:%s\t%s\0' "$sid" "$sname" "$sid" "$sid" "$_scard"`
- pane (multi): block entry `printf 'pane\t%s\t%s\t%s\tp:%s:%s\t%s' "$psid" "${sess_name[$psid]:-}" "$ppid" "$psid" "$ppid" "$pdisp"` joined with `\x1f` internally, re-terminated `\0` at emit time;
- single-line fallback: `printf 'pane\t%s\t%s\t%s\t%s' "$psid" "${sess_name[$psid]:-}" "$ppid" "$pcol"` joined with `\n`.

## 6. Current nav verb dispatch + action mechanics

`nav)` case (line 5369):

```
case "${1:-}" in
  "")              pick_nav                       # interactive fzf launcher (drawer)
  help|-h|--help)  nav_help
  next)            nav_session_cycle next         # switch-client -n
  prev)            nav_session_cycle prev         # switch-client -p
  attention-next)  nav_attention_cycle next
  attention-prev)  nav_attention_cycle prev
  back)            jump_back                      # @picker_prev
  *)               usage error
esac
```

- [x] Verbs: **next, prev, attention-next, attention-prev, back, help** + bare `nav` → `pick_nav`. Interactive-only; `--json` refused.
- [x] `nav_go <token>` (line 3965): `parse_nav_token` → for `session` records `record_prev` + `jump_to_target session \$sid`; for `pane` records `resolve_nav_pane_session` (rejects if pane no longer owns the session) → `record_prev` + `jump_to_target pane`.
- [x] `record_prev` (line 3872): reads `#{session_id}\t#{pane_id}` via `display-message`, stores `@picker_prev` as `$sid:$pane`.
- [x] `jump_to_target` (line 5034): `exec tmux switch-client -t \$sid \; select-window -t target \; select-pane -t target` for pane; else `exec tmux switch-client -t \$sid`.
- [x] `nav_act <token> <action>` (line 3123) is the single strict dispatcher for Enter-adjacent actions; Enter itself calls `nav_go` (line 5348). Actions act on the hidden machine token only; display text never reaches a tmux command.

## 7. GitNexus impact analysis

- [x] MCP gitnexus tools are **not present** in this runtime's tool set (no `gitnexus_impact`).
- [x] CLI attempted: `gitnexus impact <symbol> --repo xtmux --direction upstream --include-tests`.
      Result: index is stale (indexed commit `125f1e4`, current `a188095`) and the index does not
      contain these bash symbols — returns **`UNKNOWN` risk / `Target '<symbol>' not found`** for
      `parse_nav_token`, `nav_go`, `build_list`, `pane_meta`.
- [x] Fallback: static caller characterization from `bin/tmux-session-picker` source (single-file bash tool):

| Symbol | Call sites | Blast radius |
|---|---|---|
| `pane_meta` | 1 (`build_list` pane loop, line 3683) | Shared inventory for all `list*` commands; changing field set affects every list/nav path. |
| `build_list` | 6 (`list`, `list-nav`, `list-nav-single`, `list-active`, `list-active-nav`, `list-active-nav-single`) | Central emitter; shape change touches all six commands + nav launcher + contract tests. |
| `parse_nav_token` | 3 (`nav_act` 3131, `nav_go` 3967, action-safety 5089) | Every nav/action entry point; adding `w:` changes accepted token grammar. |
| `nav_go` | 1 (Enter binding, line 5348, via `pick_nav`) | The action executor for the Enter key in the nav fzf. |

- [x] **Risk level: LOW-MEDIUM (contained).** All four symbols are internal to
      `bin/tmux-session-picker`; there are **no external producers** from other repos/runtimes.
      The downstream consumers (six list commands, the nav fzf launcher, `test/nav-contract.sh`,
      `scripts/verify-json-api.sh` JSON gate, ADR-0001 docs) are all in-repo and covered by contract
      tests. Not HIGH/CRITICAL: no cross-process or cross-repo coupling found.

## 8. Baseline performance + byte metrics (hard gate)

### 8.1 Fixture definition (deterministic; NAV-T7 reproduces identically)

Match the megaprompt §29 required fixture exactly. Emulated under a `tmux` shim (the same pattern
`test/nav-contract.sh` uses), so no live tmux server is touched and the result is byte-reproducible:

```
$42 program
├─ @17 0:coord
│  ├─ %553 running      (pane_active=1)
│  └─ %621 idle         (pane_active=0)
└─ @31 1:research
   ├─ %875 needs-input  (pane_active=1)
   └─ %901 running      (pane_active=0)
```

- state sourced from `@agent_state` on each pane row (running/idle/needs-input), so no
  `capture-pane`/process scan is needed.
- all four `pane_current_path` point to **one real git repo** (fresh `git init` + one seed commit)
  so the git hot path is real but cache-collapsed (one distinct root).
- instrumented: `tmux` and `git` wrapped with counting shims (`test/lib/harness.sh`-style);
  picker state/cache isolated under a per-run `TMPDIR`.

Measurement command (the actual NUL-delimited nav projection):
`bin/tmux-session-picker list-nav all expanded` (emit=nav, mode=expanded, lines=multi);
compact via `... list-nav all sessions-only`; one-line fallback via `list-nav-single all expanded`;
forced refresh via `list-active-nav all expanded`.

### 8.2 Subprocess counts (hot path)

| Operation | tmux subproc | git subproc | notes |
|---|---|---|---|
| cold list/nav (list-nav, no git cache) | **2** | **3** | tmux: `list-sessions` + `list-panes -a`; git: `rev-parse --show-toplevel` (git_root_for_path) + `rev-parse --git-dir`, `status --porcelain=v2 --branch` (git-pane-status.sh) |
| warm nav (git cache valid, <TTL) | **2** | **0** | only session_meta + pane_meta; git fully cached |
| forced refresh (list-active-nav, warm) | **2** | **0** | |
| compact (sessions-only) | **2** | **0** | |
| expanded (toggle target) | **2** | **0** | |
| nav single one-line (cold) | **2** | **3** | |

- [x] Cold subprocess call log (exact, from the counting shim): exactly two tmux calls
      (`list-sessions`, `list-panes -a`) and three git calls as tabulated. **No per-session,
      per-window, or per-pane tmux fanout**, and **no per-pane git subprocess** (single root is
      collapsed by `root_cache`). This already satisfies the "one bulk pane inventory + existing
      session inventory + cached git" target shape.
- [x] **process-tree probe count = 0** on this fixture: `sp_is_specialist` only runs `kill -0`
      when the session name is `sp-*`; non-sp names skip the probe, and `@agent_state` is the only
      state source in the hot path (no `capture-pane`, no `pgrep`).

### 8.3 Latency (wall ms, same fixture, `date +%s%N`)

| Operation | latency (sample / range) |
|---|---|
| cold list/nav | ~150-171 ms (cold, git cache empty) |
| warm nav | ~77-128 ms (samples 77,84,96,98,128; mean ≈ 101 ms) |
| forced refresh | ~106 ms |
| compact (sessions-only) | ~103 ms |
| expanded (toggle target) | ~105 ms |
| nav single one-line (cold) | ~133 ms |

Dominant cost is picker startup: each run is a fresh `bash` sourcing a ~5700-line script
(~80-150 ms even on this minimal fixture). The fixture is the smallest valid topology, so these
are floor figures; NAV-T7 must compare before/after on **this same fixture** (relative delta, not
absolute).

### 8.4 Emitted private-nav bytes (measured from the NUL-delimited nav projection, not the TSV)

| Emitter | total emitted bytes | record count | max single-record bytes |
|---|---|---|---|
| expanded multi | **905** | 5 (1 session + 4 panes) | **190** |
| compact sessions-only | **191** | 1 (session only) | **190** |
| single one-line fallback | **789** | 5 | **178** |

- [x] Expanded nav emits exactly: `session` ($42) 190 B + `pane` %553 177 B + `pane` %621 178 B +
      `pane` %875 178 B + `pane` %901 177 B = 905 B.
- [x] **Total private-nav bytes = 905; max single record = 190 bytes** (multi) / 178 B (oneline).
- [x] Reproducibility: two independent cold runs (`list-nav all expanded`) are **byte-identical**
      (905 B), confirming the fixture/measurement is deterministic for the before/after gate.
- [x] No explicit hard byte cap exists today — record size is the rendered card length (190 B on
      this fixture). Record bounding is the explicit NAV-T4/T7 fix.

### 8.5 Memory (representative)

- [x] Representative RSS: peak sampled RSS of the picker process during `list-nav all expanded` ≈
      **7388 kB (~7.2 MB)** bash main process. This excludes transient subshells fork/exit during
      render; treat as an approximate representative, not a precise peak.

### 8.6 Existing nav contract baseline

- [x] `bash test/nav-contract.sh` → **124 pass, 0 fail** (current GREEN baseline; NAV-T6 extends it
      for `w:` tokens). The bead description's note that the file "FAILS while production nav slices
      are unimplemented" refers to the older pre-`a188095` state; on the current HEAD the nav
      production slices exist and the file passes.

## 9. Planned changed-file list (the epic)

- `bin/tmux-session-picker` — NAV-T1 add `window_id`+`window_active` to `pane_meta()`; normalize
  session→window→pane; NAV-T3 add `w:$N:@N` to `parse_nav_token` + `nav_go` window actions /
  ownership validation; NAV-T4 renderer (compact/expanded session/window/pane, permanent `%pane-id`
  + `@window-id`, bounded row heights + record bytes); NAV-T5 `window-next`/`window-prev` + back.
- `test/nav-contract.sh` — NAV-T6 full nav contracts (token accept/reject §30, window/pane
  identity, hostile-char display).
- `scripts/verify-json-api.sh` — NAV-T6 JSON gate (run against `topology --json`).
- Docs: `docs/design/adr/adr001-navigation-design.md` (ADR-0001 nav phases/record model),
  `docs/keys.md` (window-next/window-prev bindings), `docs/json-command-api.md` (nav command
  reference, if emitted shapes change), `docs/perf-audit.md` (before/after §27 numbers).
- Re-measure: NAV-T7 on this same fixture (the §8 numbers above are the `before`).

## 10. Contradictions vs the prompt

- [x] **None found.** All prompt characterization claims match current code:
  - origin/main `82cc8548`, branch `xt/xjif` @ `a1880953`, tmux `3.5a` — confirmed (§38).
  - `pane_meta()` lacks `window_id`/`window_active` — confirmed (§38 NAV-T1 premise).
  - `topology --json` already exposes `window_id`/`window_index`/`name`/`active`/`panes` — confirmed.
  - record framing `type<TAB>sid<TAB>name<TAB>target<TAB>token<TAB>display<NUL>` matches code.
  - `parse_nav_token` accepts `s:$N`, `p:$N:%N`, `p:%N`; no `w:` — confirmed (§10/§11).
  - Required fixture (§29) reproduced byte-identically.
- [x] Two clarifying observations (not contradictions):
  1. `parse_nav_token` *accepts* bare `p:%N`, but `build_list` currently *emits* only `p:$N:%N`
     (and `s:$N`) — session-owner is always known at emit time.
  2. Internal asymmetry: `topology --json` already has full window identity while the list/nav
     inventory (`pane_meta`) does not; NAV-T1 mirrors, not reinvents.

## 11. Session-close state (read-only)

- [x] No tracked files modified by this phase. Only artifact created:
      `.xtrm/reports/2026-08-17-nav-topology-baseline.md`.
- [x] `bd` status: `xtmux-w5i.1` remains the active IN_PROGRESS bead for this phase.
