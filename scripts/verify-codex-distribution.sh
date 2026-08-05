#!/usr/bin/env bash
# K4-xtmux (xtmux-s96.4) managed-distribution smoke.
#
# The bead's VALIDATION names "package install/update/drift/uninstall smoke"
# explicitly, and no such command existed: the behaviours were covered piecewise
# by tests/installer/install.test.mjs but nothing exercised them end to end as a
# single upgrade story, and CI's `smoke` job (verify-json-api.sh) does not run
# the installer suite at all.
#
# Every stage runs against a THROWAWAY HOME. This script must never touch the
# operator's real ~/.codex — that file holds individually trusted hook entries
# whose trust is keyed by position, so a stray write is not recoverable by
# re-running anything.
#
# The load-bearing assertion is UNOWNED_INDEX: a third-party Codex hook entry
# must hold index 0 through install, update, drift repair and uninstall. Codex
# records hook trust as
#   [hooks.state."<hooks.json>:<event_snake_case>:<entryIndex>:<hookIndex>"]
# so shifting an unowned entry silently invalidates the operator's own grant.
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
installer="$root/scripts/install.mjs"
home="$(mktemp -d "${TMPDIR:-/tmp}/xtmux-codex-dist-XXXXXX")"
trap 'rm -rf "$home"' EXIT

hooks="$home/.codex/hooks.json"
mkdir -p "$home/.codex" "$home/runtime" "$home/tmp"

pass=0
fail=0
check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf '  ok    %-46s %s\n' "$name" "$actual"
    pass=$((pass + 1))
  else
    printf '  FAIL  %-46s expected=%s actual=%s\n' "$name" "$expected" "$actual" >&2
    fail=$((fail + 1))
  fi
}

run() {
  ( cd "$root" && HOME="$home" \
      XDG_STATE_HOME="$home/.local/state" XDG_RUNTIME_DIR="$home/runtime" TMPDIR="$home/tmp" \
      XTMUX_OBS_DB_PATH="$home/.local/state/xtmux/observability.db" \
      node "$installer" --home "$home" "$@" )
}

# jq is not a dependency of this repo, so the readers are node one-liners.
q() { node -e "$1" "$hooks" "${@:2}"; }
unowned_index() {
  q 'const h=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).hooks||{};
     const e=h[process.argv[2]]||[];
     process.stdout.write(String(e.findIndex((x)=>x.hooks?.[0]?.command===process.argv[3])));' "$1" "$2"
}
xtmux_count() {
  q 'const h=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).hooks||{};
     const e=h[process.argv[2]]||[];
     process.stdout.write(String(e.filter((x)=>x.hooks?.some((k)=>String(k.command||"").includes("/.codex/hooks/xtmux/agent-state.sh"))).length));' "$1"
}

echo "codex-distribution smoke (HOME=$home)"

# Seed the state an upgrading operator actually has: their own trusted hook at
# index 0, plus a pre-#82 UNTAGGED xtmux entry (the shape releases before the
# _source tag emitted, taken verbatim from `git show 9708c2d~1:scripts/install.mjs`).
script="$home/.codex/hooks/xtmux/agent-state.sh"
node -e '
const fs=require("fs");
// node -e has no script filename, so argv[1] is the first user argument.
const [,out,script]=process.argv;
fs.writeFileSync(out, JSON.stringify({hooks:{
  SessionStart:[
    {hooks:[{type:"command",command:"third-party-session-start"}]},
    {matcher:"startup|resume|clear",hooks:[{type:"command",command:`bash "${script}" idle`,statusMessage:"marking pane idle"}]},
  ],
  UserPromptSubmit:[{hooks:[{type:"command",command:"third-party-prompt"}]}],
}}, null, 2));' "$hooks" "$script"

echo "[1/6] dry-run plans without writing"
before="$(sha256sum "$hooks" | cut -d' ' -f1)"
plan="$(run --dry-run)"
check "dry-run leaves hooks.json byte-identical" "$before" "$(sha256sum "$hooks" | cut -d' ' -f1)"
check "dry-run reports a codex plan" "yes" "$(grep -q 'dry-run: codex hooks plan' <<<"$plan" && echo yes || echo no)"
check "dry-run plans the legacy adoption" "yes" "$(grep -qE '^\s*adopt' <<<"$plan" && echo yes || echo no)"

echo "[2/6] fresh install"
run >/dev/null
check "UNOWNED_INDEX SessionStart after install" "0" "$(unowned_index SessionStart third-party-session-start)"
check "UNOWNED_INDEX UserPromptSubmit after install" "0" "$(unowned_index UserPromptSubmit third-party-prompt)"
# The upgrade story: the untagged pre-#82 entry is adopted, not duplicated, so
# the pane does not fire its whole lifecycle twice.
check "one xtmux SessionStart entry (no duplicate firing)" "1" "$(xtmux_count SessionStart)"
check "one xtmux UserPromptSubmit entry" "1" "$(xtmux_count UserPromptSubmit)"

echo "[3/6] update is idempotent"
snapshot="$(sha256sum "$hooks" | cut -d' ' -f1)"
run >/dev/null
check "second install is a no-op" "$snapshot" "$(sha256sum "$hooks" | cut -d' ' -f1)"
check "UNOWNED_INDEX survives update" "0" "$(unowned_index SessionStart third-party-session-start)"

echo "[4/6] drift repair"
# Tamper with the entry we own; the unowned neighbour must be untouched.
node -e '
const fs=require("fs");const p=process.argv[1];
const d=JSON.parse(fs.readFileSync(p,"utf8"));
const owned=d.hooks.SessionStart.find((e)=>e._source==="xtmux");
owned.hooks[0].command=owned.hooks[0].command.replace(" --new-instance","");
fs.writeFileSync(p, JSON.stringify(d,null,2));' "$hooks"
run >/dev/null
check "drift repaired (--new-instance restored)" "1" "$(q 'const h=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).hooks||{};
  process.stdout.write(String((h.SessionStart||[]).filter((e)=>e.hooks?.some((k)=>/--new-instance$/.test(k.command||""))).length));')"
check "UNOWNED_INDEX survives drift repair" "0" "$(unowned_index SessionStart third-party-session-start)"

echo "[5/6] uninstall preserves unowned config"
run --uninstall >/dev/null
check "UNOWNED_INDEX survives uninstall" "0" "$(unowned_index SessionStart third-party-session-start)"
check "no xtmux entries remain" "0" "$(xtmux_count SessionStart)"
check "unowned UserPromptSubmit preserved" "0" "$(unowned_index UserPromptSubmit third-party-prompt)"
check "managed hook payload removed" "no" "$([ -d "$home/.codex/hooks/xtmux" ] && echo yes || echo no)"

echo "[6/6] a near-miss entry is preserved, never adopted"
node -e '
const fs=require("fs");const [,p,script]=process.argv;
const d=JSON.parse(fs.readFileSync(p,"utf8"));
d.hooks.SessionStart.push({matcher:"startup|resume|clear",hooks:[{type:"command",command:`bash "${script}" idle --operator-tweak`,statusMessage:"marking pane idle"}]});
fs.writeFileSync(p, JSON.stringify(d,null,2));' "$hooks" "$script"
out="$(run)"
check "near-miss preserved" "1" "$(q 'const h=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).hooks||{};
  process.stdout.write(String((h.SessionStart||[]).filter((e)=>e.hooks?.some((k)=>/--operator-tweak/.test(k.command||""))).length));')"
check "near-miss reported for review" "yes" "$(grep -q 'preserved unowned' <<<"$out" && echo yes || echo no)"

printf '\ncodex-distribution smoke: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
