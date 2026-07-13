## 📦 updating-dependencies — {{verdict}}

**{{package.name}}** `{{package.from_version}}` → `{{package.to_version}}` ({{package.ecosystem}}, {{package.dependency_kind}}/{{package.scope}})

> Case `{{case_id}}` · verdict decided by `updating-dependencies` skill

### Summary
{{summary}}

### Why this verdict
{{verdict_reason}}

### Security
- Advisories: {{advisory_count}} (SECURITY_FORCED: {{security_forced_count}})
- Known exploited: {{known_exploited}} · Public exploit: {{public_exploit_available}} · EPSS: {{epss_bucket}}
- Malicious-package signal: {{malicious_package_signal}}

### Supply chain
- Release age: {{release_age_hours}}h · Cooldown: {{cooldown_status}} · Registry: {{registry_status}}

### Required gate on this PR
{{required_gate}}
<!-- advisory verdict → "No merge block from this check. Details above."
     SECURITY_FORCED/BLOCKED → "This check FAILS the PR until remediated." -->

### Follow-ups
{{follow_ups}}

---
<sub>Evidence-first verdict · community signals never block alone · full dossier attached to case {{case_id}}</sub>
