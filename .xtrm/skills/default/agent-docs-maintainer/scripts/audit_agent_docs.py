#!/usr/bin/env python3
"""Audit CLAUDE.md / AGENTS.md for agent-docs-maintainer."""

from __future__ import annotations

import argparse
import json
import re
import tomllib
from pathlib import Path
from typing import Any

DOC_NAMES = ("CLAUDE.md", "AGENTS.md")
MANAGED_MARKERS = {
    "xtrm": ("<!-- xtrm:start -->", "<!-- xtrm:end -->"),
    "gitnexus": ("<!-- gitnexus:start -->", "<!-- gitnexus:end -->"),
    "beads": ("<!-- BEGIN BEADS INTEGRATION -->", None),
}
COMMAND_RE = re.compile(
    r"(^|\s)(bd|bv|xt|sp|specialists|gitnexus|npm|pnpm|uv|pytest|ruff|mypy|git|gh|docker|docker\s+compose|alembic|make)\s+[\w./:-]",
    re.MULTILINE,
)
DEFAULT_STALE_TERMS = (
    "Jaggers Agent Tools",
    "jaggers-agent-tools",
    "YFinance Analytics",
    "YFinance",
    "Clavix",
)
BLOAT_HEADINGS = (
    "Command Reference",
    "Quick Reference",
    "Common Query Patterns",
    "Docker Operations",
    "Alembic Migrations",
    "Testing",
    "Best Practices",
)
OPERATIONAL_COMMAND_HEADINGS = (
    "Essential Commands",
    "Operational Entry Points",
    "Makefile Entry Points",
    "Validation",
    "Session Start",
    "Quick Reference",
)
IDENTITY_HEADINGS = (
    "Project Summary",
    "Repo Identity",
    "Repository Identity",
    "Stack Overview",
    "Platform Overview",
)


def count_code_fences(lines: list[str]) -> int:
    return sum(1 for line in lines if line.strip().startswith("```")) // 2


def heading_ranges(lines: list[str]) -> list[dict[str, Any]]:
    headings = [(index + 1, line.strip()) for index, line in enumerate(lines) if line.startswith("#")]
    ranges = []
    for idx, (line_no, title) in enumerate(headings):
        next_line = headings[idx + 1][0] if idx + 1 < len(headings) else len(lines) + 1
        ranges.append({"line": line_no, "end_line": next_line - 1, "title": title})
    return ranges


def managed_blocks(text: str) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name, (start, end) in MANAGED_MARKERS.items():
        starts = [match.start() for match in re.finditer(re.escape(start), text)]
        ends = [match.start() for match in re.finditer(re.escape(end), text)] if end else []
        result[name] = {
            "start_count": len(starts),
            "end_count": len(ends) if end else None,
            "duplicated": len(starts) > 1 or (end is not None and len(ends) > 1),
        }
    return result


def marker_line_indexes(lines: list[str]) -> dict[str, tuple[int, int | None] | None]:
    ranges: dict[str, tuple[int, int | None] | None] = {}
    for name, (start, end) in MANAGED_MARKERS.items():
        start_idx = next((idx for idx, line in enumerate(lines) if start in line), None)
        if start_idx is None:
            ranges[name] = None
            continue
        end_idx = None
        if end:
            end_idx = next((idx for idx, line in enumerate(lines[start_idx:], start_idx) if end in line), None)
        ranges[name] = (start_idx, end_idx)
    return ranges


def managed_line_count(lines: list[str]) -> int:
    total = 0
    for block_range in marker_line_indexes(lines).values():
        if not block_range:
            continue
        start_idx, end_idx = block_range
        if end_idx is None:
            continue
        total += end_idx - start_idx + 1
    return total


def first_managed_line(lines: list[str]) -> int | None:
    starts = [start for start, _end in MANAGED_MARKERS.values()]
    for idx, line in enumerate(lines):
        if any(marker in line for marker in starts):
            return idx
    return None


def leading_identity_slice(lines: list[str]) -> list[str]:
    first_marker = first_managed_line(lines)
    stop = first_marker if first_marker is not None else min(len(lines), 40)
    return lines[:stop]


def detect_repo_identity(lines: list[str]) -> dict[str, Any]:
    leading = leading_identity_slice(lines)
    first_nonblank = next((line.strip() for line in lines if line.strip()), "")
    starts_with_managed_block = any(first_nonblank.startswith(marker) for marker, _end in MANAGED_MARKERS.values())
    heading_lines = [line.strip() for line in leading if re.match(r"^#{1,2}\s+", line)]
    identity_named_heading = any(
        any(name.lower() in heading.lower() for name in IDENTITY_HEADINGS)
        for heading in heading_lines
    )
    prose_lines = [
        line.strip()
        for line in leading
        if line.strip()
        and not line.lstrip().startswith(("#", "-", "|", "<!--", "```"))
        and len(line.strip()) >= 40
    ]
    leading_line_count = len([line for line in leading if line.strip()])

    if starts_with_managed_block or not heading_lines:
        status = "missing"
        recommendation = "add a Repo Identity / Stack Overview section before managed xtrm blocks"
    elif not prose_lines:
        status = "thin"
        recommendation = "add 2-5 lines of plain-language repo identity prose before managed blocks"
    else:
        status = "ok"
        recommendation = "ok"

    return {
        "status": status,
        "starts_with_managed_block": starts_with_managed_block,
        "leading_line_count": leading_line_count,
        "heading_count_before_managed_block": len(heading_lines),
        "identity_named_heading": identity_named_heading,
        "substantive_prose_lines": len(prose_lines),
        "recommendation": recommendation,
    }


def load_agent_docs_config(repo: Path) -> dict[str, Any]:
    config_path = repo / ".xtrm" / "agent-docs.toml"
    if not config_path.exists():
        return {"stale_terms": []}
    try:
        data = tomllib.loads(config_path.read_text())
    except Exception as error:  # pragma: no cover - surfaced in metrics, not fatal
        return {"stale_terms": [], "config_error": str(error)}

    audit = data.get("audit", {}) if isinstance(data.get("audit", {}), dict) else {}
    stale_terms = data.get("stale_terms", audit.get("stale_terms", []))
    if not isinstance(stale_terms, list):
        stale_terms = []
    return {
        "stale_terms": [str(term) for term in stale_terms],
        "config_path": str(config_path),
    }


def detect_service_context(repo: Path) -> dict[str, Any]:
    registry = repo / ".claude" / "service-registry.json"
    skill_dirs = [repo / ".xtrm" / "skills" / "default", repo / ".claude" / "skills"]
    service_skills = []
    for skill_dir in skill_dirs:
        if not skill_dir.exists():
            continue
        service_skills.extend(
            child.name
            for child in skill_dir.iterdir()
            if child.is_dir() and "service" in child.name
        )
    return {
        "service_registry": registry.exists(),
        "service_skill_names": sorted(set(service_skills)),
    }


def command_count(text: str) -> int:
    return len(COMMAND_RE.findall(text))


def section_command_details(lines: list[str]) -> dict[str, Any]:
    headings = heading_ranges(lines)
    operational_refs = 0
    manual_refs = 0
    bloat_headings = []

    for heading in headings:
        title = heading["title"].lstrip("#").strip()
        body = "\n".join(lines[heading["line"] - 1 : heading["end_line"]])
        refs = command_count(body)
        section_lines = heading["end_line"] - heading["line"] + 1
        is_operational = any(name.lower() in title.lower() for name in OPERATIONAL_COMMAND_HEADINGS)
        is_bloat_prone = any(name.lower() in title.lower() for name in BLOAT_HEADINGS)

        if is_operational and refs <= 15 and section_lines <= 80:
            operational_refs += refs
        else:
            manual_refs += refs

        if is_bloat_prone:
            threshold = 30 if "quick reference" in title.lower() else 20
            if refs > threshold or section_lines > 80:
                bloat_headings.append({"title": heading["title"], "line": heading["line"], "lines": section_lines, "command_refs": refs})

    if not headings:
        manual_refs = command_count("\n".join(lines))

    return {
        "operational_command_refs": operational_refs,
        "manual_command_refs": manual_refs,
        "bloat_headings": bloat_headings,
    }


def split_size_budget(lines: list[str]) -> dict[str, Any]:
    identity_lines = len(leading_identity_slice(lines))
    managed_lines = managed_line_count(lines)
    routing_lines = max(len(lines) - identity_lines, 0)
    boilerplate_lines = managed_lines
    return {
        "total_lines": len(lines),
        "repo_identity_lines": identity_lines,
        "managed_lines": managed_lines,
        "routing_lines": routing_lines,
        "boilerplate_lines": boilerplate_lines,
    }


def recommend(metrics: dict[str, Any]) -> list[str]:
    recommendations = []
    size = metrics["size_budget"]
    identity = metrics["repo_identity"]
    command_details = metrics["command_details"]

    if identity["status"] != "ok":
        recommendations.append(identity["recommendation"])

    if size["routing_lines"] > 500:
        recommendations.append("rewrite routing/managed content: above 500-line soft maximum excluding repo identity overview")
    elif size["routing_lines"] > 300:
        recommendations.append("trim routing/managed content: above preferred 300-line target excluding repo identity overview")
    elif metrics["lines"] > 500 and size["repo_identity_lines"] >= 80:
        recommendations.append("review total length, but preserve substantive repo-identity prose if current and useful")

    if command_details["manual_command_refs"] > 60:
        recommendations.append("replace CLI manual dumps with --help and skill pointers")
    elif command_details["manual_command_refs"] > 20:
        recommendations.append("trim command references outside essential operational-entry sections")

    if metrics["code_fences"] > 20:
        recommendations.append("move code examples/runbooks out of always-loaded agent doc")
    if any(block["duplicated"] for block in metrics["managed_blocks"].values()):
        recommendations.append("deduplicate managed xtrm/GitNexus/beads blocks")
    if metrics["stale_terms"]:
        recommendations.append("remove or rename stale project terms")
    if command_details["bloat_headings"]:
        recommendations.append("collapse oversized bloat-prone sections into concise pointers")
    if not recommendations:
        recommendations.append("ok: no major bloat signals")
    return recommendations


def audit_doc(path: Path, repo: Path, config: dict[str, Any]) -> dict[str, Any]:
    text = path.read_text(errors="replace")
    lines = text.splitlines()
    stale_terms = tuple(dict.fromkeys([*DEFAULT_STALE_TERMS, *config.get("stale_terms", [])]))
    command_details = section_command_details(lines)
    metrics: dict[str, Any] = {
        "path": str(path),
        "exists": True,
        "lines": len(lines),
        "chars": len(text),
        "code_fences": count_code_fences(lines),
        "table_lines": sum(1 for line in lines if line.strip().startswith("|")),
        "command_refs": command_count(text),
        "command_details": command_details,
        "managed_blocks": managed_blocks(text),
        "stale_terms": [term for term in stale_terms if term.lower() in text.lower()],
        "top_headings": heading_ranges(lines)[:25],
        "size_budget": split_size_budget(lines),
        "repo_identity": detect_repo_identity(lines),
        "service_context": detect_service_context(repo),
        "config": {key: value for key, value in config.items() if key != "stale_terms"},
    }
    metrics["bloat_headings"] = command_details["bloat_headings"]
    metrics["recommendations"] = recommend(metrics)
    return metrics


def audit_repo(repo: Path) -> dict[str, Any]:
    repo = repo.expanduser().resolve()
    config = load_agent_docs_config(repo)
    docs: dict[str, Any] = {}
    for name in DOC_NAMES:
        path = repo / name
        if path.exists():
            docs[name] = audit_doc(path, repo, config)
        else:
            docs[name] = {"path": str(path), "exists": False, "recommendations": ["missing"]}
    return {"repo": str(repo), "docs": docs, "config": {key: value for key, value in config.items() if key != "stale_terms"}}


def render_markdown(results: list[dict[str, Any]]) -> str:
    chunks = ["# Agent docs audit", ""]
    for repo_result in results:
        chunks.append(f"## {repo_result['repo']}")
        for name, doc in repo_result["docs"].items():
            if not doc["exists"]:
                chunks.append(f"- **{name}**: missing")
                continue
            recs = "; ".join(doc["recommendations"])
            stale = ", ".join(doc["stale_terms"]) or "-"
            blocks = ", ".join(
                block_name for block_name, block in doc["managed_blocks"].items() if block["duplicated"]
            ) or "-"
            service = doc["service_context"]
            service_hint = "yes" if service["service_registry"] or service["service_skill_names"] else "no"
            size = doc["size_budget"]
            identity = doc["repo_identity"]
            commands = doc["command_details"]
            chunks.append(
                f"- **{name}**: {doc['lines']} lines "
                f"(identity={size['repo_identity_lines']}, routing={size['routing_lines']}, managed={size['managed_lines']}), "
                f"{doc['command_refs']} command refs "
                f"(operational={commands['operational_command_refs']}, manual={commands['manual_command_refs']}), "
                f"{doc['code_fences']} code fences, service_context={service_hint}"
            )
            chunks.append(f"  - repo identity: {identity['status']} — {identity['recommendation']}")
            chunks.append(f"  - recommendations: {recs}")
            chunks.append(f"  - duplicated managed blocks: {blocks}")
            chunks.append(f"  - stale terms: {stale}")
        chunks.append("")
    return "\n".join(chunks).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit CLAUDE.md / AGENTS.md for compactness and staleness.")
    parser.add_argument("repos", nargs="*", default=["."], help="Repository paths to audit")
    parser.add_argument("--format", choices=("json", "md"), default="json")
    args = parser.parse_args()

    results = [audit_repo(Path(repo)) for repo in args.repos]
    if args.format == "json":
        print(json.dumps(results, indent=2))
    else:
        print(render_markdown(results), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
