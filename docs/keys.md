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
inside the popup. The nav launcher reserves four cells for fzf's borderless
selection/marker gutter before it bounds rows; long names, branches, and tasks are
truncated deterministically (machine identity always survives; full values stay
in the details inspector). The `#222222` background uses a
terminal-dependent alpha (`@200`) for slight transparency on terminals that
support it. The palette is restrained (neutral primary, one cool accent,
one amber attention, one restrained red for danger; run/done/idle neutral) and
nothing is bold — `%pane-id` and agent state labels are styled by color, never
by bold.

Keep a classic/full-screen rollback binding:

```tmux
bind S display-popup -E -w 99% -h 97% "$HOME/.local/bin/tmux-session-picker"
bind g display-popup -E -w 99% -h 97% "TMUX_PICKER_MODE=compact-wrap $HOME/.local/bin/tmux-session-picker"
bind G display-popup -E -w 99% -h 97% "TMUX_PICKER_MODE=compact-nowrap $HOME/.local/bin/tmux-session-picker"
```

`XTMUX_NAV_LAYOUT=classic xtmux nav` also selects the classic renderer. These
are optional prefix-table examples; xtmux does not install global bindings.

Inside nav, `▎` marks the current session (the pane the operator is attached
to); the current window and pane get the cool accent, and `>` is the fzf
selection (distinct from running state). Sessions
are grouped by urgent, active, and other state. `Tab` toggles compact <-> expanded
topology — compact shows session rows only, expanded shows session → window →
pane (it does not merely hide/show pane rows). `Ctrl-/` opens the hidden details
inspector, and `?` shows all nav actions.

Window rows show `@window-id` intact plus truncatable `index:name`, the
pane→window aggregate state, and the pane count. `Enter` on a window row selects
that exact window; `Alt-r` renames it and `Alt-x` kills it. Pane-only actions
(approve/interrupt/message) on a window row are refused with a bounded message.

## native and xtmux traversal

```tmux
# tmux built-ins: previous, next, and last session
bind ( switch-client -p
bind ) switch-client -n
bind L switch-client -l

# optional discoverable xtmux wrappers
bind N run-shell '$HOME/.local/bin/xtmux nav next'
bind P run-shell '$HOME/.local/bin/xtmux nav prev'
bind W run-shell '$HOME/.local/bin/xtmux nav window-next'
bind Q run-shell '$HOME/.local/bin/xtmux nav window-prev'
bind A run-shell '$HOME/.local/bin/xtmux nav attention-next'
bind B run-shell '$HOME/.local/bin/xtmux nav back'
```

`nav attention-next` and `nav attention-prev` wrap the authoritative attention
order. `nav window-next` and `nav window-prev` invoke the native tmux
next-window/previous-window operations for the current client's session (single
tmux call, no inventory, wraps around). `nav back` reuses `jump-back` state.
Choose keys that do not collide with your existing prefix table.

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
