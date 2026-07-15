# Install and release decisions

## Install

Requirements: Node.js 20+, tmux, and fzf. The npm package supplies Bun for the SQLite runtime; the public `xtmux-obs` Node shim resolves that package-local binary, so a system `bun` on `PATH` is not required.

```sh
npm install --global @jaggerxtrm/xtmux
```

The installer prints five plain progress lines and does not open Chrome or any browser. It installs:

- commands in `~/.local/bin`
- one grouped Pi package in `~/.pi/agent/packages/xtmux`, registered in `~/.pi/agent/settings.json`
- Claude hooks in `~/.claude/hooks/xtmux`, registered in `~/.claude/settings.json`
- agent-state hooks in `~/.codex/hooks/xtmux` only when an existing `~/.codex` installation is detected; xtmux never installs Codex CLI

Restart Pi or run `/reload` after installation. Start new Claude Code and existing Codex CLI sessions to load hook changes; running sessions keep their startup hook configuration.

### Add the tmux bindings

The installer does not edit `~/.tmux.conf`. Add at least the picker popup binding, then reload tmux:

```tmux
bind s display-popup -E -w 99% -h 97% "$HOME/.local/bin/xtmux"
```

```sh
tmux source-file ~/.tmux.conf
```

Optional compact picker and attention-jump bindings are in [`docs/keys.md`](keys.md), which is included in the npm package.

## Upgrade

```sh
npm update --global @jaggerxtrm/xtmux
```

Updates replace only entries tagged with `_source: "xtmux"`. Re-running installation is idempotent. Run `/reload` in Pi or start a fresh Pi session, and start fresh Claude Code sessions; running processes retain their loaded extension/hook code.

### Coordination migration

SQLite at `${XDG_STATE_HOME:-$HOME/.local/state}/xtmux/observability.db` is the
source of truth for messages, reply links, requester-owned waits, monitor wakes,
and wake consumption. Schema migrations 0010 and 0011 apply automatically when
the runtime opens the database. Verify after upgrade:

```sh
xtmux-obs health
xtmux obligations list --pane "$TMUX_PANE" --json
xtmux message-list --for "$(tmux display-message -p '#{session_id}')" \
  --pane "$TMUX_PANE" --expects-reply --json
xtmux monitor-list --json
```

Old `xtmux-reply-obligations`, `xtmux-outbound-expectations`, and
`xtmux-auto-monitor` runtime directories are neither imported nor read by the
new hooks/extensions. They were projections of durable message/monitor state,
not authority. Do not restore marker readers or use marker age/absence to infer
completion; re-arm a fresh wait when `obligations list` shows a pending send with
no covering monitor. `obs-migrate` remains limited to legacy JSONL and monitor
TSV import.

No `XDG_RUNTIME_DIR` is required for coordination. The installer does not delete
arbitrary runtime directories; stale marker files may be removed by normal OS
runtime cleanup after all old agent processes have exited.

## Uninstall

```sh
xtmux-install --uninstall
npm uninstall --global @jaggerxtrm/xtmux
```

Run `xtmux-install --uninstall` first so npm has not yet removed the cleanup command. It removes only xtmux-owned links, the grouped Pi package, Claude/Codex hook files, and owned settings entries.

## Conflict avoidance and xtrm coexistence

The installer refuses to replace a real file or foreign symlink in a command destination. It preserves unrelated Pi packages, Claude settings, and hook wrappers. Before changing Claude settings it writes `~/.claude/settings.json.pre-xtmux`.

xtmux does not write to `~/.xtrm`, `.xtrm/config/hooks.json`, or xtrm's `_source: "xtrm-global"` wrappers. This follows the primary xtrm hook manager's convention: copy package-owned hooks to a product-owned global directory, tag owned wrappers, replace only wrappers with that source tag, and atomically merge the remaining settings. xtmux uses `~/.claude/hooks/xtmux` instead of xtrm's `~/.xtrm/hooks`, so either product can update or uninstall independently.

Legacy xtmux agent-state wrappers that point to `~/.tmux/scripts/agent-state.sh` are migrated to tagged wrappers under `~/.claude/hooks/xtmux`; unrelated wrappers remain untouched.

## Pi package grouping

Pi supports an npm package manifest with a `pi.extensions` array. xtmux therefore publishes one Pi package instead of separate extension packages. `pi-agent-state.ts` and `pi-auto-monitor.ts` are the two entrypoints; `pi-auto-monitor.ts` initializes `pi-inbox-reply.ts`, and both use `coordination-json.ts` internally. Loading all four as independent entrypoints would register inbox handlers twice.

For a Pi-only project install, without global commands or Claude hooks:

```sh
pi install npm:@jaggerxtrm/xtmux
```

## Changelog decision

xtmux does **not** use the stock Keep a Changelog template. A hand-maintained template duplicates information already present in Conventional Commits and tends to drift. The generated file keeps the useful Keep a Changelog shape (`# Changelog`, `[Unreleased]`, version/date headings) but groups entries by xtmux's scopes.

Structure:

```text
# Changelog
## [Unreleased]
### Observability runtime
### Coordination and hooks
### Messages and delivery
### Migration
### Pi extensions
### Added
### Fixed
### Project maintenance
```

Example output:

```markdown
## [Unreleased]
### Coordination and hooks
- Install owned Claude hooks without replacing xtrm entries ([abc1234](...))

### Pi extensions
- Group agent state and auto-monitor entrypoints in one package ([def5678](...))
```

Generate it in this repository:

```sh
npm run changelog -- --unreleased --output CHANGELOG.md
```

Consume the same generator from another repository:

```sh
npx --package @jaggerxtrm/xtmux xtmux-changelog --unreleased --output CHANGELOG.md
```

The reusable config is exported as `@jaggerxtrm/xtmux/changelog-config`. The optional AI authoring prompt is exported as `@jaggerxtrm/xtmux/aicommit2-prompt`.

## aicommit2 and pi-cliff decision

Neither blocks the installer and neither should be implemented first.

- **aicommit2:** optional authoring assistance, not a release prerequisite. Installing a repository Git hook automatically would change contributor workflow and can conflict with `core.hooksPath`, Husky, or pre-commit. The package ships `prompts/aicommit2.txt`; users who want it can set `systemPromptPath` and run `aicommit2 hook install`. The changelog remains deterministic without AI.
- **pi-cliff:** no such npm package exists under `pi-cliff` or `@jaggerxtrm/pi-cliff` as of 2026-07-14. Creating one would duplicate the official `git-cliff` npm distribution. xtmux depends on `git-cliff@2.13.1` and exposes the small `xtmux-changelog` wrapper instead.

Suggested optional setup:

```sh
npm install --global aicommit2
AICOMMIT_CONFIG_PATH="$HOME/.config/aicommit2/config.ini" aicommit2 config set systemPromptPath="$(npm root -g)/@jaggerxtrm/xtmux/prompts/aicommit2.txt"
aicommit2 hook install
```

The author always retains veto over the generated commit message. No API keys or provider configuration are stored by xtmux.
