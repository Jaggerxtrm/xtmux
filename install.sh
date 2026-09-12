#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
classic_src="$root/bin/xtmux-classic"
classic_dst="${HOME:?HOME is required}/.local/bin/xtmux-classic"

install_classic() {
  if [ -e "$classic_dst" ] || [ -L "$classic_dst" ]; then
    if [ ! -L "$classic_dst" ] || [ "$(readlink "$classic_dst" 2>/dev/null || true)" != "$classic_src" ]; then
      printf 'refusing to replace existing file: %s\n' "$classic_dst" >&2
      return 1
    fi
    rm -f -- "$classic_dst"
  fi
  mkdir -p -- "${classic_dst%/*}"
  ln -s -- "$classic_src" "$classic_dst"
}

uninstall_classic() {
  if [ -L "$classic_dst" ] && [ "$(readlink "$classic_dst" 2>/dev/null || true)" = "$classic_src" ]; then
    rm -f -- "$classic_dst"
  fi
}

case "${1:-}" in
  "")
    node "$root/scripts/install.mjs"
    install_classic
    ;;
  --tmux-hooks|--hooks)
    node "$root/scripts/install.mjs" --tmux-hooks
    install_classic
    ;;
  --uninstall)
    node "$root/scripts/install.mjs" --uninstall
    uninstall_classic
    ;;
  -h|--help) printf '%s\n' 'usage: ./install.sh [--tmux-hooks|--uninstall]' ;;
  *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
esac
