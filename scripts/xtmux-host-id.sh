#!/usr/bin/env bash
# Shared host identity and UUID generation for xtmux shell callers.

xtmux_gen_uuid() {
  local seconds nanos
  # Keep source order stable: kernel UUID, uuidgen, then a best-effort UUID-shaped
  # composite so missing UUID tooling never fails an agent turn.
  if [ -r /proc/sys/kernel/random/uuid ]; then
    if IFS= read -r REPLY < /proc/sys/kernel/random/uuid && [ -n "$REPLY" ]; then
      return 0
    fi
  fi
  if command -v uuidgen >/dev/null 2>&1; then
    if REPLY="$(uuidgen 2>/dev/null)" && [ -n "$REPLY" ]; then
      return 0
    fi
  fi
  seconds="$(date +%s 2>/dev/null || printf '0')"
  nanos="$(date +%N 2>/dev/null || printf '0')"
  REPLY="$(printf '%08x-%04x-4%03x-%04x-%012x' \
    "$seconds" "$((RANDOM & 0xffff))" "$((RANDOM & 0xfff))" \
    "$((0x8000 | (RANDOM & 0x3fff)))" "$$$nanos")"
}

xtmux_read_host_id() {
  local file="$1"
  if [ -s "$file" ]; then
    if REPLY="$(<"$file")" 2>/dev/null; then
      return 0
    fi
  fi
  REPLY=""
}

# host_id namespaces every tmux identifier across machines. It is a generated
# UUID persisted in xtmux's own state dir — never derived from /etc/machine-id,
# which would leak a stable public fingerprint of the host.
host_id() {
  local dir file attempt
  dir="${XDG_STATE_HOME:-$HOME/.local/state}/xtmux"
  file="${XTMUX_HOST_ID_FILE:-$dir/host-id}"
  xtmux_read_host_id "$file"
  [ -n "$REPLY" ] && return 0

  mkdir -p "$(dirname -- "$file")" 2>/dev/null || true
  xtmux_gen_uuid
  # noclobber makes creation atomic: whichever caller creates the file wins.
  if (set -C; printf '%s\n' "$REPLY" > "$file") 2>/dev/null; then
    return 0
  fi

  # A failed noclobber create means another caller owns the identity. Never
  # return this process's candidate; reread the winner's value instead.
  REPLY=""
  for attempt in 1 2 3 4 5; do
    xtmux_read_host_id "$file"
    [ -n "$REPLY" ] && return 0
    sleep 0.01 2>/dev/null || true
  done
  xtmux_read_host_id "$file"
  return 0
}
