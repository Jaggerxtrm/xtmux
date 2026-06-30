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

### Auditing hook firing order

When wiring hooks for an orchestrator, set this env to record every transition
to a log so you can confirm the ordering (e.g. that `PostToolUse` clears a stale
`[WAIT]`) on real agent runs:

```sh
export XTMUX_AGENT_STATE_LOG=1
export XTMUX_AGENT_STATE_LOG_FILE=/tmp/agent-state.log
claude   # then in another shell:
tail -f /tmp/agent-state.log
# 2026-06-30T15:25:...+02:00	%559	UserPromptSubmit	running
# 2026-06-30T15:25:...+02:00	%559	Notification	needs-input
# 2026-06-30T15:25:...+02:00	%559	PostToolUse	running
```

The `CLAUDE_HOOK_EVENT=...` prefix in the example commands populates the third
column. Off by default.

## Claude Code

Claude Code supports JSON command hooks. Merge the following into your Claude
settings (global `~/.claude/settings.json` or project-local `.claude/settings.json`).
Do not replace existing hooks; append these entries alongside them. The
`PreToolUse`/`PostToolUse` -> `running` entries are what keep `[WAIT]` honest for
orchestrators (see the state mapping below).

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "CLAUDE_HOOK_EVENT=SessionStart ~/.tmux/scripts/agent-state.sh idle" }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "CLAUDE_HOOK_EVENT=UserPromptSubmit ~/.tmux/scripts/agent-state.sh running" }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "CLAUDE_HOOK_EVENT=PreToolUse ~/.tmux/scripts/agent-state.sh running" }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "CLAUDE_HOOK_EVENT=Notification ~/.tmux/scripts/agent-state.sh needs-input" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "CLAUDE_HOOK_EVENT=PostToolUse ~/.tmux/scripts/agent-state.sh running" }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "CLAUDE_HOOK_EVENT=Stop ~/.tmux/scripts/agent-state.sh done" }
        ]
      }
    ],
    "SubagentStop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "CLAUDE_HOOK_EVENT=SubagentStop ~/.tmux/scripts/agent-state.sh done" }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "CLAUDE_HOOK_EVENT=SessionEnd ~/.tmux/scripts/agent-state.sh off" }
        ]
      }
    ]
  }
}
```

The full set (with `CLAUDE_HOOK_EVENT` tags for the audit log) lives at
`examples/claude/settings.agent-state.json`.

### Claude state mapping

| Claude event | `@agent_state` |
|---|---|
| `SessionStart` | `idle` |
| `UserPromptSubmit` | `running` |
| `PreToolUse` | `running` |
| `Notification` | `needs-input` |
| `PostToolUse` | `running` |
| `Stop` | `done` |
| `SubagentStop` | `done` |
| `SessionEnd` | `off` |

### Why both `PreToolUse` and `PostToolUse` map to `running`

This is what keeps the WAIT badge honest for orchestrators / multiplexing:

- `Notification` fires when Claude needs permission (or otherwise needs a human).
  That sets `needs-input` -> `[WAIT]`.
- If the user **approves**, Claude resumes and the tool executes. `PostToolUse`
  fires and resets the pane to `running`, so `[WAIT]` is cleared the instant the
  blockage is gone — not stuck until the next prompt or `Stop`.
- `PreToolUse` reinforces the busy signal at the start of every tool.

**Invariant:** `[WAIT]` ⟺ the agent is blocked right now and no tool is
completing. An orchestrator that jumps to `[WAIT]` panes will never land on a
pane that is actively working. Without `PostToolUse`, a stale `[WAIT]` could
persist while Claude is busy again, which is exactly the multiplexing failure
mode to avoid.

`Notification` is broader than only permission waits, but combined with the
`PostToolUse` reset it is a safe "this pane needs user attention" signal.

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

The extension is self-contained TypeScript (no npm install needed) and calls the
shared script with `pi.exec(...)`. Override the script path if needed:

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
input events, but they do not document an event for "awaiting permission" or
"awaiting user input". That means the shipped pi extension can accurately write
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
