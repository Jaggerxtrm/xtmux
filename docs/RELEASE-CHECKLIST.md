# Release cadence

Cutting a release from a clean main:

```sh
make release VERSION=v0.1.0       # cli.cliff regen + commit + tag + push
```

`make release` runs `git-cliff` under the tag, rewrites `CHANGELOG.md` so the
pending block moves under `## [X.Y.Z] - <date>`, commits it as
`docs(changelog): cut vX.Y.Z`, tags the commit, and pushes tag + HEAD. The
tag push triggers `.github/workflows/release.yml`, which runs the test gate,
`npm publish --provenance`, and `gh release create` with that tag's CHANGELOG
section as the body.

Version bumps: minor for user-facing features, patch for fix/cleanup batches.
No major bumps by default. To roll the pending block without cutting a tag,
`make changelog` regenerates against `[Unreleased]`.

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

## Pending v0.3.0 release notes

Author-side notes to fold into the CHANGELOG `[v0.3.0]` section when the
operator cuts the tag. The generator (`npm run changelog`) rebuilds
`[Unreleased]` from git commits and does not preserve prose blocks, so this
lives here until tag time.

### Upgrade note (v0.3.0)

- Semver target: `v0.3.0`. Minor bump. Additive over `v0.2.3`: K3 Codex runtime
  adapter, K4 Codex lifecycle/recovery/managed distribution, monitor liveness
  and retention, stale Pi-context defenses, byte-identical compatibility links.
- Operators should re-run install after upgrade. Rationale: the K4 batch
  changes installer distribution surface (`scripts/install.mjs` compatibility
  links, packaged Codex hook trust, hook entry repair for pre-tag installs)
  and the Pi extension surface (grouped extension package internals). A rerun
  of `npm i -g @jaggerxtrm/xtmux` (or the project-local `install:global`
  script) rewrites Claude/Codex hook wrappers with the current `_source`-tagged
  payload and picks up the compatibility-link fix.
- xtmux never installs the Codex CLI; the Codex hook payload only installs
  when a `~/.codex` directory already exists. Restated per the phase-2 gate
  above.

### Pi dev-dependency pin rationale

- `@earendil-works/pi-ai@0.80.6` and `@earendil-works/pi-coding-agent@0.80.6`
  are pinned as `devDependencies`, exact (no `^` / `~`). They are the
  characterization baseline for the Pi ExtensionAPI surface that the
  `packages/pi-extensions` sources compile and typecheck against.
- Consumer runtime Pi is whatever version the operator installs globally
  (typically 0.84.1 at time of writing); xtmux does not depend on that
  version at runtime beyond the ExtensionAPI shape captured by the pin.
- Do not bump the pin on this release. Bump only when the Pi ExtensionAPI
  surface changes materially for xtmux extensions and the change requires
  refreshing our type-checked characterization. When bumping, re-run the K1
  characterization gate and update this note.
- Dependabot PRs that bump this pin (for example PR #97) are intentionally
  deferred until the next characterization refresh, so the baseline moves in
  one operator-owned step rather than drifting per Dependabot update.

## Phase 2 coordination release gates

- [ ] Build the runtime before help/smoke checks: `bun run build`.
- [ ] Run `bun test`, `bash test/contract.sh`, installer tests, typecheck, and
      `scripts/verify-json-api.sh`; JSON examples must parse and picker/raw help
      must name the same flags and fields.
- [ ] Pack the npm artifact and verify it contains migrations 0010/0011, the
      grouped Pi package sources, all owned Claude hooks, and the updated public
      docs. Run clean install, update, and uninstall smoke from that tarball.
- [ ] Upgrade smoke starts fresh Claude and Pi sessions (or `/reload` for Pi),
      verifies `xtmux-obs health`, `obligations list`, pane-scoped `message-list
      --expects-reply`, and `monitor-list`, then completes one correlated reply
      and one delivered/consumed wake across process restart.
- [ ] Repeat coordination smoke with `XDG_RUNTIME_DIR` unset and assert no
      `xtmux-reply-obligations`, `xtmux-outbound-expectations`, or
      `xtmux-auto-monitor` directory is created or consulted.
- [ ] Verify ack-only leaves `replyStatus:"pending"`, failed safe-send leaves the
      obligation pending, wrong requester/pane cannot reply or consume, and a
      same-target older wait does not cover a newer obligation.
- [ ] Verify Pi bounds: outgoing obligations default to 200 rows and inbox reads
      pass `--limit 500`; `monitor-list` remains unbounded and Pi must fail closed
      after parsing more than 500 monitor rows. Successful cycles cap work at 20
      reply keys/mutations, 22 widget rows, and bounded continuation text;
      backend/JSON failures remain visible and do not promote summaries to
      instructions.
- [ ] Compare `README.md`, `docs/json-command-api.md`, architecture/install docs,
      `xtmux help`, raw `xtmux-obs --help`, packaged hooks/extensions, and the
      operator skills. No surface may teach ack-as-reply, runtime-marker TTL, or
      target-only requester ownership.
- [ ] Confirm the upgrade note says xtmux installs Codex hooks only into an
      existing `~/.codex`; it never installs Codex CLI. Do not publish until all
      gates above pass.

## Multiplexed coordination findings

Pane `xtmux:1.1` (Claude Code) inspected the repository, live global Claude config, and hook history. It found that xtrm regeneration had removed the three auto-monitor registrations while leaving their scripts behind, and that the old hook default hardcoded `/home/dawid/dev/xtmux`. It recommended a dedicated `~/.claude/hooks/xtmux` namespace, atomic read/merge/write, deterministic ownership, and preserving every foreign wrapper. The installer implements that layout and the hardcoded path now defaults to `$HOME/.local/bin/xtmux`.

Pane `xtmux:1.2` (this Pi session) inspected `~/dev/xtrm/.xtrm/config/hooks.json`, `~/dev/xtrm/.xtrm/registry.json`, the live `~/.claude/settings.json`, and the primary manager implementation in `~/dev/core/cli/src/core/{global-hooks-bootstrap,claude-runtime-sync}.ts`. Conventions confirmed:

1. product-owned global hook directory
2. canonical config resolved to absolute global paths
3. atomic JSON replacement
4. source-tagged wrappers replaced only by their owner
5. unrelated top-level settings and hook wrappers preserved

xtmux mirrors those conventions with its own paths and `_source: "xtmux"`; it does not import, call, or modify xtrm. The package-owned hook copies live in `hooks/claude`, not the xtrm-managed `.xtrm` asset tree, so a future `xt update --apply` cannot overwrite the published installer payload.
