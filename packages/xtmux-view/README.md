# @jaggerxtrm/xtmux-view

Rich Markdown overlays for completed Claude Code, Pi, and Codex turns managed by xtmux.

This package is deliberately separate from `xtmux nav`. The picker remains a navigation index. `xtmux-view` is a presentation layer over the raw agent TUIs.

## Architecture

```text
Claude / Pi / Codex
        │
        │ existing xtmux hooks/extensions
        ▼
agent_episodes + agent_turns.episode_id
        │ (response episodes: one user prompt + all continuations)
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

- xtmux with response-episode capture (`agent_episodes` + `agent_turns.episode_id`, migration 0014; targeted for xtmux v0.3.0). Against an older schema the viewer degrades to the previous single-row read.
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

This opens the latest completed response episode in a tmux popup while the underlying TUI remains untouched.

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

`xtmux-view` always reads the **latest response episode** for a canonical `%pane` or `$session` id. An episode is one user prompt plus all Claude continuations caused before control returns to the operator (Stop-hook block follow-ups); its `agent_turns` rows are candidates. The rendered document is conservative by contract:

- the first substantive candidate is the **primary response**;
- later substantive candidates render as **follow-up** sections;
- short hook acknowledgements ("Acknowledged.") are **collapsed** into a footer and never replace the primary — a response holding a Mermaid diagram survives a later short Stop candidate.

Pane ids remain visible in the rendered document because they are operational handles for multiplexing and inter-agent communication.

The package uses the existing unified xtmux turn capture:

- Claude Code: UserPromptSubmit hook opens the episode; the Stop hook stores each turn's full assistant text as a candidate (`last_assistant_message` preferred, transcript fallback).
- Pi: native extension publishes the full assistant turn at `agent_end`.
- Codex: lifecycle hook publishes the full assistant turn.

No runtime-specific transcript parsing belongs in this package unless the xtmux turn-capture contract cannot supply the content.

## Security and performance

The database is opened read-only. Targets are restricted to canonical `%N` and `$N` identities. Assistant content is never interpolated into a shell command and terminal control bytes are stripped before display. The rich renderer receives a mode-0600 temporary Markdown file which is deleted when the renderer exits.

The normal path performs one indexed SQLite read plus one Glow TUI process. It does not enumerate tmux panes, invoke git, scan process trees, or affect picker latency.

## Scope

v0.1 renders the latest response episode only. Future work can add transcript navigation and follow mode while preserving the same read-only boundary. Mermaid blocks remain Markdown source unless the selected renderer gains a terminal-safe Mermaid backend; this package does not rasterize them in v0.1.
