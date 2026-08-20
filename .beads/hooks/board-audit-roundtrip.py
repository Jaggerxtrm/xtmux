#!/usr/bin/env python3
"""Safe Beads work-package edit/reconcile/apply tool for board-audit.

A package exported by ``board-audit --export`` contains immutable source state
under ``issues.<id>.source``. ``prepare`` adds a separate ``desired_issues``
projection and ``new_comments`` plane for human/model edits.

Before compilation the tool performs a three-way reconciliation:

    base (export) + current (fresh bd export --all) + desired (edited artifact)

Overlapping changes fail closed. Disjoint concurrent changes survive. Existing
Beads lifecycle/claim/storage state is deliberately read-only in round-trip v1.
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import json
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
from typing import Any

PACKAGE_SCHEMA = "xtrm.board-audit.work-package.v1"
ROUNDTRIP_SCHEMA = "xtrm.board-audit.roundtrip.v1"
PLAN_SCHEMA = "xtrm.board-audit.apply-plan.v1"

PROTECTED_EXISTING_FIELDS = {
    "id",
    "created_at",
    "created",
    "created_by",
    "updated_at",
    "updated",
    "closed_at",
    "started_at",
}

# Fields that an edited package may change on an existing Beads record. This is
# intentionally narrower than the lossless export schema. Assignment, status,
# lease/heartbeat, scheduling, persistence, compaction, gates/events and other
# operational state must eventually use their guarded native commands instead
# of the migration/recovery import door.
EDITABLE_EXISTING_FIELDS = {
    "title",
    "description",
    "design",
    "acceptance_criteria",
    "notes",
    "spec_id",
    "priority",
    "issue_type",
    "estimated_minutes",
    "external_ref",
    "metadata",
    "labels",
    "dependencies",
    "deps",
    "relations",
}
NEW_ISSUE_FIELDS = set(EDITABLE_EXISTING_FIELDS)
AUX_FIELDS = {"labels", "dependencies", "deps", "relations", "comments"}
MISSING = object()


class RoundtripError(RuntimeError):
    pass


def utcnow() -> str:
    return (
        dt.datetime.now(dt.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def canonical_bytes(obj: Any) -> bytes:
    return (
        json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode()


def sha256_obj(obj: Any) -> str:
    return hashlib.sha256(canonical_bytes(obj)).hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RoundtripError(f"cannot read JSON {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise RoundtripError("work package must be a JSON object")
    return data


def write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def read_export_rows(path: Path) -> list[dict[str, Any]]:
    """Read canonical Beads JSONL, plus common list/object wrappers for tests."""
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return []

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = None

    if isinstance(parsed, list):
        return [r for r in parsed if isinstance(r, dict) and r.get("id")]
    if isinstance(parsed, dict):
        for key in ("issues", "beads", "records"):
            if isinstance(parsed.get(key), list):
                return [
                    r for r in parsed[key] if isinstance(r, dict) and r.get("id")
                ]
        if parsed.get("id"):
            return [parsed]

    rows: list[dict[str, Any]] = []
    for line_no, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise RoundtripError(f"invalid JSONL line {line_no}: {exc}") from exc
        if isinstance(row, dict) and row.get("_schema"):
            continue
        if isinstance(row, dict) and row.get("id"):
            rows.append(row)
    return rows


def source_issues(pkg: dict[str, Any]) -> dict[str, dict[str, Any]]:
    issues = pkg.get("issues")
    if not isinstance(issues, dict):
        raise RoundtripError("package issues must be an object")

    out: dict[str, dict[str, Any]] = {}
    for key, wrapper in issues.items():
        if not isinstance(wrapper, dict) or not isinstance(wrapper.get("source"), dict):
            raise RoundtripError(f"issues.{key}.source must be an object")
        row = wrapper["source"]
        rid = str(row.get("id") or key)
        if rid != str(key):
            raise RoundtripError(
                f"issues.{key}.source.id is {rid!r}; IDs must agree"
            )
        out[rid] = row
    return out


def selected_ids(pkg: dict[str, Any]) -> set[str]:
    return {
        str(key)
        for key, wrapper in (pkg.get("issues") or {}).items()
        if isinstance(wrapper, dict) and wrapper.get("selection_state") != "context-only"
    }


def prepare_package(pkg: dict[str, Any]) -> dict[str, Any]:
    if pkg.get("schema_version") != PACKAGE_SCHEMA:
        raise RoundtripError(
            f"unsupported package schema {pkg.get('schema_version')!r}"
        )

    base = source_issues(pkg)
    selected = selected_ids(pkg)
    out = copy.deepcopy(pkg)
    out.setdefault(
        "desired_issues",
        {rid: copy.deepcopy(base[rid]) for rid in sorted(selected)},
    )
    out.setdefault("new_comments", {})
    out.setdefault("roundtrip", {})
    out["roundtrip"].update(
        {
            "schema_version": ROUNDTRIP_SCHEMA,
            "prepared_at": out["roundtrip"].get("prepared_at") or utcnow(),
            "base_package_sha256": out.get("content_sha256") or sha256_obj(pkg),
            "base_record_sha256": {
                rid: sha256_obj(base[rid]) for rid in sorted(base)
            },
            "edit_contract": (
                "modify desired_issues and new_comments only; "
                "issues.*.source is immutable base state"
            ),
        }
    )
    return out


def desired_issues(pkg: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw = pkg.get("desired_issues")
    if not isinstance(raw, dict):
        raise RoundtripError(
            "package is not prepared: missing desired_issues; run prepare first"
        )

    out: dict[str, dict[str, Any]] = {}
    for key, row in raw.items():
        if not isinstance(row, dict):
            raise RoundtripError(f"desired_issues.{key} must be an object")
        rid = str(row.get("id") or key)
        if rid != str(key):
            raise RoundtripError(
                f"desired_issues.{key}.id is {rid!r}; IDs must agree"
            )
        row = copy.deepcopy(row)
        row["id"] = rid
        out[rid] = row
    return out


def proposed_comments(pkg: dict[str, Any]) -> dict[str, list[str]]:
    raw = pkg.get("new_comments", {})
    if not isinstance(raw, dict):
        raise RoundtripError("new_comments must be an object mapping issue IDs to text lists")

    out: dict[str, list[str]] = {}
    for key, values in raw.items():
        rid = str(key)
        if not isinstance(values, list):
            raise RoundtripError(f"new_comments.{rid} must be a list of strings")
        texts: list[str] = []
        for idx, text in enumerate(values):
            if not isinstance(text, str) or not text.strip():
                raise RoundtripError(
                    f"new_comments.{rid}[{idx}] must be a non-empty string"
                )
            texts.append(text)
        if texts:
            out[rid] = texts
    return out


def comment_text(comment: Any) -> str | None:
    if isinstance(comment, str):
        return comment
    if isinstance(comment, dict):
        for key in ("text", "body", "comment"):
            value = comment.get(key)
            if isinstance(value, str):
                return value
    return None


def validate_package(
    pkg: dict[str, Any], *, allow_context_edit: bool = False
) -> list[str]:
    if pkg.get("schema_version") != PACKAGE_SCHEMA:
        raise RoundtripError(
            f"unsupported package schema {pkg.get('schema_version')!r}"
        )

    base = source_issues(pkg)
    desired = desired_issues(pkg)
    selected = selected_ids(pkg)
    comments = proposed_comments(pkg)
    warnings: list[str] = []

    rt = pkg.get("roundtrip")
    if not isinstance(rt, dict) or rt.get("schema_version") != ROUNDTRIP_SCHEMA:
        raise RoundtripError("missing/unsupported roundtrip metadata; run prepare first")
    recorded = rt.get("base_record_sha256")
    if not isinstance(recorded, dict):
        raise RoundtripError("roundtrip.base_record_sha256 is missing")

    tampered = [
        rid for rid, row in base.items() if recorded.get(rid) != sha256_obj(row)
    ]
    if tampered:
        raise RoundtripError(
            "immutable base source records were modified: "
            + ", ".join(sorted(tampered))
        )

    missing = selected - desired.keys()
    if missing:
        raise RoundtripError(
            "desired_issues may not delete existing selected beads; "
            "close/supersede requires a future guarded lifecycle compiler: "
            + ", ".join(sorted(missing))
        )

    context = set(base) - selected
    edited_context = context & desired.keys()
    if edited_context and not allow_context_edit:
        raise RoundtripError(
            "context-only ancestors are read-only by default: "
            + ", ".join(sorted(edited_context))
        )

    for rid, row in desired.items():
        if rid not in base:
            if not str(row.get("title") or "").strip():
                raise RoundtripError(f"new bead {rid} requires title")
            unsupported = sorted(set(row) - NEW_ISSUE_FIELDS - {"id"})
            if unsupported:
                raise RoundtripError(
                    f"new bead {rid}: unsupported v1 fields: {', '.join(unsupported)}"
                )
            continue

        b = base[rid]
        for field in PROTECTED_EXISTING_FIELDS:
            if field == "id":
                continue
            if row.get(field, MISSING) != b.get(field, MISSING):
                raise RoundtripError(
                    f"{rid}: protected provenance field {field!r} was edited"
                )

        changed = {
            field
            for field in set(b) | set(row)
            if row.get(field, MISSING) != b.get(field, MISSING)
        }
        unsupported = sorted(
            changed - EDITABLE_EXISTING_FIELDS - PROTECTED_EXISTING_FIELDS
        )
        if unsupported:
            raise RoundtripError(
                f"{rid}: fields are preserved losslessly but not mutable through "
                f"round-trip v1: {', '.join(unsupported)}"
            )

    unknown_comment_targets = set(comments) - set(desired)
    if unknown_comment_targets:
        raise RoundtripError(
            "new_comments targets must be selected/new desired issues: "
            + ", ".join(sorted(unknown_comment_targets))
        )

    package_ids = set(base) | set(desired)
    for rid, row in desired.items():
        for rel in relation_map(rid, row):
            if rel[1] not in package_ids:
                warnings.append(
                    f"{rid}: relation target {rel[1]} is outside this package; "
                    "current-board validation will resolve it"
                )
    return warnings


def dep_target(dep: Any) -> str | None:
    if isinstance(dep, str):
        return dep
    if not isinstance(dep, dict):
        return None
    for key in (
        "depends_on_id",
        "depends_on_issue_id",
        "target_id",
        "target",
        "bead_id",
        "id",
    ):
        value = dep.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def dep_type(dep: Any, default: str = "blocks") -> str:
    if isinstance(dep, dict):
        return str(
            dep.get("type")
            or dep.get("dependency_type")
            or dep.get("relation_type")
            or default
        )
    return default


def relation_map(
    rid: str, row: dict[str, Any]
) -> dict[tuple[str, str, str], Any]:
    out: dict[tuple[str, str, str], Any] = {}
    for field in ("dependencies", "deps", "relations"):
        values = row.get(field)
        if not isinstance(values, list):
            continue
        for dep in values:
            target = dep_target(dep)
            if target:
                out[(rid, target, dep_type(dep))] = copy.deepcopy(dep)
    return out


def val(value: Any) -> Any:
    return "<missing>" if value is MISSING else value


def merge_metadata(
    base: Any,
    desired: Any,
    current: Any,
    rid: str,
    conflicts: list[dict[str, Any]],
) -> Any:
    if not all(isinstance(x, dict) for x in (base, desired, current)):
        if desired != base and current != base and desired != current:
            conflicts.append(
                {
                    "id": rid,
                    "field": "metadata",
                    "base": base,
                    "current": current,
                    "desired": desired,
                }
            )
        return copy.deepcopy(desired if desired != base else current)

    result = copy.deepcopy(current)
    for key in set(base) | set(desired) | set(current):
        b = base.get(key, MISSING)
        d = desired.get(key, MISSING)
        c = current.get(key, MISSING)
        user_changed = d != b
        current_changed = c != b
        if user_changed and current_changed and d != c:
            conflicts.append(
                {
                    "id": rid,
                    "field": f"metadata.{key}",
                    "base": val(b),
                    "current": val(c),
                    "desired": val(d),
                }
            )
            continue
        if user_changed:
            if d is MISSING:
                result.pop(key, None)
            else:
                result[key] = copy.deepcopy(d)
    return result


def merge_labels(base: Any, desired: Any, current: Any) -> tuple[list[str], list[str], list[str]]:
    b = {str(x) for x in (base if isinstance(base, list) else [])}
    d = {str(x) for x in (desired if isinstance(desired, list) else [])}
    c = {str(x) for x in (current if isinstance(current, list) else [])}
    added = d - b
    removed = b - d
    return sorted((c - removed) | added), sorted(added), sorted(removed)


def merge_dependencies(
    rid: str,
    base: dict[str, Any],
    desired: dict[str, Any],
    current: dict[str, Any],
) -> tuple[
    list[Any],
    set[tuple[str, str, str]],
    set[tuple[str, str, str]],
    set[tuple[str, str, str]],
]:
    bm = relation_map(rid, base)
    dm = relation_map(rid, desired)
    cm = relation_map(rid, current)
    b, d, c = set(bm), set(dm), set(cm)
    added = d - b
    removed = b - d
    result_keys = (c - removed) | added

    merged: list[Any] = []
    for key in sorted(result_keys):
        raw = dm.get(key) or cm.get(key) or bm.get(key)
        if isinstance(raw, dict):
            merged.append(copy.deepcopy(raw))
        else:
            merged.append(
                {
                    "issue_id": rid,
                    "depends_on_id": key[1],
                    "type": key[2],
                }
            )
    return merged, added, removed, result_keys


def merge_issue(
    base: dict[str, Any],
    desired: dict[str, Any],
    current: dict[str, Any],
    rid: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    conflicts: list[dict[str, Any]] = []
    result = copy.deepcopy(current)
    user_changed_fields: list[str] = []
    current_changed_fields: list[str] = []

    special = AUX_FIELDS | {"metadata"}
    for field in sorted(set(base) | set(desired) | set(current)):
        if field in special or field in PROTECTED_EXISTING_FIELDS:
            continue
        b = base.get(field, MISSING)
        d = desired.get(field, MISSING)
        c = current.get(field, MISSING)
        user_changed = d != b
        current_changed = c != b
        if user_changed:
            user_changed_fields.append(field)
        if current_changed:
            current_changed_fields.append(field)
        if user_changed and current_changed and d != c:
            conflicts.append(
                {
                    "id": rid,
                    "field": field,
                    "base": val(b),
                    "current": val(c),
                    "desired": val(d),
                }
            )
            continue
        if user_changed:
            if d is MISSING:
                result.pop(field, None)
            else:
                result[field] = copy.deepcopy(d)

    result["metadata"] = merge_metadata(
        base.get("metadata", {}),
        desired.get("metadata", {}),
        current.get("metadata", {}),
        rid,
        conflicts,
    )

    labels, label_add, label_remove = merge_labels(
        base.get("labels"), desired.get("labels"), current.get("labels")
    )
    if "labels" in base or "labels" in desired or "labels" in current:
        result["labels"] = labels

    dependencies, dep_add, dep_remove, dep_result = merge_dependencies(
        rid, base, desired, current
    )
    if any(
        key in base or key in desired or key in current
        for key in ("dependencies", "deps", "relations")
    ):
        result["dependencies"] = dependencies
        result.pop("deps", None)
        result.pop("relations", None)

    # Historical comments are never editor-controlled. The freshest local
    # comments ride through the import row unchanged; proposals use native
    # ``bd comments add`` after import so Beads owns author/timestamp provenance.
    if "comments" in current:
        result["comments"] = copy.deepcopy(current["comments"])

    result["id"] = rid
    for field in ("created_at", "created", "created_by"):
        if field in current:
            result[field] = copy.deepcopy(current[field])
        elif field in base:
            result[field] = copy.deepcopy(base[field])

    issue_changed = desired != base
    return result, {
        "id": rid,
        "new": False,
        "issue_changed": issue_changed,
        "changed": issue_changed,
        "user_changed_fields": user_changed_fields,
        "current_changed_fields": current_changed_fields,
        "label_add": label_add,
        "label_remove": label_remove,
        "dependency_add": [list(x) for x in sorted(dep_add)],
        "dependency_remove": [list(x) for x in sorted(dep_remove)],
        "dependency_result": [list(x) for x in sorted(dep_result)],
        "new_comment_count": 0,
        "conflicts": conflicts,
    }


def acquire_current_jsonl() -> tuple[Path, tempfile.TemporaryDirectory[str]]:
    if shutil.which("bd") is None:
        raise RoundtripError(
            "bd is not on PATH; pass --current-jsonl for offline reconciliation"
        )

    td = tempfile.TemporaryDirectory(prefix="board-audit-roundtrip-")
    path = Path(td.name) / "current.jsonl"
    proc = subprocess.run(
        ["bd", "export", "--all", "-o", str(path)],
        text=True,
        capture_output=True,
    )
    if proc.returncode != 0 or not path.exists():
        proc = subprocess.run(
            ["bd", "export", "--all"], text=True, capture_output=True
        )
        if proc.returncode != 0:
            td.cleanup()
            raise RoundtripError(
                f"bd export --all failed: {proc.stderr.strip() or proc.stdout.strip()}"
            )
        path.write_text(proc.stdout, encoding="utf-8")
    return path, td


def current_map(path: Path) -> dict[str, dict[str, Any]]:
    return {
        str(row["id"]): row
        for row in read_export_rows(path)
        if row.get("id") is not None
    }


def reconcile(
    pkg: dict[str, Any],
    current: dict[str, dict[str, Any]],
    *,
    allow_context_edit: bool = False,
) -> dict[str, Any]:
    warnings = validate_package(pkg, allow_context_edit=allow_context_edit)
    base = source_issues(pkg)
    desired = desired_issues(pkg)
    comments = proposed_comments(pkg)
    merged: dict[str, dict[str, Any]] = {}
    changes: list[dict[str, Any]] = []
    conflicts: list[dict[str, Any]] = []

    for rid in sorted(desired):
        d = desired[rid]
        if rid not in base:
            if rid in current:
                conflict = {
                    "id": rid,
                    "field": "<issue>",
                    "base": "missing",
                    "current": "present",
                    "desired": "new",
                }
                conflicts.append(conflict)
                changes.append(
                    {
                        "id": rid,
                        "new": True,
                        "issue_changed": True,
                        "changed": True,
                        "new_comment_count": len(comments.get(rid, [])),
                        "conflicts": [conflict],
                    }
                )
                continue

            row = copy.deepcopy(d)
            row["id"] = rid
            # Beads JSON unmarshal defaults status/type but omitted integer
            # priority becomes P0. Set explicit conservative creation defaults.
            row.setdefault("status", "open")
            row.setdefault("priority", 2)
            row.setdefault("issue_type", "task")
            merged[rid] = row
            changes.append(
                {
                    "id": rid,
                    "new": True,
                    "issue_changed": True,
                    "changed": True,
                    "user_changed_fields": sorted(row),
                    "current_changed_fields": [],
                    "label_add": sorted(str(x) for x in row.get("labels", [])),
                    "label_remove": [],
                    "dependency_add": [
                        list(x) for x in sorted(relation_map(rid, row))
                    ],
                    "dependency_remove": [],
                    "dependency_result": [
                        list(x) for x in sorted(relation_map(rid, row))
                    ],
                    "new_comment_count": len(comments.get(rid, [])),
                    "conflicts": [],
                }
            )
            continue

        if rid not in current:
            conflict = {
                "id": rid,
                "field": "<issue>",
                "base": "present",
                "current": "missing",
                "desired": "present",
            }
            conflicts.append(conflict)
            changes.append(
                {
                    "id": rid,
                    "new": False,
                    "issue_changed": d != base[rid],
                    "changed": d != base[rid] or bool(comments.get(rid)),
                    "new_comment_count": len(comments.get(rid, [])),
                    "conflicts": [conflict],
                }
            )
            continue

        row, change = merge_issue(base[rid], d, current[rid], rid)
        change["new_comment_count"] = len(comments.get(rid, []))
        change["changed"] = bool(change["issue_changed"] or comments.get(rid))
        merged[rid] = row
        changes.append(change)
        conflicts.extend(change["conflicts"])

    known = set(current) | set(desired)
    for rid, row in desired.items():
        for rel in relation_map(rid, row):
            if rel[1] not in known:
                conflicts.append(
                    {
                        "id": rid,
                        "field": "dependencies",
                        "base": None,
                        "current": "target missing",
                        "desired": list(rel),
                    }
                )

    return {
        "schema_version": "xtrm.board-audit.reconciliation.v1",
        "generated_at": utcnow(),
        "root_id": pkg.get("root_id"),
        "warnings": sorted(set(warnings)),
        "changes": changes,
        "conflicts": conflicts,
        "merged_issues": merged,
        "new_comments": comments,
        "safe": not conflicts,
    }


def ensure_updated_at(row: dict[str, Any], *, is_new: bool) -> dict[str, Any]:
    out = copy.deepcopy(row)
    if is_new:
        return out
    stamp = utcnow()
    if "updated_at" in out or "updated" not in out:
        out["updated_at"] = stamp
        out.pop("updated", None)
    else:
        out["updated"] = stamp
    return out


def cycle_signature(cycle: Any) -> tuple[str, ...] | str:
    if isinstance(cycle, dict) and isinstance(cycle.get("members"), list):
        ids = [
            str(member["id"])
            for member in cycle["members"]
            if isinstance(member, dict) and member.get("id") is not None
        ]
        if ids:
            return tuple(ids)
    return "raw:" + sha256_obj(cycle)


def introduced_cycles(before: list[Any], after: list[Any]) -> list[Any]:
    known = {cycle_signature(cycle) for cycle in before}
    return [cycle for cycle in after if cycle_signature(cycle) not in known]


def post_commands(rec: dict[str, Any]) -> list[list[str]]:
    commands: list[list[str]] = []
    for change in rec["changes"]:
        if change.get("new") or not change.get("issue_changed"):
            continue
        rid = change["id"]
        for label in change.get("label_remove", []):
            commands.append(["bd", "update", rid, "--remove-label", label])

        removed = {tuple(x) for x in change.get("dependency_remove", [])}
        result = {tuple(x) for x in change.get("dependency_result", [])}
        pairs = {(source, target) for source, target, _ in removed}
        for source, target in sorted(pairs):
            # ``bd dep remove`` removes the source/target pair irrespective of
            # relation type. Re-add every type that the reconciled graph keeps.
            commands.append(["bd", "dep", "remove", source, target])
            for s, t, typ in sorted(
                edge
                for edge in result
                if edge[0] == source and edge[1] == target
            ):
                commands.append(["bd", "dep", "add", s, t, "--type", typ])

    for rid in sorted(rec.get("new_comments", {})):
        for text in rec["new_comments"][rid]:
            commands.append(["bd", "comments", "add", rid, text])
    return commands


def compile_plan(
    pkg_path: Path,
    pkg: dict[str, Any],
    current_path: Path,
    out_dir: Path,
    *,
    allow_context_edit: bool = False,
) -> tuple[dict[str, Any], dict[str, Any]]:
    rec = reconcile(
        pkg, current_map(current_path), allow_context_edit=allow_context_edit
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    if not rec["safe"]:
        write_json(out_dir / "changes.json", rec)
        raise RoundtripError(
            f"three-way reconciliation found {len(rec['conflicts'])} conflict(s); "
            f"see {out_dir / 'changes.json'}"
        )

    base = source_issues(pkg)
    changed_ids = [change["id"] for change in rec["changes"] if change["changed"]]
    import_ids = [
        change["id"]
        for change in rec["changes"]
        if change.get("new") or change.get("issue_changed")
    ]
    records = [
        ensure_updated_at(rec["merged_issues"][rid], is_new=rid not in base)
        for rid in import_ids
    ]

    import_path = out_dir / "beads-import.jsonl"
    with import_path.open("w", encoding="utf-8") as handle:
        for row in records:
            handle.write(
                json.dumps(
                    row,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
                + "\n"
            )

    commands = post_commands(rec)
    plan = {
        "schema_version": PLAN_SCHEMA,
        "generated_at": utcnow(),
        "package": str(pkg_path),
        "base_package_sha256": (pkg.get("roundtrip") or {}).get(
            "base_package_sha256"
        ),
        "current_snapshot_sha256": hashlib.sha256(
            current_path.read_bytes()
        ).hexdigest(),
        "import_file": "beads-import.jsonl",
        "changed_ids": changed_ids,
        "import_ids": import_ids,
        "post_import_commands": commands,
        "conflict_count": 0,
        "verified_against_current": True,
    }
    write_json(out_dir / "changes.json", rec)
    write_json(out_dir / "apply-plan.json", plan)

    apply_sh = out_dir / "apply.sh"
    lines = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'HERE="$(cd "$(dirname "$0")" && pwd)"',
        'CYCLES_BEFORE="$(mktemp)"',
        'CYCLES_AFTER="$(mktemp)"',
        'trap \'rm -f "$CYCLES_BEFORE" "$CYCLES_AFTER"\' EXIT',
        'bd dep cycles --json > "$CYCLES_BEFORE"',
        'if [ -s "$HERE/beads-import.jsonl" ]; then',
        '  echo "== Beads import dry-run =="',
        '  bd import "$HERE/beads-import.jsonl" --dry-run --json',
        "else",
        '  echo "== No issue-row import required =="',
        "fi",
        'if [ "${1:-}" != "--execute" ]; then',
        '  echo "dry-run only; pass --execute to mutate" >&2',
        "  exit 0",
        "fi",
        'if [ -s "$HERE/beads-import.jsonl" ]; then',
        '  bd import "$HERE/beads-import.jsonl" --json',
        "fi",
    ]
    lines.extend(shlex.join(command) for command in commands)
    lines.extend(
        [
            'bd dep cycles --json > "$CYCLES_AFTER"',
            'python3 - "$CYCLES_BEFORE" "$CYCLES_AFTER" <<\'PY\'',
            "import json, sys",
            'before = json.load(open(sys.argv[1], encoding="utf-8"))',
            'after = json.load(open(sys.argv[2], encoding="utf-8"))',
            "def sig(c):",
            '    members = c.get("members", []) if isinstance(c, dict) else []',
            '    ids = tuple(str(m.get("id")) for m in members if isinstance(m, dict) and m.get("id") is not None)',
            '    return ids or json.dumps(c, sort_keys=True, separators=(",", ":"))',
            "known = {sig(c) for c in before}",
            "introduced = [c for c in after if sig(c) not in known]",
            "if introduced:",
            '    print(json.dumps({"error":"new dependency cycles introduced","cycles":introduced}, indent=2), file=sys.stderr)',
            "    raise SystemExit(4)",
            "PY",
            'echo "apply complete; run board-audit-roundtrip verify on the package"',
        ]
    )
    apply_sh.write_text("\n".join(lines) + "\n", encoding="utf-8")
    apply_sh.chmod(0o755)
    return rec, plan


def intent_fields(
    base: dict[str, Any] | None, desired: dict[str, Any]
) -> set[str]:
    if base is None:
        return set(desired)
    return {
        key
        for key in set(base) | set(desired)
        if base.get(key, MISSING) != desired.get(key, MISSING)
    } - PROTECTED_EXISTING_FIELDS


def verify_metadata_delta(
    base: Any, desired: Any, actual: Any, rid: str
) -> list[dict[str, Any]]:
    if not all(isinstance(x, dict) for x in (base, desired, actual)):
        if actual != desired:
            return [
                {
                    "id": rid,
                    "field": "metadata",
                    "expected": desired,
                    "actual": actual,
                }
            ]
        return []

    failures: list[dict[str, Any]] = []
    for key in sorted(set(base) | set(desired)):
        b = base.get(key, MISSING)
        d = desired.get(key, MISSING)
        a = actual.get(key, MISSING)
        if d == b:
            continue
        if a != d:
            failures.append(
                {
                    "id": rid,
                    "field": f"metadata.{key}",
                    "expected": val(d),
                    "actual": val(a),
                }
            )
    return failures


def verify_intent(
    pkg: dict[str, Any], actual: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    base = source_issues(pkg)
    desired = desired_issues(pkg)
    comments = proposed_comments(pkg)
    failures: list[dict[str, Any]] = []

    for rid, d in desired.items():
        a = actual.get(rid)
        if a is None:
            failures.append(
                {
                    "id": rid,
                    "field": "<issue>",
                    "expected": "present",
                    "actual": "missing",
                }
            )
            continue

        b = base.get(rid)
        if b is None:
            # Compiler-owned defaults for new rows are part of resulting state,
            # but only editor-specified fields are strict verification targets.
            fields = set(d)
        else:
            fields = intent_fields(b, d)

        for field in sorted(fields):
            if field in {"dependencies", "deps", "relations"}:
                desired_set = set(relation_map(rid, d))
                actual_set = set(relation_map(rid, a))
                base_set = set(relation_map(rid, b or {}))
                for rel in desired_set - base_set:
                    if rel not in actual_set:
                        failures.append(
                            {
                                "id": rid,
                                "field": "dependencies",
                                "expected": list(rel),
                                "actual": "missing",
                            }
                        )
                for rel in base_set - desired_set:
                    if rel in actual_set:
                        failures.append(
                            {
                                "id": rid,
                                "field": "dependencies",
                                "expected": f"removed {list(rel)}",
                                "actual": "present",
                            }
                        )
            elif field == "labels":
                base_set = set((b or {}).get("labels") or [])
                desired_set = set(d.get("labels") or [])
                actual_set = set(a.get("labels") or [])
                if not (desired_set - base_set) <= actual_set or (
                    base_set - desired_set
                ) & actual_set:
                    failures.append(
                        {
                            "id": rid,
                            "field": "labels",
                            "expected_delta": {
                                "add": sorted(desired_set - base_set),
                                "remove": sorted(base_set - desired_set),
                            },
                            "actual": sorted(actual_set),
                        }
                    )
            elif field == "metadata":
                failures.extend(
                    verify_metadata_delta(
                        (b or {}).get("metadata", {}),
                        d.get("metadata", {}),
                        a.get("metadata", {}),
                        rid,
                    )
                )
            elif a.get(field, MISSING) != d.get(field, MISSING):
                failures.append(
                    {
                        "id": rid,
                        "field": field,
                        "expected": val(d.get(field, MISSING)),
                        "actual": val(a.get(field, MISSING)),
                    }
                )

    # New comments are a separate append intent. Existing comment records are
    # immutable source history and never compared as editor-controlled objects.
    for rid, texts in comments.items():
        actual_row = actual.get(rid)
        if actual_row is None:
            continue
        actual_texts = [
            text
            for comment in (actual_row.get("comments") or [])
            if (text := comment_text(comment)) is not None
        ]
        base_texts = [
            text
            for comment in ((base.get(rid) or {}).get("comments") or [])
            if (text := comment_text(comment)) is not None
        ]
        for text in sorted(set(texts)):
            required = base_texts.count(text) + texts.count(text)
            observed = actual_texts.count(text)
            if observed < required:
                failures.append(
                    {
                        "id": rid,
                        "field": "new_comments",
                        "expected_text": text,
                        "expected_min_count": required,
                        "actual_count": observed,
                    }
                )
    return failures


def resolve_current_path(
    arg: str | None,
) -> tuple[Path, tempfile.TemporaryDirectory[str] | None]:
    if arg:
        return Path(arg), None
    return acquire_current_jsonl()


def cmd_prepare(args: argparse.Namespace) -> int:
    src = Path(args.package)
    pkg = prepare_package(load_json(src))
    out = Path(args.output) if args.output else src.with_name(src.stem + ".editable.json")
    write_json(out, pkg)
    print(out)
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    pkg = load_json(Path(args.package))
    warnings = validate_package(pkg, allow_context_edit=args.allow_context_edit)
    result: dict[str, Any] = {"valid": True, "warnings": warnings}
    temp = None
    if args.current_jsonl is not None or not args.offline:
        current_path, temp = resolve_current_path(args.current_jsonl)
        rec = reconcile(
            pkg,
            current_map(current_path),
            allow_context_edit=args.allow_context_edit,
        )
        result["reconciliation"] = {
            key: value for key, value in rec.items() if key != "merged_issues"
        }
        result["valid"] = rec["safe"]
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    if temp:
        temp.cleanup()
    return 0 if result["valid"] else 3


def cmd_diff(args: argparse.Namespace) -> int:
    pkg = load_json(Path(args.package))
    current_path, temp = resolve_current_path(args.current_jsonl)
    rec = reconcile(
        pkg,
        current_map(current_path),
        allow_context_edit=args.allow_context_edit,
    )
    print(
        json.dumps(
            {key: value for key, value in rec.items() if key != "merged_issues"},
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
    )
    if temp:
        temp.cleanup()
    return 0 if rec["safe"] else 3


def cmd_compile(args: argparse.Namespace) -> int:
    pkg_path = Path(args.package)
    pkg = load_json(pkg_path)
    current_path, temp = resolve_current_path(args.current_jsonl)
    out_dir = (
        Path(args.output_dir)
        if args.output_dir
        else pkg_path.with_name(pkg_path.stem + ".roundtrip")
    )
    rec, plan = compile_plan(
        pkg_path,
        pkg,
        current_path,
        out_dir,
        allow_context_edit=args.allow_context_edit,
    )
    print(
        json.dumps(
            {
                "output_dir": str(out_dir),
                "changed_ids": plan["changed_ids"],
                "import_ids": plan["import_ids"],
                "post_import_commands": len(plan["post_import_commands"]),
                "safe": rec["safe"],
            },
            indent=2,
        )
    )
    if temp:
        temp.cleanup()
    return 0


def run_checked(command: list[str]) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(command, text=True, capture_output=True)
    if proc.returncode != 0:
        raise RoundtripError(
            f"command failed ({proc.returncode}): {shlex.join(command)}\n"
            f"{proc.stderr.strip() or proc.stdout.strip()}"
        )
    return proc


def dependency_cycles() -> list[Any]:
    proc = run_checked(["bd", "dep", "cycles", "--json"])
    try:
        data = json.loads(proc.stdout or "[]")
    except json.JSONDecodeError as exc:
        raise RoundtripError(
            f"bd dep cycles --json returned invalid JSON: {exc}"
        ) from exc
    if not isinstance(data, list):
        raise RoundtripError("bd dep cycles --json returned a non-list payload")
    return data


def cmd_apply(args: argparse.Namespace) -> int:
    if shutil.which("bd") is None:
        raise RoundtripError("bd is required for apply")

    pkg_path = Path(args.package)
    pkg = load_json(pkg_path)
    with tempfile.TemporaryDirectory(prefix="board-audit-apply-") as temp_dir:
        current_path, current_temp = resolve_current_path(args.current_jsonl)
        out_dir = Path(temp_dir) / "compiled"
        _, plan = compile_plan(
            pkg_path,
            pkg,
            current_path,
            out_dir,
            allow_context_edit=args.allow_context_edit,
        )
        if current_temp:
            current_temp.cleanup()

        import_path = out_dir / plan["import_file"]
        if import_path.stat().st_size:
            dry = run_checked(
                ["bd", "import", str(import_path), "--dry-run", "--json"]
            )
            print(dry.stdout.strip())
        else:
            print('{"dry_run":true,"issue_rows":0}')

        if not args.execute:
            print("dry-run only; re-run with --execute to mutate", file=sys.stderr)
            return 0

        before_cycles = dependency_cycles()
        if import_path.stat().st_size:
            run_checked(["bd", "import", str(import_path), "--json"])
        for command in plan["post_import_commands"]:
            run_checked(list(command))
        after_cycles = dependency_cycles()
        new_cycles = introduced_cycles(before_cycles, after_cycles)
        if new_cycles:
            print(
                json.dumps(
                    {
                        "verified": False,
                        "error": "new dependency cycles introduced",
                        "cycles": new_cycles,
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                file=sys.stderr,
            )
            return 4

        post_path, post_temp = acquire_current_jsonl()
        failures = verify_intent(pkg, current_map(post_path))
        post_temp.cleanup()
        if failures:
            print(
                json.dumps(
                    {"verified": False, "failures": failures},
                    ensure_ascii=False,
                    indent=2,
                ),
                file=sys.stderr,
            )
            return 4

        print(json.dumps({"verified": True, "changed_ids": plan["changed_ids"]}, indent=2))
        return 0


def cmd_verify(args: argparse.Namespace) -> int:
    pkg = load_json(Path(args.package))
    current_path, temp = resolve_current_path(args.current_jsonl)
    failures = verify_intent(pkg, current_map(current_path))
    if temp:
        temp.cleanup()
    print(
        json.dumps(
            {"verified": not failures, "failures": failures},
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
    )
    return 0 if not failures else 4


def add_current_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--current-jsonl",
        help="use this bd export --all snapshot instead of acquiring local Beads",
    )
    parser.add_argument(
        "--allow-context-edit",
        action="store_true",
        help="allow edits to context-only ancestor records",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="board-audit-roundtrip",
        description="Safely reconcile edited board-audit work packages back into Beads",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    command = sub.add_parser(
        "prepare", help="add editable desired state to an exported work package"
    )
    command.add_argument("package")
    command.add_argument("-o", "--output")
    command.set_defaults(func=cmd_prepare)

    command = sub.add_parser(
        "validate", help="validate package and optionally reconcile current Beads"
    )
    command.add_argument("package")
    command.add_argument(
        "--offline",
        action="store_true",
        help="edit-contract validation only; do not acquire current board",
    )
    add_current_args(command)
    command.set_defaults(func=cmd_validate)

    command = sub.add_parser(
        "diff", help="show base/current/desired three-way reconciliation"
    )
    command.add_argument("package")
    add_current_args(command)
    command.set_defaults(func=cmd_diff)

    for name in ("compile-import", "compile-apply"):
        command = sub.add_parser(
            name,
            help="compile native Beads JSONL plus explicit post-import mutations",
        )
        command.add_argument("package")
        command.add_argument("-o", "--output-dir")
        add_current_args(command)
        command.set_defaults(func=cmd_compile)

    command = sub.add_parser(
        "apply", help="dry-run, optionally execute, then verify an edited package"
    )
    command.add_argument("package")
    command.add_argument(
        "--execute",
        action="store_true",
        help="perform mutations; without this flag apply is dry-run only",
    )
    add_current_args(command)
    command.set_defaults(func=cmd_apply)

    command = sub.add_parser(
        "verify", help="verify local Beads satisfies the package's intended delta"
    )
    command.add_argument("package")
    add_current_args(command)
    command.set_defaults(func=cmd_verify)
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
        return int(args.func(args))
    except RoundtripError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
