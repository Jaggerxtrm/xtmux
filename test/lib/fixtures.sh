# Shared fixture builders for xtmux contract tests.
# Creates isolated, deterministic git repositories under a temp dir so golden
# snapshots are stable (independent of the operator's real repos).

# mk_repo <dir> — creates a fresh repo with one commit on main.
mk_repo() {
  local d="$1"
  mkdir -p "$d"
  git -C "$d" init -q -b main
  git -C "$d" config user.email "test@xtmux"
  git -C "$d" config user.name "xtmux test"
  printf 'hello\n' > "$d/README"
  git -C "$d" add -A
  git -C "$d" commit -q -m "init"
}

# add_clean <dir> <file> <content> — committed file (clean tree after).
add_clean() {
  local d="$1" f="$2" c="$3"
  mkdir -p "$d/$(dirname "$f")"
  printf '%s\n' "$c" > "$d/$f"
  git -C "$d" add -A
  git -C "$d" commit -q -m "add $f"
}

# add_modified <dir> <file> <content> — tracked file with uncommitted change.
add_modified() {
  local d="$1" f="$2" c="$3"
  printf '%s\n' "$c" > "$d/$f"
}

# add_staged <dir> <file> <content> — new file staged for commit.
add_staged() {
  local d="$1" f="$2" c="$3"
  printf '%s\n' "$c" > "$d/$f"
  git -C "$d" add "$f"
}

# add_untracked <dir> <file> <content> — untracked file.
add_untracked() {
  local d="$1" f="$2" c="$3"
  printf '%s\n' "$c" > "$d/$f"
}

# add_stash <dir> — push the current modified set onto the stash.
add_stash() {
  local d="$1"
  git -C "$d" stash -u -q
}

# make_ahead <dir> <n> — advance local by n commits ahead of upstream.
make_ahead() {
  local d="$1" n="${2:-1}"
  local bare
  bare="$d/../$(basename "$d").bare"
  git clone -q --bare "$d" "$bare"
  git -C "$d" remote remove origin 2>/dev/null || true
  git -C "$d" remote add origin "$bare"
  git -C "$d" fetch -q origin
  git -C "$d" branch --set-upstream-to=origin/main main >/dev/null 2>&1 || git -C "$d" push -q -u origin main >/dev/null
  local i
  for ((i=0; i<n; i++)); do
    printf 'ahead %d\n' "$i" > "$d/ahead-$i"
    git -C "$d" add -A
    git -C "$d" commit -q -m "ahead $i"
  done
}
