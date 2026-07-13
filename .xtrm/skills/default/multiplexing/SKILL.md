---
name: multiplexing
description: Help the operator coordinate work across N concurrent tmux sessions (Claude Code, pi, raw shells, vim, REPLs). Inventory state, hand off tasks cleanly, prevent messy-run failure modes, keep hygiene. Not an agent harness; not a /using-specialists replacement; tool-agnostic. Invoked explicitly via /multiplexing — do not rely on auto-activation.
---

# Multiplexing

You are an orchestration assistant for an operator who works in N concurrent tmux sessions at once. Each session runs its own tool (Claude Code, pi, raw shell, vim, REPL). Your job: inventory, hand off, monitor, clean up, recover. You do not run a new harness. You do not replace specialists. You do not assume the operator uses you in any specific session — they may switch agents at any time.

This skill is invoked explicitly via `/multiplexing`. Auto-activation through keyword triggers is unreliable across harnesses; do not assume it fires.

## When this skill applies

The operator triggers `/multiplexing` when they want:
- An inventory of what is running where across their tmux sessions
- Help delegating a task to another session
- Cleanup of dead sessions, orphan processes, leaked worktrees
- Recovery from a "messy run" (a delegated agent that filed spurious beads, fragmented prompt, off-rails behavior)
- A coordinated multi-session plan toward a single goal

## When it does NOT apply

- Specialist chain orchestration → use `/using-specialists`
- Delegated pane/team-member self-protocol → have that pane use `/multiplexing-team`
- Designing a new agent runtime or harness → out of scope
- In-process subagent spawn (Claude Agent SDK, Cline, Cursor subagents, etc.) → out of scope; this skill stays tool-agnostic
- Single-session deep work → no multiplexing needed

## Cardinal rules — non-negotiable

1. **Never multi-line paste via send-keys.** Each `\n` inside the send-keys argument is interpreted as Enter. The delegated agent receives N separate fragmented prompts instead of one.
2. **Never use `$(...)` or backticks** inside the send-keys argument. Shell expansion can inject characters into the target pane unexpectedly.
3. **Never use `tmux paste-buffer`** with a file that contains newlines. Same fragmentation problem as rule 1.
4. **Never send a prompt while the target pane is in Working state.** It will be queued, fragmented, or worse, race against in-flight tool output.
5. **Never invent ad-hoc session names.** Always follow the naming convention below.

## Communication primitives — beads first, /tmp second, send-keys third

The operator's workflow uses three concentric primitives. Pick the right one per content type. Do not invent a fourth.

### Beads — persistent inter-session comms (PRIMARY)

Beads (`bd`) are the canonical cross-session communication primitive in xtrm workflows. They survive session deaths, harness restarts, agent switches, and orphan processes. They are the single most important comms layer in this skill. Use them for:

- **Task content**: title, description, scope, constraints, validation criteria, expected output. The delegated agent reads the bead with `bd show <id>` as the authoritative contract.
- **Findings and output**: the delegated agent appends findings to bead notes via `bd update <id> --notes "..."`. The main session reads them later with `bd show <id>` — no need to scrape the pane.
- **Status changes**: `bd update --claim`, `bd close`, `bd supersede`, dep edges. Any session, at any later time, sees the current state via `bd show` or `bd query`.
- **Cross-session memory**: `bd remember "<insight>" --key <key>` then `bd memories <keyword>` from any session, including future sessions on the same project.
- **Soft handoff between sessions**: chain A finishes, files a follow-up bead with `--deps discovered-from:<source>` → chain B (or session B) picks it up later via `bd ready`.

The operator does NOT need a custom message bus. Beads already are one. Default to beads for any inter-session content that should survive a session crash.

What beads cannot do, and what to use instead:
- **Push notifications**: there is no native push. The main session polls via `bd query "status=closed AND assignee=me"` or watches via a wrapper script.
- **Real-time streaming output**: use `tmux capture-pane` for snapshots or `tail -f` on a log file for streams.

### /tmp prompt-file — ephemeral meta-protocol

Beads carry persistent content. Bootstrap constraints, scope clarifications, and meta-protocol belong in a separate file in `/tmp/<session>-<topic>.txt`:

- Negative constraints ("NEVER merge", "NEVER touch file X", "NO new beads beyond N")
- Output format and report shape
- Which skill to invoke (`/using-specialists`, `/btw`, etc.)
- One-off scope clarifications that do not belong in the bead body

Why separate from beads: these are session-specific instructions that pollute the bead's permanent record. The bead remains a clean task contract; the /tmp file is throwaway.

How to create the file: use Bash heredoc, NOT the Write tool. The Write tool is blocked by the bd claim gate in beads-managed repos:

```bash
cat > /tmp/<session>-<topic>.txt <<'EOF'
<full prompt content here>
EOF
```

### send-keys — single-line pointer only

Three allowed forms, nothing else:

1. **Read pointer**: `'leggi /tmp/<file>.txt e seguilo. <one-line constraint>. report finale.'`
2. **Slash command**: `/using-specialists`, `/btw`, `/compact`, etc.
3. **Brief correction**: a single redirective sentence (≤ 3 sentences) when an in-flight agent needs a course adjustment. Anything longer goes in a /tmp file.

### xtmux picker — operational assist, not a comms bus

When the repository has the `tmux-session-picker` features from the `xtmux-rib` epic, use them to make multiplexing safer and faster. They do **not** replace beads, `/tmp` prompt files, or the send-keys rules; they only improve inventory, pre-flight checks, monitoring, and cleanup.

Useful features:
- `@agent_state` pane option: prefer this as the structured signal for `working` / idle / waiting state before sending input or firing timers. Fall back to capture-pane UI greps only when the option is absent.
- `tmux-session-picker dashboard sessions-only|expanded`: preferred orchestrator inventory. It emits TSV rows with session/pane, `@agent_state`, bead/task, repo/branch, dirty count, shared-worktree flag, idle age, and cwd/path. Use `sessions-only` for a compact map and `expanded` when pane detail is needed.
- `xtmux picker` sessions-only / expanded toggle: useful for the human interactive map; for agent-readable output prefer `dashboard`.
- Rich filters (`repo:<x>`, `branch:<x>`, `cmd:agent`, `grep:<text>`): use them to find the target agent/session without scraping every pane.
- Specialist `sp-*` awareness and bottom grouping: useful for delegated specialist chains; stale/orphan badges help cleanup.
- Staleness badges / idle time: useful as a cleanup hint, never as sole proof that a prompt is safe. Confirm with `@agent_state` or pane capture.
- `tmux-session-picker wait-agent <target> --timeout 30m --interval 30s`: preferred one-shot timer primitive; fires when the target leaves working/running/busy/thinking.
- `tmux-session-picker monitor-agent <target> --timeout 30m --interval 30s` + `monitor-list`/`monitor-kill`: preferred registered timer primitive when the orchestrator needs to see active waits. Entries show target, pane, state, start, timeout, interval, and last update; they clean up on completion or kill.
- `tmux-session-picker safe-send-pointer <target> 'leggi /tmp/file.txt e seguilo'`: preferred dry-run-first send wrapper. It rejects working targets, multiline payloads, shell substitution, and non-pointer inline instructions; use `--yes` only after inspecting the printed command. Safety defaults now include auto-double-Enter for Claude Code targets detected via `pane_current_command=claude` or `claude-*`, and `--force-freeform` for brief corrections. `--force-freeform` bypasses only the payload-shape check; multiline and shell-substitution guards remain enforced.
- `tmux-session-picker handoff --target <target> --bead <id> --note <meta>`: assisted handoff flow. It creates the `/tmp` prompt-file, keeps the bead as the durable contract, prints the exact `safe-send-pointer --yes` command, and refuses working targets before creating/sending.
- Bead-aware preview: when a pane/session advertises `@agent_bead`, picker preview includes bounded `bd show` context. Use it to inspect delegated task contract/close notes before deciding the next orchestration step.
- `tmux-session-picker worktree-collisions`: reports git worktrees used by multiple live sessions; picker rows may show `[shared-wt]`. Treat as a warning to consider dedicated `xt pi` / `xt claude` worktrees, not as an automatic blocker.
- `tmux-session-picker audit`: read-only end-of-session hygiene report. `warning` rows require operator judgment (dirty/shared/working/no-bead/naming); `cleanup` rows are safer candidates (missing paths, stale specialists).
- `?` in the picker / `tmux-session-picker mux-help`: concise multiplexing-safe delegation cheatsheet. Use it as a reminder, not as a replacement for this skill.
- Act-on-preview controls (`approve`, `interrupt`, `message`): acceptable for micro-actions only. Long instructions still go through beads + `/tmp` pointer.
- Rename and kill/bulk-kill controls: useful for enforcing naming convention and cleanup hygiene, with the same dirty-worktree caution as shell cleanup.

## Pre-flight checklist — mandatory before every first send-keys to a session

```bash
# 1. Structured agent state if available. Any working/running/busy/thinking value means STOP.
tmux list-panes -t <session> -F '#{pane_id} #{pane_current_command}'
tmux show-options -p -t <pane_id> -qv @agent_state 2>/dev/null || true

# 2. Pane idle? No Working state, no menu wizard, no auth prompt. Always check visually too.
tmux capture-pane -t <session> -p | tail -15

# 3. Real cwd (session name does NOT guarantee cwd)
tmux display-message -t <session> -p '#{pane_current_path}'

# 4. Agent loaded? Look for model name (Opus / Sonnet / Haiku / gpt-* / kimi / claude-*) and budget indicator
tmux capture-pane -t <session> -p | grep -E '(Opus|Sonnet|Haiku|gpt-|kimi|claude-)'
```

If any check fails: STOP. Do not improvise. Either wait, switch session, or recreate. Treat `@agent_state=working`/`running`/`busy`/`thinking` as a hard stop even if the pane tail looks quiet. The operator's time spent confirming a clean pre-flight is far cheaper than recovering from a fragmented prompt.

## Session naming convention

```
<orchestrator-session-name>-<topic-slug>
```

| Example | Decomposition |
|---|---|
| `infra-audit-sweep` | Spawned by `infra`; topic = sweep over a target repo |
| `infra-research-mux` | Spawned by `infra`; topic = research on multiplexing |
| `svc-branchname-roll` | Spawned by `svc`; legacy "roll" name retained |
| `design-spec-rewrite` | Spawned by `design`; topic = rewrite of a spec |

Collision handling: append `-2`, `-3`. Persistent main sessions (e.g. `design`, `infra`, `svc`) keep their bare names. Specialist-spawned `sp-<role>-<hash>` sessions follow the specialists CLI convention and are left alone.

Forbidden: ad-hoc names like `svc-s24f-tests`, `test-orch-xyz`, `tmp-investigation`. Use the convention even for one-off delegations. The naming convention is what lets the operator parse `tmux ls` and immediately see parent → children.

## Operator-help patterns

### Pattern 1 — Inventory on demand

Trigger: operator says "what's running in `<X>`?", "give me a session map", "what state is everything in?"

Steps:
1. If available, start with `tmux-session-picker dashboard sessions-only` for agent-readable inventory. Use `dashboard expanded` when pane detail is needed.
2. For human navigation, use `tmux-session-picker` / `xtmux picker` in sessions-only mode; use filters such as `cmd:agent`, `repo:<x>`, `branch:<x>`, or `grep:<text>` to narrow the map.
3. Fallback when the dashboard command is unavailable: `tmux ls`, then for each live session `tmux capture-pane -t <session> -p | tail -8`, `tmux display-message -t <session> -p '#{pane_current_path}'`, and for agent panes `tmux show-options -p -t <pane_id> -qv @agent_state 2>/dev/null || true`.
4. Return a table: `session | cwd | branch (if git) | model (if agent) | @agent_state | bead/task | dirty/shared | idle/working`

### Pattern 2 — Assisted hand-off

Trigger: operator says "send task X to session Y", "delegate to Y", "ask Y to do Z"

Steps:
1. Run the pre-flight checklist on Y. If it fails, report which check and stop.
2. If the task represents trackable work, create a bead first (`bd create --title ... --description ...`). This is the persistent content.
3. If available, prefer `tmux-session-picker handoff --target Y --bead <id> --note '<constraints>'` to create the `/tmp` file and print the exact safe-send command. Otherwise write any ephemeral meta-protocol (negative constraints, output format) to `/tmp/<session>-<topic>.txt` via Bash heredoc.
4. Show the operator the exact send-keys / `safe-send-pointer --yes` command you would run. Wait for explicit confirmation before executing.
5. On confirmation: use `tmux-session-picker safe-send-pointer --yes ...` when available; otherwise `tmux send-keys -t Y '<single-line pointer>' Enter`. **Claude Code panes consume the first Enter deterministically as paste-detection**; send a second Enter after 1-2s for Claude Code targets. Codex/pi panes submit on the first Enter.
6. If polling is appropriate, set up a registered monitor or background polling loop (see Monitoring).

### Pattern 3 — Cleanup hygiene

Trigger: operator says "clean orphans", "kill dead sessions", "what's leaking RAM"

Steps:
1. Process inventory: `ps -ef | grep -E "(serena|gitnexus|uvx.*serena|bun.*specialists)"`
2. For each candidate, extract its `--project` argument. Classify into LIVE (path exists on disk), ORPHAN (path is gone), NO_PROJECT (parent uvx wrappers etc.)
3. Kill ORPHAN PIDs with `kill -9`. Skip LIVE (active work). Skip NO_PROJECT (children will cascade-die after their actual workers are gone)
4. tmux sessions: if available, run `tmux-session-picker audit` first. Use `cleanup` rows as candidates and treat `warning` rows as requiring operator judgment. Otherwise use the picker to spot stale/orphan/specialist rows quickly, but confirm with shell checks. Identify ones with idle `❯` prompt or non-working `@agent_state` AND no pending commits in their cwd worktree. Those are safe to `tmux kill-session -t <name>`. Sessions in Working state or with dirty trees: leave alone
5. Worktrees: `git worktree list` per affected repo. Remove worktrees whose owning job is in `cancelled` / `error` state per `sp ps`
6. `sp clean --ps` to hide resolved terminal rows from the default `sp ps` dashboard

### Pattern 4 — Recovery from messy run

Trigger: operator says "the agent went off-rails", "filed N spurious beads", "fragmented prompt", "started processing each line as a separate task"

Steps:
1. Interrupt the running agent: `tmux send-keys -t <session> C-c`, two or three times. Esc does NOT stop pi processing — only C-c works.
2. If interrupt fails (agent stuck mid-tool-call): `tmux kill-session -t <session>`. Recreate cleanly later if needed.
3. Inventory side effects: `bd list --status=open --since today` in each affected repo. Identify the spurious beads created today by the messy run.
4. Close them: `bd close <id> --reason "reverted — messy run on <date>"`. Use `--force` if blocked by dependencies (after verifying the dependencies are also spurious).
5. For polluted notes: `bd update <id> --notes ""` OVERWRITES the entire notes field — there is no undo for individual appended note entries. Use this only when the entire notes section is junk.
6. Save the lesson via `bd remember --key <key>` so the next session knows what triggered the messy run and can avoid the same trigger.

### Pattern 5 — Coordinated multi-session goal

Trigger: operator wants one outcome that requires work in N sessions.

Steps:
1. File one parent or epic bead describing the overall goal.
2. Per session needed, file a child bead with `bd create --parent <epic> ...` describing the per-session scope. Each child carries the per-session contract.
3. Hand off each child bead to its target session via Pattern 2.
4. Monitor: poll bead status changes with `bd query "status=closed AND parent=<epic>"`, or capture-pane summaries from each session (see Monitoring).
5. When all children close, read each child's notes via `bd show <id>` and aggregate. Report the consolidated outcome to the operator.

### Pattern 6 — Sprint orchestration

Trigger: operator wants to run a full sprint through the multiplexed session — multiple workers, a dedicated judge pane, a dedicated deploy-monitor pane, PRs that must land in a specific order, real production deploys at the end.

This pattern extends Pattern 5. Everything Pattern 5 says still holds; Pattern 6 adds the sprint-shape gates that Pattern 5 alone won't enforce. Extracted from a multi-pane sprint eval; the rules below survived that sprint. **The orchestrator role is this skill** — do not spawn a separate `/sprint-orchestrator`; there isn't one, and there won't be one.

**Loading discipline (EVAL-24).** The very first action of a sprint is loading `/multiplexing`. Load it as `first action`, not as a mid-sprint recovery. The sprint eval flagged this discipline gap: the orchestrator followed the multiplexing patterns empirically but never explicitly invoked the skill. Don't repeat that.

**Task graph.** One epic bead per sprint. One child bead per workstream, `bd create --parent <epic>`. Every child carries a SCOPE section listing the path allowlist the worker may touch — the executor mandatory-rule refuses to push files outside SCOPE, so the sprint gets scope discipline for free. Children can close independently. Follow-ups discovered during the sprint are also parented under the epic — nothing floats.

**Every worker's first action is `bd show <epic>` AND `bd show <their-child>`**, written verbatim into their `/tmp` prompt file so it cannot be skipped. Ambiguity in a child → clarify against the epic, not against you.

**Delegation topology.** Dispatch these panes:

- **Workers** (N of them) — each with their own child bead, `/tmp` prompt file, and worktree.
- **Judge** — one pane loading `/judge-with-codex`. Reviews every PR before merge; emits `PASS` / `PASS_WITH_NOTES` / `NEEDS_CHANGES` / `BLOCKED`. Do NOT collapse orchestrator + judge into one pane except for tiny sprints. In one sprint eval the judge's third-cycle `NEEDS_CHANGES` caught scope pollution the orchestrator had waved through — that verdict was the sprint's single most valuable safety net.
- **Deploy Monitor** — one pane loading `/deploy-monitor` (which can in turn consult `/sre-triage` or direct `mcpq`) + a per-sprint prompt file naming the services, PRs, expected signals, and observation window. Opens a 60-minute observation window after each deploy. Refuses to open the window if the running artifact is older than the PR `mergedAt` (see deploy-gap chain below).

**When Deploy Monitor is mandatory even for a "tiny" sprint.** Do not collapse the DM role into the orchestrator when ANY PR in the flight touches a load-bearing infra surface, even if the sprint has just 1-2 PRs. One historical incident: a sprint collapsed DM into the orchestrator on the reasoning that 4 doc/dashboard PRs qualified as tiny — one of them modified `prometheus.yml` (scrape job add) and triggered a `docker compose up` from a worktree without `.env`, which cascaded into a 7h reverse-proxy edge blackout. The metric plane looked green throughout; only external 404s revealed it. The trigger conditions that make DM mandatory regardless of sprint size:

- Any PR touching `prometheus.yml` (scrape job add/remove — bind-mount inode bug + force-recreate).
- Any PR touching `alertmanager.yml` or its templates (env-var interpolation gotcha).
- Any PR touching `traefik/**` (dynamic config regressions are silent).
- Any PR touching `docker-compose.yml` or a service Dockerfile (image swap, network re-attach).
- Any PR that changes required `.env` variables (missing var → empty interpolation → silent breakage).
- Any production-facing service redeploy on a shared infra stack, regardless of the change surface.

For those PRs, DM must run the deploy-gap guard AND the public edge probe (per-stack subdomain list, expect non-404 codes) at every sample, per `/deploy-monitor` §What each sample checks. A "healthy" container is not a healthy deploy.

**The deploy-gap chain — non-negotiable (EVAL-22).** Between "PR merged" and "DM opens observation window", you MUST deploy the new artifact and the DM must independently verify that it is actually running. Chain:

1. `gh pr merge <N> --repo <owner>/<repo> --squash --admin` (or the repo's canonical merge command).
2. `docker compose -f <compose> build <service>` on the target host.
3. `docker compose -f <compose> up -d --force-recreate <service>` on the target host.
4. Only then hand off to DM.

For GitOps-deployed services: wait for the reconciler to advance past the PR's `mergedAt` before handoff. `docker inspect --format '{{.State.StartedAt}}' <container>` must be later than `gh pr view <N> --json mergedAt`.

This closes the same class of failure that let a multi-week regression run in production for over a month and that reproduced inside the sprint itself. Full doctrine and enforcement: consult your project's deploy-gap doctrine file (typically `docs/devops/deploy-gap-pattern.md`).

**Direct-`mcpq` fallback when DM is stuck.** When the Deploy Monitor thrashes on protocol or timing failures and cannot produce a verdict, query Tempo directly through `mcpq opentelemetry-mcp` from the orchestrator pane and produce a p95 measurement in ~30 seconds. Break-glass only; not a DM replacement:

```bash
mcpq opentelemetry-mcp tempo-query \
  --service <service> --span <span> --window <duration> --quantile p95
```

The sprint eval flagged this as a positive pattern worth codifying.

**Merge-order authority.** The judge emits verdicts; the orchestrator executes merges in the right order. When merges are sequenced ("A first, DM 60 min, then B"), the judge's `PASS` on B is not a merge authorization. Confirm the DM window on A cleared, then merge B, then chain into deploy-gap guard. Do not hand merge authority to workers or the judge — merges are executed by the pane that reconciles all the gates.

**Anchor-bead close hygiene (EVAL-10).** The executor / worker does NOT close the anchor bead. Closure is a post-verification act. The orchestrator closes the anchor after: judge PASS + DM 60-min window clean + deploy-gap guard satisfied + evidence in bead notes.

```bash
bd update <bead> --notes "POST-VERIFY: p95 <metric> = <value> (Tempo query <url>); DM window clean (start <t1> end <t2>); rollback validated."
bd close <bead> --reason "verified <one-line>"
```

Every close carries evidence — Tempo query link, Prometheus query, dashboard screenshot URL, unit test output, whatever proved the fix.

**Follow-up beads filed during close.** Walk every issue that surfaced during the run (scope pollution, CI oddity, tool bug, protocol clarification). Each becomes a follow-up bead parented under the epic with a priority. This is what makes future sprints faster. Typical categories: CI hardening (P1), deploy-gap enforcement (P1), executor scope gate (P2), pyright venv wiring (P2).

**Persist non-obvious lessons via `bd remember`.**

```bash
bd remember "Deploy Monitor must refuse window if docker inspect StartedAt < PR mergedAt" \
  --key deploy-gap-refuse-rule
bd remember "Executor closes anchor bead prematurely; orchestrator closes on evidence only" \
  --key anchor-bead-close-authority
```

**End-of-sprint eval.** Write two documents at sprint close:
- `/tmp/<sprint>/eval-<sprint>.md` — target-side (application or code) outcomes.
- `/tmp/<sprint>/eval-harness.md` — harness/system findings tagged `EVAL-NN`. This feeds the next system-hardening pass. Do not skip.

### Pattern 7 — Interactive role coordinator sub-orchestrator

When an epic grows to more than a handful of tracked tasks, the main orchestrator's own context blows up from monitoring: `sp ps` output, `sp feed` snippets, `sp result` blobs, chain-fix loops. That is the exact context-rot specialists exist to avoid — but it applies to the orchestrator itself. The fix is to spawn a subordinate Pi session whose only job is to coordinate one epic, so the orchestrator only ever sees the coordinator's final report.

Launch it with `xt pi --role <specialist> --bead <epic> --no-attach`. This is a real specialist config (`.specialist.json`) with `execution.interactive: true`; it just runs as a persistent Pi session instead of a managed sp job. Chain-coordinator is the canonical role for this pattern; pr-reviewer, sre-triage, deploy-monitor follow the same shape.

```bash
# 1. Capture your own session_id — this is your inbox filter, not your session name.
MY_SID=$(tmux display-message -p '#{session_id}')   # e.g. $1495
SINCE_MS=$(date +%s%3N)                             # for time-bounded polling

# 2. Spawn detached; stdout is machine-parseable as `session_name:pane_id`.
TARGET=$(xt pi --role chain-coordinator --bead $EPIC_BEAD --no-attach 2>/dev/null | tail -1)
SESSION_NAME="${TARGET%:*}"   # role-<runtime>-<slug>[-<bead>]  e.g. role-pi-chain-coordinator-abc-1
PANE_ID="${TARGET#*:}"        # %1656

# 3. Verify pane metadata is what you expect.
tmux show-options -p -t "$PANE_ID" -qv @agent_task            # should print role:chain-coordinator
tmux show-options -p -t "$PANE_ID" -qv @agent_parent_session  # should equal $MY_SID
```

**Launcher flag surface (xtmux-1lb).** The command above uses `--no-attach` because a coordinator you monitor from outside should not steal your pane. The full surface:

| Flag | Behavior |
|---|---|
| (no session flag inside `$TMUX`) | **Default**: runs pi in the CURRENT PANE. Use only when you want the coordinator to replace your pane. |
| `--no-attach` | Spawn a new session, print `session_name:pane_id`, do not attach. Canonical for orchestrator-monitored coordinators. |
| `--new-session` / `--ns` | Spawn a new session and attach (`switch-client` inside `$TMUX`, `attach-session` outside). Use for hands-on coordinators. |
| `--parent <name-or-sid>` | Bind the child to a specific parent — sets `@agent_parent_session` to that parent's `#{session_id}` regardless of where you launch. |
| `--child` | Auto-detect the current session as parent. Redundant when launching from inside a session that will monitor the child; explicit and safe. |
| `--reuse` | If the target session name already exists, attach/print its coordinates instead of failing. Skips `agent.role.launched` emission. Only meaningful with `--new-session` / `--no-attach`. |
| (no `--reuse`, collision) | Launcher auto-suffixes `-<hex>` and retries up to 10× before erroring. |
| `--model <id>` / `--thinking <level>` | Override `specialist.execution.model` / `.thinking_level` per launch. |
| `--` (trailing) | Everything after `--` forwards verbatim to the pi runtime. Guards reject `--session-dir`/`--name`/`--system-prompt`/`--append-system-prompt`; warn-and-drop `--print`/`--list-models`/`--export`/`--mode`. |

Session-name shape post-xtmux-3h8: `role-<runtime>-<slug>[-<bead>]`. The `<runtime>` prefix (`pi` or `claude`) is what distinguishes a pi coordinator from a claude one on the same specialist — earlier shape (no runtime) collided.

**`xt claude --role` has full parity** with `xt pi --role` (same flags, same scaffold, same pane options, same session-name shape). Reach for it when you want a Claude-Code coordinator instead of pi — same monitoring loop.

**Env vars exported to the child runtime** (both current-pane and new-session modes): `XTMUX_AGENT_BEAD`, `XTMUX_AGENT_TASK`, `XTMUX_AGENT_PROMPT_FILE`, `XTMUX_AGENT_PARENT_SESSION`. A coordinator prompt that resolves its bead from env instead of an argv slot reads these directly.


**Monitor the coordinator via three signals — pick the one that matches the address space:**

| Signal | Address space | Use for |
|---|---|---|
| `wait-agent <pane_id>` / `monitor-agent <pane_id>` | pane (`%1656`) | "wake me when this pane goes done" |
| `tmux-session-picker message-list --for <session_id>` | session (`$1495`) | pulling escalation messages FROM the coordinator |
| observability DB (`.specialists/db/observability.db`) | `bead_id` / `epic_id` | seeing which sub-chains the coordinator has dispatched |

**Address-space warning.** These primitives use different targets: `wait-agent`/`safe-send-pointer` address panes (`%1656` or `session.pane_index`); `message-send` from `pi-agent-state.ts` sets `--to $@agent_parent_session` which is your `#{session_id}` (`$1495`). If you poll `message-list --for xt-design.3` (pane target) you will miss messages routed to `$1495`. Always filter with `MY_SID=$(tmux display-message -p '#{session_id}')`.

**Auto-notification.** On every `agent_end` inside the coordinator, `pi-agent-state.ts` emits an `agent.turn.done` event AND `message-send --to <parent_session_id> --bead <bead> --text "turn done: <last message>"`. So `message-list --for "$MY_SID" --since 5m` gives you a live feed of coordinator turn completions without polling `sp ps`. Ack with `message-ack <id>` after reading.

**Escalation contract.** The coordinator's system prompt directs it to explicit `message-send` for judgment calls (merge decisions, reviewer PARTIAL/FAIL, sensitive-surface findings). The auto-notification is fire-and-forget status; explicit escalations require your response. Reply by `safe-send-pointer` to the coordinator's pane_id with a `/tmp/reply.md` pointer — that is how you unblock a waiting coordinator without opening its pane.

**When to interrupt vs kill.**
- Interrupt: `safe-send-pointer $PANE_ID /tmp/steer.md` — new directive; coordinator processes on next turn.
- Kill: `tmux kill-session -t "$SESSION_NAME"` after the epic bead closes. Then `git worktree remove <path> && git worktree prune`. Leaving an idle coordinator alive costs nothing but leaks state on `git worktree list`.

**When NOT to use this pattern.**
- Single-chain work — dispatch `sp run` directly per `using-specialists`; a coordinator adds ceremony without saving context.
- Work you must approve every step of — coordinator's whole value is turning judgment into fewer, higher-level asks; if every dispatch needs your OK, keep the loop in the main session.
- Work already handled by another running coordinator on the same epic — you cannot claim the same bead twice. `bd show <epic>` shows the active claim.



## V2 SQLite runtime (xtmux-3xs) — default-on since 2026-07-13

The picker delegates message/monitor/audit primitives to a SQLite-backed
runtime by default. The CLI surface (`message-send`, `message-list`,
`unread-count`, `monitor-list`, `log-emit`, ...) is unchanged; storage moved
from JSONL to `${XDG_STATE_HOME:-$HOME/.local/state}/xtmux/observability.db`.
Everything below composes with the primitives already documented above.

- **Env override**: `XTMUX_OBS_V2=on|shadow|off`. Unset defaults to `on`.
  `shadow` runs V1 authoritatively and mirrors writes into V2 for divergence
  tracking (`tmux-session-picker shadow-summary`). `0`/`off` reverts to the
  JSONL path — contract tests still export this because goldens are V1-shaped.
- **Sender-declared reply obligation**: `message-send --bead <id> ...`
  implicitly sets `--expects-reply=true`. Opt out with `--expects-reply=false`
  for FYI beaded messages. Non-beaded messages remain expects_reply=false.
  The delegated pane's extension uses this flag to record its own reply
  obligation (see `/multiplexing-team`).
- **Pane-scoped inbox**: `unread-count --for <sid> --pane %N` filters to
  messages targeting that pane (or unpaned to the session). Two agents
  cohabiting one tmux session (pi + Claude on `$1732:%1930` / `$1732:%1931`)
  no longer double-count each other. Omit `--pane` for session-wide.
- **Auto-monitor coordination (Claude side)**: `.claude/settings.json`
  registers three hooks that structurally enforce "wake me when the peer
  responds":
  - `PostToolUse` on `Bash` matching `message-send|safe-send-pointer|tmux send-keys -t`:
    touches `${XDG_RUNTIME_DIR:-/tmp}/xtmux-auto-monitor/<target>_pending`.
  - `PostToolUse` on `Monitor|Bash` matching `wait-agent <target>`: deletes marker.
  - `Stop`: if any marker survives, emits `{"decision":"block","reason":"..."}`
    with the exact `Monitor(command:"tmux-session-picker wait-agent <target>
    --wait-for-transition --timeout 30m --interval 30s")` Claude must call.
    Loop-guarded via `stop_hook_active`; TTL prune via
    `XTMUX_AUTO_MONITOR_TTL_MS` (default 1h); global bypass via
    `XTMUX_AUTO_MONITOR_DRAIN_DISABLE=1`.
- **Auto-wake (pi side)**: the `pi-inbox-reply` + `pi-auto-monitor` extensions
  provide the symmetric mechanism — obligation record on `--bead` receipt,
  `sendUserMessage(followUp)` wake on new mid-idle inbound (30s poll),
  outbound-expectation record + `sendUserMessage` wake on peer transition,
  and `before_agent_start` systemPrompt injection of the pending duty. Full
  detail in `/multiplexing-team`. From the orchestrator's view: a pi
  coordinator you launched via `xt pi --role` will not sit silently on a
  reply — no operator prod required.
- **Smoke-test bypass**: `XTMUX_AUTO_MONITOR_SKIP_TARGETS=alice:bob:smoke:1.99`
  (colon-separated, PATH-shape) tells both Claude hooks and the pi extension
  to skip monitor spawn + marker touch for synthetic recipients. Redundant
  with the `tmux has-session -t <target>` precheck (non-existent targets
  skip automatically) but kept as an explicit override for cross-tmux-server
  smoke where the target is real on another daemon.
- **Runtime binary**: `bin/xtmux-obs` is a compiled Bun single-file binary
  (`bun run build`, ~100 MB, gitignored). Falls back to `bun run src/cli.ts`
  when absent. Rebuild after any pull or after editing `src/`:
  `cd <xtmux-checkout> && bun run build`.

## xtmux team observability — logs, messages, telemetry

When `xtmux-team` primitives are installed, the orchestrator has a local event
log and a short-message channel in addition to Beads and `/tmp` prompt files.
Use these for observability and coordination; do not use them as a replacement
for the durable Beads task contract.

### Event log

Default path:

```bash
${XDG_STATE_HOME:-$HOME/.local/state}/xtmux/events.jsonl
```

Override path:

```bash
export XTMUX_EVENT_LOG_FILE=/path/to/events.jsonl
```

Useful commands:

```bash
tmux-session-picker log tail 80
tmux-session-picker log query --since 1h --limit 200
tmux-session-picker log query --type message.sent --since 4h
tmux-session-picker log query --type agent.turn.done --since 4h
tmux-session-picker log query --bead <bead-id> --since 4h
tmux-session-picker log query --pane %42 --since 1h
```

Important event types:

- `agent.state` — `scripts/agent-state.sh` state transition
- `agent.turn.done` — pi extension published compact last assistant message
- `message.sent` / `message.ack` — log-backed short messages
- `handoff.created` / `handoff.sent`
- `monitor.started` / `monitor.done` / `monitor.timeout` / `monitor.killed`
- `audit.run`
- `git.commit` / `git.push` / `git.merge` / `git.command` from explicit telemetry wrapper
- `bd.claim` / `bd.update` / `bd.close` / `bd.remember` / `bd.command` from explicit telemetry wrapper
- `git.pr.create` / `git.pr.merge` / `gh.command` from explicit telemetry wrapper

### Message channel

Use this for short status updates between orchestrator, judge, and delegated panes.
It writes to the xtmux event log; it does **not** inject text into another pane.
Long content still belongs in bead notes or a file.

```bash
# send short update
tmux-session-picker message-send --from <orchestrator> --to <session-or-pane> --bead <id> --text 'short update'

# read messages for orchestrator/session
tmux-session-picker message-list --for <session-or-pane> --unacked

# acknowledge after acting
tmux-session-picker message-ack <message-id> --by <session-or-pane>
```

Delegated panes should use `/multiplexing-team` and report upward with
`message-send` plus durable Beads notes.

### `safe-send-pointer` safety defaults

Auto-double-Enter is now a built-in safety default for Claude Code panes. `safe-send-pointer` probes the target pane's `pane_current_command`; when it is `claude` or matches `claude-*`, the wrapper appends a delayed second Enter because Claude Code consumes the first Enter with its paste-detection heuristic. Codex and pi panes do not receive the extra Enter. If you bypass `safe-send-pointer` and call raw `tmux send-keys`, apply this rule manually.

`--force-freeform` exists for short course-correction messages that are valid under Cardinal Rule 3 but are not slash commands or `/tmp` file pointers. It bypasses only the payload-shape check. The multiline guard, shell-substitution guard (`$(...)` / backticks), working-target refusal, and dry-run/confirmation expectations remain enforced.

### Explicit command telemetry

Telemetry is opt-in and never shadows `git`, `bd`, or `gh` unless the operator
chooses to alias it in a specific shell.

```bash
tmux-session-picker telemetry git -- commit -m 'message'
tmux-session-picker telemetry git -- push
tmux-session-picker telemetry bd -- update <id> --claim
tmux-session-picker telemetry bd -- close <id> --reason 'done'
tmux-session-picker telemetry gh -- pr create --fill
```

Optional shell aliases for a dedicated monitored terminal/pane only:

```bash
alias git='tmux-session-picker telemetry git --'
alias bd='tmux-session-picker telemetry bd --'
alias gh='tmux-session-picker telemetry gh --'
```

Do not add those aliases globally unless the operator explicitly wants all
commands wrapped.

### One terminal to monitor everything

For a human monitoring terminal, prefer the helper script when installed:

```bash
xtmux-monitor --full
# or from the repo:
scripts/xtmux-monitor.sh --full
```

Useful flags:

```bash
xtmux-monitor --session muxmon --interval 2 --kill-existing
xtmux-monitor --messages <session-or-pane> --turns
xtmux-monitor --telemetry --no-attach
xtmux-monitor --log /tmp/xtmux-events.jsonl
```

If the helper script is unavailable, use tmux panes rather than a single noisy stream.
Manual equivalent:

```bash
tmux new-session -s xtmux-monitor 'watch -n 5 "tmux-session-picker dashboard sessions-only"'
tmux split-window -v 'watch -n 10 "tmux-session-picker monitor-list; echo; tmux-session-picker audit"'
tmux split-window -h 'tail -F ${XDG_STATE_HOME:-$HOME/.local/state}/xtmux/events.jsonl'
tmux select-layout tiled
```

Optional focused panes:

```bash
# recent short messages
tmux split-window 'me=$(tmux display-message -p "#S"); watch -n 3 "tmux-session-picker message-list --for $me --unacked 2>/dev/null || true"'

# recent turn completions
tmux split-window 'watch -n 5 "tmux-session-picker log query --type agent.turn.done --since 2h --limit 30"'

# recent git/bd/gh telemetry
tmux split-window 'watch -n 5 "tmux-session-picker log query --since 2h --limit 80 | grep -E '\"type\":\"(git\.|bd\.|gh\.|git.pr)' || true"'
```

For compact ad-hoc monitoring without creating a tmux layout:

```bash
watch -n 5 'tmux-session-picker dashboard sessions-only; echo; tmux-session-picker monitor-list; echo; tmux-session-picker audit'
```

If the JSONL stream is too raw, prefer filtered queries:

```bash
watch -n 5 'tmux-session-picker log query --type message.sent --since 1h --limit 20'
watch -n 5 'tmux-session-picker log query --type agent.turn.done --since 1h --limit 20'
```

## Monitoring — polling via run_in_background

When a delegated agent runs and the operator wants me to wait without burning context with manual capture-pane calls, prefer the project primitive when available:

```bash
tmux-session-picker wait-agent <pane_id> --timeout 30m --interval 30s
# or, when you need a visible registry of active waits:
tmux-session-picker monitor-agent <pane_id> --timeout 30m --interval 30s
tmux-session-picker monitor-list
```

If these commands are unavailable, fall back to structured `@agent_state` polling. This is the safest implementation of the rule "do not prompt while Working":

```bash
# Replace <pane_id> with the actual pane id, e.g. %42. Fires when no longer working.
until state="$(tmux show-options -p -t <pane_id> -qv @agent_state 2>/dev/null || true)" \
  && ! printf '%s\n' "$state" | grep -qE '^(working|running|busy|thinking)$'; do
  sleep 30
done
echo "DONE state=${state:-unknown}"
```

If `@agent_state` is absent or unreliable for that tool, fall back to UI-marker grep:

```bash
until ! tmux capture-pane -t <session> -p | grep -qE '\([0-9]+m? ?[0-9]*s? ·|thinking with|↓ [0-9]+|↑ [0-9]+'; do sleep 30; done
echo "DONE"
```

Run this with `run_in_background: true` / the harness background process facility. The harness will notify when the until-loop exits.

Status-marker grep is intentionally brittle — agent UIs change across versions. Maintain 2-3 fallback patterns and accept that the polling may need adjustment per harness encountered. If the polling exits immediately (false positive), refine the grep before relaunching. A timer firing means "inspect now", not "safe to send blindly"; rerun pre-flight before any send-keys.

Race conditions to know:
- After send-keys, wait 2-3s before the first capture check. The target agent may not yet have entered Working state. A premature check will see "idle" and you risk sending a second prompt on top of the first.
- A fresh `pi --approve` session shows a "Yes/No data usage" prompt before the chat is ready. Sending keystrokes before that prompt clears them gets you into the wrong dialog.
- Double-Enter pattern: **Claude Code panes always need a delayed second Enter after a `tmux send-keys ... Enter` pointer**, because the first Enter is consumed by paste-detection. Codex and pi panes do not need it. Current `safe-send-pointer` applies this automatically when `pane_current_command` is `claude` or `claude-*`; apply it manually only when bypassing `safe-send-pointer`.

## Back-channel notification — do not rely on it as primary

Tested 2026-06-19: `tmux send-keys` from a child session into the parent pane DOES deliver text, but:
- The parent harness catalogs the incoming text as `user sent a new message` system reminder
- Indistinguishable from the operator's real typing — race condition
- Concatenates with any in-flight operator input

Therefore: the default mechanism for "delegated agent finished" is operator-driven (they tell me) or polling (the Monitoring section above). Send-keys-back is acceptable only as a last-resort POSIX-signal-style marker:

```bash
# child sends a TINY signal, no payload:
tmux send-keys -t <parent-session> '[done] /tmp/<output-file>' Enter
```

The parent reads the marker, then reads the file for actual content. Never send the payload itself over send-keys.

The preferred pattern remains: the delegated agent writes its output into the bead via `bd update <id> --notes "..."` and closes the bead with `bd close <id>`. The main session polls bead status. This route has zero injection risk.

## Worktree isolation — known good practice, not enforced today

When a delegated session works on a shared repo checkout where other sessions are also active, sharing the same checkout causes git-state races. One session's `git checkout` or `git stash` affects what every other session sees on disk. Observed live: one discovery session ran a sweep against a different branch than intended because a sibling session had switched the working tree concurrently. The sweep result was still useful only because the analysis was branch-agnostic.

The known mitigation is to spawn delegated sessions in dedicated worktrees via `xt claude` or `xt pi`. This is not currently enforced. When pre-flight detects two live sessions in the same checkout, warn the operator and recommend `xt claude` / `xt pi` for the next delegation. If available, use `tmux-session-picker worktree-collisions` for this check.

## Deploy-gap chain — post-merge observability guard

When the orchestrator moves a PR from merge to a Deploy Monitor observation window, the running container MUST reflect the merged code. Merging on GitHub does not, by itself, rebuild the container. Between `gh pr merge` and container restart, Prometheus/Tempo/Grafana continue to show pre-merge behavior, and any DM window opened during that gap measures the wrong world. This is the class of failure that let a multi-week regression sit in production for over a month, and that reproduced inside a multi-pane sprint eval (EVAL-22).

Enforce the chain as an indivisible sequence:

1. `gh pr merge <N> --repo <owner>/<repo> --squash --admin` (or the repo's canonical merge command).
2. `docker compose -f <compose> build <service>` on the target host.
3. `docker compose -f <compose> up -d --force-recreate <service>` on the target host. `--force-recreate` is required — without it, Docker keeps the existing container when the image tag hasn't textually changed even if the bytes underneath have.
4. Verify the running artifact is newer than the merge, then hand off to DM.

For GitOps-deployed services: wait for the reconciler to advance past the PR's `mergedAt` before handoff.

The verification step is codified as a runnable script bundled with this skill:

```bash
scripts/verify-deploy-applied.sh <container> <pr-number> <owner/repo>
# exit 0 → StartedAt > mergedAt, safe to open DM window
# exit 1 → deploy NOT applied, orchestrator must rebuild + restart
# exit 2 → usage / dependency error (missing gh/docker, PR unmerged, container absent)
```

The file also defines a `verify_deploy_applied` bash function that can be sourced by other scripts, sprint runbooks, and `/tmp/<sprint>-deploy-monitor.txt` prompt templates as step 0 of the DM window protocol. DM refuses to open the window when the script returns non-zero and reports `deploy-not-applied` upward to the orchestrator.

Full doctrine: consult your project's deploy-gap doctrine file (typically `docs/devops/deploy-gap-pattern.md`).

## End-of-session hygiene

Before closing the orchestrator session:
1. `tmux ls` → for each `<orchestrator>-*` session with no pending work, `tmux kill-session -t <name>`
2. `git worktree prune` on each affected repo
3. `sp clean --ps` (if `sp ps` shows resolved terminal rows from cancelled or errored jobs)
4. Process check: classify candidates via `--project` path existence, kill orphans
5. If `/session-close-report` skill is loaded in the current repo, run it

## Out of scope — do not add to this skill later

- Spawn primitives (Docker, VM, subprocess pool)
- Custom IPC schemas (inotify, FIFO, Unix sockets, MCP message bus) — beads already serve the comms role
- Replacement for `/using-specialists` — that skill owns specialist chain orchestration
- Tool-specific bindings (Claude Agent SDK, Cline, Cursor, etc.) — keep this skill tool-agnostic
- Auto-activation triggers based on keywords — auto-activation is unreliable across harnesses; this skill is invoked explicitly
