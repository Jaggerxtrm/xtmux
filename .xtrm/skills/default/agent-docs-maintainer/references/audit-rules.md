# Agent docs audit rules

## Budgets

Line budgets apply primarily to routing/managed boilerplate, not to current repo-identity prose. Split the file before judging size:

| Metric | Good | Warning | Rewrite |
|---|---:|---:|---:|
| Routing + managed lines, excluding Stack Overview / Repo Identity | <=300 | 301-500 | >500 |
| Command refs outside concise operational-entry sections | <=20 | 21-60 | >60 |
| Code fences | <=8 | 9-20 | >20 |
| Table lines | <=30 | 31-80 | >80 |

These are heuristics. A short but stale file still needs cleanup, and a longer file may be correct when the extra lines are substantive repo identity.

## Repo-identity check

The first 20-30 lines must answer what the repo is. Flag a doc when:

- the first substantive line is `<!-- xtrm:start -->`, `<!-- gitnexus:start -->`, or another managed block marker;
- no H1/H2 appears before the first managed block;
- the leading heading has no plain-language prose explaining role, services, or platform context.

Recommend a `Stack Overview` / `Repo Identity` section, not trimming, when this is missing.

## Bloat signals

- Headings named `Command Reference`, `Common Query Patterns`, `Docker Operations`, `Testing` with many commands.
- `Quick Reference` only when it becomes a long inline manual (>30 command refs or >80 section lines); a 5-10 command essentials list is good.
- More than 10 consecutive lines inside a shell code fence.
- Multiple managed blocks for the same system.
- Generic xtrm/beads/GitNexus instructions repeated before and after project-specific sections.
- Old project names that do not match the repo/package. Extend stale-term checks per repo with `.xtrm/agent-docs.toml`, for example:

```toml
stale_terms = ["OldPlatform", "LegacyService"]
# or:
[audit]
stale_terms = ["OldPlatform", "LegacyService"]
```

## Rewrite priorities

1. Remove duplicated managed blocks.
2. Replace CLI manuals with a tiny essential command surface plus pointers to `--help` and skills.
3. Keep project-specific operational facts.
4. Move service-specific runbooks into service skills/docs.
5. Delete stale history and completed work notes.

## Required final shape

Every cleaned agent doc should have:

- project summary
- rules
- skill/workflow routing
- project map
- runtime-specific notes, if needed
- essential commands: enough for safe work inspection/claim/delegation/validation/close, not a full manual
- current gotchas
- references

## Managed xtrm block source

The bd/bv/xtrm top blocks in `CLAUDE.md` and `AGENTS.md` are managed content. Durable edits belong in the canonical xtrm instruction templates for the current installation/package, then `xt update --apply` regenerates project copies.

Do not hard-code machine-specific template paths in user-facing docs: installation layouts differ. The GitNexus block is regenerated separately by GitNexus hooks.
