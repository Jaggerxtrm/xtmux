---
name: code-review
description: Portable PR-review discipline usable from any harness (Claude Code, pi, Codex, raw shell). Fetches the PR narrative, the diff, existing review threads, and Codex findings via `gh`; produces a structured issue list under a confidence rubric; and either prints the review or files it back via `gh pr comment`. This is the harness-agnostic sibling of the Claude-Code `/code-review` slash-command (which uses parallel subagents); use this SKILL when you're on pi/Codex and the plugin registry doesn't resolve the slash-command.
---

# Code Review — portable

You are reviewing a pull request from a pane that may or may not have Claude Code's `/code-review` plugin available. This SKILL captures the review discipline in a shape any harness can execute: fetch, structure, score, filter, comment.

If you are on Claude Code and the plugin slash-command resolves, prefer it — it runs parallel subagents you don't have from pi/Codex. This SKILL exists so pi/Codex panes (and the multi-pane sprint Judge role in particular) can still produce a Codex-informed review verdict without the plugin.

## When to use

- The Judge in a multiplexed sprint (`/judge-with-codex`) needs to run a review on a PR from a pi/Codex pane.
- Any pane needs a structured PR review and the Claude Code plugin is not resolvable.
- Any operator wants a review that specifically weighs `openai-codex[bot]` comments and threads.

## When NOT to use

- Refactoring, writing new code, general "what does this do" — that's not a review, that's exploration.
- Approving a PR without reading the diff. This SKILL never rubber-stamps.

## Inputs the review needs

Before starting:

- `<owner>/<repo>` — the target repo.
- `<N>` — the PR number.
- Optional: the bead the PR is anchored to (`bd show <bead>` for the contract).
- Optional: relevant CLAUDE.md / AGENTS.md conventions in the repo — treat as guidance, not policy, unless the bead says otherwise.

## The review flow

Every review follows this shape. Do not skip steps.

### 1. Eligibility

Skip the PR entirely if any of these hold:
- PR is closed or merged.
- PR is a draft.
- PR is obviously mechanical (bot bump, generated file only, whitespace-only).
- You already left a review on an earlier revision of this PR and no new commits landed since.

```bash
gh pr view <N> --repo <owner>/<repo> --json state,isDraft,commits
```

### 2. Narrative and scope

Read the PR body and understand what the author says they did:

```bash
gh pr view <N> --repo <owner>/<repo>
```

If a bead anchors the PR, read it — that's the contract, not the PR body:

```bash
bd show <bead>
```

If the PR touches conventions files, list the relevant CLAUDE.md / AGENTS.md so you can check adherence:

```bash
gh pr diff <N> --repo <owner>/<repo> --name-only \
  | awk -F/ '{ for (i=NF; i>=1; i--) { p=""; for (j=1;j<i;j++) p=p$j"/"; print p"CLAUDE.md"; print p"AGENTS.md"; } }' \
  | sort -u
```

### 3. Diff

Read the actual diff — not a summary:

```bash
gh pr diff <N> --repo <owner>/<repo>
# for a specific file when the diff is big:
gh pr diff <N> --repo <owner>/<repo> -- <path>
```

### 4. Existing review signal

Four channels — fetch all four:

```bash
# 1. Inline review comments (line-anchored)
gh api repos/<owner>/<repo>/pulls/<N>/comments \
  --paginate --jq '.[] | {user:.user.login, path, line, body}'

# 2. Top-level issue comments (PR-wide)
gh api repos/<owner>/<repo>/issues/<N>/comments \
  --paginate --jq '.[] | {user:.user.login, body}'

# 3. Review threads with resolved state
gh pr view <N> --repo <owner>/<repo> --comments
gh pr view <N> --repo <owner>/<repo> --json reviews,reviewThreads

# 4. Review-level verdicts (APPROVED / CHANGES_REQUESTED / COMMENTED)
gh api repos/<owner>/<repo>/pulls/<N>/reviews \
  --jq '.[] | {user:.user.login, state, body}'
```

Filter for Codex (`openai-codex[bot]` / `openai/codex`) — those are the highest-signal, non-authoritative findings. Human reviewer comments matter too but you already know how to weigh those.

### 5. Cross-check Codex against the diff

On PRs with more than ~30 files changed, Codex sometimes references lines or symbols that do not exist in the diff. For every Codex finding you plan to act on, verify the location:

```bash
gh pr diff <N> --repo <owner>/<repo> | grep -n '<symbol-or-fragment>'
```

Codex findings that cannot be located in the actual diff are discarded, not filed as follow-ups.

### 6. Your own read

Walk the diff dimension by dimension. Note issues as you go — one line per issue, with a file:line anchor.

Dimensions worth spending review budget on:

- **Correctness** — null-deref, missing await, incorrect condition, off-by-one, wrong types.
- **Resource safety** — leaks (file handles, DB connections, goroutines), unbounded retries.
- **Migration ordering** — schema change vs read/write path timing, dual-write windows.
- **Event envelope drift** — `forensic.v1` (or your project's equivalent) — every field preserved, new fields additive.
- **Telemetry deletions** — every removed span/metric/log line is a monitoring gap; must be intentional.
- **Rollback plan** — every non-trivial PR body needs a `## Rollback` section.
- **Test presence** — the PR must include tests for its own changes unless the bead explicitly waives.
- **Convention adherence** — CLAUDE.md / AGENTS.md rules relevant to the touched files.

Dimensions to spend LESS budget on:

- Naming / typing nits, docstring gaps — flag if severe, ignore otherwise.
- Edge-case suggestions where the edge case is genuinely rare.
- Style preferences that the repo's tooling doesn't enforce.

### 7. Confidence score — the filter

Every issue you flagged gets a confidence score. Rubric (verbatim):

- **0** — false positive under light scrutiny, or a pre-existing issue not touched by this PR.
- **25** — might be real; you weren't able to verify.
- **50** — verified real, but a nitpick or rare in practice; low relative importance.
- **75** — verified real, likely to bite in practice, or explicitly called out in CLAUDE.md.
- **100** — verified real, confirmed evidence, will bite frequently.

**Filter: drop everything scoring < 80.** If nothing remains, the review is "no issues" — see the "No issues found" template below.

### 8. Reconcile Codex vs your own findings

Build three lists:

- **AGREED with Codex** — Codex flagged it; you verified; it stands.
- **REJECTED from Codex** — Codex flagged it; you verified and it's a false positive; one sentence why.
- **OWN findings** — things you found that Codex missed.

Silent overrides of Codex `CHANGES_REQUESTED` are not allowed. If your verdict is `PASS` and Codex requested changes, list each Codex finding you disagreed with and the justification.

### 9. Emit the verdict

One of exactly four:

- `PASS` — ready to merge.
- `PASS_WITH_NOTES` — ready to merge; follow-ups filed as child beads.
- `NEEDS_CHANGES` — not ready; concrete change requests, each anchored to file:line.
- `BLOCKED` — external block (missing infra, dep, or a prior PR must land); include what unblocks it.

### 10. Persist and report

If you're the Judge in a sprint, follow `/judge-with-codex` — verdict goes into bead notes (JUDGE VERDICT format) and upward via `tmux-session-picker message-send`.

_[xtmux-3xs]_ Since 2026-07-13, `message-send --bead` implicitly sets `--expects-reply=true`. A pi orchestrator surfaces your JUDGE VERDICT as a reply obligation until they respond — see `/multiplexing` § V2 SQLite runtime for the mechanism.

If you're reviewing standalone, comment on the PR:

```bash
gh pr comment <N> --repo <owner>/<repo> --body-file /tmp/review-<N>.md
```

## Comment templates

### Found issues

```markdown
### Code review — <verdict>

Found N issues (confidence ≥ 80):

1. <one-line description> — <file>:<line>
   Why: <one sentence>. Cite: <link to file+line at the exact commit SHA>.

2. <one-line description> — <file>:<line>
   Why: <one sentence>. Cite: <link>.

Codex findings AGREED: <list, each with file:line>
Codex findings REJECTED: <list, each with one-sentence justification>
```

### No issues found

```markdown
### Code review — PASS

No issues at confidence ≥ 80. Reviewed:
- diff (<N> files, <M> lines)
- Codex findings (<K> flagged; all reviewed)
- Convention adherence for CLAUDE.md paths: <list>
- Rollback plan: present.
```

## Notes

- Do NOT build or run tests yourself as part of review — that's CI's job. Trust the CI signal from `gh pr checks`.
- Do NOT rewrite the PR body or push commits during review. You review; the author fixes.
- Every cited line must have the full commit SHA in the URL, not a branch name — branches move.
- Emojis: don't. Follow the review convention: no decorative emoji in review comments.

## Provenance

Portable equivalent of Claude Code's plugin `/code-review` slash-command (which uses parallel subagents; harness-portable version above). Extracted during a multi-pane sprint harness pass to close a Codex-side skill-registry gap. Companion skill: `/judge-with-codex` (uses this SKILL underneath).
