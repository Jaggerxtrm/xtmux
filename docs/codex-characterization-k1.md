# Codex K1 characterization packet

Status: read-only characterization for `xtmux-s96.1`.

## Capture boundary

- xtmux under test: `v0.2.3` at commit `12d6709e`.
- Codex under test: `codex-cli 0.146.0` from `/home/dawid/.local/bin/codex`.
- Live captures used an isolated temporary `CODEX_HOME`, a command hook that copied
  stdin, `codex exec --ephemeral --skip-git-repo-check --sandbox read-only
  --dangerously-bypass-hook-trust --json`, and a redacted prompt.
- The live request was unauthenticated. `SessionStart`, `UserPromptSubmit`, and
  `SessionEnd` were captured. A successful turn was not available, so `Stop` is a
  release-document reference fixture, not a live capture.
- Dynamic identifiers, paths, model names, prompts, and assistant text are redacted.
  The original payload shape and field presence remain unchanged.

Fixtures are versioned under `tests/fixtures/codex/0.146.0/`:

| Fixture | Provenance | Observed fields |
|---|---|---|
| `session-start.json` | live Codex capture | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `source` |
| `user-prompt-submit.json` | live Codex capture | common fields plus `turn_id`, `prompt` |
| `session-end.json` | live Codex capture after request failure | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `reason` |
| `stop-reference.json` | Codex 0.146.0 release docs | common fields plus `turn_id`, `stop_hook_active`, `last_assistant_message` |

## Current installed xtmux wiring

`scripts/install.mjs` updates an existing `~/.codex/hooks.json`; it does not install
Codex. It writes two `_source: "xtmux"` entries:

| Codex event | Matcher | Command | Current effect |
|---|---|---|---|
| `SessionStart` | `startup|resume|clear` | `agent-state.sh idle --new-instance` | starts a fresh pane occupation and identity |
| `UserPromptSubmit` | none (Codex ignores matcher) | `agent-state.sh running` | marks the pane running |

The installer removes only entries tagged `_source: "xtmux"`. Untagged foreign or
legacy entries survive install and uninstall. The managed Codex directory contains
only `agent-state.sh`; the Claude turn-capture hook is not installed there.

The `SessionStart` matcher intentionally excludes `compact`, so compaction does not
mint a second `@agent_instance_id`. The Codex commands pass state through argv;
`agent-state.sh` does not parse the Codex JSON on stdin. It requires both `TMUX` and
`TMUX_PANE`; outside a live tmux client it exits successfully without changing state.

## Authority inventory

| Domain | Existing authority | Codex status |
|---|---|---|
| messages | `src/domains/messages/*`, `src/cli-messages.ts` | shared; no Codex-specific store or parser |
| obligations | `src/domains/messages/obligations.ts` and reply correlation | shared; no Codex-specific ownership |
| monitors and wakes | `src/domains/monitors/*`, `src/cli-monitors.ts` | shared; Codex hooks do not register or consume monitors |
| identity | `scripts/agent-state.sh`, `src/domains/identity/runtime-context.ts`, pane options | Codex startup reaches the shared pane identity path |
| lifecycle | `scripts/agent-state.sh`, `src/domains/agents/instance.ts` | startup and prompt transitions only; no Codex stop/off transition |
| recovery | shared SQLite journal and fail-open hook callers | no Codex recovery hook or restart transition |
| turn capture | `extensions/pi-agent-state.ts`, `hooks/claude/claude-agent-turn-capture.mjs`, `src/domains/agents/turn.ts` | no Codex producer; no `agent.turn.done` hook is installed |
| installer | `scripts/install.mjs` | Codex ownership is tag-based and isolated from Claude/Pi assets |

## Turn and K2 boundary

The current xtmux tree has no Codex payload parser, Codex adapter, or K2 outcome
consumer. Therefore the exact set of K2 fields consumed by current xtmux code is
**empty**. This is an observed absence, not an inferred Core contract.

The existing shared turn writer accepts these xtmux-owned fields when a producer
exists: `pane`, `session`, `session_name`, `bead`, `parent`, `last_message`, and
`last_message_file`. `src/domains/agents/turn.ts` stores the corresponding
`paneId`, `sessionId`, `beadId`, `parentSessionId`, `summary`, and
`lastMessageText`. Neither path reads Codex hook JSON or a Core K2 outcome.

K2 remains an external contract boundary. The sibling gate `xtmux-s96.6` blocks K3
until the Core package is consumable. K3 must define an explicit mapping from that
boundary to these existing xtmux authorities instead of adding a Codex message,
obligation, monitor, wake, identity, lifecycle, or turn store.

## Observed gaps blocking K3

1. Codex has verified `Stop` and `SessionEnd` payloads, but xtmux installs neither;
   Codex panes cannot report `done` or `off` through the current installer.
2. Codex `Stop` exposes `last_assistant_message`, but no current Codex hook captures
   it or emits `agent.turn.done`.
3. Codex docs expose `PermissionRequest`, `PreToolUse`, `PostToolUse`, compact-aware
   `SessionStart`, and subagent events. xtmux currently wires none of these for
   Codex, and the verified hook set has no `Notification` event equivalent.
4. Pi and Claude already have turn capture and broader lifecycle coverage. Codex
   currently has only startup identity and prompt-running parity.
5. Recovery remains shared-domain work: no Codex-specific recovery state machine is
   present or justified by this characterization.

## Validation

The focused replay/ownership test is `tests/contracts/codex-characterization.test.ts`:

```text
bun test tests/contracts/codex-characterization.test.ts
3 pass, 0 fail, 51 expect() calls
```

It verifies fixture provenance and redaction, executes the configured startup/prompt
state commands with the captured payloads as stdin under a deterministic tmux stub,
and asserts the resulting `idle`/`running` pane state. It also proves tagged versus
untagged installer ownership and the current Codex turn-capture/stop gaps without
claiming that `agent-state.sh` parses Codex payloads or changing runtime behavior.
