#!/usr/bin/env bash
# verify-deploy-applied — deploy-gap guard for post-merge observability windows.
#
# Between a PR merge and the Deploy Monitor (DM) opening its observation
# window, the running container MUST reflect the merged code. If the
# container's StartedAt predates the PR's mergedAt, the DM would measure
# the pre-merge baseline and either miss the regression fix or report a
# false regression against old bytes. Same class of failure as the
# multi-week regression that sat in prod for over a month and one
# multi-pane sprint eval where DM opened a window against a pre-merge
# container.
#
# Full doctrine: consult your project's deploy-gap doctrine file
# (typically docs/devops/deploy-gap-pattern.md).
#
# Usage:
#   verify-deploy-applied <container> <pr-number> <owner/repo>
#
# Exit codes:
#   0  container StartedAt is AFTER PR mergedAt (deploy applied — safe to open DM window)
#   1  container StartedAt is BEFORE PR mergedAt (deploy NOT applied — orchestrator must rebuild+restart)
#   2  usage / dependency error (bad args, gh/docker/jq missing, container not found, PR not merged)
#
# Callable as a script or sourced as a function (defines verify_deploy_applied).

set -euo pipefail

verify_deploy_applied() {
    if [[ $# -ne 3 ]]; then
        echo "usage: verify_deploy_applied <container> <pr-number> <owner/repo>" >&2
        return 2
    fi

    local container="$1"
    local pr="$2"
    local repo="$3"

    for cmd in gh docker; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            echo "verify-deploy-applied: missing dependency: $cmd" >&2
            return 2
        fi
    done

    local merged_at
    merged_at=$(gh pr view "$pr" --repo "$repo" --json mergedAt --jq .mergedAt 2>/dev/null || true)
    if [[ -z "$merged_at" || "$merged_at" == "null" ]]; then
        echo "verify-deploy-applied: PR $pr on $repo is not merged (mergedAt is null)" >&2
        return 2
    fi

    local started_at
    started_at=$(docker inspect --format '{{.State.StartedAt}}' "$container" 2>/dev/null || true)
    if [[ -z "$started_at" ]]; then
        echo "verify-deploy-applied: container '$container' not found or not running" >&2
        return 2
    fi

    # RFC3339 timestamps sort correctly as strings when both use Z suffix.
    # docker StartedAt uses fractional seconds; gh mergedAt uses whole seconds.
    # Both are UTC. String comparison is safe.
    if [[ "$started_at" < "$merged_at" ]]; then
        cat >&2 <<EOF
verify-deploy-applied: DEPLOY-NOT-APPLIED
  container:    $container
  StartedAt:    $started_at
  PR:           $repo#$pr
  mergedAt:     $merged_at
  action:       run 'docker compose build <service> && docker compose up -d --force-recreate <service>' on the target host, then re-run this check.
EOF
        return 1
    fi

    echo "verify-deploy-applied: OK — $container StartedAt=$started_at > PR $repo#$pr mergedAt=$merged_at"
    return 0
}

# Run as a script when not sourced.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    verify_deploy_applied "$@"
fi
