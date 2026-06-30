#!/usr/bin/env bash
# idempotently symlink xtmux files into their live locations.
# any pre-existing real file is moved aside to <path>.pre-xtmux.
set -euo pipefail

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
link "$repo/scripts/git-pane-status.sh"   "$HOME/.tmux/scripts/git-pane-status.sh"
link "$repo/scripts/agent-state.sh"       "$HOME/.tmux/scripts/agent-state.sh"
chmod +x "$repo/bin/tmux-session-picker" "$repo/scripts/git-pane-status.sh" "$repo/scripts/agent-state.sh"

echo
echo "done. reload tmux config if needed:  tmux source-file ~/.tmux.conf"
