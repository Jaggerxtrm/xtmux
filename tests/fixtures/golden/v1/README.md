# V1 golden fixtures — pre-epic behavior baseline

Captured with `XTMUX_OBS_V2` unset. For every command in PRD `docs/ts-sqlite.md`
§20 we snapshot three files:

- `<label>.stdout`  — captured stdout
- `<label>.stderr`  — captured stderr
- `<label>.exit`    — captured exit code (integer + newline)

Comparators run `sed -f normalize.sed` on both sides before diffing.
`normalize.sed` (owned by companion worktree, merged at Phase 1 close) filters
volatile tokens: timestamps, PIDs, hashes, `/tmp/…​` paths, `%<pane_id>`,
`$<session_id>`, epoch seconds, 40-hex SHAs.

## Phase 1 captured (this worktree, xt/hnjk)

- `message-list-empty` — `message-list --for nonexistent-session`, empty stdout
- `message-list-unacked-empty` — `--unacked` variant, empty stdout
- `monitor-list-empty` — clean state, empty stdout
- `log-tail-empty` — live traffic sample (nonzero, xtmux dev machine state)
- `log-query-empty` — `--type message.sent` live sample
- `audit-noop` — live audit run on clean-ish worktree
