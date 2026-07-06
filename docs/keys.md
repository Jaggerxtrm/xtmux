# tmux keys

Copy these snippets into `~/.tmux.conf` after running `./install.sh`.

## picker popup

```tmux
bind s display-popup -E -w 99% -h 97% "$HOME/.local/bin/tmux-session-picker"
bind g display-popup -E -w 99% -h 97% "TMUX_PICKER_MODE=compact-wrap $HOME/.local/bin/tmux-session-picker"
bind G display-popup -E -w 99% -h 97% "TMUX_PICKER_MODE=compact-nowrap $HOME/.local/bin/tmux-session-picker"
```

These are prefix-table binds (`prefix s`, `prefix g`, `prefix G`).

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
