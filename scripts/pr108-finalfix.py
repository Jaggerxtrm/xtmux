#!/usr/bin/env python3
from pathlib import Path

picker = Path("bin/tmux-session-picker")
s = picker.read_text()

# Private snapshot plumbing is not part of the user-facing command reference.
added = "  list-active-nav-single, list-active-nav-chain, list-active-nav-single-chain,\n  nav-snapshot-view, nav-snapshot-refresh\n"
original = "  list-active-nav-single, list-active-nav-chain, list-active-nav-single-chain\n"
if added in s:
    s = s.replace(added, original, 1)
elif original not in s:
    raise SystemExit("internal help anchor missing")

# Preserve the established one-live-build initial list boundary. Query changes
# remain snapshot-local and never re-enumerate live tmux/git state.
old = '    picker_state_read filter || true; spec="$REPLY"\n    read_list_mode\n    build_list "$spec" "$REPLY" nav "$lines" > "$flat_file"\n    nav_snapshot_project_stream "$flat_file" "$lines" > "$chain_file"'
new = '    # Initial open performs one ordinary live projection. Query changes below\n    # never return to live inventory; they switch between local snapshots.\n    if [ "$lines" = single ]; then\n      "$self" list-active-nav-single > "$flat_file"\n    else\n      "$self" list-active-nav > "$flat_file"\n    fi\n    nav_snapshot_project_stream "$flat_file" "$lines" > "$chain_file"'
if old in s:
    s = s.replace(old, new, 1)
elif '"$self" list-active-nav > "$flat_file"' not in s:
    raise SystemExit("initial projection anchor missing")
s = s.replace(
    "then atomically replace both files before output.",
    "then replace both temp-backed files before output.",
    1,
)
picker.write_text(s)

test = Path("test/nav-contract.sh")
t = test.read_text()

# One-line fallback uses the same local snapshot query source.
old = '''if grep -qF "list-active-nav-single-chain '{q}'" "$WORK/nav-fzf-args-oneline"; then
  ok "nav chrome: oneline fallback binds its own single-line chain source"
else
  nok "nav chrome: oneline fallback misses its single-line chain source"
fi'''
new = '''if grep -qF "nav-snapshot-view" "$WORK/nav-fzf-args-oneline" \\
  && ! grep -qF "list-active-nav-single-chain '{q}'" "$WORK/nav-fzf-args-oneline"; then
  ok "nav chrome: oneline fallback also uses the local snapshot source"
else
  nok "nav chrome: oneline fallback is not snapshot-backed"
fi'''
if old in t:
    t = t.replace(old, new, 1)
elif "oneline fallback also uses the local snapshot source" not in t:
    raise SystemExit("oneline assertion anchor missing")

# Attention shim now serves two list-panes contracts: rich rows to attn_list,
# bare pane ids to the action-time occurrence validator.
needle = '''  list-panes) printf '%b\\n' \\
      '$42\\tprogram\\t%901\\tpi\\t2000\\tneeds-input\\t901\\t-' \\
      '$42\\tprogram\\t%553\\tclaude\\t1000\\tneeds-input\\t553\\t-' \\
      '$42\\tprogram\\t%875\\tpi\\t500\\tdone\\t875\\t-' ;;'''
replacement = '''  list-panes)
    case "$*" in
      *'#{session_name}'*) printf '%b\\n' \\
          '$42\\tprogram\\t%901\\tpi\\t2000\\tneeds-input\\t901\\t-' \\
          '$42\\tprogram\\t%553\\tclaude\\t1000\\tneeds-input\\t553\\t-' \\
          '$42\\tprogram\\t%875\\tpi\\t500\\tdone\\t875\\t-' ;;
      *) printf '%s\\n' '%901' '%553' '%875' ;;
    esac
    ;;'''
if needle in t:
    t = t.replace(needle, replacement, 1)
elif "*) printf '%s\\n' '%901' '%553' '%875' ;;" not in t:
    raise SystemExit("attention shim anchor missing")

# Hosted hostile-display dispatch: p:$26:%553 now performs an action-time
# session-scoped list-panes membership read before the exact jump.
marker = ': > "$WORK/t30-dispatch.log"'
pos = t.index(marker)
start = t.index("  tmux() {", pos)
end = t.index("\n  }", start) + len("\n  }")
block = t[start:end]
if "list-panes -s -t $26" not in block:
    case_line = '    case "$*" in\n'
    at = block.index(case_line) + len(case_line)
    block = block[:at] + "      *'list-panes -s -t $26'*) printf '%%553\\n' ;;\n" + block[at:]
    t = t[:start] + block + t[end:]

# §32 pathological nav-go: p:$47:%1 needs the same membership response.
marker = ': > "$WORK/t32-navgo.log"'
pos = t.index(marker)
start = t.index("  tmux() {", pos)
end = t.index("\n  }", start) + len("\n  }")
block = t[start:end]
if "list-panes)" not in block:
    case_line = '    case "$1" in\n'
    at = block.index(case_line) + len(case_line)
    block = block[:at] + "      list-panes) printf '%%1\\n' ;;\n" + block[at:]
    t = t[:start] + block + t[end:]

test.write_text(t)
print("PR108 final integration patch applied")
