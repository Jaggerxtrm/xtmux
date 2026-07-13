#!/usr/bin/env bash
# idempotently symlink xtmux files into their live locations.
# any pre-existing real file is moved aside to <path>.pre-xtmux.
set -euo pipefail

usage() {
  cat <<'USAGE'
usage: ./install.sh [--tmux-hooks|--hooks]

  --tmux-hooks, --hooks   also install tmux cache-invalidation hooks in the
                          currently running tmux server
USAGE
}

install_hooks=0
case "${1:-}" in
  "") ;;
  --tmux-hooks|--hooks) install_hooks=1 ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

link() {
  local src="$1" dst="$2"
  if [ -L "$dst" ]; then
    rm -f "$dst"
  elif [ -e "$dst" ]; then
    mv "$dst" "$dst.pre-xtmux"
    echo "moved existing file aside: $dst -> $dst.pre-xtmux"
  fi
  mkdir -p "$(dirname "$dst")"
  ln -s "$src" "$dst"
  echo "linked $dst -> $src"
}

# The picker resolves its repo root as ${self%/bin/*} WITHOUT following symlinks,
# so from ~/.local/bin/<entry> root is ~/.local and it loads the V2 observability
# backend from ~/.local/bin/xtmux-obs. That binary is a gitignored build artifact:
# if it is not linked here, every --json command fails with
# XTMUX_JSON_BACKEND_UNAVAILABLE. Refuse to install a half-working setup.
obs="$repo/bin/xtmux-obs"
if [ ! -x "$obs" ]; then
  if command -v bun >/dev/null 2>&1; then
    echo "building the observability backend (bun run build)..."
    (cd "$repo" && bun run build >/dev/null) || {
      echo "build failed. run it yourself and re-run ./install.sh:" >&2
      echo "  cd $repo && bun run build" >&2
      exit 1
    }
  else
    echo "missing $obs, and bun is not installed." >&2
    echo "it is the V2 observability backend; without it every --json command fails." >&2
    echo "install bun (https://bun.sh), then:  cd $repo && bun run build" >&2
    exit 1
  fi
fi

link "$repo/bin/tmux-session-picker"      "$HOME/.local/bin/tmux-session-picker"
# `xtmux` is the canonical name; `tmux-session-picker` stays forever as the
# compatibility name. The alias MUST sit next to it: same ${self%/bin/*} rule —
# an entry in any other directory resolves root wrong and silently loses the
# V2 obs backend.
link "$repo/bin/tmux-session-picker"      "$HOME/.local/bin/xtmux"
link "$obs"                               "$HOME/.local/bin/xtmux-obs"
link "$repo/scripts/xtmux-monitor.sh"      "$HOME/.local/bin/xtmux-monitor"
link "$repo/scripts/git-pane-status.sh"   "$HOME/.tmux/scripts/git-pane-status.sh"
link "$repo/scripts/agent-state.sh"       "$HOME/.tmux/scripts/agent-state.sh"
chmod +x "$repo/bin/tmux-session-picker" "$repo/scripts/xtmux-monitor.sh" "$repo/scripts/git-pane-status.sh" "$repo/scripts/agent-state.sh"

if [ "$install_hooks" = 1 ]; then
  if ! command -v tmux >/dev/null 2>&1; then
    echo "tmux not found; skipped tmux hooks" >&2
  elif ! tmux info >/dev/null 2>&1; then
    echo "tmux server not running; skipped tmux hooks" >&2
  else
    "$repo/bin/tmux-session-picker" install-hooks "$HOME/.local/bin/tmux-session-picker"
    echo "installed tmux cache-invalidation hooks"
  fi
fi

echo
echo "done. reload tmux config if needed:  tmux source-file ~/.tmux.conf"
