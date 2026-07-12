# V1 golden fixtures — pre-epic behavior baseline

Captured with `XTMUX_OBS_V2=0`. Every command produces three files:

- `<label>.stdout`
- `<label>.stderr`
- `<label>.exit` (integer + newline)

## Two flavors

| Flavor | Suffix | Reproducible? | Used for |
|---|---|---|---|
| **isolated** | `-empty` | yes — captured inside a scratch `XDG_STATE_HOME` + `TMPDIR` so empty-state is deterministic | byte-identity oracle for `XTMUX_OBS_V2=0` (PRD §20 / Phase 2 VALIDATION) |
| **live** | `-live` | no — snapshot of real dev-machine state at capture time | documentary reference for downstream phase authors; NOT a byte-identity oracle |

## Harness

Capture (write mode): `scripts/capture-v1-fixtures.sh`
Drift check (byte identity vs committed): `scripts/capture-v1-fixtures.sh --check`

The harness isolates state by exporting a scratch `XDG_STATE_HOME` and `TMPDIR`
before invoking the picker; that scopes `events.jsonl`, the monitor TSV
directory, and rotated files to a per-run sandbox.

Companion worktree `xt/ojsx` ships `normalize.sed` for filtering volatile
tokens in fixtures that DO contain state (timestamps, PIDs, hashes,
`/tmp/…`, `%pane_id`, `$session_id`, epoch, 40-hex SHAs). Merges at Phase 1 close.

## Phase 1 captured

### Isolated (byte-identity)

- `message-list-empty` — `message-list --for nonexistent-session`
- `message-list-unacked-empty` — `--unacked` variant
- `monitor-list-empty` — empty monitor registry
- `log-tail-empty` — no events in isolated log
- `log-query-empty` — `--type message.sent` against empty log

### Live (documentary)

- `log-tail-live` — snapshot of live-traffic tail
- `log-query-live` — snapshot of live `message.sent` history
- `audit-live` — snapshot of an audit run on the current dev tree

## Deferred

Owner phase in parens: `message-send` (3), `message-ack` (3), `monitor-agent` (4), `monitor-kill` (4), `handoff` (6), `safe-send-pointer` (3/6), `telemetry` (7). Each phase captures its own fixtures under both flavors as commands become V2-routable.
