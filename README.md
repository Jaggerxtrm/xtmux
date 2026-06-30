# xtmux

An fzf-driven tmux session & pane picker with agent awareness, git-rich rows,
attention ranking, and live preview. Bash, no dependencies beyond `tmux` + `fzf`
(+ `git` for repo annotations).

## Files

| Path | Role |
|---|---|
| `bin/tmux-session-picker` | The picker: list / preview / jump / kill / attention flows |
| `scripts/git-pane-status.sh` | Per-path git status line (also used by the tmux status bar) |
| `scripts/agent-state.sh` | Shared hook target that writes pane `@agent_state` |

`git-pane-status.sh` is shared: the picker calls it for repo rows, and the tmux
status line calls it directly. Its CLI/output contract is stable.

## Install

Symlinks the three files into their live locations (idempotent; backs up any
existing real file first):

```sh
./install.sh
```

Live paths:

- `~/.local/bin/tmux-session-picker`  →  `bin/tmux-session-picker`
- `~/.tmux/scripts/git-pane-status.sh`  →  `scripts/git-pane-status.sh`
- `~/.tmux/scripts/agent-state.sh`  →  `scripts/agent-state.sh`

Then bind in `~/.tmux.conf`:

```tmux
bind s display-popup -E -w 99% -h 97% "$HOME/.local/bin/tmux-session-picker"
# optional compact modes
bind g display-popup -E -w 99% -h 97% "TMUX_PICKER_MODE=compact-wrap $HOME/.local/bin/tmux-session-picker"
bind G display-popup -E -w 99% -h 97% "TMUX_PICKER_MODE=compact-nowrap $HOME/.local/bin/tmux-session-picker"
```

## tmux keys

| Key | Action |
|---|---|
| `prefix s` | Open picker (default) |
| `prefix g` | Open picker (compact-wrap) |
| `prefix G` | Open picker (compact-nowrap) |

## fzf keys (inside the picker)

| Key | Action |
|---|---|
| `Enter` | Switch client to session/pane |
| `Alt-Enter` | Attach in a new popup client |
| `Alt-x` | Kill session/pane |
| `Alt-p` | Toggle wide preview |
| `Ctrl-a` / `Ctrl-w` / `Ctrl-e` | Filter: all / waiting / running |
| `Ctrl-r` | Force refresh (bypasses cache) |
| `Ctrl-/` | Toggle preview |

## CLI

```sh
tmux-session-picker list [all|waiting|running]
tmux-session-picker preview <type> <sid> <name> <target>
tmux-session-picker popup   <type> <sid> <target>
tmux-session-picker jump    <type> <sid> <target>
tmux-session-picker kill    <type> <sid> <target>
tmux-session-picker attn-jump <n>
tmux-session-picker jump-back
```

## Agent state hooks

See [`docs/agent-state-hooks.md`](docs/agent-state-hooks.md). Claude Code can emit `running`, `needs-input`, `done`, and `off`; pi is supported via `extensions/pi-agent-state.ts` for `running`, `done`, `idle`, and `off` (pi has no documented `needs-input` extension event yet).

## Tuning

| Env | Default | Effect |
|---|---|---|
| `TMUX_PICKER_GIT_CACHE_TTL` | `30` | Seconds the git table (path→root, root→status) is reused |
| `TMUX_PICKER_NO_CACHE` | `0` | `1` bypasses the git cache (forces full git re-resolve; used by `Ctrl-r`) |
| `TMUX_PICKER_AGENT` | `0` | `1` enables capture-pane agent-state inference |
| `TMUX_PICKER_MODE` | `default` | `default` / `compact-wrap` / `compact-nowrap` |
| `TMUX_ASCII_ICONS` | `0` | `1` uses ASCII `br`/`path` instead of Nerd Font glyphs |
| `TMUX_GIT_TOPLEVEL` | — | Caller-supplied repo root; skips a `rev-parse` in the status script |

## Testing

```sh
make test
# or regenerate status-line goldens after an intentional output-contract change:
make test-regen
```

`test/contract.sh` checks:

- deterministic `scripts/git-pane-status.sh` golden snapshots for clean, dirty,
  stash, ahead, non-repo, and `TMUX_GIT_TOPLEVEL` fast-path cases
- `scripts/agent-state.sh` no-op/validation/live pane-option write
- live `tmux-session-picker list` TSV shape (`type sid name target display`)
- live preview smoke and bad-argument exit behavior

## Performance

See [`docs/perf-audit.md`](docs/perf-audit.md). Current measured headline:
warm list ~122 ms (fresh — agent state read live), cold build ~484 ms,
preview ~95 ms.

The list output is **never** cached as a whole — only the expensive, near-static
git half (path→root, root→status) is cached. Agent state (`@agent_state`) and the
attention sort/badges derived from it are always fresh, so a pane flipping to
`needs-input` is reflected immediately.

## Roadmap

Tracked in beads. Themes: act-on-preview (send-keys), create flow (worktree/new
session), live preview, specialist (`sp-*`) awareness, frecency, staleness
badges, bulk multi-select, confirm-before-kill, cache-invalidation hooks.
