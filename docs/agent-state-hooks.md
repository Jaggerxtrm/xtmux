# agent state hooks

xtmux reads a tmux pane option named `@agent_state` to render `[wait]`, `[run]`,
`[done]`, and `[idle]` badges and to rank attention targets.

the state contract is deliberately tiny:

```sh
~/.tmux/scripts/agent-state.sh <running|needs-input|done|idle|off>
```

the script writes the state to the current pane (`$TMUX_PANE`):

```sh
tmux set-option -p -t "$TMUX_PANE" @agent_state <state>
```

outside tmux it exits successfully without doing anything, so hooks are safe to
install globally.

## orchestration metadata

for multiplexing/orchestrator workflows, the same script also standardizes these
pane-scoped tmux user options:

| option | source env | meaning |
|---|---|---|
| `@agent_state` | first CLI arg | structured lifecycle state: `running`, `needs-input`, `done`, `idle`, `off` |
| `@agent_bead` | `XTMUX_AGENT_BEAD` | current durable task contract, if any |
| `@agent_task` | `XTMUX_AGENT_TASK` | short human-readable task summary |
| `@agent_prompt_file` | `XTMUX_AGENT_PROMPT_FILE` | `/tmp/...` prompt-file pointer used for safe handoff |
| `@agent_parent_session` | `XTMUX_AGENT_PARENT_SESSION` | orchestrator tmux session that delegated the work |
| `@agent_last_transition` | automatic | ISO timestamp for the latest state transition |

metadata env vars are optional and backward-compatible: if a hook only calls
`agent-state.sh running`, existing metadata is left alone. `agent-state.sh off`
keeps `@agent_state=off` for compatibility and clears optional task metadata so
reused panes do not show stale bead/task pointers.

example:

```sh
XTMUX_AGENT_BEAD=xtmux-mux.1 \
XTMUX_AGENT_TASK='standardize agent metadata' \
XTMUX_AGENT_PROMPT_FILE=/tmp/orch-metadata.txt \
XTMUX_AGENT_PARENT_SESSION=orchestrator \
~/.tmux/scripts/agent-state.sh running
```

the picker consumes missing metadata safely. pane rows may show compact metadata
badges such as `bead:xtmux-mux.1 task:... from:orchestrator`; pane/session preview shows
the full metadata line when present. when `@agent_bead` is set and `bd` can read
that bead from the pane cwd, preview also includes a bounded `bd show` summary.
when metadata is absent, preview conservatively derives bead ids only from
confident dot-number conventions such as `xtmux-rib.16` in the session name or
worktree path. invalid or unavailable beads degrade to a short `(not found)` /
`(bd unavailable)` line instead of breaking preview. git worktree previews also
show dirty file count and a bounded diff stat.

orchestrators can wait for a delegated pane to become safe-to-inspect with:

```sh
tmux-session-picker wait-agent %42 --timeout 30m --interval 30s
```

`wait-agent` prefers `@agent_state`; when the option is absent, it falls back to
the same lightweight UI inference used by the picker. a successful exit means the
pane is no longer `running` / `working` / `busy` / `thinking`; callers should
still rerun their pre-flight before any `send-keys`.

for the actual handoff keystroke, use the dry-run-first safe wrapper:

```sh
tmux-session-picker safe-send-pointer %42 'leggi /tmp/task.txt e seguilo'
# inspect printed tmux send-keys command, then:
tmux-session-picker safe-send-pointer --yes %42 'leggi /tmp/task.txt e seguilo'
```

`safe-send-pointer` rejects working targets, multiline payloads, shell command
substitution/backticks, and non-pointer inline instructions. accepted payloads
are slash commands or single-line text that references a `/tmp/...` prompt file.

for monitors that should remain visible to the orchestrator, start a registered
background monitor instead of a one-shot wait:

```sh
tmux-session-picker monitor-agent %42 --timeout 30m --interval 30s
tmux-session-picker monitor-list
tmux-session-picker monitor-kill <id>
```

active monitor records are stored under the picker state dir and removed when the
monitor completes or is killed.

Pi `extensions/pi-agent-state.ts` also publishes `agent.turn.done` on `agent_end`, including a compact last assistant message when the pi `turn_end`/`agent_end` event payload exposes it. If `@agent_parent_session` is set, it emits a short log-backed `message.sent` to the parent.

state transitions and orchestration actions are also written to the xtmux JSONL
event log (default `${XDG_STATE_HOME:-$HOME/.local/state}/xtmux/events.jsonl`,
override with `XTMUX_EVENT_LOG_FILE`). Use:

```sh
tmux-session-picker log tail 50
tmux-session-picker log query --pane %42 --since 1h
tmux-session-picker message-send --to orchestrator --bead xtmux-team.4 --text 'done; notes in bead'
tmux-session-picker message-list --for orchestrator --unacked
```

press `?` in the picker (or run `tmux-session-picker mux-help`) for a concise
multiplexing-safe delegation cheatsheet.

for assisted delegation, generate the bead + `/tmp` pointer handoff without sending by default:

```sh
tmux-session-picker handoff --target %42 --bead xtmux-mux.9 --note 'NO push'
# inspect prompt-file and printed command, then add --yes if desired
```

`handoff` creates the prompt-file, keeps the bead as the durable contract, prints
the exact `safe-send-pointer --yes` command, and refuses working targets before
creating the prompt file.

for end-of-session hygiene, run the read-only audit report:

```sh
tmux-session-picker audit
```

it emits `warning` rows for dirty/shared/working/naming/agent-without-bead cases
and `cleanup` rows for safer candidates such as missing paths or stale specialist
sessions.

before delegating multiple agents, check checkout sharing:

```sh
tmux-session-picker worktree-collisions
```

it prints `shared-worktree` TSV rows for git worktrees used by more than one live
session. the picker also adds an informational `[shared-wt]` badge to affected
session rows. this is a warning, not a blocker: use it to decide when to spawn a
dedicated worktree with `xt pi` / `xt claude`.

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
`[wait]`) on real agent runs:

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
`PreToolUse`/`PostToolUse` -> `running` entries are what keep `[wait]` honest for
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
  that sets `needs-input` -> `[wait]`.
- if the user **approves**, claude resumes and the tool executes. `PostToolUse`
  fires and resets the pane to `running`, so `[wait]` is cleared the instant the
  blockage is gone — not stuck until the next prompt or `Stop`.
- `PreToolUse` reinforces the busy signal at the start of every tool.

**invariant:** `[wait]` <=> the agent is blocked right now and no tool is
completing. an orchestrator that jumps to `[wait]` panes will never land on a
pane that is actively working. without `PostToolUse`, a stale `[wait]` could
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


## Optional command telemetry

The xtmux event log can also record selected shell commands, but only through an
explicit wrapper. xtmux does not shadow `git`, `bd`, or `gh` automatically.

```sh
tmux-session-picker telemetry git -- commit -m 'message'
tmux-session-picker telemetry git -- push
tmux-session-picker telemetry bd -- update xtmux-123 --claim
tmux-session-picker telemetry bd -- close xtmux-123 --reason 'done'
tmux-session-picker telemetry gh -- pr create --fill
```

Successful or failed wrapped commands emit a start event plus a typed result
event such as `git.commit`, `git.push`, `bd.claim`, `bd.close`, or
`git.pr.create`, including exit code and pane/session/bead context when tmux
metadata is available.
