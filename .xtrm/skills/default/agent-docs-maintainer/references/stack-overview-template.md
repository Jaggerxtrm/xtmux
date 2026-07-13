# Stack Overview / Repo Identity Template

Use this before any managed `xtrm:start`, GitNexus, or beads block when a fresh agent would otherwise see generic workflow boilerplate first.

Keep the section factual and current. It may be longer than the normal compact-doc target when it teaches the repo's actual role; do not trim useful repo identity just to satisfy global line caps.

```md
# <Platform / Product> — <Repo role in one phrase>

<One sentence: what this repo owns and why it exists.>

## Stack overview

<2-4 short paragraphs explaining what runs here, the major components/layers, and how they fit into the platform. Prefer prose over command dumps.>

## Public surface

| Surface | Purpose | Owner / notes |
|---|---|---|
| `<domain-or-entrypoint>` | <what it exposes> | <routing/ops notes> |

## Sibling stacks / external networks

| Stack / dependency | Relationship | Where to go instead |
|---|---|---|
| `<sibling repo>` | <how this repo interacts with it> | `<path or skill>` |

## Operational entry points

| Command | Purpose |
|---|---|
| `<make target>` | <one-line purpose> |
| `<project validation command>` | <one-line purpose> |

## Data flow

1. <input/source enters here>
2. <this repo transforms/routes/observes it>
3. <output leaves here>

## What is not in this repo

- <Responsibility> lives in `<other repo/path>`.
- <Runbook/detail> lives in `<docs path>` or the canonical service skill.
```

## Reference shape

The intended shape is a substantive top section before the managed xtrm block explaining the repo's role, edge/observability/MCP layers, public domains, sibling stack networks, Makefile entry points, environment requirements, data flow, and explicit routing for responsibilities that belong elsewhere.
