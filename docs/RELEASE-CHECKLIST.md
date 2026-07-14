# Release epic 5j3 checklist

| proposal | implementation or decision |
|---|---|
| 5j3.1 git-cliff changelog | `changelog/cliff.toml`, `xtmux-changelog`, `npm run changelog`, reusable exported config |
| 5j3.2 README and docs audit | npm install section refreshed; `docs/INSTALL.md`; post-cutover quickstart added; observability design framing updated. `~/dev/core/docs/xt-pi-role.md` was verified: it correctly delegates extension discovery to global/project Pi settings, which the grouped package uses. |
| 5j3.3 publish/install strategy | public `@jaggerxtrm/xtmux`; source package with official Bun and git-cliff dependencies; npm global lifecycle installer; tag-triggered trusted npm publish workflow. Prebuilt GitHub binaries rejected: the tested tarball is ~120 KB and the Bun npm dependency supplies the platform runtime without a second release channel. |
| 5j3.4 license and metadata | MIT `LICENSE`; public package metadata; strict `files` whitelist plus `.npmignore` |
| 5j3.5 aicommit2 | optional prompt shipped; hook install deliberately not automatic because it is contributor policy, not runtime installation |
| 5j3.6 coordination skill docs | already completed in the epic before this installer work |
| 5j3.7 specialists callout | explicitly non-blocking upstream-only follow-up; no vendored specialists file is modified here |
| Pi extensions | one grouped local Pi package with two entrypoints and their internal modules |
| Claude hooks | six hook files under `~/.claude/hooks/xtmux`; owned, idempotent global settings wrappers |
| xtrm coexistence | separate directories/source tags; `_source: xtrm-global` preserved; no writes under `~/.xtrm` |
| clean install/update/uninstall | installer contract tests plus packed-artifact smoke before publication |
| actual npm publish | blocked by the explicit goal constraint until packed install, contents, idempotency, coexistence, and changelog consumption pass |

## Multiplexed coordination findings

Pane `xtmux:1.1` (Claude Code) inspected the repository, live global Claude config, and hook history. It found that xtrm regeneration had removed the three auto-monitor registrations while leaving their scripts behind, and that the old hook default hardcoded `/home/dawid/dev/xtmux`. It recommended a dedicated `~/.claude/hooks/xtmux` namespace, atomic read/merge/write, deterministic ownership, and preserving every foreign wrapper. The installer implements that layout and the hardcoded path now defaults to `$HOME/.local/bin/xtmux`.

Pane `xtmux:1.2` (this Pi session) inspected `~/dev/xtrm/.xtrm/config/hooks.json`, `~/dev/xtrm/.xtrm/registry.json`, the live `~/.claude/settings.json`, and the primary manager implementation in `~/dev/core/cli/src/core/{global-hooks-bootstrap,claude-runtime-sync}.ts`. Conventions confirmed:

1. product-owned global hook directory
2. canonical config resolved to absolute global paths
3. atomic JSON replacement
4. source-tagged wrappers replaced only by their owner
5. unrelated top-level settings and hook wrappers preserved

xtmux mirrors those conventions with its own paths and `_source: "xtmux"`; it does not import, call, or modify xtrm. The package-owned hook copies live in `hooks/claude`, not the xtrm-managed `.xtrm` asset tree, so a future `xt update --apply` cannot overwrite the published installer payload.
