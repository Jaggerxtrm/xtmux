#!/usr/bin/env python3
"""Standalone service-skills drift reconciler for zero-install runners."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).parent))
from bootstrap import get_project_root, get_registry_path, load_registry, save_registry  # type: ignore[import-not-found]  # noqa: E402
from drift_detector import scan_drift  # type: ignore[import-not-found]  # noqa: E402

DEFAULT_NANO_GPT_URL = "https://nano-gpt.com/api/v1/chat/completions"
NANO_GPT_MODEL = os.environ.get("NANO_GPT_MODEL", "gpt-4o-mini")
ALLOWED_NANO_GPT_HOSTS = {"nano-gpt.com"}
SECRET_QUERY_PARAMS = {"api_key", "key", "token"}
TOKEN_CHARS = 4


@dataclass(frozen=True)
class ReconcileOptions:
    dry_run: bool
    max_files: int | None
    api_key: str
    cost_limit_tokens: int | None


@dataclass(frozen=True)
class LlmResult:
    content: str
    tokens: int


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Reconcile service SKILL.md drift.")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON only")
    parser.add_argument("--dry-run", action="store_true", help="build prompts and call API without writes")
    parser.add_argument("--max-files", type=int, default=None, help="maximum drifted files to reconcile")
    return parser.parse_args(argv)


def parse_cost_limit(value: str | None) -> int | None:
    if value is None or value == "":
        return None
    limit = int(value)
    if limit < 0:
        raise ValueError("XTRM_AUTO_RECONCILE_COST_LIMIT_TOKENS must be non-negative")
    return limit


def estimate_tokens(text: str) -> int:
    return max(1, (len(text) + TOKEN_CHARS - 1) // TOKEN_CHARS)


def build_prompt(drift: dict[str, Any], current_skill: str, source_evidence: str) -> str:
    """Trust model: source files come from the repo (trusted but commit-reviewed); LLM output is treated as PR-reviewed (human approves auto-PR)."""
    citations = {
        "symbols": drift.get("symbols", []),
        "processes": drift.get("processes", []),
        "cross_territory": drift.get("cross_territory", []),
        "tier": drift.get("tier"),
        "tier_source": drift.get("tier_source"),
        "gitnexus_status": drift.get("gitnexus_status"),
    }
    return "\n".join(
        [
            "You reconcile service skill documentation with implementation drift.",
            "Return only the complete updated SKILL.md content. No markdown fences. No commentary.",
            f"Service: {drift.get('service_id', 'unknown')} ({drift.get('service_name', 'unknown')})",
            f"Drifted source file: {drift.get('file_path', 'unknown')}",
            f"Drift evidence: {json.dumps(citations, sort_keys=True)}",
            "",
            "Current SKILL.md:",
            current_skill,
            "",
            "Source file evidence:",
            source_evidence,
        ]
    )


def parse_llm_response(payload: dict[str, Any]) -> LlmResult:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ValueError("nano-gpt response missing choices")
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str) or not content.strip():
        raise ValueError("nano-gpt response missing content")
    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
    total_tokens = usage.get("total_tokens", 0)
    return LlmResult(content=content.strip() + "\n", tokens=total_tokens if isinstance(total_tokens, int) else 0)


def get_nano_gpt_url() -> str:
    return os.environ.get("NANO_GPT_API_URL", DEFAULT_NANO_GPT_URL)


def validate_nano_gpt_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise ValueError("NANO_GPT_API_URL must use https")
    if parsed.hostname not in ALLOWED_NANO_GPT_HOSTS:
        raise ValueError("NANO_GPT_API_URL host must be nano-gpt.com")
    query_keys = {key.lower() for key in parse_qs(parsed.query)}
    if query_keys & SECRET_QUERY_PARAMS:
        raise ValueError("NANO_GPT_API_URL must not contain secret query parameters")
    return url


def redact_exception(exc: Exception, api_key: str | None = None) -> str:
    message = f"{type(exc).__name__}: {str(exc)[:200]}"
    message = re.sub(r"Bearer\s+\S+", "Bearer [REDACTED]", message)
    if api_key:
        message = message.replace(api_key, "[REDACTED]")
    return message


def call_nano_gpt(prompt: str, api_key: str) -> LlmResult:
    try:
        import httpx  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError("httpx is required for reconcile.py") from exc
    timeout = int(os.environ.get("NANO_GPT_TIMEOUT_SECONDS", "300"))
    response = httpx.post(
        validate_nano_gpt_url(get_nano_gpt_url()),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={"model": NANO_GPT_MODEL, "messages": [{"role": "user", "content": prompt}]},
        timeout=timeout,
    )
    response.raise_for_status()
    return parse_llm_response(response.json())


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(content)
        temp_path = Path(handle.name)
    os.replace(temp_path, path)


def current_head(project_root: Path) -> str:
    result = subprocess.run(["git", "-C", str(project_root), "rev-parse", "HEAD"], capture_output=True, text=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else ""


def find_skill_path(drift: dict[str, Any], registry: dict[str, Any], project_root: Path) -> str | None:
    skill_path = drift.get("skill_path")
    if not isinstance(skill_path, str) or not skill_path:
        service_id = drift.get("service_id")
        service = registry.get("services", {}).get(service_id) if isinstance(service_id, str) else None
        skill_path = service.get("skill_path") if isinstance(service, dict) else None
    if not isinstance(skill_path, str) or not skill_path:
        return None
    resolved_root = project_root.resolve()
    resolved_skill_path = (project_root / skill_path).resolve()
    if not resolved_skill_path.is_relative_to(resolved_root):
        raise ValueError(f"skill_path escapes project root: {skill_path}")
    return skill_path


def bump_last_sync_ref(project_root: Path, new_ref: str, dry_run: bool) -> str | None:
    # Mirrors drift_detector.update_sync_time: bump BOTH last_sync_ref (SHA) AND
    # last_sync (ISO timestamp). scan_drift compares file mtime against last_sync
    # — bumping only the ref left the timestamp at the old value, so post-merge
    # source file mtimes triggered drift on every subsequent merge (xtrm-qxu4y).
    now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    registry = load_registry(str(project_root))
    services = registry.get("services", {})
    old_refs = [service.get("last_sync_ref") for service in services.values() if isinstance(service, dict)]
    old_ref = next((ref for ref in old_refs if isinstance(ref, str) and ref), None)
    for service in services.values():
        if isinstance(service, dict):
            service["last_sync_ref"] = new_ref
            service["last_sync"] = now_iso
    if not dry_run:
        save_registry(registry, str(project_root))
        update_yaml_registry(project_root, new_ref, now_iso)
    return old_ref


def update_yaml_registry(project_root: Path, new_ref: str, new_sync_iso: str | None = None) -> None:
    for name in ("service-registry.yml", "service-registry.yaml"):
        path = project_root / name
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        text = re.sub(r"(last_sync_ref:\s*)[^\n]*", rf"\g<1>{new_ref}", text)
        if new_sync_iso is not None:
            text = re.sub(r"(last_sync:\s*)[^\n]*", rf"\g<1>{new_sync_iso}", text)
        atomic_write(path, text)


def reconcile(options: ReconcileOptions) -> dict[str, Any]:
    project_root = Path(get_project_root())
    registry = load_registry(str(project_root))
    drifted = scan_drift(str(project_root), enrich_with_gitnexus=False, use_gitnexus=False)
    selected = drifted[: options.max_files] if options.max_files is not None else drifted
    truncated = len(selected) < len(drifted)
    result: dict[str, Any] = {
        # If --max-files truncated the drift list, the un-processed entries are
        # deferred — call the run partial so bump_last_sync_ref is skipped and
        # those services stay visible to the next scan_drift. Without this, all
        # services' last_sync gets stamped to now and the deferred drift is
        # silently masked (xtrm-vlxug).
        "status": "partial" if truncated else "success",
        "drift_count": len(drifted),
        "reconciled_count": 0,
        "failed": [],
        "cost_tokens": 0,
        "last_sync_ref_old": None,
        "last_sync_ref_new": current_head(project_root),
    }
    if truncated:
        for skipped in drifted[len(selected):]:
            result["failed"].append({
                "file_path": skipped.get("file_path"),
                "error": f"deferred: --max-files={options.max_files} truncated this entry",
            })
    for drift in selected:
        try:
            skill_path_value = find_skill_path(drift, registry, project_root)
            if not skill_path_value:
                raise ValueError(f"missing skill_path for {drift.get('service_id', 'unknown')}")
            skill_path = project_root / skill_path_value
            source_path = project_root / str(drift["file_path"])
            prompt = build_prompt(drift, skill_path.read_text(encoding="utf-8"), source_path.read_text(encoding="utf-8", errors="ignore"))
            projected_tokens = result["cost_tokens"] + estimate_tokens(prompt)
            if options.cost_limit_tokens is not None and projected_tokens > options.cost_limit_tokens:
                result["status"] = "partial"
                result["failed"].append({"file_path": drift.get("file_path"), "error": "cost limit exceeded before request"})
                break
            llm_result = call_nano_gpt(prompt, options.api_key)
            result["cost_tokens"] += llm_result.tokens or estimate_tokens(prompt)
            if options.cost_limit_tokens is not None and result["cost_tokens"] > options.cost_limit_tokens:
                result["status"] = "partial"
                result["failed"].append({"file_path": drift.get("file_path"), "error": "cost limit exceeded after request"})
                break
            if not options.dry_run:
                atomic_write(skill_path, llm_result.content)
            result["reconciled_count"] += 1
        except Exception as exc:
            result["status"] = "partial"
            result["failed"].append({"file_path": drift.get("file_path"), "error": redact_exception(exc, options.api_key)})
    if result["reconciled_count"] and not (options.dry_run or result["status"] == "partial"):
        result["last_sync_ref_old"] = bump_last_sync_ref(project_root, result["last_sync_ref_new"], options.dry_run)
    return result


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    api_key = os.environ.get("NANO_GPT_API_KEY")
    if not api_key:
        print("NANO_GPT_API_KEY is required for reconcile.py", file=sys.stderr)
        return 2
    try:
        validate_nano_gpt_url(get_nano_gpt_url())
        options = ReconcileOptions(args.dry_run, args.max_files, api_key, parse_cost_limit(os.environ.get("XTRM_AUTO_RECONCILE_COST_LIMIT_TOKENS")))
        output = reconcile(options)
    except Exception as exc:
        output = {"status": "failed", "drift_count": 0, "reconciled_count": 0, "failed": [{"file_path": None, "error": redact_exception(exc, api_key)}], "cost_tokens": 0, "last_sync_ref_old": None, "last_sync_ref_new": ""}
    print(json.dumps(output, sort_keys=True) if args.json else json.dumps(output, indent=2, sort_keys=True))
    # Exit 0 when the program achieved useful work (full or partial reconcile).
    # status field in the JSON carries the quality signal. Workflow gates on
    # status + reconciled_count to decide auto-PR; downstream shell scripts
    # that only check $? still get a clean signal for "anything reconciled".
    if output["status"] == "success":
        return 0
    if output["status"] == "partial" and int(output.get("reconciled_count", 0) or 0) > 0:
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
