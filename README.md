# xtmux

`xtmux` is a Bash/tmux toolkit centered around an fzf-driven session + pane
picker. It is designed for people and agents who keep many tmux sessions open at
once: repos, worktrees, long-running agents, specialist sessions, shells, and
monitoring panes.

The picker is intentionally small and local: Bash + `tmux` + `fzf`, with `git`
used for repo annotations. `bd`/Beads is optional but unlocks richer task context
in previews and multiplexing workflows.

## What xtmux offers today

### Interactive tmux picker

- session and pane picker with fzf
- switch to a session/pane with `Enter`
- open a target in a popup client with `Alt-Enter`
- preview session/pane contents without attaching
- compact modes for smaller displays
- sessions-only vs expanded nesting toggle
- rename session/window inline
- kill pane/session with safety prompt for sessions
- bulk multi-select kill with `Space` + `Alt-X`
- root-level attention jumps `Alt-1`..`Alt-5` and jump-back

### Agent awareness

- pane-scoped `@agent_state` written by hooks:
  - `running`
  - `needs-input`
  - `done`
  - `idle`
  - `off`
- state badges in list rows: `[wait]`, `[run]`, `[done]`, `[idle]`
- attention ranking keeps waiting/running agents at the top
- agent state is read live; list output is never cached as a whole
- optional fallback UI inference via `TMUX_PICKER_AGENT=1`

### Git/worktree awareness

- per-row repo/status annotations via `scripts/git-pane-status.sh`
- branch/status/path hints in session and pane rows
- idle/stale badge from tmux activity
- preview enrichment:
  - conservative bead id derivation from dot-number names/paths such as
    `xtmux-rib.16`
  - bounded `bd show` context when a bead is known
  - git branch + dirty count
  - bounded `git diff --stat`
- shared-worktree detection and `[shared-wt]` warnings

### Specialist session awareness

- detects `sp-*` specialist sessions by name + live pane pid
- groups specialists in a dedicated bottom section
- shows `[sp]` and specialist role in the hot list path
- enriches specialist preview with job/bead/role/state when discoverable
- avoids `sp ps`, `pgrep`, and `ps` in the hot list path

### Rich filters and list modes

- attention presets: `all`, `waiting`, `running`
- content filters:
  - `repo:<substr>`
  - `branch:<name>`
  - `cmd:<agent|shell|bun>`
  - `grep:<text>`
- comma-separated clauses are ANDed
- unknown filter clauses are ignored defensively
- active `Ctrl-f` filter survives refresh/cache invalidation
- `Tab` toggles nesting:
  - expanded = session rows + child pane rows
  - sessions-only = dense session-only overview

### Multiplexing/orchestrator primitives

These features were added for `/multiplexing`-style inter-agent coordination.
They do not replace Beads; they make it safer to discover, monitor, hand off,
and clean up tmux-based agent work.

- standardized `@agent_*` metadata:
  - `@agent_state`
  - `@agent_bead`
  - `@agent_task`
  - `@agent_prompt_file`
  - `@agent_parent_session`
  - `@agent_last_transition`
- `wait-agent`: requester-owned SQLite wait that blocks until an agent pane leaves working/running state; `--consume` claims a terminal wake once
- `monitor-agent` / `monitor-list` / `monitor-kill`: durable background monitors linked to requester session and pane identity
- `safe-send-pointer`: dry-run-first safe wrapper around `tmux send-keys`; `--reply-to <messageKey>` records a correlated reply only after successful injection; Claude targets receive the required delayed second Enter
- `handoff`: generate `/tmp` prompt file + exact safe-send command for a bead
- `dashboard`: agent-readable TSV inventory for orchestrators
- `audit`: read-only hygiene report separating warnings from cleanup candidates
- `worktree-collisions`: report sessions sharing one git checkout
- opt-in command telemetry wrappers for `git`, `bd`, and `gh pr` actions
- `mux-help`: concise multiplexing safety cheatsheet, also available with `?`
  inside the picker
- typed SQLite state plus an append-only event journal for state/message/handoff/monitor/audit events
- SQLite-backed message channel between sessions/panes, with receipt ack separate from reply fulfilment

## Operator quickstart

```sh
xtmux-obs health
xtmux dashboard sessions-only
xtmux message-send --to '$42' --to-pane '%7' --bead xtmux-demo.1 --text 'status' --json
xtmux message-list --for "$(tmux display-message -p '#{session_id}')" \
  --pane "$TMUX_PANE" --expects-reply --json
```

A bead implies `expectsReply:true`; use `--expects-reply=false` for FYI-only
messages. `message-ack` records receipt only. The original recipient fulfils an
obligation with `message-reply --in-reply-to <messageKey> --text ...`, or with
`safe-send-pointer --reply-to <messageKey>` after successful pane injection.

SQLite is the source of truth at
`${XDG_STATE_HOME:-$HOME/.local/state}/xtmux/observability.db`. Set
`XTMUX_OBS_V2=0` only for temporary legacy rollback or `XTMUX_OBS_V2=shadow` for
comparison; neither mode makes runtime marker files authoritative.

## Files

| path | role |
|---|---|
| `bin/tmux-session-picker` | picker, preview, CLI commands, orchestration helpers |
| `scripts/git-pane-status.sh` | stable per-path git status line; also usable from tmux status bar |
| `scripts/agent-state.sh` | shared hook target that writes `@agent_state` and optional `@agent_*` metadata |
| `scripts/xtmux-monitor.sh` | opens a tmux monitoring terminal for dashboard/audit/events/messages/turns/telemetry |
| `extensions/pi-agent-state.ts` | pi extension for writing `@agent_state` on pi lifecycle events |
| `docs/agent-state-hooks.md` | hook setup and orchestration metadata reference |
| `docs/keys.md` | tmux keybinding snippets and collision notes |
| `docs/perf-audit.md` | performance notes and cache rationale |

`git-pane-status.sh` has a stable CLI/output contract. The picker calls it for
repo rows, and the tmux status line can call it directly.

## Install

```sh
npm install --global @jaggerxtrm/xtmux
```

This installs the command suite, grouped Pi extensions under `~/.pi`, and owned
Claude hooks under `~/.claude`. Existing unrelated settings and xtrm-managed
hooks are preserved. The installer is idempotent and never opens a browser.

For upgrade, uninstall, conflict behavior, optional aicommit2 setup, and the
reusable changelog command, see [`docs/INSTALL.md`](docs/INSTALL.md).

A checkout can use the same installer directly:

```sh
./install.sh
```

### The `xtmux` name

`xtmux <subcommand>` and `tmux-session-picker <subcommand>` are the same program:
same subcommands, same flags, byte-identical output. `xtmux` is the name to use in
new docs, skills and hooks; `tmux-session-picker` keeps working indefinitely, so no
existing call site, hook or live tmux pane needs to change.

Both entries must live in the **same directory**. The picker derives its repo root
from its own path as `${self%/bin/*}` and does not resolve symlinks, so it looks for
the observability backend beside the installed command as `xtmux-obs` — which only resolves when
the entry sits in `~/.local/bin/` alongside `~/.local/bin/xtmux-obs`. An `xtmux` placed
anywhere else resolves root to the wrong directory and cannot find the adjacent backend. The npm and checkout installers place both entries together; do not hand-copy only one entry.

Optional tmux cache-invalidation hooks:

```sh
./install.sh --tmux-hooks
```

Equivalent hook snippet:

```tmux
set-hook -g 'session-created[90]' "run-shell '~/.local/bin/tmux-session-picker clear-cache'"
set-hook -g 'session-closed[90]' "run-shell '~/.local/bin/tmux-session-picker clear-cache'"
set-hook -g 'window-linked[90]' "run-shell '~/.local/bin/tmux-session-picker clear-cache'"
set-hook -g 'window-unlinked[90]' "run-shell '~/.local/bin/tmux-session-picker clear-cache'"
```

Suggested tmux bindings:

```tmux
bind s display-popup -E -w 99% -h 97% "$HOME/.local/bin/tmux-session-picker"

# optional compact modes
bind g display-popup -E -w 99% -h 97% "TMUX_PICKER_MODE=compact-wrap $HOME/.local/bin/tmux-session-picker"
bind G display-popup -E -w 99% -h 97% "TMUX_PICKER_MODE=compact-nowrap $HOME/.local/bin/tmux-session-picker"

# optional root-level attention jumps
bind -n M-1 run-shell '~/.local/bin/tmux-session-picker attn-jump 1'
bind -n M-2 run-shell '~/.local/bin/tmux-session-picker attn-jump 2'
bind -n M-3 run-shell '~/.local/bin/tmux-session-picker attn-jump 3'
bind -n M-4 run-shell '~/.local/bin/tmux-session-picker attn-jump 4'
bind -n M-5 run-shell '~/.local/bin/tmux-session-picker attn-jump 5'
bind -n M-` run-shell '~/.local/bin/tmux-session-picker jump-back'
```

See [`docs/keys.md`](docs/keys.md) for copy-paste snippets and collision notes.

## Tmux keys

| key | action |
|---|---|
| `prefix s` | open picker, default mode |
| `prefix g` | open picker, compact-wrap mode |
| `prefix G` | open picker, compact-nowrap mode |
| `Alt-1`..`Alt-5` | jump to the 1st..5th waiting/attention pane |
| `` Alt-` `` | jump back to pane active before the last attention jump |

The attention jumps intentionally use root-level `bind -n` for one-keystroke
triage. If a foreground TUI needs `Alt-digit`, use the prefix-gated alternative
from `docs/keys.md`.

## Fzf keys inside the picker

| key | action |
|---|---|
| `Enter` | switch client to highlighted session/pane |
| `Alt-Enter` | attach target in a popup client |
| `Ctrl-y` | approve/waiting-agent micro-action (`y Enter`) |
| `Alt-i` | interrupt pane (`C-c`) |
| `Ctrl-o` | prompt for one-line message and send it to pane |
| `Alt-r` | rename highlighted session/window |
| `Alt-x` | kill pane immediately; prompt before killing session |
| `Space` | mark/unmark row for bulk actions |
| `Alt-X` | bulk kill marked rows; session kills prompt, pane kills immediate |
| `Tab` | toggle nesting: expanded vs sessions-only |
| `Alt-p` | toggle wide preview window |
| `Ctrl-a` | all sessions/panes |
| `Ctrl-w` | waiting/needs-input attention preset |
| `Ctrl-e` | running/done attention preset |
| `Ctrl-f` | filter submenu: repo / branch / command / grep |
| `Ctrl-r` | refresh list; keeps active filter and nesting mode |
| `Ctrl-/` | toggle preview pane |
| `?` | show multiplexing-safe delegation cheatsheet in preview |

## CLI reference

### Listing, filtering, preview, navigation

```sh
tmux-session-picker list [all|waiting|running|repo:..|branch:..|cmd:..|grep:..]
tmux-session-picker list-active
tmux-session-picker preview <type> <sid> <name> <target>
tmux-session-picker popup   <type> <sid> <target>
tmux-session-picker jump    <type> <sid> <target>
tmux-session-picker attn-jump <n>
tmux-session-picker jump-back
```

Filter grammar:

```text
all | waiting | running
repo:<substr>
branch:<name>
cmd:<agent|shell|bun>
grep:<text>
```

Comma-separated clauses are ANDed:

```sh
tmux-session-picker list 'repo:xtmux,cmd:agent'
```

`grep:` captures pane text lazily only when the grep clause is active.

### Picker UI helpers

```sh
tmux-session-picker filter-menu
tmux-session-picker filter-clear
tmux-session-picker prompt-label
tmux-session-picker mode-toggle
tmux-session-picker border-label
tmux-session-picker mux-help
```

`filter` and `list-mode` UI state live outside the git cache under the picker
state dir, so lifecycle cache invalidation does not reset the active UI state.

### Act, rename, kill

```sh
tmux-session-picker act <type> <sid> <target> <approve|interrupt|message>
tmux-session-picker rename <type> <sid> <target>
tmux-session-picker rename-apply <type> <target> <name>
tmux-session-picker kill <type> <sid> <target>
tmux-session-picker kill-confirm <sid> <answer>
tmux-session-picker bulk-kill <rows...>
tmux-session-picker bulk-kill-confirm <answer> <sid...>
```

### Orchestrator/multiplexing commands

```sh
# agent-readable inventory
tmux-session-picker dashboard sessions-only
tmux-session-picker dashboard expanded

# read-only hygiene report
tmux-session-picker audit

# wait for one target to complete a fresh working cycle and consume its wake once
tmux-session-picker wait-agent %42 --wait-for-transition --consume --timeout 30m --interval 30s

# requester-owned background waits
tmux-session-picker monitor-agent %42 --wait-for-transition --timeout 30m --interval 30s
tmux-session-picker monitor-list --json
tmux-session-picker monitor-kill <id>

# safe handoff primitives
tmux-session-picker safe-send-pointer %42 'leggi /tmp/task.txt e seguilo'
tmux-session-picker safe-send-pointer --yes %42 'leggi /tmp/task.txt e seguilo'
# Claude Code target: auto-double-Enter. Force one-Enter behavior with --no-double-enter:
tmux-session-picker safe-send-pointer --yes --no-double-enter %42 '/compact'
# Bypass the slash/tmp payload check for a short course-correction. Multiline and
# shell-substitution guards STILL enforced. Without --yes, prints a confirmation banner
# showing exactly what is bypassed:
tmux-session-picker safe-send-pointer --force-freeform %42 'stop and check the migration order first'
# Correlate only after successful injection:
tmux-session-picker safe-send-pointer --yes --reply-to msg-123 %42 'leggi /tmp/reply.txt e seguilo' --json
tmux-session-picker handoff --target %42 --bead xtmux-mux.9 --note 'NO push'
tmux-session-picker handoff --yes --target %42 --bead xtmux-mux.9 --note 'NO push'

# worktree collision report
tmux-session-picker worktree-collisions

# runtime identity, session/window/pane inventory, bounded pane content
tmux-session-picker context --current --json          # who am I? (xtrm.runtime-origin.v1)
tmux-session-picker topology --json                   # complete host/session/window/pane snapshot
tmux-session-picker pane capture --pane %42 --lines 200 --json

# read-only NDJSON bridge over ssh — inspect a remote xtmux host with your own auth
ssh peer-host xtmux bridge --stdio                    # remote server, exchanges JSON-RPC on stdio

# event log
tmux-session-picker log emit custom.event pane=%42 bead=xtmux-team.1 text=hello
tmux-session-picker log tail 50
tmux-session-picker log query --type message.sent --bead xtmux-team.4 --since 1h
tmux-session-picker log query --after-id 1234 --limit 100 --json    # cursor-paged
tmux-session-picker log follow --after-id 1234 --json               # NDJSON stream

# SQLite-backed message channel: ack receipt, then reply explicitly
tmux-session-picker message-send --to worker --bead xtmux-team.4 --text 'blocked on data' --json
tmux-session-picker message-list --for worker --pane %42 --expects-reply --json
tmux-session-picker message-ack <messageKey> --by worker --json
tmux-session-picker message-reply --in-reply-to <messageKey> --text 'resolved' --json
tmux-session-picker message-cancel --message-key <messageKey> --json
tmux-session-picker message-status <messageKey> --json
tmux-session-picker unread-count --for worker --pane %42 --json
tmux-session-picker obligations list --pane %42 --json     # active reply obligations owned by this pane

# opt-in command telemetry; does not shadow git/bd/gh unless you alias it yourself
tmux-session-picker telemetry git -- commit -m 'message'
tmux-session-picker telemetry git -- push
tmux-session-picker telemetry bd -- close xtmux-team.7 --reason 'done'
tmux-session-picker telemetry gh -- pr create --fill
```

Important safety defaults:

- `safe-send-pointer` is dry-run unless `--yes`/`--send` is given.
- `safe-send-pointer` rejects:
  - working/running/busy/thinking targets
  - multiline payloads
  - backticks / `$()` shell substitution
  - inline instructions that do not reference `/tmp/...` or a slash command (bypass with `--force-freeform`; multiline + shell-substitution guards still enforced)
- `safe-send-pointer` auto-appends a second Enter after 2s when the target's `pane_current_command` is `claude` or `claude-*`, because Claude Code's paste-detection consumes the first. Override with `--no-double-enter` (never send a second), or force it on other pane types with `--double-enter`.
- `handoff` is dry-run unless `--yes`/`--send` is given.
- `handoff` refuses working targets before writing the prompt-file.
- `audit` is read-only.
- `message-send` commits a message and receipt to SQLite and updates tmux unread options only as a best-effort projection. It does not inject text into panes. `--bead` implies a reply obligation unless explicitly disabled. Acking the receipt never fulfils that obligation; only a correlated reply or owner cancellation does.
- Reply and wait mutations require the live requester session and pane. A monitor owned by another pane, or one older than the obligation it is meant to cover, cannot satisfy the gate. Timeouts return `124`; ownership, pane, endpoint, and duplicate-reply conflicts are structured errors with no partial mutation.
- `telemetry git|bd|gh` is explicit opt-in and forwards to the real command while logging start/end events.

### Maintenance

```sh
tmux-session-picker clear-cache
tmux-session-picker install-hooks [picker-path]
```

## Agent state hooks and metadata

See [`docs/agent-state-hooks.md`](docs/agent-state-hooks.md).

`scripts/agent-state.sh` writes pane-scoped tmux options. Existing hooks can keep
calling only the state argument:

```sh
~/.tmux/scripts/agent-state.sh running
~/.tmux/scripts/agent-state.sh needs-input
~/.tmux/scripts/agent-state.sh done
~/.tmux/scripts/agent-state.sh idle
~/.tmux/scripts/agent-state.sh off
```

Optional metadata env vars:

| env | tmux option | meaning |
|---|---|---|
| `XTMUX_AGENT_BEAD` | `@agent_bead` | current durable Beads task contract |
| `XTMUX_AGENT_TASK` | `@agent_task` | short human-readable task summary |
| `XTMUX_AGENT_PROMPT_FILE` | `@agent_prompt_file` | `/tmp/...` prompt file used for handoff |
| `XTMUX_AGENT_PARENT_SESSION` | `@agent_parent_session` | orchestrator tmux `#{session_id}` (e.g. `$3`) — stable, per-instance, never recycled; do not use `#S` (session name) |
| automatic | `@agent_last_transition` | ISO timestamp for last state transition |

`off` keeps `@agent_state=off` for compatibility and clears optional task
metadata so reused panes do not display stale bead/task pointers.

Claude Code can emit `running`, `needs-input`, `done`, and `off` via hooks. Pi is
supported through `extensions/pi-agent-state.ts` for `running`, `done`, `idle`,
and `off`; pi currently has no documented `needs-input` extension event. The pi
extension also listens for `turn_end`/`agent_end`: it logs `agent.turn.done` with
a compact `last_message`, and if `@agent_parent_session` is set it sends a short
`message.sent` update to the parent.

## Preview enrichment

Session and pane preview can show:

- session/root/cwd basics
- pane command/state/geometry
- capture-pane tail
- specialist metadata for `sp-*` sessions
- `agent-meta bead=... task=... parent=... prompt=... last=...`
- bounded `bd show` context for explicit or confidently derived bead ids
- `git-worktree branch=<branch> dirty=<count>`
- bounded `diff-stat` for dirty worktrees

Bead derivation is conservative: it only derives dot-number ids such as
`xtmux-rib.16` from session names or worktree/path conventions. Loose numeric
slugs are ignored.

## Event journal and message channel

Typed tables in `observability.db` are authoritative; `event_journal` is the
append-only forensic stream queried by `log tail`, `log query`, and `log follow`.
Message bodies are not copied into coordination lifecycle events.

Useful coordination events include `messages.sent`, `messages.ack`,
`messages.reply.linked`, `messages.reply.rejected`, `messages.cancelled`,
`wait.registered`, `wait.monitor.armed`, `wait.terminal`,
`wait.wake.delivered`, `wait.wake.consumed`, `wait.wake.orphan`, and
`wait.validation_failed`.

CLI:

```sh
tmux-session-picker log emit <type> key=value ...
tmux-session-picker log tail [n]
tmux-session-picker log query [--type t] [--pane %42] [--session s] [--bead id] [--since 1h] [--limit n]

tmux-session-picker message-send --to <session|pane> [--from sender] [--bead id] --text 'short update'
tmux-session-picker message-list --for <session|pane> [--pane %N] [--unacked] [--expects-reply] [--since 1h]
tmux-session-picker message-ack <messageKey> [--by session]
tmux-session-picker message-reply --in-reply-to <messageKey> --text 'result'
tmux-session-picker message-cancel --message-key <messageKey>

tmux-session-picker telemetry git -- <git-args...>
tmux-session-picker telemetry bd -- <bd-args...>
tmux-session-picker telemetry gh -- <gh-args...>
```

Use the message channel for short status updates between orchestrator/team panes
without scraping `capture-pane` or injecting text into another pane. Beads remain
the durable task contract. Pending replies and unconsumed wakes survive process
restart because Pi and Claude re-query SQLite; no runtime marker directory is
read, written, or cleaned during steady-state coordination.

Command telemetry is intentionally explicit. xtmux does not install aliases or
shadow `git`, `bd`, or `gh`. If an operator wants automatic logging in a pane,
they can opt in with shell aliases such as `alias git='tmux-session-picker telemetry git --'`.

## Dashboard TSV

`dashboard sessions-only` is the primary agent-readable inventory for
orchestrators:

```text
dashboard  mode  sessions-only
session    sid   name   state   bead   task   repo   branch   dirty   shared   idle   path
```

`dashboard expanded` also emits pane rows:

```text
pane  sid  session_name  pane_id  state  bead  task  command  path
```

This output is intended for scripts/agents. Use the interactive picker for human
navigation.

## Audit TSV

`audit` emits a read-only hygiene report:

```text
audit    read-only  warnings-and-cleanup-candidates
warning  dirty-worktree ...
warning  shared-worktree ...
warning  working-do-not-kill ...
warning  agent-pane-without-bead ...
warning  naming-convention ...
cleanup  missing-path ...
cleanup  stale-specialist ...
```

Warnings require operator judgment. Cleanup rows are candidates, not automatic
actions.

## Caches and state

| path | purpose |
|---|---|
| `${TMPDIR:-/tmp}/tmux-picker-cache-$UID/git-table` | path->git-root and root->status cache |
| `${TMPDIR:-/tmp}/tmux-picker-state-$UID/filter` | active `Ctrl-f` content filter |
| `${TMPDIR:-/tmp}/tmux-picker-state-$UID/list-mode` | `expanded` / `sessions-only` nesting mode |
| `${XDG_STATE_HOME:-$HOME/.local/state}/xtmux/observability.db` | authoritative messages, receipts, reply links, waits, monitors, and event journal |

The list output itself is never cached. Agent state and attention ranking are
always read fresh.

## Tuning

| env | default | effect |
|---|---|---|
| `TMUX_PICKER_GIT_CACHE_TTL` | `30` | seconds the git table is reused |
| `TMUX_PICKER_STALE_MINS` | `60` | idle threshold for stale session styling |
| `TMUX_PICKER_NO_CACHE` | `0` | `1` bypasses git cache; used by refresh |
| `TMUX_PICKER_AGENT` | `0` | `1` enables capture-pane agent-state inference fallback |
| `TMUX_PICKER_MODE` | `default` | `default`, `compact-wrap`, `compact-nowrap` |
| `TMUX_ASCII_ICONS` | `0` | `1` uses ASCII `br`/`path` instead of nerd font glyphs |
| `TMUX_GIT_TOPLEVEL` | — | caller-supplied repo root for `git-pane-status.sh` fast path |
| `XTMUX_AGENT_STATE_LOG` | `0` | `1` logs agent-state transitions for hook debugging |
| `XTMUX_AGENT_STATE_LOG_FILE` | `~/.cache/xtmux/agent-state.log` | legacy transition log path |
| `XTMUX_INBOX_POLL_INTERVAL_S` | `30` | Pi coordination SQLite refresh interval |
| `XTMUX_AUTO_MONITOR_TIMEOUT` | `8h` | Pi auto-monitor timeout |
| `XTMUX_AUTO_MONITOR_INTERVAL` | `60s` | Pi auto-monitor poll interval |

### Full monitoring terminal

Use the helper script to open a tmux monitoring layout:

```sh
scripts/xtmux-monitor.sh --full
# after install.sh:
xtmux-monitor --full
```

Useful flags:

```sh
xtmux-monitor --session muxmon --interval 2 --kill-existing
xtmux-monitor --messages docs --turns
xtmux-monitor --log /tmp/xtmux-events.jsonl --no-attach
```

Default layout shows dashboard, monitor/audit, and raw event log. `--full` adds
recent `agent.turn.done` events and git/bd/gh telemetry; if run inside tmux it
also adds unacked messages for the current session.

## Testing

```sh
make test
# regenerate status-line goldens after intentional output-contract changes:
make test-regen
```

Current validation at the time of this README update:

```text
116 pass, 0 fail
```

`test/contract.sh` covers:

- git status snapshots: clean, dirty, stash, ahead, non-repo, fast-path
- cache clearing and hook installation
- filter grammar and active filter state
- nesting mode state
- `agent-state.sh` no-op, validation, pane option, metadata, and clearing
- `wait-agent`, monitor registry, safe-send-pointer, handoff, dashboard, audit
- event log and log-backed message channel
- rename/kill/bulk-kill/act helper contracts
- live picker TSV shape and preview smoke
- specialist grouping/preview/waiting filter
- richer filter integration against live tmux sessions

Some legacy rename checks can print intermediate `FAIL rename: ...` lines inside
an isolated subshell in certain tmux environments, but the final suite summary is
the source of truth.

## Performance

See [`docs/perf-audit.md`](docs/perf-audit.md). Current measured headline from
that audit:

- warm list: ~122 ms
- cold build: ~484 ms
- preview: ~95 ms

Only the expensive git half is cached. Agent state, attention sort, badges,
filters, and dashboard/audit views are rendered from live tmux state.

## Current implementation status

Completed major epics/work:

- `xtmux-rib` v0.2 foundation and actionable picker work:
  - contract test harness
  - agent-state hooks
  - act-on-preview micro-actions
  - specialist awareness
  - cache invalidation
  - staleness badge
  - confirm-before-kill
  - inline rename
  - bulk multi-select
  - richer filters
  - sessions-only/expanded nesting
  - preview enrichment substrate
  - performance/cache split work
  - attention jump bindings
  - specialist section grouping
- `xtmux-mux` multiplexing-safe orchestration primitives:
  - `@agent_*` metadata
  - `wait-agent`
  - `safe-send-pointer`
  - bead-aware preview
  - worktree collision detector
  - dashboard TSV
  - monitor registry
  - audit report
  - handoff prompt workflow
  - `mux-help` / `?` cheatsheet

Known reverted/abandoned historical work:

- a `Ctrl-n` create-flow over worktrees/recent dirs was tried and reverted by
  operator request because it was noisy/confusing. It is not currently exposed.

Remaining open roadmap in Beads:

- `xtmux-rib.13` live preview: manual tap-to-refresh (`ctrl-t`) and optional
  auto-tick mode
- `xtmux-rib.14` frecency: recent/frequent sessions rank higher below the
  attention head
- `xtmux-rib.15` general picker help overlay (distinct from the multiplexing
  `mux-help` cheatsheet)
- `xtmux-team.5` `multiplexing-team` delegated-agent skill is maintained by xtrm; the npm package does not install skills
- `xtmux-team.6` pi runtime turn-done publishing via `agent.turn.done` + parent message
- `xtmux-team.7` opt-in `git`/`bd`/`gh pr` telemetry wrappers
- deeper Claude last-message hook integration remains future work if needed

Beads are the source of truth for current planning/status.
