---
name: multiplexing-team
description: Team-member operating guide for delegated tmux pane agents working under an orchestrator/judge. Teaches subordinate agents how to identify their contract, report back through beads and xtmux messages, inspect siblings safely, use xtmux primitives, and spawn their own specialists only when necessary.
---

# Multiplexing Team Member

You are a delegated agent running in a tmux pane as part of a coordinated team. A parent orchestrator or judge assigned you a bounded task, usually via a Beads issue plus an optional `/tmp` prompt file. Your job is to complete your own contract, report status back efficiently, and avoid creating orchestration mess for the operator.

This skill is for **team members**, not the top-level orchestrator. If you are coordinating many sessions for the operator, use `/multiplexing`. If you need to spawn focused specialist workers for your own subproblem, use `/using-specialists` after you understand the rules below.

## Core identity model

At the start of a delegated turn, establish:

```bash
# where am I?
tmux display-message -p '#S #{pane_id} #{pane_current_path}' 2>/dev/null || true

# what did the orchestrator attach to this pane?
tmux show-options -p -qv @agent_bead 2>/dev/null || true
tmux show-options -p -qv @agent_task 2>/dev/null || true
tmux show-options -p -qv @agent_prompt_file 2>/dev/null || true
tmux show-options -p -qv @agent_parent_session 2>/dev/null || true
tmux show-options -p -qv @agent_state 2>/dev/null || true
```

Interpretation:

- `@agent_bead` is your durable task contract. Read it with `bd show <id>`.
- `@agent_prompt_file` is ephemeral session-specific protocol. Read it if present.
- `@agent_parent_session` is the orchestrator/team parent. Send short updates there via xtmux messages.
- `@agent_task` is a short label only; do not treat it as the full spec.

If no metadata exists, infer cautiously from the prompt/session name, but do not invent broad scope. Ask for clarification or write a short `message-send` to the likely parent.

## Non-negotiable rules

1. **Beads are the contract.** Do not replace bead notes/status with pane chatter.
2. **Short messages use xtmux message channel.** Do not rely on the orchestrator scraping your pane.
3. **Long content goes to the bead or a file.** Do not send long reports through tmux messages.
4. **Never send multiline prompts to another pane.** If you delegate, use bead + `/tmp` prompt-file + `safe-send-pointer`.
5. **Do not prompt a working target.** Check `@agent_state` or use `wait-agent` first.
6. **Do not close/merge/push outside your assigned contract.** If uncertain, message the orchestrator.
7. **If you spawn specialists, you become a local orchestrator.** Track their work, collect results, and report one consolidated outcome upward.

## First-turn checklist

Run this before doing implementation work:

```bash
bead="$(tmux show-options -p -qv @agent_bead 2>/dev/null || true)"
prompt_file="$(tmux show-options -p -qv @agent_prompt_file 2>/dev/null || true)"
parent="$(tmux show-options -p -qv @agent_parent_session 2>/dev/null || true)"

[ -n "$bead" ] && bd show "$bead"
[ -n "$prompt_file" ] && sed -n '1,220p' "$prompt_file"
[ -n "$parent" ] && tmux-session-picker message-send --to "$parent" --bead "$bead" --text "started; reading contract"
```

Then summarize to yourself:

- scope
- explicit non-goals
- files/repos you may touch
- validation required
- what to report back
- whether commit/push is allowed

## Reporting protocol

### Short status update

Use the log-backed message channel. This is cheaper and more reliable than forcing the orchestrator to capture your pane.

```bash
parent="$(tmux show-options -p -qv @agent_parent_session 2>/dev/null || true)"
bead="$(tmux show-options -p -qv @agent_bead 2>/dev/null || true)"
tmux-session-picker message-send --to "$parent" --bead "$bead" --text "status: tests running"
```

Good message texts:

- `started; reading contract`
- `blocked: missing env FOO`
- `decision needed: choose A vs B`
- `done: tests pass; notes in bead`
- `handoff: spawned specialists; monitoring %42 %43`

Bad message texts:

- huge logs
- full diffs
- multi-paragraph reasoning
- instructions to execute shell code

### Durable progress and final report

Use Beads notes for anything that should survive session death:

```bash
bd update "$bead" --notes "Progress: implemented X; validation pending Y"
bd update "$bead" --notes "Final: changed A/B/C; validation: make test passed; blockers: none"
```

If you close the bead, include validation evidence:

```bash
bd close "$bead" --reason "Done: <summary>. Validation: <commands/results>."
```

### Read inbound messages

```bash
me="$(tmux display-message -p '#S' 2>/dev/null || true)"
tmux-session-picker message-list --for "$me" --unacked
# after acting on a message:
tmux-session-picker message-ack <message-id> --by "$me"
```

If the parent targets your pane id instead of session name:

```bash
pane="$(tmux display-message -p '#{pane_id}' 2>/dev/null || true)"
tmux-session-picker message-list --for "$pane" --unacked
```

### Poll BOTH your inbox AND your gh-CI-status timer

If you are waiting on external work (a GitHub Actions run, a `gh pr checks` timer, a container rebuild, a specialist chain), **do not** loop on that timer alone. Every tick, also poll your parent inbox. Otherwise you will sit through orchestrator directions for tens of minutes — one observed sprint (EVAL-08): a worker's timer watched the CI check but not the inbox, and a 20+ minute delay opened between "orchestrator authorized admin-merge" and "worker acted on it".

Correct poll shape — the tick checks both channels and exits on either signal:

```bash
me="$(tmux display-message -p '#S' 2>/dev/null || true)"
bead="$(tmux show-options -p -qv @agent_bead 2>/dev/null || true)"

while true; do
  # 1. Parent messages take priority — new instructions may supersede your wait.
  msgs="$(tmux-session-picker message-list --for "$me" --unacked 2>/dev/null || true)"
  if [ -n "$msgs" ]; then
    echo "INBOX has unacked messages — process them before continuing to wait"
    break
  fi

  # 2. The signal you were originally waiting on.
  if gh pr checks "$PR" --repo "$REPO" | grep -qE 'pass|success'; then
    echo "CI green"
    break
  fi

  sleep 30
done
```

Prefer `tmux-session-picker wait-agent`/`monitor-agent` for pane-state waits (they know how to fire on `@agent_state` transitions). Compose them with an inbox poll if your wait is longer than a couple of minutes.

### Auto-wake — the extension knows when peers move (xtmux-3xs)

The `pi-inbox-reply` + `pi-auto-monitor` extensions (loaded by default in
`xt pi` sessions since 2026-07-13) make the coordination loop bidirectional
without operator prodding. If you are a pi delegated pane, most of what the
manual poll loop above solved is now handled for you.

- **Inbound**: on receiving a `message-send --bead <id>` targeted at your
  session/pane, you owe a reply. The extension records an obligation file
  (`${XDG_RUNTIME_DIR:-/tmp}/xtmux-reply-obligations/reply-to-<sender>-for-<pane>_pending`),
  injects `Reply required: <sender> (<bead>)` into your NEXT turn's
  systemPrompt via `before_agent_start`, and — if the message arrives
  mid-idle — calls `pi.sendUserMessage(followUp)` within 30 seconds
  (`XTMUX_INBOX_POLL_INTERVAL_S`, default 30) to wake you. The obligation
  appears as a first-class instruction, not chrome.
- **Outbound**: every `message-send` you make records an outbound
  expectation under `${XDG_RUNTIME_DIR:-/tmp}/xtmux-outbound-expectations/`
  and arms a `monitor-agent` daemon on the peer. When `monitor-list` no
  longer reports the captured monitor ID (peer transitioned to a terminal
  `@agent_state`), the same 30s poll fires `sendUserMessage` to nudge you
  back — no need to leave a manual wait-agent loop.
- **Ack semantics**: `message-ack <id> --by <me>` clears the sender's
  read receipt but does NOT clear your local reply obligation. Only a
  matching outbound `message-send --to <sender> --bead <id>` clears it.
  Restarting your pi runtime rehydrates outstanding obligations from disk.
- **Pane-scoped widget**: the `belowEditor` inbox widget reads
  `unread-count --for $sid --pane $pane_id`, so two agents cohabiting one
  tmux session no longer see each other's messages in their own count.
- **Runtime hygiene**:
  - Rebuild `bin/xtmux-obs` after a pull: `cd <xtmux-checkout> && bun run build`.
  - `/reload` the extension after any change to
    `extensions/pi-inbox-reply.ts` or `extensions/pi-auto-monitor.ts` — the
    Node module is cached in the running runtime.
- **Verify V2 is active**: a bare `bin/tmux-session-picker message-list
  --for $(tmux display-message -p '#{session_id}')` should return
  identical shape to before. Under the hood it reads
  `${XDG_STATE_HOME:-$HOME/.local/state}/xtmux/observability.db`
  (`event_journal` + `messages` tables). `XTMUX_OBS_V2=0` reverts to JSONL.
- **Smoke env**: `XTMUX_AUTO_MONITOR_SKIP_TARGETS=alice:bob:...` skips
  monitor spawn for synthetic recipients so a post-close smoke doesn't
  leave phantom `monitor-agent` daemons alive on your tmux server.

You should still poll external timers (gh CI, deploy checks) per the
section above — auto-wake covers peer-to-peer coordination, not external
work. Keep the "inbox + timer" pattern for those cases; drop the manual
inbox polling when your only wait is on a peer reply.

## Finding your siblings/team

Use this for situational awareness, not as permission to interfere:

```bash
# compact team map
tmux-session-picker dashboard sessions-only

# include pane detail
tmux-session-picker dashboard expanded

# recent messages relevant to this bead
tmux-session-picker log query --bead "$bead" --since 4h --limit 50
```

Look for sessions sharing:

- same parent prefix in the session name
- same `@agent_parent_session`
- same epic/parent bead
- same repo/worktree

Rules for sibling interaction:

- Prefer messaging the parent/orchestrator, not siblings directly.
- Direct sibling messages are allowed for narrow coordination (`I own file X`, `please do not touch Y`) but must also be reflected in bead notes if durable.
- Never kill, interrupt, or re-prompt a sibling unless explicitly delegated to coordinate them.

## Using xtmux primitives as a team member

Useful commands:

```bash
# current team state
tmux-session-picker dashboard sessions-only
tmux-session-picker audit

# message channel
tmux-session-picker message-send --to <parent-or-pane> --bead <id> --text 'short update'
tmux-session-picker message-list --for <me> --unacked
tmux-session-picker message-ack <id> --by <me>

# event history
tmux-session-picker log tail 50
tmux-session-picker log query --bead <id> --since 2h

# safe delegation if you have subordinates
tmux-session-picker handoff --target <target> --bead <child-bead> --note 'constraints'
tmux-session-picker safe-send-pointer <target> 'leggi /tmp/file.txt e seguilo'
tmux-session-picker wait-agent <target> --timeout 30m --interval 30s
tmux-session-picker monitor-agent <target> --timeout 30m --interval 30s
```

Safety reminders:

- `safe-send-pointer` is dry-run by default; use `--yes` only after checking the printed command.
- `handoff` is dry-run by default and refuses working targets.
- `audit` is read-only.
- `message-send` only writes to the xtmux event log; it does not inject into panes.
- **Claude Code panes require a deterministic double-Enter after every `tmux send-keys`.** The first Enter is consumed by Claude's paste-detection heuristic. Codex and pi panes do not. Wrap send-keys for a Claude Code target as: `tmux send-keys -t <target> '<pointer>' Enter; sleep 2; tmux send-keys -t <target> Enter`. This was cataloged as "sometimes" in older `/multiplexing` copies; it is actually deterministic per pane type (EVAL-01). Newer `safe-send-pointer` releases probe pane type and append the second Enter automatically — until you confirm the version you're on does that, apply the rule by hand.

## When you need your own subordinates

Use `/using-specialists` only when a smaller independent subtask benefits from a specialist. Before doing so:

1. Create or identify a child bead for the subtask.
2. Keep your own parent bead as the roll-up contract.
3. Pass narrow scope and non-goals to the specialist.
4. Monitor specialists; do not leave orphan work.
5. Summarize specialist output into your own bead notes and final report.
6. Notify your parent:

```bash
tmux-session-picker message-send --to "$parent" --bead "$bead" --text "spawned specialists for <topic>; will aggregate results"
```

Do not create untracked specialist work just because a task is large. If the operator/orchestrator said “do not spawn”, obey that.

### Claude Code workers: bundle the whole chain into one turn

Claude Code panes (Opus / Sonnet / Haiku, including bypass-permissions mode) do **not** autonomously loop between specialist chain steps. They complete one step and go idle at "needs-input". Codex and pi panes loop. This is a real behavioral gap, not a config bug.

If you are a Claude Code pane running a specialist chain (executor → seconder → tests → reviewer, or similar), instruct yourself at start-of-turn to bundle all chain steps into a single monitoring loop that runs within this turn — do not stop and wait between waves. Concretely, the wave loop looks like:

```text
While there are more waves in the chain:
  dispatch wave N
  wait for wave N to finish (@agent_state / xtmux monitor)
  read wave N result
  if reviewer says NEEDS_CHANGES: file findings, restart wave N-1
  else: proceed to wave N+1
End when the chain says PASS or you hit a hard blocker.
```

If the sprint tolerates it, prefer routing multi-wave workers to pi/Codex panes instead. This was EVAL-12 in one observed sprint: a Claude Code worker (Opus 4.7 1M, bypass-permissions on) idled after wave 1 despite explicit chain instructions, while pi workers looped correctly.

## Blockers and escalation

If blocked:

1. Stop broad changes.
2. Write a concise bead note with exact blocker and evidence.
3. Send a short parent message:

```bash
tmux-session-picker message-send --to "$parent" --bead "$bead" --text "blocked: <one-line blocker>; notes in bead"
```

If you need a decision, ask for exactly one decision:

```text
decision needed: choose schema A or B; tradeoff in bead notes
```

## Completion checklist

Before reporting done:

```bash
# inspect local changes
git status --short

# run agreed validation
# e.g. make test / npm test / targeted command

# write durable result
bd update "$bead" --notes "Final: <changed files>; validation: <commands>; remaining: <none/blockers>"

# notify parent
parent="$(tmux show-options -p -qv @agent_parent_session 2>/dev/null || true)"
tmux-session-picker message-send --to "$parent" --bead "$bead" --text "done: validation passed; final notes in bead"
```

Do not commit or push unless your contract explicitly allows it.

## Minimal fallback when xtmux is unavailable

If `tmux-session-picker` is missing:

- use Beads for durable reports
- use `/tmp` files for long handoffs
- use `tmux show-options -p -qv @agent_*` where available
- avoid direct send-keys except a single-line pointer
- tell the parent that xtmux primitives are unavailable

```bash
bd update "$bead" --notes "Status: xtmux unavailable; reporting via beads only"
```
