#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
case "${1:-}" in
  "") exec node "$root/scripts/install.mjs" ;;
  --tmux-hooks|--hooks) exec node "$root/scripts/install.mjs" --tmux-hooks ;;
  --uninstall) exec node "$root/scripts/install.mjs" --uninstall ;;
  -h|--help) printf '%s\n' 'usage: ./install.sh [--tmux-hooks|--uninstall]' ;;
  *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
esac
