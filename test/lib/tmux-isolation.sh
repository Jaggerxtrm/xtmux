#!/usr/bin/env bash
# Hermetic tmux for the xtmux test suites (XTMUX-492).
#
# THE FAILURE THIS PREVENTS. A suite that runs inside a live tmux session
# inherits TMUX and TMUX_PANE. tmux resolves its socket from TMUX FIRST and only
# then from TMUX_TMPDIR, so `TMUX_TMPDIR=$(mktemp -d) tmux ...` inside a live
# session still reaches the operator's server. Bare `tmux kill-session`,
# `send-keys` and `set-option` then kill, type into or rewrite the operator's
# sessions. On 2026-11-26 that is how a worker command and, before it, bare
# contract.sh section calls reached the live server.
#
# THE FIX, in three parts:
#   1. unset TMUX and TMUX_PANE — for this shell and every child it spawns;
#   2. point TMUX_TMPDIR at a private directory, so the server socket and socket
#      directory of every client live under it (layout:
#      $TMUX_TMPDIR/tmux-<uid>/<socket-name>);
#   3. name that server explicitly with -L in tmux_private, so even a leaked
#      TMUX could not redirect a call.
#
# A -t target is still dangerous on its own: an EMPTY -t falls back to the
# current pane (or session) of whatever server the client resolved. Callers
# therefore check tmux_guard_target before any command that carries -t.
#
# Sourced by test/contract.sh, test/nav-contract.sh, test/harness-selftest.sh,
# scripts/smoke-json-api.sh and scripts/verify-json-api.sh. Test suites that do
# not source it still get the same protection from the parent script's
# environment (TMUX unset + private TMUX_TMPDIR are inherited by children).

# tmux_isolation_begin <name-prefix> [socket-name]
#   Isolate this shell and everything it spawns from any live tmux server.
#   Sets TMUX_ISO_DIR and TMUX_ISO_SOCKET, and exports TMUX_TMPDIR.
#
#   The failure guard lives HERE, not at each call site: this helper is the one
#   choke point (three suites and two scripts call it), and a call site that
#   forgot the guard would fall through to the caller's live server. A private
#   directory that cannot be created is fatal, never a skip — skipping would
#   silently drop the isolation claim the whole suite rests on.
tmux_isolation_begin() {
  local prefix="${1:?tmux_isolation_begin: name prefix required}"
  TMUX_ISO_SOCKET="${2:-default}"
  TMUX_ISO_DIR="$(mktemp -d "${TMPDIR:-/tmp}/${prefix}-tmux.XXXXXX")" || {
    printf '\033[31mFAIL\033[0m cannot create a private tmux directory; refusing to run against an inherited tmux server\n' >&2
    exit 1
  }
  unset TMUX TMUX_PANE
  export TMUX_TMPDIR="$TMUX_ISO_DIR"
}

# tmux_private <args...>
#   Run tmux against the private server, named explicitly. Use this instead of a
#   bare `tmux` in any suite that calls tmux directly.
tmux_private() {
  TMUX_TMPDIR="${TMUX_ISO_DIR:?tmux_isolation_begin not called}" \
    command tmux -L "${TMUX_ISO_SOCKET:-default}" "$@"
}

# tmux_private_running — true when the private server answers.
tmux_private_running() {
  tmux_private list-sessions >/dev/null 2>&1
}

# tmux_isolation_end
#   Kill only the private server (explicit -L under the private directory) and
#   remove that directory. Safe to call more than once.
tmux_isolation_end() {
  [ -n "${TMUX_ISO_DIR:-}" ] || return 0
  tmux_private kill-server >/dev/null 2>&1 || true
  rm -rf "$TMUX_ISO_DIR"
  TMUX_ISO_DIR=""
}

# tmux_guard_target <target>
#   True when a -t target is non-empty. Never run `tmux ... -t "$x"` with an
#   empty $x: tmux treats it as "the current pane", which is the operator's.
tmux_guard_target() {
  [ -n "${1:-}" ]
}
