---
name: updating-dependencies
description: >-
  Evidence-first dependency-bump and vulnerability-scan capability. Turns a
  Dependabot/Renovate/manual bump into a deterministic case, researches it
  against a 4-tier source matrix, and emits an upgrade dossier + verdict from a
  fixed taxonomy (PASS / PASS_WITH_NOTES / COOLDOWN / SECURITY_FORCED /
  NEEDS_CHANGES / BLOCKED / ESCALATE_*). Use whenever a dependency PR, lockfile
  bump, advisory, or vulnerability scan needs a risk-grounded merge/block
  decision instead of ad-hoc scanner triage. Distinguishes advisory vs blocking
  findings and never lets community signals block alone.
---

# Updating Dependencies

Turn a dependency bump into an **evidence-backed verdict**, not a scanner
shouting match. This skill is **rigid**: it specifies the inputs, the
deterministic-first protocol, the source matrix, the verdict taxonomy, the
cooldown policy, and the required outputs. Do not invent the process.

**Primary references (read alongside this skill):**
- `~/dev/xtrm/docs/devops/dependency-bump-policy.md` — the decision layer (advisory vs blocking, SECURITY_FORCED def, phased board)
- `~/dev/xtrm/docs/devops/dependencies-updating.md` — the exhaustive spec (§1–21)

## Core principles (spec §3)

1. **Deterministic first.** Anything computable — direct/transitive, prod/dev/build/test, release age, advisory match, usage — comes from parsers, scanners, registry metadata, SBOM, usage graph. The LLM does NOT invent these. If a deterministic case is not available, say so explicitly and mark fields `unknown`.
2. **Research second.** Context7 / DeepWiki / official docs / changelogs for migration semantics; threat-intel and community radar for supply-chain risk. Classify every source by tier.
3. **Service-aware.** A dependency is tied to repo, service, runtime, deploy artifact, GitHub Actions, container image, service-skill, owner.
4. **Delivery boundary.** This skill prepares the case and may propose a patch/comment. The **deployer** decides delivery; **SRE** observes post-deploy. Do not become a DevOps monolith.
5. **Evidence-first materialization.** Every verdict states what was observed, what was inferred, what is missing, which gate is required, which post-deploy watch is advised.

## Inputs

Minimum usable inputs:
- Trigger context: PR metadata / diff, or advisory id, or manual bump intent, or sweep scope.
- Lockfile + manifest (and the diff between from/to).
- Package identity + ecosystem + from_version + to_version.
- Advisory feed result (OSV/GHSA) for the target version.

Preferred additional inputs (mark `unknown` when absent — do NOT fabricate):
- SBOM, dependency graph, registry metadata, release timestamp, direct/transitive path.
- Usage map (imports, call sites, workflows, Docker/base image).
- Service-skill path + its `Dependency Surface` section (if present).
- CI result on the PR.

If the deterministic inspector (C1 / `xtrm-r1ed7.2`) is available, start from
its `dependency_update_case.json` (validates against
`schemas/dependency_update_case.schema.json`). If it is not available, build
the case by hand into the same shape and flag every inferred field.

## Workflow

```
1. Build/consume dependency_update_case.json   (deterministic layer)
2. Source matrix research                       (4 tiers, classified)
3. Migration analysis                           (breaking changes, deprecated API, behavior)
4. Local impact                                 (usage map, services, tests, workflows)
5. Emit upgrade dossier                         (templates/upgrade-dossier.md)
6. Decide verdict                               (taxonomy + decision rules below)
7. Materialize PR comment + gates + watch spec  (templates/pr-comment.md, post-deploy-watch-spec.md)
```

## Source matrix (4 tiers — spec §5)

Classify every source you cite into exactly one tier. Record it in the dossier.

| Tier | Sources | Blocking weight |
|---|---|---|
| **1. Authoritative machine-readable** | OSV, GHSA, CVE/NVD, CISA KEV, registry advisories, maintainer security advisories, registry metadata, lockfile, SBOM, provenance | **Primary.** Drives SECURITY_FORCED. |
| **2. Official migration semantics** | release notes, changelog, migration guide, API reference, official docs, tags/commit diff, Context7, DeepWiki, upgrade guides | Drives `NEEDS_CHANGES`. |
| **3. Research / threat intelligence** | OpenSSF, Socket, Datadog Security Labs, Snyk Research, Sonatype, JFrog, ReversingLabs, Chainguard, Aqua, Wiz, Unit 42, Mandiant, Trail of Bits, GitGuardian, StepSecurity, Semgrep/Checkmarx research, GuardDog | Raises caution; can escalate to `BLOCKED`/`ESCALATE_SECURITY` on strong signal. |
| **4. Community early-warning** | Hacker News, Reddit netsec/programming, GitHub Issues/Discussions, maintainer comments, public Discord/Slack, recognized researcher social posts | **Radar only. NEVER blocks alone.** Can raise caution and require verification. |

## Verdict taxonomy + decision rules (spec §9, policy §5)

Decide the verdict by walking these rules top-down; stop at the first match.

| # | Condition | Verdict |
|---|---|---|
| 1 | Malicious-package signal `strong`, OR registry `yanked`, OR advisory worsens at target, OR GitHub Action not pinned to full SHA, OR CI broken, OR a critical signal is missing | `BLOCKED` (+ `ESCALATE_SECURITY` if supply-chain) |
| 2 | Any advisory is **SECURITY_FORCED** (policy §4.1) | `SECURITY_FORCED` (bypasses cooldown; gated remediation) |
| 3 | No security urgency AND `release_age_hours < 168` (7d) | `COOLDOWN` (defer / quarantine ledger) |
| 4 | Bump requires code/config/test/workflow change | `NEEDS_CHANGES` (executor follow-up) |
| 5 | Acceptable but needs migration note / specific test / post-deploy watch / service-skill drift | `PASS_WITH_NOTES` |
| 6 | Small bump, cooldown cleared, no advisories, low usage impact, relevant tests present | `PASS` |
| — | Risk crosses the security/devops/sre boundary | append `ESCALATE_SECURITY` / `ESCALATE_DEPLOYER` / `ESCALATE_SRE` |

### SECURITY_FORCED (policy §4.1) — blocks on PR despite advisory default

A finding is SECURITY_FORCED when **any** is true:
- CISA KEV listed, or OSV/GHSA flags active exploitation.
- Public exploit / PoC available.
- EPSS ≥ 0.7 (high bucket).
- CVSS ≥ 9.0 **and** runtime-reachable on a publicly-exposed path in this repo.
- Maintainer-reported active attack.

## Cooldown policy

- Default **7 days** (`release_age_hours >= 168` to clear) for ordinary bumps.
- Bypass only via `SECURITY_FORCED`.
- **Extend** the cooldown (do not clear) when: install script present/changed, CI/CD blast radius high, binary blobs, recent maintainer change, freshly-created package, artifact/repo mismatch, obfuscation, or an unverified community warning.

## GitHub Actions — special case (spec §11)

GitHub Actions are **build-infrastructure dependencies**, not ordinary libs.
Minimum checks before any non-`BLOCKED` verdict:
- Pinned to **full-length commit SHA**, not a moving tag. (No SHA pin → `BLOCKED` or `NEEDS_CHANGES`.)
- Minimal `permissions`; evaluate `pull_request_target` trigger.
- Secrets/OIDC/deploy scope exposure reviewed.
- `workflow_run` / release triggers reviewed.
- Action maintainer trust + provenance + compromised history checked.

## Required outputs

Every invocation MUST produce, committed or attached to the PR/bead:

1. **`dependency_update_case.json`** — validates against `schemas/dependency_update_case.schema.json`.
2. **Upgrade dossier** — `templates/upgrade-dossier.md`, every stable section filled.
3. **PR comment** — `templates/pr-comment.md`, verdict + summary + required gates.
4. **Post-deploy watch spec** — `templates/post-deploy-watch-spec.md` (only when verdict is `PASS_WITH_NOTES` / `SECURITY_FORCED`-remediated / `ESCALATE_DEPLOYER`).
5. **Follow-up tasks** — substrate `advisor` / `followup` (discovered-from) / `gate` (blocks merge) per spec §13, materialized by the consumer (E1 / `unitAI-c7zdy.3`).

## Hard constraints

- **Community tier never blocks alone.** If only community signals are present, verdict is at most `PASS_WITH_NOTES` with a verification follow-up.
- **No secrets/tokens** in any emitted artifact. Redact before emitting.
- **No fabrication.** Unknown deterministic fields must be `unknown`, not invented.
- **Delivery boundary.** Propose patches/comments; do not auto-deploy, auto-merge, or auto-rollback.
- **Verdict must cite evidence.** Every non-PASS verdict references the case field + source tier that produced it.

## When NOT to use this skill

- Routine version pinning with no security/compat signal and no advisory → a normal PR, no dossier needed.
- Incident response already in progress (SRE leads; this skill only informs).
- Deploy/rollback execution (deployer leads; this skill only prepares the case).

## Related

- Deterministic inspector: `xtrm-r1ed7.2` (xtrm-tools DB).
- GitHub Action wrapper: `xtrm-r1ed7.3` (xtrm-tools DB).
- specialists CI adoption (osv/payload/substrate): `unitAI-c7zdy` (specialists DB).
