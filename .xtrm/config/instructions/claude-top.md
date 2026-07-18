# XTRM Agent Workflow

> Full reference: `XTRM-GUIDE.md` | Session manual: `/using-xtrm` skill.
> This is a compact managed block. Use CLI `--help` and skills for details; do not paste full manuals here.

## Session start

1. `bd prime` — load workflow context and active claims.
2. `bd memories <topic>` / `bd recall <key>` — retrieve durable context before answering questions or changing workflow-sensitive code.
3. Catch up on recent work: check handoff/next-session beads, latest `xt report` handoffs, recent merged/closed PRs, and `bd list --status=in_progress`.
4. `bv --robot-triage --format toon` or `bv --robot-next` — choose work when needed. Never run bare `bv`.
5. If board state is unclear, run `/issue-triage` or the robot triage/plan commands before editing.
6. For service/docs/project context, run `/scope` or `/using-service-skills`; note stale/missing service skills before relying on them.
7. `bd ready` / `bd show <id>` / `bd update <id> --claim` — inspect and claim before edits.
8. For non-trivial work, use Claude Code task planning features (TaskCreate/TodoWrite-style when available) before proceeding; keep the plan synchronized with the active bead.

## Operating rules

- Beads is authoritative for ownership, dependencies, memory gates, and closure.
- Claude-local task plans are required for non-trivial/multi-step work but are ephemeral execution tracking only.
- Close beads and satisfy memory ack before commit: `bd remember` when useful, then `bd kv set memory-acked:<id> saved:<key>` or `nothing novel:<reason>`, then `bd close <id> --reason="..."`.
- Ask before destructive, irreversible, production-impacting, or history-rewriting actions.
- Do not ask repetitive “Proceed?” confirmations for normal implementation once scope is clear.
- For reply-required xtmux messages, preserve `messageKey` and use a correlated reply (`message-reply` or successful `safe-send-pointer --reply-to`); ack and target-only sends do not fulfil the request.

## Code restraint (when implementing directly)

- YAGNI first. Lazy solution that actually works: reuse existing → stdlib → native → one line → minimum. Prefer deletion. No unrequested abstractions. Match existing project conventions; never invent a new style mid-file.
- Never simplify away: input validation at trust boundaries, error handling preventing data loss, security, accessibility, explicitly requested behavior. Never lazy about understanding the problem.
- Mark deliberate shortcuts `// SIMPLIFIED: <ceiling>. upgrade when <trigger>.` Unmarked shortcuts silently rot.

## Essential command surface

Use these as the minimal operational surface; use `--help` for full syntax.

- `bd prime`, `bd ready`, `bd list --status=in_progress`, `bd show <id>`
- `bd update <id> --claim`, `bd remember "<insight>"`, `bd close <id> --reason="..."`
- `bd set-state <id> <dim>=<val> --reason="..."`, `bd state <id> <dim>` — operational state labels (e.g. `contract=ready`, `patrol=muted`, `health=healthy`)
- `bd ready --claim` — atomic claim-on-ready; `bd ready --explain` — why an issue is ready/blocked
- `bd create --graph <plan.json> --dry-run` — issue-graph decomposition; `--waits-for <id> --waits-for-gate all-children|any-children` for fan-in/out; `--spec-id`/`--skills` to link specs/required skills
- `bv --robot-triage --format toon`, `bv --robot-next` — never bare `bv`
- `xt report list` / latest report file, `xt update --apply`, `xt end`
- `xt worktree --help` — PR/branch/restart audit primitives (`audit-prs`, `branch-gc`, `restart-audit`); pair with specialists `doctor --pr-drift` / `doctor --reap-dead-jobs`. Details: `/using-xtrm`.
- `gh pr list --state merged --limit 5` or equivalent host CLI when PR context matters
- `sp --help`, `sp list` / `specialists list`, `sp ps`, `sp feed <job-id>`, `sp result <job-id>`

## Skill routing

| Need | Use |
|---|---|
| xtrm/beads workflow | `/using-xtrm`; `bd --help`; `xt --help` |
| Specialist orchestration | latest `/using-specialists-*`, prefer `/using-specialists`; check `sp --help` + `sp list` first |
| Multi-pane coordination | `/multiplexing`; delegated panes use `/multiplexing-team` |
| xtmux CLI (messaging, handoff, agent-state) | `xtmux --help`, `xtmux <cmd> --help` first |
| Service/docs/project context | canonical service-skills skill set: `/scope`, `/using-service-skills` |
| Planning/tests/docs | `/planning`, `/test-planning`, `/sync-docs` |
| Board unclear/backlog messy | `/issue-triage`; `bv --robot-triage --format toon`; `bv --robot-plan` |
| Release/session close | `/releasing`, `/xt-end`, `/session-close-report`, `/xt-merge` |
| Hook/skill work | `/hook-development`, `/skill-creator` |

## Session start reflex

```bash
bd prime                    # workflow context + active claims
bd memories <topic>         # retrieve prior context before answering
bv --robot-triage           # ranked picks (never bare `bv` — it's a TUI)
bd update <id> --claim      # claim before any edit
```

## Trigger patterns

| When | Do |
|---|---|
| user prompt has `?` | `bd memories <keywords>` before answering |
| unfamiliar area of code | `gitnexus_query({query: "concept"})` before opening files |
| about to edit a symbol | `gitnexus_impact({target, direction:"upstream"})` |
| before `git commit` | `gitnexus_detect_changes({scope:"staged"})` |
| about to `bd create` for a specialist dispatch | pass `--parent <bead-it-services>` + title `<role>: <task>` |
| about to `sp run` | check `bd state <id> contract`; promote `draft` → `ready` first |
| just capturing an idea, not working it | `bd create --labels contract:draft` with real PROBLEM + rough SCOPE |
| tmux/xtmux coordination or reply-required msg | `/multiplexing`; preserve returned `messageKey`; use `message-reply --in-reply-to` |
| reading code | `find_symbol` / `get_symbols_overview` (Serena) — never whole files |
| memory is wrong / superseded | `bd forget <key>` — beats leaving stale entries to poison future `bd memories` searches |
| stale session claim blocking commit gate | `bd kv clear "claimed:<pid>"` (note: `bd kv clear`, NOT `bd kv delete`) |
| session end | memory gate fires — evaluate `bd remember` per closed issue; ack with `bd kv set "memory-acked:<id>" "saved:<key>"` or `"nothing novel:<reason>"` |

## Rule conflict — TaskCreate / TodoWrite

`bd prime` (auto-injected at SessionStart) says *"Prohibited: Do NOT use TodoWrite, TaskCreate, or markdown files for task tracking"*. **This project overrides that line.** Claude Code's TaskCreate / TodoWrite features are used *alongside* beads for non-trivial work — beads remains authoritative for ownership, dependencies, memory gates, and closure; TaskCreate plans are ephemeral execution tracking scoped to the active bead. Do not create MEMORY.md files (the bd prime rule against those still holds).

## Project intelligence — on demand (xtrm-x12p3)

xtrm-loader no longer embeds project bodies in every request. Read them when the task needs them:

- Architecture / roadmap: first of `architecture/project_roadmap.md`, `ROADMAP.md`, `architecture/index.md`.
- Project rules: `.claude/rules/**/*.md`.
- Project skills catalog: Claude's native skill discovery (`~/.claude/skills/`); force-load a skill's body at turn 1 via `/skill-<name>`.
- Durable cross-session knowledge: `bd memories <topic>` / `bd recall <key>` / `bd remember "<insight>"`.
- Full workflow examples + prompt-shaping guidance: `/skill-using-xtrm` (on demand — `using-xtrm-reminder.mjs` SessionStart hook still eager-loads it on Claude for now; Pi is on-demand only).
- Auto-injected essential (small): `.xtrm/memory.md` per-project synthesized state.

## Code intelligence and edits

- Before editing an existing function/class/method, run GitNexus impact analysis.
- Warn before proceeding if impact risk is HIGH or CRITICAL.
- For unfamiliar code, query GitNexus execution flows before broad grep-heavy reads.
- Before commit or handoff, run `gitnexus_detect_changes()` to verify affected scope.
- Prefer targeted symbol/file reads and precise edits over whole-tree dumps.
- When Serena is available, prefer symbolic tools (`find_symbol` → `get_symbols_overview` → `replace_symbol_body`; `find_referencing_symbols`/`rename_symbol` for LSP-accurate references) over grep-read-sed for code reads and edits.

## Context and output management

- Use context-mode automatically to keep command/file output compact: `ctx_execute` for logs, tests, large command output, and structured data processing; `ctx_execute_file` for deriving facts from files without dumping contents; `ctx_batch_execute` for multi-command research; `ctx_search` for previously indexed material.
- Use normal read/edit tools only when exact file text is needed for a patch. Do not `cat`/dump large outputs into the conversation when a context-mode tool can summarize or index them.

## Quality gates

- Run targeted tests/build/typecheck relevant to changed files.
- Fix quality failures before commit.

## Worktree sessions

- `xt claude` — launch Claude Code in a sandboxed worktree.
- `xt claude --role <specialist>` — spawn an interactive specialist session (e.g. `chain-coordinator` for tracking epic chains, `pr-reviewer`, `sre-triage`). Coordination and escalation live in `/multiplexing` Pattern 7 and `/using-specialists`.
- `xt end` — close session: commit / push / PR / cleanup when appropriate.
