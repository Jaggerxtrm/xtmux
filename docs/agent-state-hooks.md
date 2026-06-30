# agent state hooks

xtmux reads a tmux pane option named `@agent_state` to render `[WAIT]`, `[RUN]`,
`[DONE]`, and `[idle]` badges and to rank attention targets.

the contract is deliberately tiny:

```sh
~/.tmux/scripts/agent-state.sh <running|needs-input|done|idle|off>
```

the script writes the state to the current pane (`$TMUX_PANE`):

```sh
tmux set-option -p -t "$TMUX_PANE" @agent_state <state>
```

outside tmux it exits successfully without doing anything, so hooks are safe to
install globally.

## install shared script

from this repo:

```sh
./install.sh
```

this symlinks:

- `scripts/agent-state.sh` -> `~/.tmux/scripts/agent-state.sh`

manual check from inside a tmux pane:

```sh
~/.tmux/scripts/agent-state.sh needs-input
tmux display-message -p '#{@agent_state}'   # needs-input
~/.tmux/scripts/agent-state.sh off
```

### auditing hook firing order

when wiring hooks for an orchestrator, set this env to record every transition
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

the `CLAUDE_HOOK_EVENT=...` prefix in the example commands populates the third
column. off by default.

## claude code

claude code supports JSON command hooks. merge the following into your claude
settings (global `~/.claude/settings.json` or project-local `.claude/settings.json`).
don't replace existing hooks; append these entries alongside them. the
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

the full set (with `CLAUDE_HOOK_EVENT` tags for the audit log) lives at
`examples/claude/settings.agent-state.json`.

### claude state mapping

| claude event | `@agent_state` |
|---|---|
| `SessionStart` | `idle` |
| `UserPromptSubmit` | `running` |
| `PreToolUse` | `running` |
| `Notification` | `needs-input` |
| `PostToolUse` | `running` |
| `Stop` | `done` |
| `SubagentStop` | `done` |
| `SessionEnd` | `off` |

### why both `PreToolUse` and `PostToolUse` map to `running`

this is what keeps the WAIT badge honest for orchestrators / multiplexing:

- `Notification` fires when claude needs permission (or otherwise needs a human).
  that sets `needs-input` -> `[WAIT]`.
- if the user **approves**, claude resumes and the tool executes. `PostToolUse`
  fires and resets the pane to `running`, so `[WAIT]` is cleared the instant the
  blockage is gone — not stuck until the next prompt or `Stop`.
- `PreToolUse` reinforces the busy signal at the start of every tool.

**invariant:** `[WAIT]` <=> the agent is blocked right now and no tool is
completing. an orchestrator that jumps to `[WAIT]` panes will never land on a
pane that is actively working. without `PostToolUse`, a stale `[WAIT]` could
persist while claude is busy again, which is exactly the multiplexing failure
mode to avoid.

`Notification` is broader than only permission waits, but combined with the
`PostToolUse` reset it is a safe "this pane needs user attention" signal.

## pi

pi does **not** use claude-style `settings.json` hooks. it uses typescript
extensions discovered from these locations:

- `~/.pi/agent/extensions/*.ts`
- `~/.pi/agent/extensions/*/index.ts`
- `.pi/extensions/*.ts` (project-local, after project trust)
- `.pi/extensions/*/index.ts` (project-local, after project trust)

install the shipped extension globally:

```sh
mkdir -p ~/.pi/agent/extensions
ln -sf "$PWD/extensions/pi-agent-state.ts" ~/.pi/agent/extensions/xtmux-agent-state.ts
```

or reference it from pi `settings.json` via the documented `extensions` array:

```json
{
  "extensions": ["/absolute/path/to/xtmux/extensions/pi-agent-state.ts"]
}
```

the extension is self-contained typescript (no npm install needed) and calls the
shared script with `pi.exec(...)`. override the script path if needed:

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

### known pi limitation: no documented `needs-input` event

pi v0.80.1 extension docs expose lifecycle, agent, message, tool, user bash, and
input events, but they do not document an event for "awaiting permission" or
"awaiting user input". that means the shipped pi extension can accurately write
`running`, `done`, `idle`, and `off`, but cannot currently emit `needs-input`
without relying on undocumented internals or polling UI state.

for now, use `TMUX_PICKER_AGENT=1` if you want heuristic WAIT detection for pi
panes. claude code can emit `needs-input` via `Notification`.

## codex

a minimal codex hook example is in `examples/codex/hooks.agent-state.json`. it
sets `running` on `UserPromptSubmit` and `idle` on `SessionStart`, matching the
hook event names already used by this repo's `.codex/hooks.json`.

codex WAIT/DONE event coverage is intentionally not asserted here because this
repo currently has no verified codex equivalent for claude `Notification`/`Stop`.
