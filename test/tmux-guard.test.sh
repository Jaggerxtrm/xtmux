#!/usr/bin/env bash
# Guard matrix for bin/tmux-guard (XTMUX-493).
#
# CLAIM UNDER TEST: the installed `tmux` refuses `kill-server` when it targets the
# protected socket, on every spelling of that command, and changes nothing else:
# every other command, every argument and the exit status pass through to the real
# tmux.
#
# METHOD. The real tmux is a recording fake on PATH, so no assertion depends on a
# live server and both the exit status and the argv are observable directly. Every
# passthrough case also proves the guard found the real binary from PATH (the fake
# lives outside /usr/bin), not a hard-coded path. The inherited-TMUX case
# reproduces the 2026-11-26 incident: TMUX names the default socket, exactly as an
# agent pane passes it.
#
# CONSTRAINT (XTMUX-492, lead brief 2026-11-27): no assertion and no command here
# may touch the operator's server. The script unsets TMUX/TMUX_PANE and points
# TMUX_TMPDIR at a fresh private directory before the first tmux call, every refusal
# case sets XTMUX_GUARD_SOCKET to a private socket so the protected path is never
# the live default socket, and the one real-server block starts its server with -L
# and stops it with -L.
#
# Run: bash test/tmux-guard.test.sh
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
GUARD="$ROOT/bin/tmux-guard"

. "$HERE/lib/harness.sh"
. "$HERE/lib/tmux-isolation.sh"

RESULTS="$(mktemp "${TMPDIR:-/tmp}/xtmux-guard-results.XXXXXX")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/xtmux-guard.XXXXXX")"
harness_init "$RESULTS"
GUARD_BIN="$WORK/guard-bin"
REAL_BIN="$WORK/real-bin"
RECORD="$WORK/real-args"
# The socket this matrix treats as protected, and the private directory the guard
# derives its default-socket target in. Both are under $WORK: never /tmp/tmux-<uid>.
PROTECTED_DIR="$WORK/protected"
PROTECTED_SOCKET="$PROTECTED_DIR/tmux-$(id -u)/default"
mkdir -p "$GUARD_BIN" "$REAL_BIN" "$PROTECTED_DIR"
ln -s "$GUARD" "$GUARD_BIN/tmux"
cat >"$REAL_BIN/tmux" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${FAKE_TMUX_RECORD:?}"
case ${1:-} in exit7) exit 7 ;; esac
exit 0
FAKE
chmod +x "$REAL_BIN/tmux"

tmux_isolation_begin xtmux-guard-isolation || {
  printf '\033[31mFAIL\033[0m cannot create a private tmux directory; refusing to run against an inherited tmux server\n'
  exit 1
}

cleanup() {
  tmux_isolation_end
  find "$WORK" -delete 2>/dev/null
  find "$RESULTS" -delete 2>/dev/null
}
trap cleanup EXIT

# guard_run <tmux-env|-> <override|-> <args...>
#   Run the guard through its installed name with a controlled TMUX, override and
#   protected socket. Leaves CASE_RC, CASE_ARGS (what the real tmux received),
#   CASE_OUT, CASE_ERR.
guard_run() {
  local tmux_env=$1 override=$2
  shift 2
  : >"$RECORD"
  (
    unset TMUX TMUX_PANE TMUX_ALLOW_KILL_SERVER XTMUX_GUARD_SOCKET XTMUX_GUARD_REAL XTMUX_REAL_TMUX
    export TMUX_TMPDIR="$PROTECTED_DIR"
    export XTMUX_GUARD_SOCKET="$PROTECTED_SOCKET"
    if [ "$tmux_env" != "-" ]; then export TMUX="$tmux_env"; fi
    if [ "$override" != "-" ]; then export TMUX_ALLOW_KILL_SERVER="$override"; fi
    export FAKE_TMUX_RECORD="$RECORD"
    PATH="$GUARD_BIN:$REAL_BIN:/usr/bin:/bin" "$GUARD_BIN/tmux" "$@"
  ) >"$WORK/out" 2>"$WORK/err"
  CASE_RC=$?
  CASE_ARGS="$(cat "$RECORD")"
  CASE_OUT="$(cat "$WORK/out")"
  CASE_ERR="$(cat "$WORK/err")"
}

assert_refused() { # <case name>
  assert_eq "$1: exit status" 1 "$CASE_RC"
  assert_eq "$1: real tmux not invoked" "" "$CASE_ARGS"
  case $CASE_ERR in
    *TMUX_ALLOW_KILL_SERVER*) ok "$1: refusal names the override" ;;
    *) nok "$1: refusal names the override" ;;
  esac
  case $CASE_ERR in
    *-L*) ok "$1: refusal names the explicit-target escape" ;;
    *) nok "$1: refusal names the explicit-target escape" ;;
  esac
}

assert_passed() { # <case name> <expected argv>
  assert_eq "$1: exit status" 0 "$CASE_RC"
  assert_eq "$1: argv reaches the real tmux" "$2" "$CASE_ARGS"
}

echo "== passthrough =="
guard_run - - -V
assert_passed "-V" "-V"
guard_run - - list-sessions
assert_passed "list-sessions" "list-sessions"
guard_run - - new-session -d -s demo
assert_passed "multi-argument command" "new-session -d -s demo"
guard_run - - kill-session -t keep
assert_passed "kill-session is not guarded" "kill-session -t keep"
guard_run - - exit7
assert_eq "child exit status passes through" 7 "$CASE_RC"

# Invoked by its PATH name, as a shell, script or agent would.
: >"$RECORD"
CASE_RC=$(
  env -u TMUX -u TMUX_PANE -u TMUX_ALLOW_KILL_SERVER FAKE_TMUX_RECORD="$RECORD" \
    TMUX_TMPDIR="$PROTECTED_DIR" XTMUX_GUARD_SOCKET="$PROTECTED_SOCKET" \
    PATH="$GUARD_BIN:$REAL_BIN:/usr/bin:/bin" tmux -V >/dev/null 2>&1
  echo $?
)
assert_eq "invoked as bare tmux from PATH" 0 "$CASE_RC"
assert_eq "PATH resolution finds the fake, not /usr/bin/tmux" "-V" "$(cat "$RECORD")"

echo "== kill-server on the protected socket =="
guard_run - - kill-server
assert_refused "bare kill-server"
guard_run "$PROTECTED_SOCKET,4242,0" - kill-server
assert_refused "inherited TMUX pointing at the default socket (the incident)"
guard_run "$PROTECTED_SOCKET,4242,0" - kill-ser
assert_refused "abbreviated kill-ser"
guard_run - - kill-serv
assert_refused "abbreviated kill-serv"
guard_run - - kill-serve
assert_refused "abbreviated kill-serve"
guard_run - - -f /dev/null kill-server
assert_refused "global option with a value does not hide the command"
guard_run - - -- kill-server
assert_refused "-- does not hide the command"
guard_run "$PROTECTED_SOCKET,4242,0" 0 kill-server
assert_refused "TMUX_ALLOW_KILL_SERVER=0 does not allow it"
guard_run "$PROTECTED_SOCKET,4242,0" yes kill-server
assert_refused "TMUX_ALLOW_KILL_SERVER=yes does not allow it: only 1 does"
guard_run "$PROTECTED_SOCKET,4242,0" 1 kill-server
assert_passed "TMUX_ALLOW_KILL_SERVER=1" "kill-server"

echo "== explicit target and other servers =="
guard_run - - -L other kill-server
assert_passed "-L <name>" "-L other kill-server"
guard_run - - -S "$WORK/private.sock" kill-server
assert_passed "-S <path>" "-S $WORK/private.sock kill-server"
guard_run - - -Lsock kill-server
assert_passed "attached -L<name>" "-Lsock kill-server"
guard_run "$PROTECTED_DIR/tmux-$(id -u)/private,4242,0" - kill-server
assert_passed "inherited TMUX naming another server" "kill-server"
guard_run - - kill-s
assert_passed "kill-s is outside the operator rule set, so it is not guarded" "kill-s"

echo "== configured protected socket =="
: >"$RECORD"
CASE_RC=$(
  env -u TMUX -u TMUX_PANE -u TMUX_ALLOW_KILL_SERVER FAKE_TMUX_RECORD="$RECORD" \
    TMUX_TMPDIR="$PROTECTED_DIR" XTMUX_GUARD_SOCKET="$WORK/other-socket" \
    PATH="$GUARD_BIN:$REAL_BIN:/usr/bin:/bin" "$GUARD_BIN/tmux" kill-server >/dev/null 2>&1
  echo $?
)
assert_eq "XTMUX_GUARD_SOCKET moves the protected socket" 0 "$CASE_RC"
assert_eq "XTMUX_GUARD_SOCKET: the other target passes" "kill-server" "$(cat "$RECORD")"

echo "== real-binary resolution =="
: >"$RECORD"
CASE_RC=$(
  env -u TMUX -u TMUX_PANE -u TMUX_ALLOW_KILL_SERVER FAKE_TMUX_RECORD="$RECORD" XTMUX_GUARD_REAL="$REAL_BIN/tmux" \
    PATH="$GUARD_BIN:/usr/bin:/bin" "$GUARD_BIN/tmux" -V >/dev/null 2>&1
  echo $?
)
assert_eq "XTMUX_GUARD_REAL selects the binary" 0 "$CASE_RC"
assert_eq "XTMUX_GUARD_REAL argv" "-V" "$(cat "$RECORD")"
: >"$RECORD"
CASE_RC=$(
  env -u TMUX -u TMUX_PANE -u TMUX_ALLOW_KILL_SERVER -u XTMUX_GUARD_REAL FAKE_TMUX_RECORD="$RECORD" XTMUX_REAL_TMUX="$REAL_BIN/tmux" \
    PATH="$GUARD_BIN:/usr/bin:/bin" "$GUARD_BIN/tmux" -V >/dev/null 2>&1
  echo $?
)
assert_eq "XTMUX_REAL_TMUX remains a working alias" 0 "$CASE_RC"
: >"$RECORD"
CASE_RC=$(
  env -u TMUX -u TMUX_PANE -u TMUX_ALLOW_KILL_SERVER FAKE_TMUX_RECORD="$RECORD" XTMUX_TMUX_GUARD_DEPTH=3 \
    PATH="$GUARD_BIN:$REAL_BIN:/usr/bin:/bin" "$GUARD_BIN/tmux" -V >/dev/null 2>&1
  echo $?
)
assert_eq "recursion depth guard fails closed" 127 "$CASE_RC"

# The real server, when one is available to start privately. This block is the one
# place a real tmux runs, and it is named and stopped with -L.
echo "== private server =="
if [ -x /usr/bin/tmux ]; then
  unset TMUX TMUX_PANE
  if tmux_private new-session -d -s guard-probe; then
    ok "private server started with -L"
  else
    nok "private server started with -L"
  fi
  (
    unset TMUX TMUX_PANE TMUX_ALLOW_KILL_SERVER
    TMUX_TMPDIR="$PROTECTED_DIR" XTMUX_GUARD_SOCKET="$PROTECTED_SOCKET" \
      PATH="$GUARD_BIN:/usr/bin:/bin" "$GUARD_BIN/tmux" kill-server
  ) >"$WORK/out" 2>"$WORK/err"
  assert_eq "bare kill-server against the private default socket" 1 "$?"
  if tmux_private_running; then ok "refused kill-server leaves the server alive"; else nok "refused kill-server leaves the server alive"; fi
  (
    unset TMUX TMUX_PANE TMUX_ALLOW_KILL_SERVER
    TMUX_TMPDIR="$TMUX_ISO_DIR" PATH="$GUARD_BIN:/usr/bin:/bin" "$GUARD_BIN/tmux" -L default kill-server
  ) >"$WORK/out" 2>"$WORK/err"
  assert_eq "explicit -L kill-server exits 0" 0 "$?"
  if tmux_private_running; then nok "explicit -L kill-server reaches the private server"; else ok "explicit -L kill-server reaches the private server"; fi
else
  printf '  \033[33mskip\033[0m no /usr/bin/tmux; private-server block skipped\n'
fi

harness_summary
