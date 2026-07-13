#!/usr/bin/env python3
"""Retroactive alert investigator — diagnoses the root cause of a past firing alert.

Given an alert name and a look-back window, this script:
  1. Finds the exact firing window(s) from TSDB
  2. Fetches the rule's PromQL expression and threshold from Prometheus
  3. Re-evaluates the metric expression over the firing window
  4. Identifies which label dimensions peaked above the threshold
  5. Applies known false-alert heuristics and emits a fix hint

Usage:
  python3 alert_investigator.py --alert TraefikHighLatency
  python3 alert_investigator.py --alert TraefikHighLatency --hours 8
  python3 alert_investigator.py --alert ContainerCrashLoop --hours 3
  python3 alert_investigator.py --alert TraefikHighLatency --json
"""

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

PROMETHEUS_CONTAINER = "example-prometheus"

# Build an opener that ONLY supports http/https. This makes file://, ftp://, etc.
# structurally impossible regardless of what value PROMETHEUS_URL takes.
_HTTP_OPENER = urllib.request.build_opener(
    urllib.request.HTTPHandler,
    urllib.request.HTTPSHandler,
)
PROMETHEUS_URL = "http://localhost:9090"
STEP = 60  # seconds

# ---------------------------------------------------------------------------
# Known false-alert patterns
# Each entry: match(labels, expr) -> bool, plus human-readable fields.
# ---------------------------------------------------------------------------

FALSE_ALERT_PATTERNS = [
    {
        "match": lambda labels, expr: (
            any(v == "websocket" for v in labels.values())
            and "duration" in expr.lower()
        ),
        "assessment": "FALSE ALERT — WebSocket connection lifetime misread as request latency",
        "explanation": (
            "Traefik records a WebSocket 'duration' as the total connection lifetime, "
            "not the response time. A dashboard user holding a connection open for "
            "several seconds trivially exceeds any latency threshold."
        ),
        "fix": 'Add protocol!="websocket" to the bucket selector in the rule expression.\n'
        "  Before: rate(traefik_service_request_duration_seconds_bucket[5m])\n"
        '  After:  rate(traefik_service_request_duration_seconds_bucket{protocol!="websocket"}[5m])',
    },
    {
        "match": lambda _labels, expr: (
            "candles" in expr.lower() or "stale" in expr.lower()
        ),
        "assessment": "POSSIBLE DATA FEED GAP — market data freshness alert",
        "explanation": (
            "Market data freshness alerts fire when no candle updates arrive within "
            "the staleness window. Common causes: exchange maintenance, network blip, "
            "or feed connector restart."
        ),
        "fix": "Check the upstream data-feed container logs and exchange status page. "
        "Run the matching service-skill's health_probe.py for live state.",
    },
]


# ---------------------------------------------------------------------------
# Prometheus API
# ---------------------------------------------------------------------------


def prom_get(path: str, params: dict | None = None) -> dict:
    qs = ("?" + urllib.parse.urlencode(params)) if params else ""
    url = f"{PROMETHEUS_URL}{path}{qs}"

    try:
        # http/https only — see _HTTP_OPENER definition above
        with _HTTP_OPENER.open(url, timeout=10) as r:
            return json.loads(r.read())
    except Exception:
        pass

    try:
        result = subprocess.run(
            ["docker", "exec", PROMETHEUS_CONTAINER, "wget", "-qO-", url],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout)
    except Exception:
        pass

    raise RuntimeError(f"Cannot reach Prometheus at {url} (tried direct + docker exec)")


# ---------------------------------------------------------------------------
# Rule resolution
# ---------------------------------------------------------------------------


def fetch_rule(alert_name: str) -> dict | None:
    """Return the Prometheus rule object for the given alertname, or None."""
    data = prom_get("/api/v1/rules")
    for group in data.get("data", {}).get("groups", []):
        for rule in group.get("rules", []):
            if rule.get("type") == "alerting" and rule.get("name") == alert_name:
                return rule
    return None


def parse_threshold(expr: str) -> tuple[str, str, float | None]:
    """
    Split 'some_expr > 2' into (metric_expr, operator, threshold).
    Returns (expr, '', None) if no comparison operator found.
    """
    m = re.search(r"\s*([><=!]+)\s*([\d.]+)\s*$", expr.strip())
    if m:
        metric_expr = expr[: m.start()].strip()
        return metric_expr, m.group(1), float(m.group(2))
    return expr, "", None


# ---------------------------------------------------------------------------
# Firing window detection
# ---------------------------------------------------------------------------


def find_firing_windows(alert_name: str, start_ts: int, end_ts: int) -> list[dict]:
    """
    Returns a list of firing instances, each with:
      - labels: dict of label key/values
      - windows: list of (start_ts, end_ts) tuples
    """
    data = prom_get(
        "/api/v1/query_range",
        {
            "query": f'ALERTS{{alertname="{alert_name}"}}',
            "start": start_ts,
            "end": end_ts,
            "step": STEP,
        },
    )

    instances = []
    for series in data.get("data", {}).get("result", []):
        metric = series.get("metric", {})
        raw_values = series.get("values", [])

        windows: list[tuple[float, float]] = []
        w_start: float | None = None
        for ts, v in raw_values:
            ts = float(ts)
            if v == "1":
                if w_start is None:
                    w_start = ts
            else:
                if w_start is not None:
                    windows.append((w_start, ts))
                    w_start = None
        if w_start is not None:
            windows.append((w_start, float(raw_values[-1][0])))

        if windows:
            labels = {
                k: v
                for k, v in metric.items()
                if k not in ("__name__", "alertstate", "alertname")
            }
            instances.append({"labels": labels, "windows": windows})

    return instances


# ---------------------------------------------------------------------------
# Metric re-evaluation
# ---------------------------------------------------------------------------


def evaluate_metric(metric_expr: str, start_ts: int, end_ts: int) -> list[dict]:
    """
    Re-evaluate the bare metric expression over the window.
    Returns list of { metric: {labels}, peak_value: float, peak_ts: str }.
    """
    data = prom_get(
        "/api/v1/query_range",
        {
            "query": metric_expr,
            "start": start_ts,
            "end": end_ts,
            "step": STEP,
        },
    )

    results = []
    for series in data.get("data", {}).get("result", []):
        metric = series.get("metric", {})
        values = [
            (float(t), float(v))
            for t, v in series.get("values", [])
            if v not in ("NaN", "Inf", "+Inf", "-Inf")
        ]
        if not values:
            continue
        peak_ts, peak_val = max(values, key=lambda x: x[1])
        results.append(
            {
                "metric": {k: v for k, v in metric.items() if k != "__name__"},
                "peak_value": peak_val,
                "peak_ts": datetime.fromtimestamp(peak_ts, tz=timezone.utc).strftime(
                    "%H:%M UTC"
                ),
                "samples": len(values),
            }
        )

    return sorted(results, key=lambda x: x["peak_value"], reverse=True)


# ---------------------------------------------------------------------------
# Heuristic assessment
# ---------------------------------------------------------------------------


def assess(
    instances: list[dict], metric_expr: str, _threshold: float | None
) -> dict | None:
    """Run false-alert heuristics against each instance. Returns first matching pattern.

    _threshold is reserved for future heuristics that compare observed peaks
    against the rule's firing threshold; current patterns only key off labels + expr.
    """
    for inst in instances:
        for pattern in FALSE_ALERT_PATTERNS:
            if pattern["match"](inst["labels"], metric_expr):
                return pattern
    return None


def duration_note(windows: list[tuple]) -> str:
    total_sec = sum(end - start for start, end in windows)
    mins = max(1, int(total_sec / 60))
    if mins < 15:
        return f"{mins}min  (brief — possibly transient)"
    return f"{mins}min"


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


def ts_str(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def print_report(
    alert_name: str,
    rule: dict | None,
    metric_expr: str,
    operator: str,
    threshold: float | None,
    instances: list[dict],
    peaks: list[dict],
    assessment: dict | None,
) -> None:
    width = 72
    print("=" * width)
    print(f"  {alert_name} — Investigation Report")
    print("=" * width)

    if rule:
        print(f"\n  Rule group:  {rule.get('__group__', 'unknown')}")
        print(f"  Expression:  {rule.get('query', metric_expr)}")
        print(f"  For:         {rule.get('duration', '?')}s")
        if threshold is not None:
            print(f"  Threshold:   {operator} {threshold}")

    print(f"\n  Firing instances: {len(instances)}")
    for inst in instances:
        label_str = "  ".join(f"{k}={v}" for k, v in inst["labels"].items())
        print(f"    [{label_str}]")
        for w_start, w_end in inst["windows"]:
            print(
                f"      {ts_str(w_start)} → {ts_str(w_end)}  ({duration_note([(w_start, w_end)])})"
            )

    if peaks:
        print("\n  Peak metric values during firing window:")
        for p in peaks[:5]:  # top 5 dimensions
            m_str = "  ".join(
                f"{k}={v}" for k, v in p["metric"].items() if k not in ("alertname",)
            )
            thresh_str = ""
            if threshold is not None:
                over = p["peak_value"] - threshold
                thresh_str = f"  ({over:+.2f} over threshold)"
            print(f"    {p['peak_value']:.2f}  at {p['peak_ts']}{thresh_str}")
            if m_str:
                print(f"    labels: {m_str}")
    elif metric_expr:
        print(
            "\n  [No metric samples found in firing window — alert may have resolved before re-evaluation]"
        )

    print()
    if assessment:
        print(f"  Assessment:  {assessment['assessment']}")
        print()
        for line in assessment["explanation"].split(". "):
            line = line.strip()
            if line:
                print(f"  {line}.")
        print()
        print("  Fix:")
        for line in assessment["fix"].splitlines():
            print(f"    {line}")
    else:
        print("  Assessment:  No known false-alert pattern matched.")
        print("  Next step:   Review logs with the relevant service skill.")

    print()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Diagnose a past firing alert by re-evaluating its metric expression",
    )
    parser.add_argument(
        "--alert",
        required=True,
        help="Alertname to investigate (e.g. TraefikHighLatency)",
    )
    parser.add_argument(
        "--hours", type=float, default=6, help="Look-back window in hours (default: 6)"
    )
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()

    now = int(time.time())
    start = int(now - args.hours * 3600)

    try:
        rule = fetch_rule(args.alert)
        instances = find_firing_windows(args.alert, start, now)

        if not instances:
            print(
                f"No firing windows found for '{args.alert}' in the past {args.hours}h."
            )
            sys.exit(0)

        raw_expr = rule["query"] if rule else ""
        metric_expr, operator, threshold = parse_threshold(raw_expr)

        # Widen the eval window slightly to capture the metric values
        if instances:
            all_starts = [w[0] for i in instances for w in i["windows"]]
            all_ends = [w[1] for i in instances for w in i["windows"]]
            eval_start = int(min(all_starts)) - 300
            eval_end = int(max(all_ends)) + 300
        else:
            eval_start, eval_end = start, now

        peaks = (
            evaluate_metric(metric_expr, eval_start, eval_end) if metric_expr else []
        )
        assessment = assess(instances, metric_expr, threshold)

        if args.as_json:
            print(
                json.dumps(
                    {
                        "alert": args.alert,
                        "rule_expr": raw_expr,
                        "instances": [
                            {**i, "windows": [[s, e] for s, e in i["windows"]]}
                            for i in instances
                        ],
                        "peaks": peaks,
                        "assessment": assessment["assessment"] if assessment else None,
                        "fix": assessment["fix"] if assessment else None,
                    },
                    indent=2,
                )
            )
        else:
            # Attach group name to rule for display
            if rule:
                rule["__group__"] = rule.get("name", "?")
            print_report(
                args.alert,
                rule,
                metric_expr,
                operator,
                threshold,
                instances,
                peaks,
                assessment,
            )

    except RuntimeError as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()
