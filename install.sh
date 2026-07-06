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

link "$repo/bin/tmux-session-picker"      "$HOME/.local/bin/tmux-session-picker"
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
