# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Added
- CI, CodeQL, and Dependabot baseline (#2) ([fdba7b8](https://github.com/Jaggerxtrm/xtmux/commit/fdba7b8b13e7bed03b4f7312a75b87c2dcd80408))
- Additive --json command API + xtrm v2 skills migration (#6) ([fd568db](https://github.com/Jaggerxtrm/xtmux/commit/fd568dbbc46acecff5198ebcd89d16163ecf87e9))
- Expose canonical `xtmux` command prefix via alias (#9) ([589695c](https://github.com/Jaggerxtrm/xtmux/commit/589695c58f0f066b4d0ecc00940186637dca403b))
- Real `xtmux help` — grouped commands and --json output fields (#11) ([ad304ee](https://github.com/Jaggerxtrm/xtmux/commit/ad304eec948ddac1c6004125a78ec2d71a62d8d7))

### Coordination and hooks
- Wake-path completion — wait-for-transition + Claude Stop drain ([c70b725](https://github.com/Jaggerxtrm/xtmux/commit/c70b725a58fdea8531327e485b5ac9a4af8182b6))
- XTMUX_AUTO_MONITOR_SKIP_TARGETS env bypass (xtmux-3xs.29) ([ae42383](https://github.com/Jaggerxtrm/xtmux/commit/ae42383c4772e351ca33341f5bfb12474508a786))
- Auto-monitor tmux has-session precheck (xtmux-3xs.30) ([5f4eb8f](https://github.com/Jaggerxtrm/xtmux/commit/5f4eb8fd6a7f1464e2116219ad420ac07d344def))
- List pane reply obligations ([9f2eed2](https://github.com/Jaggerxtrm/xtmux/commit/9f2eed2dacf135b15a8b0a66572798c697a7ff6b))

### Fixed
- V2 message ack takes V1 message-key; audit --stable sort (xtmux-3xs.24, .17) ([7ce1eef](https://github.com/Jaggerxtrm/xtmux/commit/7ce1eef86cdc965965a23bcdf543de2320a6319d))
- Shadow-tee sites were checking stale $REPLY after log_event (xtmux-3xs.12) ([fc3195e](https://github.com/Jaggerxtrm/xtmux/commit/fc3195e98a9b152659ef99ca2fa6fd199139cbf0))
- Derive coordination effects from JSON results (#12) ([6f20973](https://github.com/Jaggerxtrm/xtmux/commit/6f209735ec2e7a89a15f44969262e4c9e9b3a77a))
- Make the smoke gate tell the truth, and fix what it was hiding (#13) ([e19886b](https://github.com/Jaggerxtrm/xtmux/commit/e19886b8b38f1684c3d26fe7150ee338a2465eb0))
- Migrate on the monitor/telemetry/audit path (#15) ([c81da80](https://github.com/Jaggerxtrm/xtmux/commit/c81da80488b6ddfa6307e421a3930694cfb5103d))
- Detect Claude panes that run behind the xt wrapper (#17) ([647bcaa](https://github.com/Jaggerxtrm/xtmux/commit/647bcaa1e117edc9683852bd3d858506ef6c2cca))

### Messages and delivery
- Add status and unread query primitives ([53b0c2b](https://github.com/Jaggerxtrm/xtmux/commit/53b0c2b885717e54878e961589a02d091d0754ca))
- Unread-count --pane %N for pane-scoped counts (xtmux-3xs.28) ([ff2c489](https://github.com/Jaggerxtrm/xtmux/commit/ff2c48994773b76d924988eae04213bc36c2d487))
- V2 timestamp column matches V1 date -Is byte-for-byte (xtmux-3xs.27) ([b056061](https://github.com/Jaggerxtrm/xtmux/commit/b05606129f72cabd9ba3dc3ce7f8d490845d895a))
- Add sender-declared reply expectations ([b87fb05](https://github.com/Jaggerxtrm/xtmux/commit/b87fb057e03450e3fe840df52bc6521be06f26a1))

### Migration
- Reconstruct monitors rows from legacy .tsv (xtmux-3xs.13) ([93576ae](https://github.com/Jaggerxtrm/xtmux/commit/93576ae1336e4bc16075f54d4e3f0a4d0fe9b89c))

### Observability runtime
- Bun --compile CLI binary + picker prefers it (xtmux-3xs.11) ([47f9d31](https://github.com/Jaggerxtrm/xtmux/commit/47f9d3164ea767d5af2dc4bb07c193505993f057))
- Shadow-mode picker wiring — writes tee, reads diff (xtmux-3xs.12) ([abf82f4](https://github.com/Jaggerxtrm/xtmux/commit/abf82f44ecc81314f7fc9edbcd06176f58c03693))
- Slow-query envelope wrapper in openDb (xtmux-3xs.14) ([f2bba70](https://github.com/Jaggerxtrm/xtmux/commit/f2bba708aa274180969f5035bb64981ff5d282ae))
- PRAGMA optimize on close (xtmux-3xs.15) ([b0a43f3](https://github.com/Jaggerxtrm/xtmux/commit/b0a43f3c1f09065a7b0f7f28bcb607c5fc6616ac))
- Retention CLI subcommand + scheduling docs (xtmux-3xs.16) ([4d8e4b4](https://github.com/Jaggerxtrm/xtmux/commit/4d8e4b4cace63c665818ac38900c2e4dcfd18c29))
- Log-query shadow-diff; audit content-diff declined (xtmux-3xs.25) ([71dd2df](https://github.com/Jaggerxtrm/xtmux/commit/71dd2dfb0f8bacbb46b7ec2dbd9992e51c004999))
- Flip V2 to default-on — epic cutover (xtmux-3xs.31) ([99dc6c6](https://github.com/Jaggerxtrm/xtmux/commit/99dc6c627902ba13031737dc5838d0d0bf13be38))

### Pi extensions
- Add inbox and deferred reply reminders ([6f224ed](https://github.com/Jaggerxtrm/xtmux/commit/6f224ede119554f6964ddefdfa03200a71606c77))
- Scope inbox counts to current pane ([c215728](https://github.com/Jaggerxtrm/xtmux/commit/c21572833fd35ff7344ef38617f66ca3c7ff8cb7))
- Detect reply obligations while idle ([b4f93da](https://github.com/Jaggerxtrm/xtmux/commit/b4f93da169c63fa96fa0fb76264e917acdc7e630))
- Inject pending replies into turn context ([22bcf10](https://github.com/Jaggerxtrm/xtmux/commit/22bcf10ef20ba6e3aca9cd6b2ec18150073150d1))
- Wake on outbound peer completion ([fc4af11](https://github.com/Jaggerxtrm/xtmux/commit/fc4af11adecc1c1482ed0652bc0b197c9bb997bc))
- Wake on idle reply obligations ([b65f9a6](https://github.com/Jaggerxtrm/xtmux/commit/b65f9a63b56cf9927b573e197a1ec72b712e4c17))

### Project maintenance
- Add hostile and differential contract oracles ([39a01fa](https://github.com/Jaggerxtrm/xtmux/commit/39a01fa5fb58cbeb6bf25f495924128a40213a5e))
- Apply 0.10.2 managed assets ([27bb881](https://github.com/Jaggerxtrm/xtmux/commit/27bb88169c7a1e5e9b9a4f489f9eb96bc55c28d7))
- Gitignore .xtrm/statusline-claim (runtime hook write) ([e2e97b8](https://github.com/Jaggerxtrm/xtmux/commit/e2e97b81580d0b4bcdb70df0fe5ba47ccaebcd4f))
- Run the json-api gate (build freshness + live tmux smoke) (#7) ([5eaeaeb](https://github.com/Jaggerxtrm/xtmux/commit/5eaeaebdb4272c3ccb62d13a51b51d7c74cf1c7f))
- Typecheck Pi extensions against pinned API (#8) ([4d6963a](https://github.com/Jaggerxtrm/xtmux/commit/4d6963a155ebada4625ffc93b4bc15d9d9ba98bc))
- Make a missing `pi` binary name its own cause (#16) ([4341167](https://github.com/Jaggerxtrm/xtmux/commit/4341167e2d0883ae11d776ea331908e98a48bc57))
- Apply 0.10.4 managed assets — hooks now fail open (#18) ([a78a352](https://github.com/Jaggerxtrm/xtmux/commit/a78a3521f62ffd4899594d0e06f7a377ccba799b))
- Apply 0.10.5 managed assets (#19) ([32f1806](https://github.com/Jaggerxtrm/xtmux/commit/32f1806e8e541f403db37181b42fc97293a3553e))
<!-- generated by xtmux-changelog; edit commit messages or cliff.toml, not generated rows -->
