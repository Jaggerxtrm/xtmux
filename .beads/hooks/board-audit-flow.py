#!/usr/bin/env python3
"""High-level board-audit handoff/reconcile UX.

The low-level exporter and round-trip reconciler remain deterministic primitives.
This layer composes them with `bd worktree create` so the caller's checkout is
never switched and every worktree shares the authoritative Beads database via
Git common-directory discovery.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
from typing import Any

INDEX_SCHEMA = "xtrm.board-audit.index.v1"
TRANSPORT_PREFIX = "board-audit/"


class FlowError(RuntimeError):
    pass


def utcnow() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def run(command: list[str], *, cwd: Path, capture: bool = False, check: bool = True) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(command, cwd=cwd, text=True, capture_output=capture, check=False)
    if check and proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip() if capture else ""
        raise FlowError(
            f"command failed ({proc.returncode}): {shlex.join(command)}"
            + (f"\n{detail}" if detail else "")
        )
    return proc


def git_output(repo: Path, *args: str) -> str:
    return run(["git", *args], cwd=repo, capture=True).stdout.strip()


def repo_root() -> Path:
    proc = subprocess.run(["git", "rev-parse", "--show-toplevel"], text=True, capture_output=True, check=False)
    if proc.returncode != 0:
        raise FlowError("not inside a git working tree")
    return Path(proc.stdout.strip()).resolve()


def script_paths() -> tuple[Path, Path]:
    here = Path(__file__).resolve().parent
    core = Path(os.environ.get("BOARD_AUDIT_CORE", str(here / "board-audit-core"))).resolve()
    roundtrip = Path(os.environ.get("BOARD_AUDIT_ROUNDTRIP", str(here / "board-audit-roundtrip.py"))).resolve()
    if not core.exists():
        raise FlowError(f"board-audit core not found: {core}")
    if not roundtrip.exists():
        raise FlowError(f"board-audit round-trip tool not found: {roundtrip}")
    return core, roundtrip


def require_commands(*names: str) -> None:
    missing = [name for name in names if shutil.which(name) is None]
    if missing:
        raise FlowError("required command(s) not on PATH: " + ", ".join(missing))


def validate_id(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", value):
        raise FlowError(f"unsupported bead id {value!r}; expected letters/numbers plus . _ -")
    return value


def transport_branch(bead_id: str) -> str:
    return f"{TRANSPORT_PREFIX}{bead_id}"


def remote_ref_exists(repo: Path, ref: str) -> bool:
    return run(["git", "show-ref", "--verify", "--quiet", ref], cwd=repo, check=False).returncode == 0


def default_remote_ref(repo: Path) -> str:
    proc = run(
        ["git", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
        cwd=repo,
        capture=True,
        check=False,
    )
    if proc.returncode == 0 and proc.stdout.strip():
        return proc.stdout.strip()
    if remote_ref_exists(repo, "refs/remotes/origin/main"):
        return "origin/main"
    raise FlowError("cannot determine origin default branch; configure origin/HEAD or origin/main")


def cache_worktree_path(repo: Path, bead_id: str) -> Path:
    cache = Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache")))
    root = cache / "xtrm" / "board-audit" / "worktrees" / repo.name
    root.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    path = root / f"{bead_id}-{stamp}-{os.getpid()}"
    if path.exists():
        raise FlowError(f"worktree path unexpectedly exists: {path}")
    return path


def make_staging_branch(repo: Path, bead_id: str, start_ref: str) -> str:
    token = f"{bead_id}-{os.getpid()}-{dt.datetime.now().strftime('%H%M%S')}"
    branch = f"board-audit-staging/{token}"
    run(["git", "branch", branch, start_ref], cwd=repo)
    return branch


def create_bd_worktree(repo: Path, path: Path, branch: str) -> None:
    run(["bd", "worktree", "create", str(path), "--branch", branch], cwd=repo)


def remove_bd_worktree(repo: Path, path: Path) -> None:
    # `bd worktree remove` is name-oriented; the created path has a unique basename.
    run(["bd", "worktree", "remove", path.name], cwd=repo)


def delete_local_branch(repo: Path, branch: str) -> None:
    run(["git", "branch", "-D", branch], cwd=repo)


def start_transport_worktree(repo: Path, bead_id: str) -> tuple[Path, str, str]:
    run(["git", "fetch", "origin"], cwd=repo)
    remote_branch = transport_branch(bead_id)
    remote_ref = f"refs/remotes/origin/{remote_branch}"
    start_ref = f"origin/{remote_branch}" if remote_ref_exists(repo, remote_ref) else default_remote_ref(repo)
    staging = make_staging_branch(repo, bead_id, start_ref)
    path = cache_worktree_path(repo, bead_id)
    try:
        create_bd_worktree(repo, path, staging)
    except Exception:
        delete_local_branch(repo, staging)
        raise
    return path, staging, remote_branch


def cleanup_transport_worktree(repo: Path, path: Path, staging: str, *, keep_on_error: bool) -> None:
    if keep_on_error:
        print(f"worktree retained for recovery: {path}", file=sys.stderr)
        print(f"staging branch retained: {staging}", file=sys.stderr)
        return
    remove_bd_worktree(repo, path)
    delete_local_branch(repo, staging)


def read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise FlowError(f"cannot read JSON {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise FlowError(f"expected JSON object: {path}")
    return data


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def rel(worktree: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(worktree.resolve()).as_posix()
    except ValueError as exc:
        raise FlowError(f"artifact escaped transport worktree: {path}") from exc


def latest_export_dir(worktree: Path) -> Path:
    root = worktree / ".xtrm" / "board-audit" / "exports"
    exports = sorted((p for p in root.glob("export-*") if p.is_dir()), key=lambda p: p.name)
    if not exports:
        raise FlowError(f"no structured export found under {root}")
    return exports[-1]


def package_from_manifest(export_dir: Path, bead_id: str) -> tuple[Path, dict[str, Any]]:
    manifest = read_json(export_dir / "manifest.json")
    packages = manifest.get("packages")
    if not isinstance(packages, list):
        raise FlowError("manifest packages must be a list")
    matches = [row for row in packages if isinstance(row, dict) and str(row.get("root_id")) == bead_id]
    if len(matches) != 1:
        raise FlowError(f"expected one work package for {bead_id}, found {len(matches)}")
    file_name = matches[0].get("file")
    if not isinstance(file_name, str) or not file_name:
        raise FlowError("manifest package has no file path")
    package = export_dir / file_name
    if not package.exists():
        raise FlowError(f"manifest package file missing: {package}")
    return package, manifest


def load_index(worktree: Path) -> dict[str, Any]:
    path = worktree / ".xtrm" / "board-audit" / "index.json"
    if not path.exists():
        return {"schema_version": INDEX_SCHEMA, "packages": {}}
    data = read_json(path)
    if data.get("schema_version") != INDEX_SCHEMA:
        raise FlowError(f"unsupported board-audit index schema: {data.get('schema_version')!r}")
    if not isinstance(data.get("packages"), dict):
        raise FlowError("board-audit index packages must be an object")
    return data


def update_index_for_handoff(
    worktree: Path,
    bead_id: str,
    remote_branch: str,
    export_dir: Path,
    package: Path,
    editable: Path,
    manifest: dict[str, Any],
) -> Path:
    index = load_index(worktree)
    index["packages"][bead_id] = {
        "branch": remote_branch,
        "state": "prepared",
        "updated_at": utcnow(),
        "export_dir": rel(worktree, export_dir),
        "manifest": rel(worktree, export_dir / "manifest.json"),
        "package": rel(worktree, package),
        "editable": rel(worktree, editable),
        "base_package_sha256": read_json(package).get("content_sha256"),
        "selected_record_count": (manifest.get("selection") or {}).get("selected_record_count"),
    }
    path = worktree / ".xtrm" / "board-audit" / "index.json"
    write_json(path, index)
    return path


def commit_and_push(worktree: Path, *, paths: list[Path], message: str, remote_branch: str) -> None:
    run(["git", "add", "--", *[rel(worktree, path) for path in paths]], cwd=worktree)
    staged = run(["git", "diff", "--cached", "--quiet"], cwd=worktree, check=False).returncode != 0
    if staged:
        run(["git", "commit", "-m", message], cwd=worktree)
    run(["git", "push", "origin", f"HEAD:refs/heads/{remote_branch}"], cwd=worktree)


def locate_editable(worktree: Path, bead_id: str) -> tuple[Path, dict[str, Any]]:
    index = load_index(worktree)
    entry = (index.get("packages") or {}).get(bead_id)
    if isinstance(entry, dict) and isinstance(entry.get("editable"), str):
        candidate = worktree / entry["editable"]
        if candidate.exists():
            return candidate, index

    # Compatibility with handoffs created before index.json existed.
    matches = sorted(
        worktree.glob(f".xtrm/board-audit/exports/export-*/work-packages/{bead_id}__*.editable.json"),
        key=lambda path: path.as_posix(),
    )
    if not matches:
        raise FlowError(f"no editable handoff artifact found for {bead_id} on transport branch")
    return matches[-1], index


def mark_applied(worktree: Path, index: dict[str, Any], bead_id: str) -> Path | None:
    packages = index.get("packages")
    if not isinstance(packages, dict) or not isinstance(packages.get(bead_id), dict):
        return None
    entry = packages[bead_id]
    entry["state"] = "applied"
    entry["updated_at"] = utcnow()
    entry["applied_at"] = utcnow()
    path = worktree / ".xtrm" / "board-audit" / "index.json"
    write_json(path, index)
    return path


def cmd_handoff(args: argparse.Namespace) -> int:
    require_commands("git", "bd", "python3")
    bead_id = validate_id(args.bead_id)
    repo = repo_root()
    original_branch = git_output(repo, "branch", "--show-current") or "(detached)"
    core, roundtrip = script_paths()

    worktree: Path | None = None
    staging = ""
    keep = False
    try:
        worktree, staging, remote_branch = start_transport_worktree(repo, bead_id)
        run([str(core), "--export", "--bead", bead_id], cwd=worktree)
        export_dir = latest_export_dir(worktree)
        package, manifest = package_from_manifest(export_dir, bead_id)
        prepared = run([sys.executable, str(roundtrip), "prepare", str(package)], cwd=worktree, capture=True)
        editable = Path(prepared.stdout.strip())
        if not editable.is_absolute():
            editable = (worktree / editable).resolve()
        if not editable.exists():
            raise FlowError(f"prepare did not create expected artifact: {editable}")
        editable_rel = rel(worktree, editable)
        index_path = update_index_for_handoff(worktree, bead_id, remote_branch, export_dir, package, editable, manifest)
        commit_and_push(
            worktree,
            paths=[export_dir, index_path],
            message=f"chore(board-audit): handoff {bead_id}",
            remote_branch=remote_branch,
        )
        selected = (manifest.get("selection") or {}).get("selected_record_count")
    except Exception:
        keep = True
        raise
    finally:
        if worktree is not None and staging:
            cleanup_transport_worktree(repo, worktree, staging, keep_on_error=keep)

    print()
    print(f"✓ {bead_id} ready for handoff")
    print(f"  branch:   {remote_branch}")
    print(f"  issues:   {selected}")
    print(f"  editable: {editable_rel}")
    print(f"  checkout: unchanged ({original_branch})")
    print()
    print(f'Tell ChatGPT: "leggi export {bead_id}"')
    return 0


def cmd_reconcile(args: argparse.Namespace) -> int:
    require_commands("git", "bd", "python3")
    bead_id = validate_id(args.bead_id)
    repo = repo_root()
    original_branch = git_output(repo, "branch", "--show-current") or "(detached)"
    _, roundtrip = script_paths()

    worktree: Path | None = None
    staging = ""
    keep = False
    try:
        run(["git", "fetch", "origin"], cwd=repo)
        remote_branch = transport_branch(bead_id)
        if not remote_ref_exists(repo, f"refs/remotes/origin/{remote_branch}"):
            raise FlowError(f"transport branch origin/{remote_branch} does not exist; run handoff first")
        staging = make_staging_branch(repo, bead_id, f"origin/{remote_branch}")
        worktree = cache_worktree_path(repo, bead_id)
        create_bd_worktree(repo, worktree, staging)
        editable, index = locate_editable(worktree, bead_id)

        print("== validate ==")
        run([sys.executable, str(roundtrip), "validate", str(editable)], cwd=worktree)
        print("\n== three-way diff ==")
        run([sys.executable, str(roundtrip), "diff", str(editable)], cwd=worktree)
        print("\n== apply + verify ==" if args.execute else "\n== apply dry-run ==")
        command = [sys.executable, str(roundtrip), "apply", str(editable)]
        if args.execute:
            command.append("--execute")
        run(command, cwd=worktree)

        if args.execute:
            index_path = mark_applied(worktree, index, bead_id)
            if index_path is not None:
                commit_and_push(
                    worktree,
                    paths=[index_path],
                    message=f"chore(board-audit): mark {bead_id} applied",
                    remote_branch=remote_branch,
                )
    except Exception:
        keep = True
        raise
    finally:
        if worktree is not None and staging:
            cleanup_transport_worktree(repo, worktree, staging, keep_on_error=keep)

    print()
    if args.execute:
        print(f"✓ {bead_id} applied and verified")
    else:
        print(f"✓ {bead_id} reconciled safely; no Beads mutation performed")
        print(f"  execute: board-audit reconcile {bead_id} --execute")
    print(f"  checkout: unchanged ({original_branch})")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="board-audit",
        description="Simple handoff/reconcile UX over deterministic Beads work-package primitives.",
        epilog="Low-level --export/audit commands and board-audit-roundtrip remain available for debugging and automation.",
    )
    sub = parser.add_subparsers(dest="command")

    handoff = sub.add_parser("handoff", help="export + prepare + commit + push through an isolated bd-managed worktree")
    handoff.add_argument("bead_id", help="epic/bead root to hand off")
    handoff.set_defaults(func=cmd_handoff)

    reconcile = sub.add_parser("reconcile", help="fetch edited handoff, validate/diff, dry-run, optionally apply + verify")
    reconcile.add_argument("bead_id", help="epic/bead root to reconcile")
    reconcile.add_argument("--execute", action="store_true", help="mutate Beads and verify; otherwise dry-run only")
    reconcile.set_defaults(func=cmd_reconcile)
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        parser = build_parser()
        args = parser.parse_args(argv)
        if not getattr(args, "command", None):
            parser.print_help()
            return 0
        return int(args.func(args))
    except FlowError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
