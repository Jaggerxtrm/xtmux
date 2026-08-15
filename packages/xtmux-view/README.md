# @jaggerxtrm/xtmux-view

Rich Markdown overlays for completed Claude Code, Pi, and Codex turns managed by xtmux.

This package is deliberately separate from `xtmux nav`. The picker remains a navigation index. `xtmux-view` is a presentation layer over the raw agent TUIs.

## Architecture

```text
Claude / Pi / Codex
        │
        │ existing xtmux hooks/extensions
        ▼
agent_turns.last_message_text
        │
        │ one read-only SQLite query
        ▼
@jaggerxtrm/xtmux-view
        │
        ├─ Glow Markdown TUI
        └─ raw Markdown fallback
        │
        ▼
tmux display-popup over the still-running agent pane
```

The package does **not** use `capture-pane`, scrape ANSI output, mutate the xtmux database, poll the agent process, or participate in picker rendering.

## Requirements

- xtmux with full assistant-turn capture (`agent_turns.last_message_text`; targeted for xtmux v0.3.0)
- Bun
- tmux for popup mode
- [Glow](https://github.com/charmbracelet/glow) >= 2.1.0 for rich Markdown rendering (`--tui`)

Glow is intentionally an external renderer rather than reimplemented here. This package owns runtime/session integration, not Markdown layout technology.

## Local install

From the xtmux repository:

```bash
cd packages/xtmux-view
bun link
```

Install Glow with your platform package manager, for example:

```bash
brew install glow
```

Then verify the environment:

```bash
xtmux-view doctor
```

## Usage

From an xtmux-managed Claude, Pi, or Codex pane:

```bash
xtmux-view
```

This opens the latest completed assistant turn in a tmux popup while the underlying TUI remains untouched.

Target another pane or stable session explicitly:

```bash
xtmux-view '%553'
xtmux-view '$42'
```

Inspect the normalized source without rendering:

```bash
xtmux-view --raw '%553'
xtmux-view --json '%553'
```

Render in the current terminal instead of creating a popup:

```bash
xtmux-view --no-popup '%553'
```

## Suggested tmux binding

```tmux
# Rich view for the pane that owns the current key context.
bind m run-shell 'xtmux-view "#{pane_id}"'
```

The package also accepts popup sizing through environment variables:

```bash
XTMUX_VIEW_POPUP_WIDTH=88%
XTMUX_VIEW_POPUP_HEIGHT=90%
XTMUX_VIEW_GLOW_STYLE=dark
```

## Runtime behavior

`xtmux-view` always reads the latest completed turn for a canonical `%pane` or `$session` id. Pane ids remain visible in the rendered document because they are operational handles for multiplexing and inter-agent communication.

The package uses the existing unified xtmux turn capture:

- Claude Code: Stop hook parses the structured transcript and stores the full assistant text.
- Pi: native extension publishes the full assistant turn at `agent_end`.
- Codex: lifecycle hook publishes the full assistant turn.

No runtime-specific transcript parsing belongs in this package unless the xtmux turn-capture contract cannot supply the content.

## Security and performance

The database is opened read-only. Targets are restricted to canonical `%N` and `$N` identities. Assistant content is never interpolated into a shell command and terminal control bytes are stripped before display. The rich renderer receives a mode-0600 temporary Markdown file which is deleted when the renderer exits.

The normal path performs one indexed SQLite read plus one Glow TUI process. It does not enumerate tmux panes, invoke git, scan process trees, or affect picker latency.

## Scope

v0.1 intentionally provides only the last completed turn. Future work can add transcript navigation and follow mode while preserving the same read-only boundary. Mermaid blocks remain Markdown source unless the selected renderer gains a terminal-safe Mermaid backend; this package does not rasterize them in v0.1.
