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
| `@agent_parent_session` | `XTMUX_AGENT_PARENT_SESSION` | orchestrator tmux `#{session_id}` that delegated the work (stable per-instance id, e.g. `$3`; never `#S` session-name which is mutable and recycled) |
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
XTMUX_AGENT_PARENT_SESSION="$(tmux display-message -p '#{session_id}')" \
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

monitor and requester-wake rows are durable in
`${XDG_STATE_HOME:-$HOME/.local/state}/xtmux/observability.db`. Terminal
unconsumed wakes survive restart; `wait-agent --consume` claims one only for the
session and pane that registered it.

Pi `extensions/pi-agent-state.ts` also publishes `agent.turn.done` on `agent_end`, including a compact last assistant message when the pi `turn_end`/`agent_end` event payload exposes it. Root panes have no parent; when `@agent_parent_session` names a distinct parent, the extension emits one reply-free SQLite FYI and never creates an obligation or monitor.

state transitions and orchestration actions write typed rows and bounded
forensic envelopes to the SQLite event journal. Use:

```sh
tmux-session-picker log tail 50
tmux-session-picker log query --pane %42 --since 1h
tmux-session-picker message-send --to orchestrator --bead xtmux-team.4 --text 'done; notes in bead' --json
tmux-session-picker message-list --for orchestrator --pane "$TMUX_PANE" --expects-reply --json
```

### reply and wake closed loops

A message with `--bead` expects a reply unless it explicitly uses
`--expects-reply=false`. `message-ack` records receipt only; it never clears the
sender's obligation. The original recipient must correlate the response:

```sh
xtmux message-reply --in-reply-to <messageKey> --text 'done; notes in bead' --json
# or, only after successful pane injection:
xtmux safe-send-pointer --yes --reply-to <messageKey> %42 \
  'leggi /tmp/reply.txt e seguilo' --json
```

`message-reply` and `message-cancel` derive authority from the live tmux session
and pane. Endpoint overrides, cross-pane replies, second replies, and
non-requester wake consumption fail without partial mutation.

Claude's PostToolUse hook verifies the SQLite obligation. At Stop it blocks once
when the sender pane lacks an active or consumed requester-owned wait that is at
least as new as the obligation, and supplies the exact native `Monitor(command:
"xtmux wait-agent ... --wait-for-transition --consume ...")` call. The consumed
hook claims a delivered wake once. Hook database failure blocks with an
`obligations list --json` diagnostic; `stop_hook_active` prevents a recursive
Stop loop.

Pi re-queries `obligations list`, pane-scoped `message-list`, `unread-count`, and
`monitor-list`. Outgoing obligations use the SQL default limit of 200 and the
inbox passes `--limit 500`. `monitor-list --json` currently reads full history;
if its parsed array exceeds 500 rows, Pi fails closed with coordination wake
degradation rather than consuming a partial batch. A successful cycle
acknowledges at most 20 receipts/wakes, displays at most 20 reply keys in a
bounded widget/prompt, and queues only one continuation while idle. Mutation-
budget work resumes on later cycles or restart. Unsafe IDs are hidden,
malformed/incompatible coordination JSON degrades visibly, and message summaries
are never inserted as instructions.

Neither loop reads, writes, expires, or asks the operator to delete
`xtmux-reply-obligations`, `xtmux-outbound-expectations`, or
`xtmux-auto-monitor` runtime marker directories. Troubleshoot durable state with:

```sh
xtmux obligations list --pane "$TMUX_PANE" --json
xtmux message-list --for "$(tmux display-message -p '#{session_id}')" \
  --pane "$TMUX_PANE" --expects-reply --json
xtmux monitor-list --json
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

Readiness-aware delivery uses existing local prompt files. Path validation happens
before any send; `--yes` remains mandatory for durable writes and tmux delivery:

```sh
tmux-session-picker handoff --target %42 --prompt-file /tmp/task.md \
  --wait-ready 2m --monitor --handoff-key task-42 --json --yes
```

This writes one `handoffs` row before delivery, optionally registers one linked
`monitors` row in same SQLite transaction, and appends one `delivery_attempts` row
per pointer injection. `send-keys` success means injection only, not acceptance.
Retry with same `--handoff-key` reuses handoff and monitor rows while appending
another attempt. `agent.ready` is queried by target pane; timeout returns structured
`XTMUX_READY_TIMEOUT` and sends nothing.

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

the npm installer registers one grouped Pi package with
`pi-agent-state.ts` and `pi-auto-monitor.ts` as entrypoints;
`pi-auto-monitor.ts` initializes `pi-inbox-reply.ts` internally. After upgrade,
run `/reload` or start a fresh Pi session. For a source-only setup, reference the
entrypoints from Pi `settings.json` via its documented `extensions` array:

```json
{
  "extensions": ["/absolute/path/to/xtmux/extensions/pi-agent-state.ts"]
}
```

the state extension calls the shared script with `pi.exec(...)`. override the script path if needed:

```sh
XTMUX_AGENT_STATE_SCRIPT=/custom/path/agent-state.sh pi
```

### pi state mapping

| pi event | `@agent_state` |
|---|---|
| `session_start` | `idle` |
| `before_agent_start` | `running` |
| `agent_start` | `running` |
| `tool_execution_start` | `running` |
| `agent_end` | `done` |
| `session_shutdown` with reason `quit` | `off` |
| `session_shutdown` with other reasons | `idle` |

### debouncing repeat `@agent_state` writes

setState() debounces same-state writes within a rolling window so the pi
extension does not fire redundant tmux `set-option -p @agent_state` calls
for every intermediate event during a single pi turn. Default window is
5000ms. Override with:

```sh
XTMUX_PI_STATE_DEBOUNCE_MS=0 pi   # disable debounce (write every event)
XTMUX_PI_STATE_DEBOUNCE_MS=1000 pi  # tighter window for high-freq observers
```

Only same-state repeats are suppressed; any state transition (e.g. running
→ done) writes through immediately regardless of window. `message_update`
was previously mapped to `running` and dropped from the event list above
because agent_start / tool_execution_start / turn_start already cover the
'running' transitions.

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
hook event names already used by this repo's `.codex/hooks.json`. The installer
adds these files only when `~/.codex` already exists; xtmux never installs the
Codex CLI.

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

## Activity spans (`agent.activity`)

The pi extension records one **completed span** per streamed agent activity —
each thinking segment, each assistant text segment, and each tool execution —
as an `agent.activity` event. It carries `activity` (`thinking` | `text` |
`tool`), `segment_id`, `turn_index`, `started_at_ms`, `duration_ms`, and — for
thinking/text only — `char_count`. From these a consumer computes exact segment
durations, time-to-first-activity (a segment's `started_at_ms` minus the turn
start), and segment counts.

It is a completed span rather than a start/end pair on purpose: both the start
time and the duration ride on one event, so nothing has to be correlated, and it
is half the writes. It flows through the ordinary journal — `agent.activity` has
no typed table — so it pages back through the same cursor (`log query
--after-id`, `log follow`) as every other event, not a second stream.

Two invariants that must never relax:

- **`duration_ms` is OBSERVED STREAM DURATION** — wall-clock between the
  provider's `*_start` and `*_end` stream events as this host saw them. It is
  **not** provider compute time and must never be presented as such. A clock that
  moves backward clamps it to `0`, never negative.
- **No content, ever.** `char_count` is a length; thinking, text, and tool
  results are never recorded.
