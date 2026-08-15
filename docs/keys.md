# tmux keys

Copy these snippets into `~/.tmux.conf` after running `./install.sh`.

## nav drawer and classic picker

Recommended sidebar-style navigator (verified tmux 3.5a syntax):

```tmux
bind s display-popup -E -x 0 -y 0 -w 40% -h 75% 'XTMUX_NAV_WIDTH=$(tput cols) $HOME/.local/bin/xtmux nav'
```

Set width in tmux configuration rather than application state:

- 38–40% for the intended sidebar hierarchy
- 44–50% when session names need more room
- 55–60% on a small terminal

Change `40%` to tune the drawer, and `75%` to tune its height. `tput cols` runs
inside the popup. The nav launcher reserves eight cells for fzf's border and
selection gutter before it bounds rows; long names, branches, and tasks wrap
onto continuation lines instead of being cut. The `#222222` background uses a
terminal-dependent alpha (`@200`) for slight transparency on terminals that
support it. Nothing is bold; `%pane-id` and agent state labels differ by color only.

Keep a classic/full-screen rollback binding:

```tmux
bind S display-popup -E -w 99% -h 97% "$HOME/.local/bin/tmux-session-picker"
bind g display-popup -E -w 99% -h 97% "TMUX_PICKER_MODE=compact-wrap $HOME/.local/bin/tmux-session-picker"
bind G display-popup -E -w 99% -h 97% "TMUX_PICKER_MODE=compact-nowrap $HOME/.local/bin/tmux-session-picker"
```

`XTMUX_NAV_LAYOUT=classic xtmux nav` also selects the classic renderer. These
are optional prefix-table examples; xtmux does not install global bindings.

Inside nav, `▎` is the live tmux target and `›` is the fzf selection. Sessions
are grouped by attention, active, and other state. `Tab` toggles expanded/sessions-only,
`Ctrl-/` opens the hidden details inspector, and `?` shows all nav actions.

## native and xtmux traversal

```tmux
# tmux built-ins: previous, next, and last session
bind ( switch-client -p
bind ) switch-client -n
bind L switch-client -l

# optional discoverable xtmux wrappers
bind N run-shell '$HOME/.local/bin/xtmux nav next'
bind P run-shell '$HOME/.local/bin/xtmux nav prev'
bind A run-shell '$HOME/.local/bin/xtmux nav attention-next'
bind B run-shell '$HOME/.local/bin/xtmux nav back'
```

`nav attention-next` and `nav attention-prev` wrap the authoritative attention
order. `nav back` reuses `jump-back` state. Choose keys that do not collide with
your existing prefix table.

## attention jumps

Default policy: root-level binds (`bind -n`) for fast triage across agent panes.

```tmux
bind -n M-1 run-shell '~/.local/bin/tmux-session-picker attn-jump 1'
bind -n M-2 run-shell '~/.local/bin/tmux-session-picker attn-jump 2'
bind -n M-3 run-shell '~/.local/bin/tmux-session-picker attn-jump 3'
bind -n M-4 run-shell '~/.local/bin/tmux-session-picker attn-jump 4'
bind -n M-5 run-shell '~/.local/bin/tmux-session-picker attn-jump 5'
bind -n M-` run-shell '~/.local/bin/tmux-session-picker jump-back'
```

- `Alt-1`..`Alt-5` jumps to the Nth waiting pane from the live attention list.
- ``Alt-` `` runs `jump-back`, returning to the pane that was active before the
  last `attn-jump`.
- tmux names the backtick/grave key as `` M-` `` in config; `M-grave` is not a valid
  tmux key name.

## collision policy

`Alt-1`..`Alt-5` are intentionally root-level so they work without pressing the
prefix. That is useful when supervising many agents, but it also means tmux sees
those keys before foreground TUIs such as browsers, IRC clients, shells, or
editor plugins that use `Alt-digit`.

If a foreground program needs `Alt-digit`, prefer a prefix-gated variant:

```tmux
bind 1 run-shell '~/.local/bin/tmux-session-picker attn-jump 1'
bind 2 run-shell '~/.local/bin/tmux-session-picker attn-jump 2'
bind 3 run-shell '~/.local/bin/tmux-session-picker attn-jump 3'
bind 4 run-shell '~/.local/bin/tmux-session-picker attn-jump 4'
bind 5 run-shell '~/.local/bin/tmux-session-picker attn-jump 5'
bind ` run-shell '~/.local/bin/tmux-session-picker jump-back'
```

The prefix-gated variant is safer for applications, but it can override tmux's
built-in `prefix 1`..`prefix 5` window selection if your config still relies on
those keys.

## conflict notes

- The root-level attention binds do not overlap with `prefix s`, `prefix g`, or
  `prefix G` picker popup binds.
- They do not overlap with common tmux-resurrect defaults (`prefix Ctrl-s` save,
  `prefix Ctrl-r` restore) because they live in the root key table.
- tmux has built-in prefix-table `M-1`..`M-5` layout binds; the snippets above
  bind root-table `M-1`..`M-5`, so `prefix Alt-1` layout selection remains
  separate unless your config changes it.
