#!/usr/bin/env bash
# board-audit-pr-adapter — PR-checkpoint event adapter.
#
# Publishes a FRESH PR-checkpoint Board-Audit handoff for every push to a
# pull-request branch. Wire it as a client-side pre-push hook (board-audit
# init does this), run it from a self-hosted PR-event executor, or invoke it
# manually.
#
# Post-delivery semantics from a pre-push hook: a plain pre-push fires BEFORE
# the code push succeeds, so a synchronous checkpoint there could only bind
# the previous remote head (STALE). The adapter therefore defers to git's own
# push (no second push — a double push races on GitHub and fails with
# "cannot lock ref") and starts a detached one-shot poller that waits for the
# remote ref to reach the pushed SHA (max ~60s), then publishes the
# checkpoint against the now-remote PR head. The handoff is FRESH after every
# push, and any agent in the repository can verify it with:
#   board-audit pr-status <pr> --check
#
# The adapter never blocks the code push. Adapter or poller failures only
# warn (poller log: /tmp/board-audit-adapter-<pr>.log). There is no
# allowlist: every PR produces its Board-Audit evidence.
#
# Protocol: as a pre-push hook, refspecs arrive on stdin as
#   <local ref> <local sha> <remote ref> <remote sha>
# and the remote name is argv[1]. Invoked directly with a PR number, it
# checkpoints that PR synchronously.
set -uo pipefail

# Hook environments set GIT_DIR (and friends); they must not leak into the
# child checkpoint, whose bd worktree create / git calls resolve the repo
# from cwd.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR 2>/dev/null || true

SELF="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
PR_FLOW="$SCRIPT_DIR/board-audit-pr.py"

REMOTE="${1:-origin}"
PR="${2:-}"

# Direct/manual invocation: adapter <pr> or adapter <remote> <pr> — the first
# numeric argument is the explicit PR to checkpoint synchronously.
if [[ "${1:-}" =~ ^[0-9]+$ ]]; then
  PR="${1}"
  export BOARD_AUDIT_PR_TRIGGER="${BOARD_AUDIT_PR_TRIGGER:-auto}"
  exec python3 "$PR_FLOW" pr-checkpoint "$PR" --trigger auto
fi
if [[ "${2:-}" =~ ^[0-9]+$ ]]; then
  export BOARD_AUDIT_PR_TRIGGER="${BOARD_AUDIT_PR_TRIGGER:-auto}"
  exec python3 "$PR_FLOW" pr-checkpoint "$PR" --trigger auto
fi

# Determine the pushed SHA of the current branch from the pre-push stdin
# protocol (skipped for non-branch refs, deletions, and TTY stdin).
branch="$(git branch --show-current 2>/dev/null || true)"
pushed_sha=""
if [ -n "$branch" ] && [ ! -t 0 ]; then
  while read -r local_ref local_sha remote_ref remote_sha; do
    [ -z "$local_ref" ] && continue
    case "$local_ref" in
      refs/heads/*)
        if [ "$local_sha" != "0000000000000000000000000000000000000000" ] \
           && [ "${local_ref#refs/heads/}" = "$branch" ]; then
          pushed_sha="$local_sha"
        fi
        ;;
    esac
  done
fi
# A preceding hook block (e.g. a gate runner) may have consumed stdin, so
# the loop above saw no refs. For the common case — pushing the current
# branch — fall back to HEAD.
if [ -z "$pushed_sha" ] && [ -n "$branch" ]; then
  pushed_sha="$(git rev-parse HEAD 2>/dev/null || true)"
fi

# Resolve the PR for the current branch.
PR_NUMBER=""
if [ -n "${BOARD_AUDIT_PR_JSON:-}" ] && [ -f "$BOARD_AUDIT_PR_JSON" ]; then
  PR_NUMBER="$(python3 -c "import json,os;print(json.load(open(os.environ['BOARD_AUDIT_PR_JSON']))['number'])" 2>/dev/null || true)"
fi
if [ -z "$PR_NUMBER" ]; then
  # gh pr view resolves the branch itself and has mis-resolved in some
  # worktrees; pass the branch explicitly for a deterministic lookup.
  PR_NUMBER="$(gh pr list --head "$branch" --state open --json number --jq '.[0].number' 2>/dev/null || true)"
fi
if [ -z "$PR_NUMBER" ] || ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "board-audit-pr-adapter: no pull request for the current branch; nothing to publish" >&2
  exit 0
fi

# No branch ref pushed (tag-only/deletion push): checkpoint synchronously as
# best effort against the current remote head.
if [ -z "$pushed_sha" ]; then
  export BOARD_AUDIT_PR_TRIGGER="${BOARD_AUDIT_PR_TRIGGER:-auto}"
  if python3 "$PR_FLOW" pr-checkpoint "$PR_NUMBER" --trigger auto; then
    echo "board-audit-pr-adapter: published FRESH Board-Audit checkpoint for PR #$PR_NUMBER" >&2
  else
    echo "board-audit-pr-adapter: WARNING — checkpoint for PR #$PR_NUMBER failed (see above)" >&2
  fi
  exit 0
fi

# Detached one-shot poller: wait for git's own push to land (remote ref ==
# pushed SHA), then publish the checkpoint. Never blocks the push; failures
# land in the poller log.
export BA_REMOTE="$REMOTE" BA_BRANCH="$branch" BA_SHA="$pushed_sha" \
       BA_PR="$PR_NUMBER" BA_FLOW="$PR_FLOW" BA_CWD="$(pwd)" \
       BOARD_AUDIT_PR_TRIGGER="${BOARD_AUDIT_PR_TRIGGER:-auto}"
LOG="/tmp/board-audit-adapter-$PR_NUMBER.log"
nohup setsid bash -c '
  cd "$BA_CWD" 2>/dev/null || exit 1
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR 2>/dev/null || true
  for _ in $(seq 1 30); do
    ref="$(git ls-remote "$BA_REMOTE" "refs/heads/$BA_BRANCH" 2>/dev/null | awk "{print \$1}")"
    if [ -n "${BOARD_AUDIT_PR_JSON:-}" ] && [ -f "$BOARD_AUDIT_PR_JSON" ]; then
      gh_head="$(python3 -c "import json,os;print(json.load(open(os.environ[\"BOARD_AUDIT_PR_JSON\"]))[\"headRefOid\"])" 2>/dev/null || true)"
    else
      # GitHub updates the PR headRefOid with a small lag after a push;
      # wait for it so the checkpoint binds the pushed head, not the old one.
      gh_head="$(gh pr view "$BA_PR" --json headRefOid --jq .headRefOid 2>/dev/null || true)"
    fi
    if [ "$ref" = "$BA_SHA" ] && [ "$gh_head" = "$BA_SHA" ]; then
      break
    fi
    sleep 2
  done
  if python3 "$BA_FLOW" pr-checkpoint "$BA_PR" --trigger auto; then
    echo "board-audit-pr-adapter: published FRESH Board-Audit checkpoint for PR #$BA_PR" >&2
  else
    echo "board-audit-pr-adapter: WARNING — checkpoint for PR #$BA_PR failed; the push landed but the handoff may be stale or missing" >&2
  fi
' > "$LOG" 2>&1 &
echo "board-audit-pr-adapter: deferred FRESH checkpoint for PR #$PR_NUMBER (poller log: $LOG)" >&2
exit 0
