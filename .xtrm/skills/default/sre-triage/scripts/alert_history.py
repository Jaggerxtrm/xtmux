#!/usr/bin/env python3
"""Retroactive alert history — shows every alert that fired in the past N hours.

Queries the Prometheus TSDB directly. Useful when a user reports receiving a
Telegram alert that has already resolved and the current health check is clean.

Usage:
  python3 alert_history.py                          # last 6h, all alerts
  python3 alert_history.py --hours 12               # last 12h
  python3 alert_history.py --alert TraefikHighLatency
  python3 alert_history.py --json
"""

import argparse
import json
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

PROMETHEUS_CONTAINER = "example-prometheus"
PROMETHEUS_URL = "http://localhost:9090"

# Build an opener that ONLY supports http/https. This makes file://, ftp://, etc.
# structurally impossible regardless of what value PROMETHEUS_URL takes.
_HTTP_OPENER = urllib.request.build_opener(
    urllib.request.HTTPHandler,
    urllib.request.HTTPSHandler,
)
STEP = 60  # seconds


# ---------------------------------------------------------------------------
# Prometheus API
# ---------------------------------------------------------------------------


def prom_get(path: str, params: dict | None = None) -> dict:
    """Fetch from Prometheus API. Tries direct HTTP, falls back to docker exec."""
    qs = ("?" + urllib.parse.urlencode(params)) if params else ""
    url = f"{PROMETHEUS_URL}{path}{qs}"

    try:
        # http/https only — see _HTTP_OPENER definition above
        with _HTTP_OPENER.open(url, timeout=10) as r:
            return json.loads(r.read())
    except Exception:
        pass

    # Fallback: exec into the container
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
# Helpers
# ---------------------------------------------------------------------------


def ts_str(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def firing_windows(values: list) -> list[tuple[float, float]]:
    """Convert raw (timestamp, value) pairs into contiguous firing [start, end] spans."""
    windows: list[tuple[float, float]] = []
    start: float | None = None
    for ts, v in values:
        ts = float(ts)
        if v == "1":
            if start is None:
                start = ts
        else:
            if start is not None:
                windows.append((start, ts))
                start = None
    if start is not None:
        windows.append((start, float(values[-1][0])))
    return windows


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------


def query_history(hours: float, alert_filter: str | None) -> dict:
    now = time.time()
    start = now - hours * 3600

    selector = f'ALERTS{{alertname="{alert_filter}"}}' if alert_filter else "ALERTS"

    data = prom_get(
        "/api/v1/query_range",
        {
            "query": selector,
            "start": int(start),
            "end": int(now),
            "step": STEP,
        },
    )

    results = data.get("data", {}).get("result", [])
    by_alert: dict[str, list[dict]] = {}

    for series in results:
        metric = series.get("metric", {})
        name = metric.get("alertname", "?")
        raw_values = series.get("values", [])

        windows = firing_windows(raw_values)
        if not windows:
            continue

        labels = {
            k: v
            for k, v in metric.items()
            if k not in ("__name__", "alertstate", "alertname")
        }

        by_alert.setdefault(name, []).append(
            {
                "labels": labels,
                "windows": windows,
            }
        )

    return by_alert


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


def print_human(by_alert: dict, hours: float) -> None:
    now = time.time()
    start = now - hours * 3600

    if not by_alert:
        print(f"No alerts fired in the past {hours}h.")
        return

    print(f"Alerts that fired in the past {hours}h  ({ts_str(start)} → {ts_str(now)})")
    print("=" * 72)

    for name, instances in sorted(by_alert.items()):
        total_windows = sum(len(i["windows"]) for i in instances)
        print(
            f"\n  {name}  ({len(instances)} dimension(s), {total_windows} firing window(s))"
        )

        for inst in instances:
            label_str = "  ".join(f"{k}={v}" for k, v in inst["labels"].items())
            if label_str:
                print(f"    [{label_str}]")
            for w_start, w_end in inst["windows"]:
                duration_min = max(1, int((w_end - w_start) / 60))
                print(f"      {ts_str(w_start)} → {ts_str(w_end)}  ({duration_min}min)")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Show alert firing history from Prometheus TSDB",
    )
    parser.add_argument(
        "--hours", type=float, default=6, help="Look back N hours (default: 6)"
    )
    parser.add_argument("--alert", default=None, help="Filter to a specific alertname")
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()

    try:
        by_alert = query_history(args.hours, args.alert)
    except RuntimeError as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        sys.exit(2)

    if args.as_json:
        print(json.dumps(by_alert, indent=2))
    else:
        print_human(by_alert, args.hours)

    sys.exit(0 if not by_alert else 1)


if __name__ == "__main__":
    main()
