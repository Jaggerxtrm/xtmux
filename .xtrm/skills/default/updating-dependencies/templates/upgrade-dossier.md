# Upgrade Dossier — {{package.name}} {{package.from_version}} → {{package.to_version}}

> Stable-section output of the `updating-dependencies` skill. Fill EVERY section.
> case_id: `{{case_id}}` · verdict: **{{verdict}}**

## Summary
<!-- 2-4 sentences: what changed, why it matters, the verdict in plain language. -->

## Trigger
<!-- dependabot_pr / renovate_pr / manual_bump / advisory / scheduled_sweep + repo + PR/branch -->

## Package / version diff
<!-- name, ecosystem, from→to, update_kind, dependency_kind (direct/transitive), scope (runtime/dev/build/test/ci/container) -->

## Source matrix
<!-- Tier 1 Authoritative: ... | Tier 2 Migration semantics: ... | Tier 3 Threat intel: ... | Tier 4 Community (never blocks alone): ... -->

## Security context
<!-- advisories (id/source/CVSS/SECURITY_FORCED?), known_exploited, public_exploit, EPSS bucket, malicious_package_signal -->

## Supply-chain context
<!-- release_age_hours, cooldown_status (cleared/active/bypass_security/blocked), registry_status, maintainer_change, install_script_changed, artifact_repo_mismatch -->

## Compatibility / migration notes
<!-- breaking changes, deprecated API, behavior changes from Tier 2 sources -->

## Local usage map
<!-- affected_services, affected_files, runtime_reachable, publicly_exposed_path, github_actions_blast_radius -->

## Service-skill impact
<!-- Dependency Surface section present? tests, watch signals, failure modes; drift to propose? -->

## Tests
<!-- existing relevant tests, missing tests, recommended_commands -->

## Verdict
<!-- {{PASS|PASS_WITH_NOTES|COOLDOWN|SECURITY_FORCED|NEEDS_CHANGES|BLOCKED|ESCALATE_*}} — reason citing the case field + source tier -->

## Required gates
<!-- e.g. "block PR" / "advisory comment only" / "none" -->

## Deploy notes
<!-- scoped issue + dossier handoff to deployer; or "n/a" -->

## Post-deploy watch spec
<!-- reference post-deploy-watch-spec.md if PASS_WITH_NOTES / SECURITY_FORCED-remediated / ESCALATE_DEPLOYER; else "n/a" -->

## Follow-up tasks
<!-- substrate advisor / followup (discovered-from) / gate (blocks merge) -->
