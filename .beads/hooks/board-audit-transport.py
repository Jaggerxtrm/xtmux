#!/usr/bin/env python3
"""Transport-branch freshness policy for board-audit handoff/reconcile.

The generic high-level flow lives in ``board-audit-flow.py``. This shim keeps
transport branches as artifact branches rooted on the current origin default
branch instead of letting them accumulate stale code history. Existing
``.xtrm/board-audit/**`` artifacts are restored from the previous transport
branch, and the rewritten transport branch is pushed with an exact
``--force-with-lease`` guard.

Transport commits are not product-code delivery. After a strict path fence
proves every staged path is under ``.xtrm/board-audit/**``, board-audit bypasses
repository-local commit/push hooks and marks the transport commit ``[skip ci]``.
This prevents code-oriented size/lint/SAST hooks and broad push CI from treating
lossless Beads transport JSON as application code. Repository review/test gates
remain unchanged for normal branches and pull requests.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path


HERE = Path(__file__).resolve().parent
FLOW_IMPL = HERE / "board-audit-flow.py"

spec = importlib.util.spec_from_file_location("board_audit_flow_impl", FLOW_IMPL)
if spec is None or spec.loader is None:
    raise RuntimeError(f"cannot load board-audit flow implementation: {FLOW_IMPL}")
flow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(flow)

# Each CLI invocation is one process. A lease recorded here belongs only to the
# handoff started in that process; reconcile --execute therefore falls back to a
# normal fast-forward push from the fetched transport head.
_HANDOFF_LEASES: dict[str, str | None] = {}

# ``bd worktree remove`` compares the worktree HEAD with the staging branch's
# configured upstream. Handoff staging branches start from origin/HEAD, but the
# commit is deliberately pushed to board-audit/<id>. Track that relationship so
# successful cleanup can realign the comparator before asking Beads to remove
# the worktree with its normal safety checks intact.
_STAGING_TRANSPORTS: dict[str, str] = {}
_BASE_MAKE_STAGING_BRANCH = flow.make_staging_branch
_BASE_CLEANUP_TRANSPORT_WORKTREE = flow.cleanup_transport_worktree


def _transport_artifacts_exist(repo: Path, remote_branch: str) -> bool:
    return (
        flow.run(
            [
                "git",
                "cat-file",
                "-e",
                f"origin/{remote_branch}:.xtrm/board-audit",
            ],
            cwd=repo,
            check=False,
        ).returncode
        == 0
    )


def _transport_relpaths(worktree: Path, paths: list[Path]) -> list[str]:
    """Return force-stageable transport paths, rejecting every other path.

    ``handoff`` deliberately versions ``.xtrm/board-audit/**`` even when a
    repository ignores ``.xtrm/`` wholesale. Because both ``git add -f`` and
    hook bypasses are powerful, keep their boundary narrower than the caller-
    provided path list and fail closed if anything escapes the transport tree.
    """
    relative_paths = [flow.rel(worktree, path) for path in paths]
    if not relative_paths:
        raise flow.FlowError("refusing to force-stage an empty transport path set")
    for relative in relative_paths:
        if relative != ".xtrm/board-audit" and not relative.startswith(
            ".xtrm/board-audit/"
        ):
            raise flow.FlowError(
                "refusing to force-stage non-board-audit path: " + relative
            )
    return relative_paths


def _transport_commit_message(message: str) -> str:
    """Mark artifact transport commits so broad push/pull_request CI skips them."""
    if any(
        marker in message.lower()
        for marker in ("[skip ci]", "[ci skip]", "[no ci]", "[skip actions]", "[actions skip]")
    ):
        return message
    return f"{message} [skip ci]"


def make_staging_branch(repo: Path, bead_id: str, start_ref: str) -> str:
    """Create a staging branch and remember its intended transport branch."""
    staging = _BASE_MAKE_STAGING_BRANCH(repo, bead_id, start_ref)
    _STAGING_TRANSPORTS[staging] = flow.transport_branch(bead_id)
    return staging


def _prepare_cleanup_upstream(
    repo: Path,
    worktree: Path,
    staging: str,
    remote_branch: str,
) -> None:
    """Prove publication and point Beads' normal comparator at that proof.

    Beads' normal worktree-removal policy checks cleanliness and requires the
    worktree HEAD to be contained in its comparison target. Handoff staging
    branches initially track origin/HEAD, while their generated commit is pushed
    to board-audit/<id>. Refresh exactly that transport ref, require exact HEAD
    equality, then repoint the ephemeral staging branch upstream so
    ``bd worktree remove`` can run without ``--force``.
    """
    remote_tracking = f"origin/{remote_branch}"
    refspec = f"+refs/heads/{remote_branch}:refs/remotes/origin/{remote_branch}"
    flow.run(["git", "fetch", "origin", refspec], cwd=repo)

    local_head = flow.git_output(worktree, "rev-parse", "HEAD")
    remote_head = flow.git_output(repo, "rev-parse", remote_tracking)
    if local_head != remote_head:
        raise flow.FlowError(
            "refusing worktree cleanup: local transport HEAD does not match "
            f"{remote_tracking} ({local_head} != {remote_head})"
        )

    flow.run(
        ["git", "branch", "--set-upstream-to", remote_tracking, staging],
        cwd=repo,
    )


def cleanup_transport_worktree(
    repo: Path,
    path: Path,
    staging: str,
    *,
    keep_on_error: bool,
) -> None:
    """Preserve Beads safety checks while cleaning published staging worktrees."""
    if keep_on_error:
        _STAGING_TRANSPORTS.pop(staging, None)
        _BASE_CLEANUP_TRANSPORT_WORKTREE(
            repo,
            path,
            staging,
            keep_on_error=True,
        )
        return

    remote_branch = _STAGING_TRANSPORTS.get(staging)
    if not remote_branch:
        raise flow.FlowError(
            f"cannot determine transport branch for cleanup staging branch {staging}"
        )

    try:
        _prepare_cleanup_upstream(repo, path, staging, remote_branch)
        _BASE_CLEANUP_TRANSPORT_WORKTREE(
            repo,
            path,
            staging,
            keep_on_error=False,
        )
    finally:
        _STAGING_TRANSPORTS.pop(staging, None)


def start_transport_worktree(
    repo: Path,
    bead_id: str,
    remote_branch: str | None = None,
) -> tuple[Path, str, str]:
    """Start transport publication from current origin default.

    ``bead_id`` names the identity (used for the staging branch and cache
    path); ``remote_branch`` overrides the derived ``board-audit/<bead-id>``
    branch for identities whose transport branch has a different name, e.g.
    PR-checkpoint handoffs published to ``board-audit/pr-<number>``.

    If a transport branch already exists we capture its exact remote SHA for a
    later lease-protected rewrite, then restore only the interchange tree into
    a staging branch rooted at current origin/main (or origin/HEAD).
    """
    flow.run(["git", "fetch", "origin"], cwd=repo)
    remote_branch = remote_branch or flow.transport_branch(bead_id)
    remote_ref = f"refs/remotes/origin/{remote_branch}"

    previous_sha: str | None = None
    if flow.remote_ref_exists(repo, remote_ref):
        previous_sha = flow.git_output(repo, "rev-parse", f"origin/{remote_branch}")

    staging = flow.make_staging_branch(repo, bead_id, flow.default_remote_ref(repo))
    # Keep this explicit as well as in make_staging_branch so tests or callers
    # that temporarily replace the flow hook cannot lose the cleanup mapping.
    _STAGING_TRANSPORTS[staging] = remote_branch
    path = flow.cache_worktree_path(repo, bead_id)
    try:
        flow.create_bd_worktree(repo, path, staging)
        if previous_sha and _transport_artifacts_exist(repo, remote_branch):
            # Path checkout updates the staging worktree/index without importing
            # stale code from the previous transport branch.
            flow.run(
                [
                    "git",
                    "checkout",
                    f"origin/{remote_branch}",
                    "--",
                    ".xtrm/board-audit",
                ],
                cwd=path,
            )
    except Exception:
        # Match the base flow's recovery behaviour: preserve a partially-created
        # worktree for inspection, but remove the staging ref if creation failed
        # before the worktree became usable.
        if not path.exists():
            flow.delete_local_branch(repo, staging)
        _STAGING_TRANSPORTS.pop(staging, None)
        raise

    _HANDOFF_LEASES[remote_branch] = previous_sha
    return path, staging, remote_branch


def commit_transport(
    worktree: Path,
    *,
    paths: list[Path],
    message: str,
) -> bool:
    """Force-stage transport paths and commit with hook/CI bypass.

    Returns True when a commit was created, False when nothing was staged.
    ``commit_and_push`` keeps its original behaviour; callers that need more
    than one commit under a single lease-protected push (PR-checkpoint
    evidence commit plus transport-seal commit) call this directly and finish
    with ``push_transport``.
    """
    relative_paths = _transport_relpaths(worktree, paths)
    # Transport artifacts are intentionally versioned even when the owning
    # repository ignores .xtrm/ globally. Force applies only after the strict
    # .xtrm/board-audit/** path check above.
    flow.run(["git", "add", "-f", "--", *relative_paths], cwd=worktree)
    staged = (
        flow.run(
            ["git", "diff", "--cached", "--quiet"],
            cwd=worktree,
            check=False,
        ).returncode
        != 0
    )
    if not staged:
        return False
    # Repository hooks are designed for product-code commits and can reject
    # valid lossless transport JSON for size/entropy/SAST reasons. The
    # strict transport path fence above is the authority boundary for this
    # narrow bypass; normal repository commits keep their hooks unchanged.
    flow.run(
        [
            "git",
            "commit",
            "--no-verify",
            "-m",
            _transport_commit_message(message),
        ],
        cwd=worktree,
    )
    return True


def push_transport(worktree: Path, *, remote_branch: str) -> None:
    """Push the current worktree HEAD to the transport branch under lease.

    Pre-push hooks (Semgrep/OSV/full test mirrors in many Mercury repos) are
    code-delivery gates, not transport gates. Skip only for this
    board-audit-owned push. GitHub-side push/pull_request workflows are also
    suppressed by the transport commit's [skip ci] marker where applicable.
    """
    push = ["git", "push", "--no-verify"]
    lease = _HANDOFF_LEASES.pop(remote_branch, None)
    if lease:
        push.append(
            f"--force-with-lease=refs/heads/{remote_branch}:{lease}"
        )
    push.extend(["origin", f"HEAD:refs/heads/{remote_branch}"])
    flow.run(push, cwd=worktree)


def commit_and_push(
    worktree: Path,
    *,
    paths: list[Path],
    message: str,
    remote_branch: str,
) -> None:
    commit_transport(worktree, paths=paths, message=message)
    push_transport(worktree, remote_branch=remote_branch)


# Install the transport policy into the generic flow implementation.
flow.make_staging_branch = make_staging_branch
flow.cleanup_transport_worktree = cleanup_transport_worktree
flow.start_transport_worktree = start_transport_worktree
flow.commit_and_push = commit_and_push


def main(argv: list[str] | None = None) -> int:
    return int(flow.main(argv))


if __name__ == "__main__":
    raise SystemExit(main())
