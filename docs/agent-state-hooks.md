# Agent state hooks

`xtmux` reads a tmux pane option named `@agent_state` to render `[WAIT]`,
`[RUN]`, `[DONE]`, and `[idle]` badges and to rank attention targets.

The contract is deliberately tiny:

```sh
~/.tmux/scripts/agent-state.sh <running|needs-input|done|idle|off>
```

The script writes the state to the current pane (`$TMUX_PANE`):

```sh
tmux set-option -p -t "$TMUX_PANE" @agent_state <state>
```

Outside tmux it exits successfully without doing anything, so hooks are safe to
install globally.

## Install shared script

From this repo:

```sh
./install.sh
```

This symlinks:

- `scripts/agent-state.sh` -> `~/.tmux/scripts/agent-state.sh`

Manual check from inside a tmux pane:

```sh
~/.tmux/scripts/agent-state.sh needs-input
tmux display-message -p '#{@agent_state}'   # needs-input
~/.tmux/scripts/agent-state.sh off
```

## Claude Code

Claude Code supports JSON command hooks. Merge the following into your Claude
settings (global `~/.claude/settings.json` or project-local `.claude/settings.json`).
Do not replace existing hooks; append these entries alongside them.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "~/.tmux/scripts/agent-state.sh running" }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "~/.tmux/scripts/agent-state.sh needs-input" }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "~/.tmux/scripts/agent-state.sh done" }
        ]
      }
    ],
    "SubagentStop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "~/.tmux/scripts/agent-state.sh done" }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "~/.tmux/scripts/agent-state.sh off" }
        ]
      }
    ]
  }
}
```

A complete example lives at `examples/claude/settings.agent-state.json`.

### Claude state mapping

| Claude event | `@agent_state` |
|---|---|
| `UserPromptSubmit` | `running` |
| `Notification` | `needs-input` |
| `Stop` | `done` |
| `SubagentStop` | `done` |
| `SessionEnd` | `off` |

`Notification` is broader than only permission/input waits, but it is the useful
Claude Code signal for “this pane needs user attention”.

## pi

pi does **not** use Claude-style `settings.json` hooks. It uses TypeScript
extensions discovered from these locations:

- `~/.pi/agent/extensions/*.ts`
- `~/.pi/agent/extensions/*/index.ts`
- `.pi/extensions/*.ts` (project-local, after project trust)
- `.pi/extensions/*/index.ts` (project-local, after project trust)

Install the shipped extension globally:

```sh
mkdir -p ~/.pi/agent/extensions
ln -sf "$PWD/extensions/pi-agent-state.ts" ~/.pi/agent/extensions/xtmux-agent-state.ts
```

Or reference it from pi `settings.json` via the documented `extensions` array:

```json
{
  "extensions": ["/absolute/path/to/xtmux/extensions/pi-agent-state.ts"]
}
```

The extension is self-contained TypeScript (no npm install needed) and calls the shared script with `pi.exec(...)`. Override the script
path if needed:

```sh
XTMUX_AGENT_STATE_SCRIPT=/custom/path/agent-state.sh pi
```

### pi state mapping

| pi event | `@agent_state` |
|---|---|
| `session_start` | `idle` |
| `before_agent_start` | `running` |
| `agent_start` | `running` |
| `message_update` | `running` |
| `tool_execution_start` | `running` |
| `agent_end` | `done` |
| `session_shutdown` with reason `quit` | `off` |
| `session_shutdown` with other reasons | `idle` |

### Known pi limitation: no documented `needs-input` event

pi v0.80.1 extension docs expose lifecycle, agent, message, tool, user bash, and
input events, but they do not document an event for “awaiting permission” or
“awaiting user input”. That means the shipped pi extension can accurately write
`running`, `done`, `idle`, and `off`, but cannot currently emit `needs-input`
without relying on undocumented internals or polling UI state.

For now, use `TMUX_PICKER_AGENT=1` if you want heuristic WAIT detection for pi
panes. Claude Code can emit `needs-input` via `Notification`.

## Codex

A minimal Codex hook example is in `examples/codex/hooks.agent-state.json`. It
sets `running` on `UserPromptSubmit` and `idle` on `SessionStart`, matching the
hook event names already used by this repo's `.codex/hooks.json`.

Codex WAIT/DONE event coverage is intentionally not asserted here because this
repo currently has no verified Codex equivalent for Claude `Notification`/`Stop`.
