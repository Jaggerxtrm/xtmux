#!/usr/bin/env bash
set -u

PANE_ID="${1:-}"
PANE_PATH="${2:-}"

# Prefer resolving path from pane id (more reliable across focus/worktree changes)
if [ -n "$PANE_ID" ] && command -v tmux >/dev/null 2>&1; then
  RESOLVED_PATH="$(tmux display-message -p -t "$PANE_ID" '#{pane_current_path}' 2>/dev/null)"
  [ -n "$RESOLVED_PATH" ] && PANE_PATH="$RESOLVED_PATH"
fi

[ -n "$PANE_PATH" ] || exit 0

# Icons (no icon before repo name by request)
if [ "${TMUX_ASCII_ICONS:-0}" = "1" ]; then
  I_BRANCH="br"
  I_PATH="path"
else
  I_BRANCH=""
  I_PATH=""
fi

run_git() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 0.9 git "$@" 2>/dev/null
  else
    git "$@" 2>/dev/null
  fi
}

short_path() {
  local p="$1"
  if [[ "$p" == "$HOME"* ]]; then
    p="~${p#$HOME}"
  fi

  IFS='/' read -r -a parts <<< "$p"
  local n=${#parts[@]}

  if [ "$n" -le 4 ]; then
    printf "%s" "$p"
    return
  fi

  local a="${parts[$((n-3))]}"
  local b="${parts[$((n-2))]}"
  local c="${parts[$((n-1))]}"
  printf "…/%s/%s/%s" "$a" "$b" "$c"
}

path_segment() {
  short_path "$PANE_PATH"
}

command -v git >/dev/null 2>&1 || {
  path_segment
  exit 0
}

# Resolve toplevel + git-dir together. If the caller already knows the
# toplevel (the session picker resolves it first), trust it and save a
# rev-parse; otherwise fetch both values in a single git invocation.
if [ -n "${TMUX_GIT_TOPLEVEL:-}" ]; then
  TOPLEVEL="$TMUX_GIT_TOPLEVEL"
  GIT_DIR="$(run_git -C "$PANE_PATH" rev-parse --git-dir)"
else
  TG="$(run_git -C "$PANE_PATH" rev-parse --show-toplevel --git-dir)"
  TOPLEVEL="${TG%%$'\n'*}"
  GIT_DIR="${TG#*$'\n'}"
fi
if [ -z "$TOPLEVEL" ]; then
  path_segment
  exit 0
fi

REPO_NAME="$(basename "$TOPLEVEL")"
STATUS_OUT="$(run_git -C "$PANE_PATH" status --porcelain=v2 --branch)"
if [ -z "$STATUS_OUT" ]; then
  path_segment
  exit 0
fi

BRANCH=""
AHEAD=0
BEHIND=0
STAGED=0
MODIFIED=0
UNTRACKED=0
CONFLICT=0

while IFS= read -r line; do
  case "$line" in
    "# branch.head "*)
      BRANCH="${line#\# branch.head }"
      [ "$BRANCH" = "(detached)" ] && BRANCH="detached"
      ;;
    "# branch.ab "*)
      ab="${line#\# branch.ab }"
      for tok in $ab; do
        case "$tok" in
          +*) AHEAD="${tok#+}" ;;
          -*) BEHIND="${tok#-}" ;;
        esac
      done
      ;;
    1\ *|2\ *)
      xy="${line:2:2}"
      x="${xy:0:1}"
      y="${xy:1:1}"
      [ "$x" != "." ] && STAGED=$((STAGED+1))
      [ "$y" != "." ] && MODIFIED=$((MODIFIED+1))
      ;;
    u\ *)
      CONFLICT=$((CONFLICT+1))
      ;;
    \?\ *)
      UNTRACKED=$((UNTRACKED+1))
      ;;
  esac
done <<< "$STATUS_OUT"

# GIT_DIR was resolved together with TOPLEVEL above. Resolve a relative
# git-dir against the toplevel so the file tests land correctly regardless of
# the caller's cwd (previously it stayed relative, silently disabling op
# detection when cwd != PANE_PATH).
OP=""
if [ -n "$GIT_DIR" ]; then
  [ "${GIT_DIR#/}" = "$GIT_DIR" ] && GIT_DIR="$TOPLEVEL/$GIT_DIR"
  [ -d "$GIT_DIR/rebase-merge" ] || [ -d "$GIT_DIR/rebase-apply" ] && OP="REBASE"
  [ -f "$GIT_DIR/MERGE_HEAD" ] && OP="MERGE"
  [ -f "$GIT_DIR/CHERRY_PICK_HEAD" ] && OP="PICK"
  [ -f "$GIT_DIR/REVERT_HEAD" ] && OP="REVERT"
  [ -f "$GIT_DIR/BISECT_LOG" ] && OP="BISECT"
fi

# Skip the stash rev-list fork entirely when no stash ref/reflog exists. For
# linked worktrees the stash lives in the common dir, so derive it from the
# worktree gitdir without a git fork: <repo>/.git/worktrees/<name> -> <repo>/.git.
STASH=0
if [ -n "$GIT_DIR" ]; then
  stash_dir="$GIT_DIR"
  case "$GIT_DIR" in */.git/worktrees/*) stash_dir="${GIT_DIR%/worktrees/*}" ;; esac
  if [ -e "$stash_dir/refs/stash" ] || [ -e "$stash_dir/logs/refs/stash" ]; then
    STASH_RAW="$(run_git -C "$PANE_PATH" rev-list --walk-reflogs --count refs/stash)"
    case "$STASH_RAW" in
      ''|*[!0-9]*) STASH=0 ;;
      *) STASH=$STASH_RAW ;;
    esac
  fi
fi

out="$REPO_NAME $I_BRANCH ${BRANCH:-?}"

[ "$AHEAD" -gt 0 ] && out+=" ↑$AHEAD"
[ "$BEHIND" -gt 0 ] && out+=" ↓$BEHIND"
[ "$STAGED" -gt 0 ] && out+=" +$STAGED"
[ "$MODIFIED" -gt 0 ] && out+=" ~$MODIFIED"
[ "$UNTRACKED" -gt 0 ] && out+=" ?$UNTRACKED"
[ "$CONFLICT" -gt 0 ] && out+=" !$CONFLICT"
[ "$STASH" -gt 0 ] && out+=" *$STASH"
[ -n "$OP" ] && out+=" $OP"

out+=" $I_PATH $(short_path "$PANE_PATH")"

printf "%s" "$out"
