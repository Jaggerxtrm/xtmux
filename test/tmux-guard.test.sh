#!/usr/bin/env bash
# Guard matrix for bin/tmux-guard (XTMUX-493).
#
# CLAIM UNDER TEST: the installed `tmux` refuses `kill-server` when it targets the
# protected socket, on every spelling of that command, for a command chained with
# `;` and for one carried in an argument (if-shell, confirm-before, command-prompt
# -I, run-shell -C), and passes through what the cases below name: other commands,
# argv with spaces and quotes, stdin, and the child exit status. `source-file` and
# other out-of-reach forms pass through and are pinned at the end of the guarded
# block.
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
case ${1:-} in
  exit7) exit 7 ;;
  cat-stdin) cat; exit 0 ;;
esac
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
guard_run - - send-keys -t keep "two words" 'a b'
assert_passed "argv with spaces and quotes" "send-keys -t keep two words a b"
# A function in a pipeline runs in a subshell, so its CASE_* would be lost; the
# stdin case invokes the guard directly and captures stdout.
: >"$RECORD"
CASE_OUT=$(
  printf 'from stdin\n' | (
    unset TMUX TMUX_PANE TMUX_ALLOW_KILL_SERVER XTMUX_GUARD_REAL XTMUX_REAL_TMUX
    export TMUX_TMPDIR="$PROTECTED_DIR" XTMUX_GUARD_SOCKET="$PROTECTED_SOCKET" \
      FAKE_TMUX_RECORD="$RECORD" PATH="$GUARD_BIN:$REAL_BIN:/usr/bin:/bin"
    "$GUARD_BIN/tmux" cat-stdin
  )
)
CASE_RC=$?
CASE_ARGS="$(cat "$RECORD")"
assert_eq "stdin passthrough: exit status" 0 "$CASE_RC"
assert_eq "stdin passthrough: bytes" "from stdin" "$CASE_OUT"
assert_eq "stdin passthrough: argv" "cat-stdin" "$CASE_ARGS"
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
guard_run - - kill-server -L "$WORK/other.sock"
assert_refused "kill-server with -L after the command word (tmux does not permute it)"
guard_run - - kill-server -S "$WORK/other.sock"
assert_refused "kill-server with -S after the command word"
guard_run - - new-session -d ';' kill-server
assert_refused "chained with a separate ; token"
guard_run - - send-keys -t keep 'a;' kill-server
assert_refused "chained with a trailing ; on a word"
guard_run - - new-session -d ';' kill-session -t keep ';' kill-server
assert_refused "chained after two other commands"
guard_run "$PROTECTED_SOCKET,4242,0" - 'kill-server;' new-session -d
assert_refused "a kill-server that ends with ;"
guard_run - - 'new-session;' kill-server
assert_refused "a trailing ; on the command word does not hide the next command"
guard_run - - if-shell true kill-server
assert_refused "a command carried by if-shell"
guard_run - - if-shell -F '#{==:1,1}' kill-server
assert_refused "a command carried by if-shell -F"
guard_run - - confirm-before -p 'close the server?' kill-server
assert_refused "a command carried by confirm-before"
guard_run - - run-shell -C kill-server
assert_refused "a shell command carried by run-shell -C"
guard_run - - command-prompt -I kill-server
assert_refused "an initial command carried by command-prompt -I"
guard_run - - if-shell true 'new-window; kill-server'
assert_refused "a quoted multi-command string is split and caught"
guard_run - - send-keys -t keep kill-server
assert_refused "over-eager by design: a plain argument naming the command is refused"
guard_run "$PROTECTED_DIR/tmux-$(id -u)/private,4242,0" - if-shell true kill-server
assert_passed "a carried command passes when TMUX names another server" "if-shell true kill-server"
guard_run - - -L other if-shell true kill-server
assert_passed "explicit -L escapes the carried-command check" "-L other if-shell true kill-server"
guard_run - - source-file "$WORK/extra.conf"
assert_passed "source-file is out of reach and passes through (pinned boundary)" "source-file $WORK/extra.conf"

echo "== explicit target and other servers =="
guard_run - - -L other kill-server
assert_passed "-L <name>" "-L other kill-server"
guard_run - - -S "$WORK/private.sock" kill-server
assert_passed "-S <path>" "-S $WORK/private.sock kill-server"
guard_run - - -Lsock kill-server
assert_passed "attached -L<name>" "-Lsock kill-server"
guard_run - - -L chained new-session -d ';' kill-server
assert_passed "a global -L before the chain covers every command in it" "-L chained new-session -d ; kill-server"
guard_run "$PROTECTED_DIR/tmux-$(id -u)/private,4242,0" - kill-server
assert_passed "inherited TMUX naming another server" "kill-server"
guard_run - - kill-s
assert_passed "kill-s is outside the operator rule set, so it is not guarded" "kill-s"

echo "== configured protected socket =="
# The recipe every contract prescribes: TMUX unset, TMUX_TMPDIR a private
# directory. That server is not the protected one, so kill-server passes.
: >"$RECORD"
CASE_RC=$(
  env -u TMUX -u TMUX_PANE -u TMUX_ALLOW_KILL_SERVER -u XTMUX_GUARD_SOCKET FAKE_TMUX_RECORD="$RECORD" \
    TMUX_TMPDIR="$WORK/private-default" PATH="$GUARD_BIN:$REAL_BIN:/usr/bin:/bin" "$GUARD_BIN/tmux" kill-server >/dev/null 2>&1
  echo $?
)
assert_eq "a private TMUX_TMPDIR is not the protected socket" 0 "$CASE_RC"
assert_eq "a private TMUX_TMPDIR: kill-server passes to the real tmux" "kill-server" "$(cat "$RECORD")"
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

echo "== mirrored option table =="
# The guard lists the tmux global options that take a value on the
# `# option-table:` line of bin/tmux-guard. If tmux ever adds one, the list must
# grow too, or the value would be scanned as the command word. This checks the
# list against the tmux installed here, not against a copy of its manual.
SYSTEM_TMUX="$(PATH=/usr/bin:/bin command -v tmux || true)"
if [ -n "$SYSTEM_TMUX" ]; then
  OPTION_TABLE="$(sed -n 's/^# option-table: \(.*\) --.*/\1/p' "$GUARD")"
  if [ -n "$OPTION_TABLE" ]; then ok "the guard names its option table"; else nok "the guard names its option table"; fi
  # Two-way: parse the value-taking flags out of tmux's own usage line and
  # compare the sets, so a flag tmux adds later fails here instead of making the
  # guard scan its value as a command word.
  usage="$("$SYSTEM_TMUX" -Z 2>&1)"
  usage=${usage#*usage: }
  usage=${usage//$'\n'/ }
  TMUX_VALUE_FLAGS=""
  rest=$usage
  while [ -n "$rest" ]; do
    case $rest in
      *'['*) rest=${rest#*[} ;;
      *) break ;;
    esac
    group=${rest%%]*}
    head_word=${group%% *}
    case $head_word in
      -?*)
        if [ "$head_word" != "$group" ]; then
          TMUX_VALUE_FLAGS="$TMUX_VALUE_FLAGS $head_word"
        fi
        ;;
    esac
  done
  guard_letters=$(printf '%s\n' $OPTION_TABLE | sed 's/^-//' | sort | tr -d '\n')
  tmux_letters=$(printf '%s\n' $TMUX_VALUE_FLAGS | sed 's/^-//' | sort | tr -d '\n')
  assert_eq "the guard's option table equals the value-taking flags in tmux's usage" "$tmux_letters" "$guard_letters"
  for opt in $OPTION_TABLE; do
    case $opt in
      -L) value=xtmux-guard-option-probe ;;
      -S) value="$WORK/option-probe.sock" ;;
      -c) value="$WORK" ;;
      -f) value=/dev/null ;;
      -T) value=root ;;
      *) value=probe ;;
    esac
    if "$SYSTEM_TMUX" "$opt" "$value" -V >/dev/null 2>&1; then
      ok "tmux $("$SYSTEM_TMUX" -V 2>/dev/null) accepts the mirrored option $opt"
    else
      nok "tmux rejects the mirrored option $opt, so the guard list is stale"
    fi
  done
else
  printf '  \033[33mskip\033[0m no system tmux for the option-table check\n'
fi

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
  # The chain the reviewer used to reach the same server in one argv.
  (
    unset TMUX TMUX_PANE TMUX_ALLOW_KILL_SERVER
    TMUX_TMPDIR="$PROTECTED_DIR" XTMUX_GUARD_SOCKET="$PROTECTED_SOCKET" \
      PATH="$GUARD_BIN:/usr/bin:/bin" "$GUARD_BIN/tmux" new-session -d ';' kill-server
  ) >"$WORK/out" 2>"$WORK/err"
  assert_eq "chained new-session ; kill-server against the private default socket" 1 "$?"
  if tmux_private_running; then ok "a refused chain leaves the server alive"; else nok "a refused chain leaves the server alive"; fi
  # The in-process carrier: if-shell runs kill-server inside the server, so no
  # second tmux process takes part.
  (
    unset TMUX TMUX_PANE TMUX_ALLOW_KILL_SERVER
    TMUX_TMPDIR="$PROTECTED_DIR" XTMUX_GUARD_SOCKET="$PROTECTED_SOCKET" \
      PATH="$GUARD_BIN:/usr/bin:/bin" "$GUARD_BIN/tmux" if-shell true kill-server
  ) >"$WORK/out" 2>"$WORK/err"
  assert_eq "carried if-shell kill-server against the private default socket" 1 "$?"
  if tmux_private_running; then ok "a refused carried command leaves the server alive"; else nok "a refused carried command leaves the server alive"; fi
  # The prescribed recipe against a real private server: TMUX unset, TMUX_TMPDIR
  # private, no protected-socket override. The guard must let this through.
  (
    unset TMUX TMUX_PANE TMUX_ALLOW_KILL_SERVER XTMUX_GUARD_SOCKET
    TMUX_TMPDIR="$TMUX_ISO_DIR" PATH="$GUARD_BIN:/usr/bin:/bin" "$GUARD_BIN/tmux" kill-server
  ) >"$WORK/out" 2>"$WORK/err"
  assert_eq "bare kill-server on a private TMUX_TMPDIR exits 0" 0 "$?"
  if tmux_private_running; then nok "the private server is gone after the allowed kill"; else ok "the private server is gone after the allowed kill"; fi
  if tmux_private new-session -d -s guard-probe; then ok "private server restarted with -L"; else nok "private server restarted with -L"; fi
  (
    unset TMUX TMUX_PANE TMUX_ALLOW_KILL_SERVER XTMUX_GUARD_SOCKET
    TMUX_TMPDIR="$TMUX_ISO_DIR" PATH="$GUARD_BIN:/usr/bin:/bin" "$GUARD_BIN/tmux" -L default kill-server
  ) >"$WORK/out" 2>"$WORK/err"
  assert_eq "explicit -L kill-server exits 0" 0 "$?"
  if tmux_private_running; then nok "explicit -L kill-server reaches the private server"; else ok "explicit -L kill-server reaches the private server"; fi
else
  printf '  \033[33mskip\033[0m no /usr/bin/tmux; private-server block skipped\n'
fi

harness_summary
