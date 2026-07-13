# Post-Deploy Watch Spec — {{package.name}}

> Hand-off to SRE for post-deploy regression watch (spec §15). Emitted only on
> PASS_WITH_NOTES / SECURITY_FORCED-remediated / ESCALATE_DEPLOYER verdicts.

## Scope
- repo: {{repo}}
- service: {{service}}
- environment: {{environment}}

## Dependency update
- package: {{package.name}}
- from → to: {{package.from_version}} → {{package.to_version}}
- case_id: {{case_id}}

## Windows
- baseline: {{baseline_window}} (e.g. 24h before deploy)
- watch: {{watch_window}} (2h / 24h / 72h by risk)

## Signals
- metrics: request_error_rate, latency_p95/p99, restart_count, job_failure_rate, queue_depth, memory, cpu
- logs: exception_rate, new error fingerprints, dependency-specific warnings
- traces: span_error_rate, critical-path latency, downstream call failures

## Expected risk area
{{expected_risk_area}}

## Verdicts
PASS · DEGRADED · FAIL · UNKNOWN

## Escalation
- on FAIL → devops-sre
- on UNKNOWN → follow-up: missing telemetry
- rollback recommendation → only when thresholds AND confidence are strong
