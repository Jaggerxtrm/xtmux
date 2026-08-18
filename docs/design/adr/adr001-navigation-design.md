# `xtmux nav` — Operator Navigation Design

**Status:** v1 design
**Date:** 2026-08-14
**Related decision:** `ADR-0001 — Retain FZF and Introduce Sidebar-Style xtmux nav`

## Topology model (NAV-T8 amendment, 2026-08-17)

The shipped navigator models tmux's real hierarchy. This explicitly corrects the
two-level view used in the original mockups:

```text
previous:
session
  pane

new:
session
  window
    pane
```

Machine identity at every level:

```text
$ = session identity
@ = window identity
% = pane identity
```

- Window index and window name are presentation only; display text never
determines action identity. Every action resolves the hidden machine token
(`s:$N`, `w:$N:@N`, `p:$N:%N`) and ownership is revalidated against live tmux
before mutation.
- Windows are independently selectable; panes are grouped under their real
windows.
- Pane location (repo / `repo · relative-path` / worktree → canonical repo
label) is first-class sidebar context in expanded mode; full absolute paths
stay in the inspector (details-only).
- Occurrence identity: `$`/`@`/`%` are stable object identities. Where a window
or pane is linked into more than one session, each structural occurrence is the
full hierarchy path (`$sid@wid`, `$sid@wid%pane`); a stored token is the
encoded `$session`+`@window` (resp. `%pane`) pair, never a bare object id.
- Restrained palette: neutral primary, one cool accent for current/focus/pointer,
one amber attention, one restrained red for danger; run/done/idle are neutral and
nothing is bold (no rainbow).
- Compact mode is session rows only; expanded mode is session → window → pane.
The sections below are corrected in place to match this amendment.

## 1. Product role

`xtmux nav` is the human navigation surface for a host containing many tmux sessions, panes and agent processes.

Its primary question is:

> Where is the work that needs my attention, and how do I get there with minimal scanning?

It is not a second dashboard database.

It is not an orchestration scheduler.

It is not a replacement for tmux.

## 2. Current UX problem

xtmux knows more information about sessions than the picker can comfortably display.

The current presentation tends toward:

```text
session + repo + branch + status + idle + pane + state + command + bead + task + parent + path
```

on one line.

A narrow terminal therefore loses the information hierarchy precisely when the operator has many sessions and needs the navigator most.

The target design changes the problem from:

```text
How can we fit more tokens on a line?
```

to:

```text
Which information deserves which visual level?
```

## 3. Target view

Expanded drawer:

```text
 xtmux nav · state groups · type to filter
 all›

   xtmux-ui                  2m  urgent wait
     xtmux · nav sidebar · +2
     ↳ @17  0:coord  wait · 2
        ↳ %17  claude  picker UX … · xtmux/src · wait
        ↳ %19  shell  … · xtmux · wait
>▎ sp-reviewer-a91f         <1m  active run
     specialists · nav review
     ↳ @23  0:main  run · 1
        ↳ %23  pi  reviewer … · specialists/nav · run
   quant                    18m  other idle
     quant · main
     ↳ @31  0:main  idle · 1
        ↳ %31  shell  … · quant · idle

 ─ ↵ open · Tab compact · ^/ details · ? help
```

Compact view:

```text
╭─ xtmux ─ compact ───────────────────────╮
│ > ▎ xtmux-ui              attn wait    │
│     quant                 other idle   │
│     market-data           active run  │
│     sp-reviewer-a91f      active run  │
╰──────────────────────────────────────────╯
```

The current target marker and selection pointer intentionally differ:

```text
▎ = where the invoking tmux client currently is
› = what the navigator currently highlights
```

## 4. UI structure

```text
<NavPopup>                         # tmux display-popup owns geometry
  <FzfNavigator>                  # bin/tmux-session-picker
    <Prompt>
      fuzzy query
      active structured filter
    <SessionList>
      <SessionRow>
        <IdentityLine />
        <ContextLine />
        <WindowRows />          # expanded mode only
          <WindowRow>
            <WindowLine />      # @window-id + index:name + state + count
            <PaneRows />        # expanded mode only
              <PaneRow>
                <PaneLine />    # %pane-id + runtime + state
                <LocationLine /># bounded repo/location projection
      <SectionHeader />
    <Inspector>                   # hidden/bottom in drawer
      <SessionMetadata />
      <AgentMetadata />
      <WorktreeMetadata />
      <TerminalCapture />
    <Footer>
      only high-frequency keys
```

Module boundary:

```text
tmux
  owns sessions, panes, client switching

xtmux inventory
  owns projection and normalization

nav renderer
  owns visual hierarchy only

fzf
  owns interactive selection/filter UI

xtmux actions
  execute exact tmux operations
```

## 5. Information hierarchy

### Level 1 — always visible

A session row should answer:

```text
What is it?
Does it need me?
Am I already there?
```

Display:

```text
▎ xtmux-ui                    attn wait
```

Candidate tokens:

```text
current marker
session name
idle age
state badge
```

### Level 2 — useful context

A second line should answer:

```text
Which repository?
What branch and terse worktree status?
```

Display:

```text
  xtmux · feat/nav-sidebar · +2
```

Candidate tokens:

```text
repo
branch
terse dirty/shared indicators
```

### Level 3 — window row

A window row answers:

```text
Which window?
What state and how many panes?
```

Display:

```text
  ↳ @17  0:coord              run · 2
```

Single `↳` ancestry glyph, fixed sibling indent (sibling-position invariant).

Candidate tokens:

```text
@window-id (machine identity, never truncated)
window index:name (presentation only)
pane→window aggregate state
pane count
```

### Level 4 — expanded child pane

A pane row answers:

```text
Which process?
Which agent state?
Which bounded work item?
Where is it?
```

Panes render one line each (`NAV_PANE_LINES=1`), with the bounded filesystem
location appended inline:

```text
  ↳ %17  claude  picker UX … · xtmux/src · WAIT
```

Candidate tokens:

```text
pane id
runtime/command
state
Bead
short task
bounded repo/location projection (inline)
```

Pane location is first-class sidebar context in expanded mode: the same repo,
`repo · relative-path` inside a repo, the canonical repo label for worktrees
(never a long `.xtrm/worktrees/…` wall), or a shortened `~/…` path when there is
no repo. The full absolute path remains inspector-only.

### Inspector-only information

Keep these out of the normal list:

```text
full path
full task
prompt_file
parent session
last-transition timestamp
pane dimensions/geometry
long Bead description
git diff stat
specialist process diagnostics
terminal capture
```

## 6. Session state roll-up

Do not create a nav-specific state machine.

Use the existing normalized pane states and session attention roll-up.

Conceptually:

```text
sessionState(panes)
  if any pane is stale
    stale
  else if any pane needs input
    needs-input
  else if any pane is running
    running
  else if any pane is done
    done
  else if any pane is idle
    idle
  else
    unknown
```

This visual roll-up does not change canonical attention filters or direct-navigation
ranking; it only places running sessions before completed sessions in the default view.

## 7. Navigation modes

### Expanded

Shows session rows, window rows, and pane children.

Use when actively supervising agents.

### Compact

Shows session rows only.

Use when switching quickly across many repositories.

The existing `sessions-only` state maps to compact mode. Compact mode is not
"hide pane records"; it is the sessions-only projection of the same
session → window → pane inventory.

### Inspector

Independent of expanded/compact.

States:

```text
hidden
visible
```

Drawer mode uses a bottom inspector hidden by default until `Ctrl-/`.

Classic mode can use a right inspector.

## 8. Canonical command surface

```text
xtmux nav
```

Open interactive navigator.

```text
xtmux nav next
xtmux nav prev
```

Cycle ordinary tmux sessions.

```text
xtmux nav attention-next
xtmux nav attention-prev
```

Cycle attention targets.

```text
xtmux nav window-next
xtmux nav window-prev
```

Move to the next/previous window of the current session (native tmux
next-window/previous-window).

```text
xtmux nav back
```

Return to the target recorded before the previous xtmux jump.

The existing commands remain valid:

```text
xtmux attn-jump N
xtmux jump-back
```

The nav family provides discoverable operator semantics over them.

## 9. Session-cycle behavior

Normal session cycling should use tmux's own session order.

Call tree:

```text
xtmux nav next
  recordPrev
  tmux switch-client -> next session

xtmux nav prev
  recordPrev
  tmux switch-client -> previous session
```

Window cycling is likewise native: `window-next`/`window-prev` invoke tmux's
`next-window`/`previous-window` for the current client's session — a single tmux
call, no inventory, no fzf/git, wraps around (verified syntax: no `-t` needed).

Do not enumerate and sort session names merely to reproduce something tmux already defines.

The docs should also teach the native tmux session keys so xtmux does not hide useful underlying behavior.

## 10. Attention-cycle behavior

```text
attentionCycle(direction)
  rows = attn_list()

  if rows is empty
    show non-error message
    return

  currentPane = live invoking pane

  if currentPane is absent
    choose first/last based on direction
  else
    choose adjacent row
    wrap at boundaries

  recordPrev()
  jumpToTarget()
```

This gives the operator two different navigation axes:

```text
session next/prev
  ordinary workspace traversal

attention next/prev
  work requiring supervision
```

## 11. Search model

Typing directly into fzf remains ordinary fuzzy search.

Structured filters remain additive:

```text
repo:<substr>
branch:<name>
cmd:<agent|shell|bun>
grep:<text>
```

Attention presets remain:

```text
all
waiting
running
```

The footer should not permanently enumerate them all.

`?` owns full key discovery.

## 12. FZF record model

The interactive navigator needs a private transport format.

```text
record
├── type
├── session_id
├── name            (bounded; session, window, or pane name)
├── target          ($N / @N / %N)
├── action token
└── display
```

Serialized conceptually as:

```text
type<TAB>sid<TAB>name<TAB>target<TAB>token<TAB>display<NUL>
```

Why NUL boundaries:

```text
display may contain newline
record identity must not
```

Why an action token:

```text
multi-select operations must never receive the entire rendered record
```

Example tokens:

```text
s:$42
w:$42:@17
p:$42:%17
```

Tokens are not user-facing identifiers and must not contain display metadata.

## 13. Action safety

For each fzf action:

```text
highlighted record
  hidden machine fields
    exact xtmux subcommand
      exact tmux target
```

Never:

```text
highlighted display
  parse visible text
    guess target
```

This matters especially for:

```text
Enter
Alt-Enter
kill
bulk kill
rename
approve
interrupt
message
```

Display strings can legitimately contain:

```text
spaces
Unicode
branch punctuation
Bead titles
task punctuation
```

They must remain inert.

## 14. Multi-line capability probe

Before enabling the multi-line renderer:

```text
probeFzf()
  inspect installed version/help
  create two NUL-delimited records
  place newline inside display field
  verify:
    two selectable records exist
    each record renders multiple lines
    hidden field placeholders resolve correctly
    selected action receives exact machine token
    multi-select receives exact machine tokens

  if any invariant fails
    use compact single-line renderer
```

Do not approximate this with a visual-only smoke test.

The action payload must be verified.

### Verified local capability surface

Characterization on 2026-08-14 used tmux 3.5a and fzf package 0.60.3 (`fzf --version` reports `0.60 (devel)`). An ephemeral PTY probe verified:

```text
two NUL-separated records remain distinct when display fields contain newlines
{5} resolves the hidden action token
{+5} passes two selected tokens as separate arguments
become and execute invoke the expected payload
reload-sync plus track-current retains the machine record boundary
```

`--filter` did not apply `--accept-nth` on this build, so filter mode is not a valid token-output capability probe. The implementation gate must use explicit action payloads.

Fallback order:

```text
full multiline nav
  all semantic probes pass

bounded one-line nav
  machine-field actions pass but multiline behavior does not

classic picker
  machine-field action safety cannot be proven
```

## 15. Inspector

Target structure:

```text
SESSION
  name      xtmux-ui
  state     needs-input
  repo      xtmux
  branch    feat/nav-sidebar
  dirty     2
  idle      2m

AGENT
  pane      %17
  runtime   claude
  bead      xtmux-nav.2
  task      Picker/sidebar redesign
  parent    $8
  last      2026-08-14T18:42:11+02:00

WORKTREE
  path      …/.xtrm/worktrees/xtmux-nav.2

GIT
  <bounded status/diff information>

────────────────────────────────────
<bounded pane capture>
```

The inspector should progressively enrich.

The hot list should not pay for enrichment that only the selected row needs.

## 16. Sidebar popup

Target desktop binding:

```text
tmux client
  prefix+s
    display-popup
      left aligned
      full height
      38–40% width
        xtmux nav
```

The exact percentage should remain configurable through tmux configuration rather than hard-coded as a runtime contract.

Recommended examples may include:

```text
38-40% intended sidebar hierarchy
44-50% long session names
55-60% small terminals
```

The binding syntax was verified with tmux 3.5a. No automatic terminal rewriting
or global key installation is required in v1.

## 17. Footer

Default drawer footer:

```text
↵ open · Tab compact · ^/ details · ? help
```

When compact:

```text
↵ open · Tab expanded · ^/ details · ? help · compact
```

`Tab` toggles topology, not pane visibility: compact = sessions-only;
expanded = session → window → pane.

When a structured filter is active, the prompt itself should communicate that state.

Do not use the footer as a complete keybinding manual.

## 18. Herdr adoption boundary

The current reference was inspected at `herdrdev/herdr@d76657f2c7fc18dcce3b9af43842c8afaba1646b` on 2026-08-14. Herdr has separate persistent-sidebar and modal-navigator behaviors. xtmux adopts selected UX mechanisms, not a one-to-one command model.

Adopt:

| Herdr mechanism | xtmux interpretation |
| --- | --- |
| bounded multi-row cards | session/context and pane/task lines |
| active row distinct from navigation selection | independent `▎` current marker and fzf `›` pointer |
| explicit worktree membership | group from normalized repository/worktree identity, never rendered names |
| priority projection | use xtmux's existing attention rank and tie-breakers, not Herdr state authority |
| minimal scroll adjustment | reveal current target on open; thereafter retain the operator selection/viewport |
| bounded metadata-row tokens | deferred constrained presets, not a general theming DSL |
| collapsed group retains active child | deferred with group collapse, so location remains visible |

Do not map directly:

| Herdr behavior | Reason |
| --- | --- |
| compact icon rail | tmux popup plus sessions-only mode already supplies the v1 narrow surface |
| hierarchy-aware workspace next/previous | `nav next/prev` intentionally preserves native tmux order |
| current-view agent cycling | attention navigation must follow xtmux's authoritative attention projection |
| done/unseen priority | requires seen-state semantics explicitly deferred from v1 |
| per-workspace subtree collapse | useful later, but distinct from existing compact/expanded list mode |

Do not adopt in this workstream:

| Herdr feature | Reason |
| --- | --- |
| persistent terminal server | conflicts with scope/authority |
| separate session runtime | tmux remains authority |
| plugin runtime | unrelated |
| drag reorder | unnecessary for first nav slice |
| workspace creation/deletion | nav is initially read/navigation focused |
| Herdr agent detection authority | xtmux already has agent-state contracts |

## 19. Worktree grouping

Current xtmux already understands worktree/repository relationships.

The visual design should eventually pack related sessions:

```text
xtrm
├─ main
├─ xtmux-nav.2
└─ xtmux-nav.4
```

Do not block the first nav release on full collapsible group state.

Initial implementation may retain the existing sorted grouping while improving tree glyphs and row proximity.

A later iteration may add group collapse if it can be done without creating complex persistent UI state.

## 20. Future row-token configuration

The long-term renderer should move away from hard-coded string concatenation.

Possible future configuration:

```text
session:
  - [current, name, state]
  - [repo, branch, git, age]

pane:
  - [tree, pane, runtime, state]
  - [bead, task]
```

Possible styles:

```text
minimal
default
verbose
```

This should be an explicit later work item.

Do not build a general theming DSL in the first PR.

## 21. Future seen/unseen attention

Potential future operator state:

```text
done + unseen
done + seen
```

A completed agent the operator has not visited is generally more important than one already inspected.

If implemented later:

```text
mark seen only on actual jump/attach
not on fzf highlight
not on preview
```

This is UI state, not a new `@agent_state`.

Persisting it in SQLite requires a separate architectural decision.

## 22. Future pinned/favorite sessions

Potential navigation convenience:

```text
pin session
pin repository
recent targets
```

This is not required for v1.

The initial navigation problem is sufficiently addressed by:

```text
fuzzy search
repo grouping
attention ordering
next/prev
jump-back
```

## 23. Native TUI decision threshold

Do not replace fzf because a native TUI would be aesthetically cleaner.

Consider a dedicated TUI only if measured evidence shows fzf cannot safely or ergonomically provide important requirements such as:

```text
multi-level collapse
stable multi-row selection
rich independent scrolling regions
complex mouse interaction
large-scale incremental updates
remote multi-host composition
```

Until then:

```text
fzf is a dependency
not an architectural liability
```

## 24. Performance model

Hot path:

```text
tmux session/pane inventory
  normalize live agent state
  read cached git metadata
  construct rows
  fzf
```

Cold/selected-row path may perform more work:

```text
preview selected row
  Bead lookup
  git diff stat
  process-tree specialist enrichment
  pane capture
```

Never move preview-only work into the hot list for visual convenience.

## 25. Current performance characterization

A 2026-08-14 live-host baseline used 13 sessions, 16 panes and 13 distinct pane paths. The checkout code matched `origin/main`; the only local commit added these design documents.

| path | repeated observed range |
|---|---:|
| cold `list all` | 796–1285 ms |
| warm `list all` | 143–294 ms |
| forced no-cache refresh | 776–1335 ms |
| warm sessions-only list | 125–183 ms |
| session preview sample | 352–461 ms |

Warm structural command tracing observed two tmux calls, zero git calls, zero process-tree probes and 18 wrapped external commands total. A parent-process RSS sample measured approximately 6.9 MiB; short-lived child RSS was not captured reliably and must be treated as a measurement limitation.

These measurements are a local baseline, not a permanent acceptance threshold.
The completed same-fixture comparison and subprocess evidence are recorded in
`docs/perf-audit.md`.

## 26. Compatibility

These remain valid:

```text
tmux-session-picker
xtmux with existing subcommands
existing list modes
existing filters
existing attention jumps
existing JSON API
existing dashboard/topology consumers
existing multiplexing workflows
```

`xtmux nav` is additive.

A user must be able to revert presentation without reverting the runtime.

## 27. Initial implementation phases

### NAV-0 — Decision and characterization

Deliver:

```text
ADR
this design document
current performance measurements
tmux/fzf capability evidence
Bead decomposition
```

### NAV-1 — Safe record boundary

Deliver:

```text
shared inventory
classic renderer unchanged
internal nav renderer
safe action tokens
multi-line capability fallback
fzf actions no longer parse visible records
bulk action safety
```

This is the highest-risk implementation slice.

### NAV-2 — Sidebar presentation

Deliver:

```text
two-line session rows
bounded pane rows
current-target marker
structured inspector
short footer
drawer/classic layouts
docs/keys examples
```

### NAV-3 — Navigation verbs

Deliver:

```text
nav next
nav prev
attention-next
attention-prev
back
wraparound tests
optional documented tmux bindings
```

### NAV-4 — Polish and release proof

Deliver:

```text
narrow-width fixtures
performance comparison
README/docs reconciliation
full test gates
classic fallback proof
review-ready PR
```

## 28. Deferred roadmap

Explicitly deferred:

```text
row-token configuration
persistent seen/unseen
favorites/pins
group collapse state
remote-host navigator
mouse navigation
native TUI
Console integration
worktree mutation
```

These ideas belong to later Beads, not hidden scope expansion of the first implementation PR.

## 29. Acceptance scenarios

### Many sessions

Given 20+ sessions across several repositories, the operator can identify session name, urgency, repository and branch state without horizontal scrolling.

### Waiting agent

When one pane changes to `needs-input`, its session presentation and attention ordering update without waiting for a rendered-output cache TTL.

### Long task text

A long `@agent_task` does not cause the primary identity/state tokens to disappear.

### Malicious/awkward metadata

A task, branch or session metadata value containing spaces, quotes, shell metacharacters or multiple visual lines cannot alter an action target.

### Session traversal

The operator can move forward/backward across sessions without opening the picker.

### Attention traversal

The operator can repeatedly cycle through all attention targets and wrap around deterministically.

### Return

After a navigation jump, one action returns to the previous target.

### Narrow drawer

At approximately 40–55 columns, the navigator remains useful rather than becoming a collection of truncated metadata fragments.

### Compatibility

If nav/multiline behavior proves defective, classic presentation can be selected without rolling back runtime changes.

## 30. Final invariant

The target UX is:

```text
session identity is obvious
attention is obvious
context is nearby
detail is available on demand
navigation is reversible
display text is never authority
```

In one sentence:

> `xtmux nav` should feel like a live sidebar over tmux, while remaining a thin, safe projection over the runtime xtmux already has.
