---
name: sre-triage
description: >-
  Cross-stack health verification with runtime-inferred routing. Queries
  Prometheus + Grafana live via the `mcpq` CLI (sidecar registry lives in
  `.mcpq.json` — `mcpq servers` lists them) to enumerate firing alerts, down
  containers, and stale freshness feeds; matches each finding to a registered
  service skill by listing the service-skills directory and matching container
  prefix / `territory:` globs; emits a triage report and loads expert personas
  for affected services. Also handles retroactive investigation of past alerts —
  use when the user reports receiving a Telegram alert hours ago that has since
  resolved. Invoke via /sre-triage for proactive checks, active incidents, or
  past-alert triage. Falls back to per-repo SERVICE_HEALTH.md files only when
  the mcpq sidecars are unreachable.
allowed-tools: Bash(mcpq *), Bash(python3 *), Bash(docker *), Bash(ls *), Read
---

# SRE Triage ( /sre-triage )

Verify every stack's health state **without touching the codebase**. If issues are
found, route immediately to the correct expert skill(s) by **listing the service-skills
directory and matching the offending container/alert label against service names or
their `territory:` globs** — no frozen mapping tables to maintain.

This skill is the first materialization of the `devops-sre` / monitor role from the
xtrm devops canon (`~/dev/xtrm/docs/devops/devops-system.md` §5.1). The future
`sre.specialist.json` inherits this body as its standing prompt.

> **Project-bound names vs. universal methodology.** The examples below use a
> placeholder project (`example-project`, `example_project_*` mcpq tool prefix,
> `~/projects/example-project/...`). These bindings are **not portable** —
> discover yours before running anything:
> - **mcpq tool prefix**: `mcpq prometheus list-tools` → find the
>   `<prefix>_execute_query` tool. Your prefix is almost never `example_project`.
> - **Container → repo routing**: read `infra/scripts/service-map.json`.
>   Container-name prefixes (`svc-*`, `feed-*`, `infra-*`, ...) are **project
>   topology, not a standard** — never assume them; read the file.
> - **Feed / alert / service names**: read `service-map.json` and your own alert
>   definitions; substitute them into the PromQL below.
>
> The methodology itself is universal and needs no replacement: the `mcpq`
> invocation pattern, the PromQL probes (`up == 0`, `ALERTS{alertstate="firing"}`,
> `node_*`, `container_*`), and the status taxonomy. Only the *names* change.

## Trigger

User types `/sre-triage` — or when any incident, alert, or "something is wrong" phrase
appears in the conversation without a specific service being named yet.

`/health` remains a colloquial alias during the deprecation window of the old
`checking-stack-health` skill.

---

## Execution Flow

### Step 1 — Live Health Probe via mcpq

Run these three queries **immediately**, before any reasoning or file reads.
They are the canonical live signals — Prometheus is the SSOT, the markdown
files are a 2-minute cache.

```bash
# 1a. Which containers are down right now?
mcpq prometheus call example_project_execute_query --arg query='up == 0' --json

# 1b. Which alerts are firing right now?
mcpq prometheus call example_project_execute_query --arg query='ALERTS{alertstate="firing"}' --json

# 1c. Which fast/live freshness feeds are stale beyond their 10m SLO?
# Cadence-aware: this intentionally checks only feeds expected inside 600s.
# Do not apply the 600s SLO to daily/hourly feeds.
mcpq prometheus call example_project_execute_query \
  --arg query='time() - example_project_freshness_last_success_unix_seconds{feed_id=~"svc-data-feed|svc-snapshot-feed|example-multi-source-container"} > 600' --json
```

Read each result's `structuredContent.result` array. An empty array on all three
means the fast-path health probe is clean. Otherwise, for each entry harvest the
labels (`job`, `instance`, `alertname`, `severity`, `feed_id`, `data_class`) and
route via the mapping tables further down this skill (Container → Service,
Alert → Service).

Freshness is cadence-aware: the 600s check is only for fast/live feeds whose
operator SLO is minutes (`svc-data-feed`, `svc-snapshot-feed`,
`example-multi-source-container`). Daily/hourly feeds can be inspected with
`sort_desc(time() - example_project_freshness_last_success_unix_seconds)` for context,
but do not mark the stack degraded solely because a daily or hourly feed is
older than 600s. Use feed-specific alerts/runbooks for those cadences.

Container → repo attribution comes from the regexes in your project's
`infra/scripts/service-map.json`. **Do not assume prefixes are standard** — they
are project topology (in one project `svc-*` might map to a data repo and
`infra-*` to the infra repo; yours will differ). Open that file and read the
actual mappings before attributing containers.

**Fallback when mcpq is unreachable** — if both `mcpq` calls return errors
mentioning `docker exec ... exited` or `connection refused`, the sidecars are
down. Fall back to the file-cache path:

```bash
python3 ~/projects/example-project/infra/scripts/health_check.py
```

…and read the per-repo `SERVICE_HEALTH.md` files if even that fails. The cron
that produces them is documented in `~/projects/example-project/infra/HEALTH_SYSTEM.md`.

---

### Step 1b — Resource Metrics Check

Run alongside Step 1 whenever the user mentions high memory, high CPU, slow
response, or when investigating `ContainerHighMemory` / `DiskUsageHigh` /
`DiskUsageCritical`. Same pattern — live PromQL via mcpq:

```bash
# Host CPU% (1m avg)
mcpq prometheus call example_project_execute_query \
  --arg query='100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[1m])))' --json

# Host memory used %
mcpq prometheus call example_project_execute_query \
  --arg query='100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)' --json

# Host disk used % at /
mcpq prometheus call example_project_execute_query \
  --arg query='100 * (1 - node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"})' --json

# Top-10 containers by 5m CPU
mcpq prometheus call example_project_execute_query \
  --arg query='topk(10, rate(container_cpu_usage_seconds_total{name!=""}[5m]) * 100)' --json

# Top-10 containers by memory-vs-limit %
mcpq prometheus call example_project_execute_query \
  --arg query='topk(10, 100 * container_memory_working_set_bytes{name!=""} / container_spec_memory_limit_bytes{name!=""})' --json
```

Warn when host CPU > 80%, host memory > 85%, any container > 80% CPU, or any
container > 85% memory-vs-limit. Use the offending container name to load the
right service skill before diagnosing further.

---

### Step 2 — Classify Overall State

Classify from the Step 1 query results:

| Signal from Step 1 queries                                              | Overall status | Action                                          |
|-------------------------------------------------------------------------|----------------|-------------------------------------------------|
| All three queries return empty `result` arrays                          | `HEALTHY`      | Report clean — but see Step 2b for past alerts  |
| `ALERTS` returns rows with `severity="warning"`, or a fast/live freshness feed breaches its cadence-aware 600s SLO | `DEGRADED` | Continue to Step 3 (warning track) |
| `up == 0` returns rows, or `ALERTS` has `severity="critical"`           | `CRITICAL`     | Continue to Step 3 (incident track)             |
| mcpq returned an error (sidecars unreachable) AND fallback also failed  | `UNKNOWN`      | Surface explicitly; load `grafana-mcp` + `prometheus-mcp` skills and fix the query surface before continuing |

---

### Step 2b — Retroactive Investigation (user reports a past alert)

When the current health check is clean but the user mentions receiving a Telegram alert
N hours ago, **do not run ad-hoc queries**. Use the dedicated scripts:

Set the skill directory once, then use it throughout:
```bash
SKILL_DIR="$CLAUDE_PROJECT_DIR/.xtrm/skills/default/sre-triage"
```

**Phase A — Find what fired:**

Derive `--hours` from what the user said (e.g. "3 hours ago" → `--hours 3`). Default to 6 if unspecified.
```bash
python3 $SKILL_DIR/scripts/alert_history.py --hours <N>
```

Options:
```bash
python3 $SKILL_DIR/scripts/alert_history.py --alert TraefikHighLatency  # filter to one alert
python3 $SKILL_DIR/scripts/alert_history.py --json                       # machine-readable
```

Exit codes: `0` = nothing fired, `1` = at least one alert fired, `2` = Prometheus unreachable.

**Phase B — Diagnose each alert that fired:**
```bash
python3 $SKILL_DIR/scripts/alert_investigator.py --alert <alertname> --hours <N>
```

The investigator:
- Fetches the rule's PromQL expression and threshold from Prometheus
- Re-evaluates the expression over the exact firing window
- Reports peak metric values and which label dimensions breached the threshold
- Applies known false-alert heuristics (WebSocket lifetime, market data feed gaps, etc.)
- Emits a structured assessment and fix hint

**Only fall back to raw PromQL or docker commands if both scripts fail** (exit code 2).

After diagnosis, report the finding and proposed fix directly — no XML scope block needed
for resolved alerts unless the root cause requires a code or config change.

---

### Step 3 — Emit XML Health Scope Block

Emit this block **before loading any skills or running any docker commands**:

```xml
<health_scope>
  <generated><!-- timestamp from script output --></generated>
  <overall_status>DEGRADED|CRITICAL</overall_status>

  <stacks>
    <stack id="example-feeds" status="DEGRADED">
      <alerts>
        <alert severity="CRITICAL" name="ContainerCrashLoop" container="example-summarizer-container">
          example-summarizer-container has restarted 3x in 1h
        </alert>
      </alerts>
      <services_affected>
        <service id="example-summarizer-skill" confidence="high">
          <reason>example-summarizer-container container crash-looping (maps to example-summarizer-skill)</reason>
          <skill>.claude/skills/example-summarizer-skill/SKILL.md</skill>
          <load>now</load>
        </service>
      </services_affected>
    </stack>
  </stacks>

  <workflow>
    <phase order="1" name="load-skills">
      Read every SKILL.md listed above. Adopt the expert persona, failure modes
      table, and diagnostic scripts from each. Do not run docker commands yet.
    </phase>
    <phase order="2" name="diagnose">
      For each affected service, run its health_probe.py and log_hunter.py scripts
      before any ad-hoc docker commands. Use the failure modes table from the skill
      to identify the root cause.
    </phase>
    <phase order="3" name="fix">
      Apply targeted fix per service. Follow the skill's operational runbook.
    </phase>
    <phase order="4" name="verify">
      Re-run health_check.py to confirm all stacks return to HEALTHY.
      If a fix involved code logic: write a regression test alongside the fix.
    </phase>
  </workflow>
</health_scope>
```

Adapt the `<services_affected>` block to what the script actually reported.

---

### Step 4 — Load Skills for Affected Services

For every `<service>` with `<load>now</load>`, read the skill file immediately:

```
Read: .claude/skills/<service-id>/SKILL.md
```

**Do not proceed to diagnosis until all affected skills are loaded.**
Adopt the failure modes table, diagnostic scripts, and runbook from each skill.

If the affected service has no registered skill:
1. Report: `"No registered skill for <service-id>."`
2. Continue with general expert mode using docker logs and AGENT_MONITORING.md guidance.
3. Offer: `"I can create a skill — use /creating-service-skills."`

---

### Step 5 — Diagnose Per Service

For each affected service (in severity order — CRITICAL first):

1. **Check the skill's failure modes table** — match the alert name or symptom.
2. **Run the skill's diagnostic scripts** in this order:
   - `health_probe.py` — current live state
   - `log_hunter.py` — recent error patterns
3. **Only then** run raw docker commands if scripts are insufficient:
   ```bash
   docker logs <container-name> --tail 100
   docker compose -f ~/projects/example-project/<stack>/docker-compose.yml ps
   ```

---

### Step 6 — Fix and Verify

Apply the fix identified in Step 5. Then re-run the Step 1 queries:

```bash
mcpq prometheus call example_project_execute_query --arg query='up == 0' --json
mcpq prometheus call example_project_execute_query --arg query='ALERTS{alertstate="firing"}' --json
mcpq prometheus call example_project_execute_query \
  --arg query='time() - example_project_freshness_last_success_unix_seconds{feed_id=~"svc-data-feed|svc-snapshot-feed|example-multi-source-container"} > 600' --json
```

All three `structuredContent.result` arrays must be empty (or no longer include
the previously-failing entries) before closing the incident. For broad cached
verification, run `python3 ~/projects/example-project/infra/scripts/health_check.py`;
do not treat daily/hourly freshness rows as failures unless their feed-specific
SLO or alert says they are late.

**Regression test rule:** If the root cause was a code logic bug, write a test
(see the Regression Test section below). If it was operational, extend or add a
check in the service's `health_probe.py`.

---

## Container → Service Routing (runtime inference)

**Do not consult a frozen table.** Derive the mapping at the moment of incident, by
listing the service-skills directory tree and matching the offending container's label
against the service-id or its `territory:` glob in the registry.

```bash
# 1. Enumerate registered services (across all packs in this repo)
ls .xtrm/skills/user/packs/*/service-skills/services/

# 2. For a container name like `infra-traefik`, the service-id is the
#    longest matching prefix or exact match against a directory name above.
#    (Routing is project topology, not a standard: read
#    `infra/scripts/service-map.json` for the real prefix → repo mappings rather
#    than assuming prefixes like `svc-*` or `infra-*`. Cross-repo containers'
#    service skills live in sibling repos — `cd ~/projects/<your-project>/<repo>`
#    then repeat the `ls`.)

# 3. Read the matched skill to adopt expert persona:
Read: .xtrm/skills/user/packs/<pack>/service-skills/services/<service-id>/SKILL.md

# 4. If no match: report the container as `unrouted`. Do not invent a skill path.
#    Offer to scaffold via /creating-service-skills.
```

The `service-registry.json` at each pack's root provides the authoritative
`territory:` globs and `triggers:` keywords if the directory-listing heuristic
needs disambiguation. Always prefer the registry over hand-matching when in
doubt — it's the single source of truth.

The two `-mcp` sidecars (`example-grafana-mcp`, `example-prometheus-mcp`) are
read-only query surfaces. The mcpq wiring smoke is whatever the project ships —
in example-project, it's `make verify-mcpq` from the infra repo root.

---

## Silent edge failure — traefik-route-drop pattern

`ContainerCrashLoop` and `up==0` miss a class of outage that *keeps the target
container running healthy* but drops ALL routes. One observed incident: `docker
compose up` invoked from a worktree without `.env` interpolated empty
`${ADMIN_CIDR}` into `traefik/dynamic/middlewares.yml`, dynamic config became
YAML-invalid, traefik discarded every router, and every public request 404-ed
for 7h. The traefik container stayed `up==1` throughout.

**Alert:** `TraefikEdgeRoutesMissing` — fires on >90% 404 rate on the
`websecure` entrypoint over 5m (with a `rate>0.05` idle guard).

**Live probe (adds ~200ms; run any time an "edge is down / can't reach
grafana / API 404" report comes in and no other alerts are firing).** The
host list comes from an edge-probe config surface — read from
`$XTRM_EDGE_PROBES` (colon-separated), else `~/.xtrm/config/edge-probes.txt`
(one host per line), else the repo-local `.xtrm/edge-probes.txt`, else skip
with a warning:

```bash
: "${XTRM_EDGE_PROBES:=$(cat ~/.xtrm/config/edge-probes.txt \
  .xtrm/edge-probes.txt 2>/dev/null | tr '\n' ':' )}"
IFS=: read -r -a hosts <<<"${XTRM_EDGE_PROBES}"
for host in "${hosts[@]}"; do
  [ -z "$host" ] && continue
  printf "%-45s %s\n" "$host" "$(curl -sS -o /dev/null -w '%{http_code}' https://$host/)"
done
```

Interpret the codes against your per-stack baseline (e.g. root=200, dashboards
behind auth=403, APIs=401). **All-404 across the board is the smoking gun**.

Fix (compose stack):

```bash
cd /path/to/infra && docker compose --env-file .env up -d traefik
```

Prevention: a `make preflight-env` guard for missing/empty required env vars +
an edge-probe pass in the deploy-gap observation window.

## Alert → Service Mapping Reference

When an alert fires, use this table to identify the affected service and the
Grafana dashboard to open for visual investigation.

| Alert name                       | Severity | Likely service / container           | Dashboard to open                              |
|----------------------------------|----------|--------------------------------------|------------------------------------------------|
| `ContainerCrashLoop`             | CRITICAL | match `name` label in alert detail   | Containers — Resource Metrics (cAdvisor)       |
| `ContainerHighMemory`            | WARNING  | match `name` label; run `--metrics`  | Containers — Resource Metrics (cAdvisor)       |
| `ExampleProjectFeedStarved`   | CRITICAL | `svc-data-feed`                      | Market Data — Feed Health & Ingestion Pipeline |
| `ExampleProjectSymbolStale`          | WARNING  | `svc-data-feed`                      | Market Data — Feed Health & Ingestion Pipeline |
| `PostgresDown`                   | CRITICAL | `serving-example-api` or svc/treasury| PostgreSQL — Database Stats                    |
| `PostgresTooManyConnections`     | WARNING  | `serving-example-api` or svc/treasury| PostgreSQL — Database Stats                    |
| `RedisDown`                      | CRITICAL | `serving-example-api`, `collecting-events` | Redis — Cache Metrics               |
| `RedisHighMemory`                | WARNING  | `serving-example-api`, `collecting-events` | Redis — Cache Metrics               |
| `HighErrorRate`                  | WARNING  | `serving-example-api`                | Example Project — API & MCP Traffic (Traefik)          |
| `TraefikHighLatency`             | WARNING  | `traefik`                            | Traefik — Routing & Proxy Metrics              |
| `TraefikEdgeRoutesMissing`       | CRITICAL | `traefik` (dynamic config regression)| Traefik — Routing & Proxy Metrics              |
| `DiskUsageHigh`                  | WARNING  | all stacks (shared host)             | VPS — Host Metrics (Node Exporter)             |
| `DiskUsageCritical`              | CRITICAL | all stacks — check Loki + volumes    | VPS — Node Exporter Full (Deep Dive)           |
| `ServiceDown`                    | CRITICAL | match `instance` label in alert      | Containers — Resource Metrics (cAdvisor)       |

### Market data alert context

`ExampleProjectFeedStarved` and `ExampleProjectSymbolStale` are **suppressed outside
Example Exchange trading hours** via `example_exchange_session_closed`. Before investigating:

```bash
# Check if market is open — 0 = open, 1 = closed
curl -s "http://<prometheus-ip>:9090/api/v1/query?query=example_exchange_session_closed" \
  | python3 -c "import json,sys; r=json.load(sys.stdin)['data']['result']; print('session closed:', r[0]['value'][1])"
```

If session is closed (`1`), the alert is expected noise — no action needed.
If session is open (`0`) and the alert fires, open the Market Data dashboard and check:
1. **Fresh symbol count** — should be ≥ 5 during active session
2. **Per-symbol staleness table** — identify which symbols/asset classes are stale
3. **Container restarts** — check if `svc-data-feed` or `svc-tick-ingestor-rust` crash-looped

---

## Grafana Dashboard Reference

All dashboards are provisioned at `~/projects/example-project/infra/grafana/dashboards/`.
Every alert rule maps to at least one dashboard.

| Dashboard                                    | Covers                                  | Alert rules wired             |
|----------------------------------------------|-----------------------------------------|-------------------------------|
| Containers — Resource Metrics (cAdvisor)     | CPU, mem, network, disk per container   | `ContainerCrashLoop`, `ContainerHighMemory`, `ServiceDown` |
| Market Data — Feed Health & Ingestion Pipeline | Symbol freshness, svc containers, TimescaleDB | `ExampleProjectFeedStarved`, `ExampleProjectSymbolStale` |
| Example Project — API & MCP Traffic (Traefik)        | HTTP error rate, latency by service     | `HighErrorRate`, `TraefikHighLatency` |
| Example Project Website — Nginx & Container          | nginx stats + website container         | `ServiceDown`, `ContainerCrashLoop` |
| VPS — Host Metrics (Node Exporter)           | CPU, memory, disk, network (host)       | `DiskUsageHigh`, `DiskUsageCritical` |
| VPS — Node Exporter Full (Deep Dive)         | 41-panel deep-dive host metrics         | `DiskUsageHigh`, `DiskUsageCritical` |
| PostgreSQL — Database Stats                  | pg_up, connections, query stats         | `PostgresDown`, `PostgresTooManyConnections` |
| Redis — Cache Metrics                        | redis_up, memory, hit rate              | `RedisDown`, `RedisHighMemory` |
| Traefik — Routing & Proxy Metrics            | Entrypoint-level traffic and latency    | `TraefikHighLatency`, `HighErrorRate` |
| Logs — Container Stream (Loki)               | All container logs (diagnostic)         | *(diagnosis only — no alert wired)* |
| Data Pipeline Health — DB Direct             | TimescaleDB + QuestDB direct SQL freshness, ingestion lag, table sizes | *(diagnostic — DB cross-check for ingestion-family alerts)* |
| Market Data — Direct                         | Direct-from-DB market data views (non-STIR via QuestDB after 2026-03-25 migration) | *(diagnostic — complements freshness alerts on `svc-data-feed`)* |

---

## Health State Interpretation

| Status     | Meaning                                                                                  |
|------------|------------------------------------------------------------------------------------------|
| `HEALTHY`  | All three Step 1 fast-path queries returned empty `result` arrays                         |
| `DEGRADED` | Firing `severity="warning"` alerts, or fast/live freshness feeds past their cadence-aware SLO |
| `CRITICAL` | `up == 0` rows present, or firing `severity="critical"` alerts                           |
| `UNKNOWN`  | mcpq sidecars unreachable AND `health_check.py` fallback also failed — query surface itself is down |

When `UNKNOWN`, the priority is restoring the query surface before assessing
anything else. Load both sidecar skills (`prometheus-mcp`, `grafana-mcp`) for
their failure-mode tables, then inspect:

```bash
docker ps --filter name=example-prometheus-mcp --filter name=example-grafana-mcp
docker logs --tail 50 example-prometheus-mcp
docker logs --tail 50 example-grafana-mcp
make verify-mcpq   # canonical smoke for the wiring
```

If the fallback `SERVICE_HEALTH.md` files are also missing, the file-cache cron
is what's broken (independent failure mode — does not block live diagnosis once
mcpq is back up):

```bash
crontab -l | grep health-report
make health-report   # one-shot regenerate from infra/
```

---

## Regression Test Binding

When a fix has been applied for a code logic bug:

```
Is the bug in application code logic?
  YES → write pytest/unit test in the service's test suite

  NO  (operational / infra / config issue) →
        Does the skill's health_probe.py already check this condition?
          YES → extend the existing check function
          NO  → add a new check function to health_probe.py
                OR add a dedicated script to .claude/skills/<service>/scripts/
```

Name after the failure mode, not the fix:

```python
def check_summarizer_not_crash_looping():    # ✅
def check_redis_eviction_not_exhausted():    # ✅
def test_fix():                              # ❌
```

If `alert_investigator.py` identifies a **false-alert pattern** that is not yet in
`FALSE_ALERT_PATTERNS`, add a new entry to the script:

```python
{
    "match": lambda labels, expr: <condition on labels + expr string>,
    "assessment": "FALSE ALERT — <one-line description>",
    "explanation": "<why it fires spuriously>",
    "fix": "<what to change in the alert rule>",
},
```

---

## Related Skills

- `/scope "task"` — Route any non-health task to the right expert
- `/using-service-skills` — Passive catalog at session start
- `/creating-service-skills` — Scaffold new expert skill packages
- `/updating-service-skills` — Sync skills after implementation drift

## System Documentation

Full architecture, maintenance guide, and Agent Forge migration path:
`~/projects/example-project/infra/HEALTH_SYSTEM.md`
