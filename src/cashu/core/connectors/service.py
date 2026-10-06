"""Connector registry: install, status, approval, removal, bindings and recorded runs.

- **Install** (``install``; CLI ``cashu connectors add``, later MCP ``propose_connector``) validates a
  directory, copies it atomically into ``<data dir>/connectors/<id>/`` and upserts the row. It never
  approves: a new connector is ``pending``; replacing an approved one with different content makes it
  ``changed`` (the old approval stays only as the reference for "what changed").
- **Approve** (``approve``; app only, never CLI or MCP) recomputes the content hash and the interpreter
  path and pins both, refusing with :class:`Conflict` when the owner looked at something else.
- **Status** is re-checked from disk (``refresh``) before a run and in every list / detail: a changed file
  or a different resolved interpreter turns ``approved`` into ``changed``; such a connector never runs.
- **Runs** (``run``): the approval gate and the run record are two short transactions around the process,
  never one transaction across it. Every run (refused ones too) is recorded; the last 500 per connector
  are kept.
- **Bindings**: a fetch connector bound to an account of a profile, with params and keychain secrets.
"""

from __future__ import annotations

import datetime as dt
import os
import re
import shutil
import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sqlmodel import Session, col, delete, select

from .. import paths
from ..db import get_session
from ..models import Account, Profile, utcnow
from . import manifest as mf
from . import protocol as proto
from .models import Connector, ConnectorBinding, ConnectorRun
from .runner import InputFile, RunResult, RunTarget, execute
from .sandbox import ConnectorSandbox

KEEP_RUNS = 500
MAX_VIEW_BYTES = 200 * 1024
MAX_PARAM_CHARS = 500
BROKERAGE = "brokerage"  # the investments module's account type id
BANK_TYPES = ("checking", "savings", "credit")  # budget bank accounts (= budget imports.ACCOUNT_TYPES)
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class ConnectorError(Exception):
    """A refused connector operation. ``status`` is the HTTP status the API answers with, ``code`` the
    stable ``X-Cashu-Error-Code`` (the app's ``error.<code>`` label)."""

    status = 422
    code = "connector_invalid"

    def __init__(self, message: str, *, issues: Iterable[str] = ()):
        super().__init__(message)
        self.issues = tuple(issues)


class NotFound(ConnectorError):
    status = 404
    code = "not_found"


class Conflict(ConnectorError):
    status = 409
    code = "connector_conflict"


class Changed(Conflict):
    """Approve: the hash or the interpreter differs from what the owner looked at."""

    code = "connector_changed"


class BindingExists(Conflict):
    code = "connector_binding_exists"


class NotApproved(ConnectorError):
    code = "connector_not_approved"


class ParamsError(ConnectorError):
    """Binding params that do not fit the manifest; ``params`` = ``{param id: message}``."""

    code = "connector_params"

    def __init__(self, message: str, params: dict[str, str]):
        super().__init__(message, issues=[f"{k}: {v}" for k, v in params.items()])
        self.params = params


class Unsupported(ConnectorError):
    status = 415
    code = "connector_file_binary"


class TooLarge(ConnectorError):
    status = 413
    code = "connector_file_too_large"


# --------------------------------------------------------------------------- #
# Locations
# --------------------------------------------------------------------------- #


def connectors_root() -> Path:
    return paths.data_dir() / "connectors"


APPROVED_DIR = ".approved"


def approved_root() -> Path:
    """``<data dir>/connectors/.approved/``: a copy of every connector as the owner approved it (the
    reference of the "what changed" diff). Never run, never on any sandbox allow-list."""
    return connectors_root() / APPROVED_DIR


def approved_dir(connector_id: str) -> Path:
    installed_dir(connector_id)  # validates the id
    return approved_root() / connector_id


def installed_dir(connector_id: str) -> Path:
    if not re.match(mf.CONNECTOR_ID, connector_id or ""):
        raise NotFound(f"no connector {connector_id!r}")
    return connectors_root() / connector_id


def _ensure_root() -> Path:
    paths.ensure_private_dir(paths.data_dir())
    return paths.ensure_private_dir(connectors_root())


def _copy_private(src: Path, dst: Path) -> None:
    """Copy a validated connector dir: owner-only dirs (0700) and files (0600, or 0700 when the
    source file is executable)."""
    dst.mkdir(mode=0o700)
    os.chmod(dst, 0o700)
    for entry in sorted(os.scandir(src), key=lambda e: e.name):
        target = dst / entry.name
        if entry.is_dir(follow_symlinks=False):
            _copy_private(Path(entry.path), target)
        elif entry.is_file(follow_symlinks=False):
            shutil.copyfile(entry.path, target, follow_symlinks=False)
            executable = entry.stat(follow_symlinks=False).st_mode & 0o100
            os.chmod(target, 0o700 if executable else 0o600)


# --------------------------------------------------------------------------- #
# Install
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class Installed:
    connector: Connector
    replaced: bool


def install(source_dir: Path, *, replace: bool = False, source: str = "cli") -> Installed:
    """Validate ``source_dir`` and install a copy (see the module doc). Raises :class:`ConnectorError`."""
    try:
        loaded = mf.load_dir(Path(source_dir))
    except mf.ManifestError as e:
        raise ConnectorError("invalid connector", issues=e.issues) from None
    cid = loaded.manifest.id
    with get_session() as s:
        existing = s.get(Connector, cid)
        if existing is not None and not replace:
            raise Conflict(f"connector {cid!r} is already installed (use --replace to update it)")
        if existing is not None and (
            existing.module != loaded.manifest.module or existing.kind != loaded.manifest.kind
        ):
            raise Conflict(
                f"connector {cid!r} changes its module or kind; remove it first "
                "(cashu connectors remove)"
            )
    root = _ensure_root()
    staging = root / f".{cid}.tmp-{uuid.uuid4().hex[:8]}"
    trash = root / f".{cid}.old-{uuid.uuid4().hex[:8]}"
    target = root / cid
    try:
        _copy_private(loaded.root, staging)
        # Validate the copy itself: the source may have changed while it was being copied.
        copied = mf.load_dir(staging)
        if copied.manifest.id != cid:
            raise ConnectorError("the connector changed while it was being copied")
        if target.exists():
            target.rename(trash)
        staging.rename(target)
    except mf.ManifestError as e:
        raise ConnectorError("invalid connector", issues=e.issues) from None
    finally:
        shutil.rmtree(staging, ignore_errors=True)
        shutil.rmtree(trash, ignore_errors=True)
    final = mf.load_dir(target)
    now = utcnow()
    with get_session() as s:
        row = s.get(Connector, cid)
        replaced = row is not None
        if row is None:
            row = Connector(id=cid, installed_at=now, status="pending", source=source)
        _apply_manifest(row, final)
        row.source = source
        row.updated_at = now
        if replaced and row.status in ("approved", "changed") and not _matches_approval(row):
            row.status = "changed"
        elif replaced and row.status == "changed" and _matches_approval(row):
            row.status = "approved"
        s.add(row)
        s.flush()
        s.refresh(row)
        return Installed(row, replaced)


def _apply_manifest(row: Connector, loaded: mf.LoadedConnector) -> None:
    m = loaded.manifest
    row.name, row.version, row.module, row.kind = m.name, m.version, m.module, m.kind
    row.manifest_json = m.model_dump(mode="json", exclude_none=True)
    row.content_sha256 = loaded.content_sha256
    row.interpreter_path = str(loaded.interpreter)


def _matches_approval(row: Connector) -> bool:
    return (
        row.approved_sha256 is not None
        and row.approved_sha256 == row.content_sha256
        and row.approved_interpreter == row.interpreter_path
    )


def content_changed(row: Connector) -> bool:
    """A ``disabled`` connector whose files or interpreter differ from its last approval (the status
    stays ``disabled``; the app shows the same diff as for ``changed`` and approving needs the current
    hash). Always False for other statuses: ``changed`` already says it."""
    return row.status == "disabled" and row.approved_sha256 is not None and not _matches_approval(row)


def manifest_of(row: Connector) -> mf.Manifest:
    return mf.Manifest.model_validate(row.manifest_json)


# --------------------------------------------------------------------------- #
# Status from disk
# --------------------------------------------------------------------------- #


@dataclass
class DiskState:
    """What is on disk right now for one installed connector."""

    files: list[mf.FileEntry] = field(default_factory=list)
    content_sha256: str | None = None
    interpreter: str | None = None
    problems: list[str] = field(default_factory=list)
    missing: bool = False
    loaded: mf.LoadedConnector | None = None

    @property
    def runnable_files(self) -> bool:
        return self.loaded is not None


def disk_state(connector_id: str) -> DiskState:
    root = installed_dir(connector_id)
    if not root.is_dir():
        return DiskState(missing=True, problems=["the installed directory is missing"])
    state = DiskState()
    try:
        state.files = mf.scan_dir(root)
        state.content_sha256 = mf.content_sha256(state.files)
    except mf.ManifestError as e:
        state.problems = list(e.issues)
        return state
    try:
        state.loaded = mf.load_dir(root)
        state.interpreter = str(state.loaded.interpreter)
    except mf.ManifestError as e:
        state.problems = list(e.issues)
    return state


def refresh(session: Session, row: Connector) -> DiskState:
    """Re-check ``row`` against the disk; an approved connector whose files or interpreter differ from
    the approval becomes ``changed``. Returns what was found."""
    state = disk_state(row.id)
    changed = False
    if state.content_sha256 and state.content_sha256 != row.content_sha256:
        row.content_sha256, changed = state.content_sha256, True
    if state.interpreter and state.interpreter != row.interpreter_path:
        row.interpreter_path, changed = state.interpreter, True
    if row.status == "approved" and (state.missing or state.problems or not _matches_approval(row)):
        row.status, changed = "changed", True
    if changed:
        row.updated_at = utcnow()
        session.add(row)
    return state


def _get(session: Session, connector_id: str) -> Connector:
    row = session.get(Connector, connector_id)
    if row is None:
        raise NotFound(f"no connector {connector_id!r}")
    return row


# --------------------------------------------------------------------------- #
# Views (API / CLI)
# --------------------------------------------------------------------------- #


def _last_run(session: Session, connector_id: str) -> ConnectorRun | None:
    return session.exec(
        select(ConnectorRun)
        .where(ConnectorRun.connector_id == connector_id)
        .order_by(col(ConnectorRun.id).desc())
        .limit(1)
    ).first()


def _iso(value: dt.datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def summary_dict(session: Session, row: Connector) -> dict:
    m = row.manifest_json
    last = _last_run(session, row.id)
    bindings = session.exec(
        select(ConnectorBinding.id).where(ConnectorBinding.connector_id == row.id)
    ).all()
    return {
        "id": row.id,
        "name": row.name,
        "version": row.version,
        "author": m.get("author"),
        "module": row.module,
        "kind": row.kind,
        "status": row.status,
        "content_changed": content_changed(row),
        "source": row.source,
        "content_sha256": row.content_sha256,
        "interpreter_path": row.interpreter_path,
        "installed_at": _iso(row.installed_at),
        "updated_at": _iso(row.updated_at),
        "approved_at": _iso(row.approved_at),
        "bindings": len(bindings),
        "description": m.get("description"),
        "extensions": (m.get("file") or {}).get("extensions", []),
        "timeout_s": m.get("timeout_s", mf.DEFAULT_TIMEOUT_S),
        "last_run": None if last is None else {
            "outcome": last.outcome,
            "error_kind": last.error_kind,
            "command": last.command,
            "started_at": _iso(last.started_at),
        },
    }


def list_connectors(session: Session) -> list[dict]:
    rows = session.exec(select(Connector).order_by(Connector.id)).all()
    out = []
    for row in rows:
        refresh(session, row)
        out.append(summary_dict(session, row))
    return out


def _file_dicts(files: Iterable[mf.FileEntry]) -> list[dict]:
    return [{"path": f.path, "size": f.size, "sha256": f.sha256} for f in files]


def _diff(approved: list[dict] | None, current: list[dict]) -> dict | None:
    if approved is None:
        return None
    before = {f["path"]: f["sha256"] for f in approved}
    after = {f["path"]: f["sha256"] for f in current}
    return {
        "added": sorted(set(after) - set(before)),
        "removed": sorted(set(before) - set(after)),
        "modified": sorted(p for p in set(before) & set(after) if before[p] != after[p]),
    }


def detail_dict(session: Session, connector_id: str) -> dict:
    row = _get(session, connector_id)
    state = refresh(session, row)
    m = row.manifest_json
    files = _file_dicts(state.files)
    out = summary_dict(session, row)
    out.update({
        "description": m.get("description"),
        "run": m.get("run"),
        "timeout_s": m.get("timeout_s", mf.DEFAULT_TIMEOUT_S),
        "extensions": (m.get("file") or {}).get("extensions", []),
        "hosts": (m.get("fetch") or {}).get("hosts", []),
        "secrets": (m.get("fetch") or {}).get("secrets", []),
        "params": (m.get("fetch") or {}).get("params", []),
        "history_days": (m.get("fetch") or {}).get("history_days"),
        "files": files,
        "missing": state.missing,
        "problems": state.problems,
        "approved_sha256": row.approved_sha256,
        "approved_interpreter": row.approved_interpreter,
        "interpreter_changed": bool(
            row.approved_interpreter and row.approved_interpreter != row.interpreter_path
        ),
        "diff": _diff(row.approved_files_json, files)
        if row.status == "changed" or content_changed(row) else None,
        "recent_runs": [_run_row(r, _slugs(session)) for r in _recent_runs(session, row.id)],
    })
    return out


RECENT_RUNS = 10


def _recent_runs(session: Session, connector_id: str) -> list[ConnectorRun]:
    return list(session.exec(
        select(ConnectorRun)
        .where(ConnectorRun.connector_id == connector_id)
        .order_by(col(ConnectorRun.id).desc())
        .limit(RECENT_RUNS)
    ).all())


def _run_row(run: ConnectorRun, slugs: dict[int, str] | None = None) -> dict:
    """A recorded run for the owner's view in the app (the redacted stderr tail included; never MCP)."""
    return {
        "profile": (slugs or {}).get(run.profile_id) if run.profile_id is not None else None,
        "proposal_id": run.proposal_id,
        "batch_ref": run.batch_ref,
        "id": run.id,
        "command": run.command,
        "started_at": _iso(run.started_at),
        "duration_ms": run.duration_ms,
        "outcome": run.outcome,
        "error_kind": run.error_kind,
        "exit_code": run.exit_code,
        "records": run.records,
        "bytes_in": run.bytes_in,
        "bytes_out": run.bytes_out,
        "denied_hosts": run.denied_hosts_json,
        "stderr_tail": run.stderr_tail,
        "profile_id": run.profile_id,
        "binding_id": run.binding_id,
    }


MAX_RUNS_LISTED = 100


def _slugs(session: Session) -> dict[int, str]:
    return {p.id: p.slug for p in session.exec(select(Profile)).all()}


def list_runs(session: Session, connector_id: str, limit: int = 20) -> list[dict]:
    """The newest recorded runs of a connector (at most :data:`MAX_RUNS_LISTED`), the owner's view."""
    _get(session, connector_id)
    limit = max(1, min(int(limit), MAX_RUNS_LISTED))
    rows = session.exec(
        select(ConnectorRun)
        .where(ConnectorRun.connector_id == connector_id)
        .order_by(col(ConnectorRun.id).desc())
        .limit(limit)
    ).all()
    slugs = _slugs(session)
    return [_run_row(r, slugs) for r in rows]


MAX_DIFF_BYTES = 200 * 1024


def _text_or_none(path: Path) -> str | None:
    """A file's UTF-8 text (None when absent); :class:`Unsupported` for binary content."""
    if not path.is_file():
        return None
    if path.stat().st_size > MAX_VIEW_BYTES:
        raise TooLarge(f"{path.name} is larger than {MAX_VIEW_BYTES // 1024} KiB")
    data = path.read_bytes()
    if b"\0" in data:
        raise Unsupported(f"{path.name} is not a text file")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        raise Unsupported(f"{path.name} is not a UTF-8 text file") from None


def diff_file(session: Session, connector_id: str, relpath: str) -> str:
    """A unified diff of one file between the approved copy and the installed one (an added file
    diffs against nothing, a removed one to nothing), capped at :data:`MAX_DIFF_BYTES`. 404 when the
    connector was never approved or neither side has the file."""
    import difflib

    row = _get(session, connector_id)
    state = refresh(session, row)
    approved = approved_dir(connector_id)
    if row.approved_sha256 is None or not approved.is_dir():
        raise NotFound(f"connector {connector_id!r} has no approved copy")
    approved_paths = {f["path"] for f in (row.approved_files_json or [])}
    current_paths = {f.path for f in state.files}
    if relpath not in approved_paths | current_paths:
        raise NotFound(f"no file {relpath!r} in connector {connector_id!r}")
    before = _text_or_none(approved / relpath) if relpath in approved_paths else None
    after = _text_or_none(installed_dir(connector_id) / relpath) if relpath in current_paths else None
    lines = difflib.unified_diff(
        (before or "").splitlines(keepends=True),
        (after or "").splitlines(keepends=True),
        fromfile=f"zatwierdzony/{relpath}" if before is not None else "/dev/null",
        tofile=f"obecny/{relpath}" if after is not None else "/dev/null",
    )
    out, size = [], 0
    for line in lines:
        if not line.endswith("\n"):
            line += "\n\\ No newline at end of file\n"
        size += len(line.encode("utf-8"))
        if size > MAX_DIFF_BYTES:
            out.append(f"... (diff cut at {MAX_DIFF_BYTES // 1024} KiB)\n")
            break
        out.append(line)
    return "".join(out)


def _snapshot(connector_id: str, expected_sha256: str) -> None:
    """Copy the installed dir to ``.approved/<id>`` atomically (copy, verify the copy's hash, rename).
    :class:`Changed` when the copy differs from what was approved (a file changed meanwhile)."""
    root = paths.ensure_private_dir(approved_root())
    staging = root / f".{connector_id}.tmp-{uuid.uuid4().hex[:8]}"
    trash = root / f".{connector_id}.old-{uuid.uuid4().hex[:8]}"
    target = root / connector_id
    try:
        _copy_private(installed_dir(connector_id), staging)
        if mf.content_sha256(mf.scan_dir(staging)) != expected_sha256:
            raise Changed("the connector changed since it was shown; look at it again")
        if target.exists():
            target.rename(trash)
        staging.rename(target)
    except mf.ManifestError:
        raise Changed("the connector changed since it was shown; look at it again") from None
    finally:
        shutil.rmtree(staging, ignore_errors=True)
        shutil.rmtree(trash, ignore_errors=True)


def read_file(session: Session, connector_id: str, relpath: str) -> str:
    """A text file of an installed connector for the code viewer (<= 200 KiB, UTF-8, no NUL)."""
    row = _get(session, connector_id)
    state = refresh(session, row)
    entry = next((f for f in state.files if f.path == relpath), None)
    if entry is None:
        raise NotFound(f"no file {relpath!r} in connector {connector_id!r}")
    if entry.size > MAX_VIEW_BYTES:
        raise TooLarge(f"{relpath} is larger than {MAX_VIEW_BYTES // 1024} KiB")
    data = (installed_dir(connector_id) / relpath).read_bytes()
    if b"\0" in data:
        raise Unsupported(f"{relpath} is not a text file")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        raise Unsupported(f"{relpath} is not a UTF-8 text file") from None


# --------------------------------------------------------------------------- #
# Approve, disable, remove
# --------------------------------------------------------------------------- #


def approve(connector_id: str, content_sha256: str, interpreter_path: str) -> dict:
    """Pin what the owner looked at. 409 (:class:`Conflict`) when the hash or the interpreter the
    client sends differs from what the server computes now."""
    with get_session() as s:
        row = _get(s, connector_id)
        state = refresh(s, row)
        if state.missing or state.problems or state.loaded is None:
            raise ConnectorError("the connector cannot be approved", issues=state.problems)
        if content_sha256 != state.content_sha256 or interpreter_path != state.interpreter:
            raise Changed("the connector changed since it was shown; look at it again")
        _snapshot(connector_id, state.content_sha256)
        row.status = "approved"
        row.approved_sha256 = state.content_sha256
        row.approved_interpreter = state.interpreter
        row.approved_files_json = _file_dicts(state.files)
        row.approved_at = row.updated_at = utcnow()
        s.add(row)
        s.flush()
        return summary_dict(s, row)


def disable(connector_id: str) -> dict:
    """Stop a connector from running (bindings and secrets stay; approving again enables it)."""
    with get_session() as s:
        row = _get(s, connector_id)
        refresh(s, row)
        row.status = "disabled"
        row.updated_at = utcnow()
        s.add(row)
        s.flush()
        return summary_dict(s, row)


@dataclass(frozen=True, slots=True)
class Removed:
    bindings: int
    secrets_left: int  # keychain entries that could not be deleted (reported, never raised)


def remove(connector_id: str) -> Removed:
    """Delete the connector: its bindings (and their keychain secrets), its runs, its row, its dir."""
    with get_session() as s:
        row = _get(s, connector_id)
        manifest = manifest_of(row)
        targets = [
            (b.id, _slug(s, b.profile_id))
            for b in s.exec(
                select(ConnectorBinding).where(ConnectorBinding.connector_id == connector_id)
            ).all()
        ]
    left = 0
    for binding_id, slug in targets:
        left += _delete_secrets(connector_id, slug, binding_id, manifest.secret_ids)
    with get_session() as s:
        s.exec(delete(ConnectorBinding).where(ConnectorBinding.connector_id == connector_id))
        s.exec(delete(ConnectorRun).where(ConnectorRun.connector_id == connector_id))
        row = s.get(Connector, connector_id)
        if row is not None:
            s.delete(row)
    shutil.rmtree(installed_dir(connector_id), ignore_errors=True)
    shutil.rmtree(approved_dir(connector_id), ignore_errors=True)
    return Removed(len(targets), left)


# --------------------------------------------------------------------------- #
# Runs
# --------------------------------------------------------------------------- #


def record_run(
    result: RunResult,
    connector_id: str,
    *,
    profile_id: int | None = None,
    binding_id: int | None = None,
) -> int:
    """Insert one run row and prune to the last :data:`KEEP_RUNS` of the connector (own transaction)."""
    with get_session() as s:
        run = ConnectorRun(
            connector_id=connector_id,
            profile_id=profile_id,
            binding_id=binding_id,
            command=result.command,
            started_at=result.started_at,
            duration_ms=result.duration_ms,
            outcome=result.outcome,
            error_kind=result.error_kind,
            exit_code=result.exit_code,
            records=result.records,
            bytes_in=result.bytes_in,
            bytes_out=result.bytes_out,
            denied_hosts_json=list(result.denied_hosts),
            stderr_tail=result.stderr_tail,
        )
        s.add(run)
        s.flush()
        keep = select(ConnectorRun.id).where(ConnectorRun.connector_id == connector_id).order_by(
            col(ConnectorRun.id).desc()
        ).limit(KEEP_RUNS)
        s.exec(
            delete(ConnectorRun).where(
                ConnectorRun.connector_id == connector_id, col(ConnectorRun.id).not_in(keep)
            )
        )
        return run.id


@dataclass(frozen=True, slots=True)
class _Approved:
    """What the gate let through: the installed target and the approval it was checked against."""

    target: RunTarget
    sha256: str
    interpreter: str


def _gate(connector_id: str) -> _Approved | RunResult:
    with get_session() as s:
        row = s.get(Connector, connector_id)
        if row is None:
            return RunResult("", "refused", "not_approved", "no such connector")
        state = refresh(s, row)
        if state.missing:
            return RunResult("", "refused", "missing", "the installed directory is missing")
        if row.status != "approved" or state.loaded is None or not _matches_approval(row):
            kind = "not_approved"
            if row.approved_interpreter and row.approved_interpreter != row.interpreter_path:
                kind = "interpreter_changed"
            return RunResult("", "refused", kind, f"the connector is {row.status}")
        return _Approved(RunTarget.of(state.loaded), row.approved_sha256, row.approved_interpreter)


def runnable(connector_id: str) -> RunTarget | RunResult:
    """The approval gate (own short transaction): a :class:`RunTarget` of the installed dir when the
    connector may run, else a ``refused`` :class:`RunResult` saying why. :func:`run` never executes this
    target itself: it runs a hash-verified snapshot of it (:func:`_run_snapshot`)."""
    gate = _gate(connector_id)
    return gate if isinstance(gate, RunResult) else gate.target


def _interpreter_key(interpreter: Path, root: Path) -> tuple[str, str]:
    """An interpreter inside the connector (``./run``) by its relative path, any other by its path."""
    real, base = Path(os.path.realpath(interpreter)), Path(os.path.realpath(root))
    if base in real.parents:
        return "connector", real.relative_to(base).as_posix()
    return "path", str(real)


def _run_snapshot(connector_id: str, approved: _Approved) -> tuple[RunTarget, Path] | RunResult:
    """Copy the installed dir into a private per-run dir (outside the writable run dir), hash the
    copy and compare it with the approval: the process runs from this copy, so a file changed after the
    gate never runs (BE-15). Returns the copy's target and the dir to delete afterwards."""
    from .runner import make_private_run_dir

    base = make_private_run_dir()
    code = base / "connector"
    try:
        _copy_private(installed_dir(connector_id), code)
        loaded = mf.load_dir(code)
    except (OSError, mf.ManifestError):
        loaded = None
    same = loaded is not None and loaded.content_sha256 == approved.sha256 and _interpreter_key(
        loaded.interpreter, code
    ) == _interpreter_key(Path(approved.interpreter), approved.target.root)
    if not same:
        shutil.rmtree(base, ignore_errors=True)
        with get_session() as s:  # flip it to "changed" now (if the change is still on disk)
            row = s.get(Connector, connector_id)
            if row is not None:
                refresh(s, row)
        return RunResult("", "refused", "not_approved", "the connector changed since it was approved")
    return RunTarget.of(loaded), base


def run(
    connector_id: str,
    command: str,
    *,
    profile_id: int | None = None,
    binding_id: int | None = None,
    sandbox: ConnectorSandbox | None = None,
    **request: Any,
) -> RunResult:
    """Run an approved connector once (from a hash-verified snapshot) and record the run. Never raises
    for a failing connector."""
    gate = _gate(connector_id)
    snapshot = gate if isinstance(gate, RunResult) else _run_snapshot(connector_id, gate)
    if isinstance(snapshot, RunResult):
        snapshot.command = command
        result = snapshot
    else:
        target, snapshot_dir = snapshot
        try:
            result = execute(target, command, sandbox=sandbox, **request)
        finally:
            shutil.rmtree(snapshot_dir, ignore_errors=True)
    result.run_id = record_run(result, connector_id, profile_id=profile_id, binding_id=binding_id)
    return result


def run_file(
    connector_id: str,
    command: str,
    file: Path,
    file_name: str,
    *,
    profile_id: int | None = None,
    account: dict[str, str] | None = None,
    sandbox: ConnectorSandbox | None = None,
) -> RunResult:
    """``detect`` / ``convert`` of an approved file connector (seam for the import integration)."""
    return run(
        connector_id, command, profile_id=profile_id, sandbox=sandbox,
        file=InputFile(Path(file), file_name), account=account,
    )


# --------------------------------------------------------------------------- #
# Bindings
# --------------------------------------------------------------------------- #


def _slug(session: Session, profile_id: int) -> str:
    profile = session.get(Profile, profile_id)
    return profile.slug if profile is not None else "unknown"


def secret_name(connector_id: str, profile_slug: str, binding_id: int, secret_id: str) -> str:
    from .. import secrets

    return secrets.connector_secret_name(connector_id, profile_slug, binding_id, secret_id)


def _delete_secrets(connector_id: str, slug: str, binding_id: int, secret_ids: Iterable[str]) -> int:
    from .. import secrets

    left = 0
    for sid in secret_ids:
        try:
            secrets.delete_connector_secret(secret_name(connector_id, slug, binding_id, sid))
        except (secrets.SecretsError, ValueError):
            left += 1
    return left


def secrets_set(connector_id: str, slug: str, binding_id: int, secret_ids: Iterable[str]) -> list[str]:
    """Which secret ids of a binding have a value in the keychain (never the values)."""
    from .. import secrets

    return [
        sid for sid in secret_ids
        if secrets.get_connector_secret(secret_name(connector_id, slug, binding_id, sid)) is not None
    ]


def validate_params(manifest: mf.Manifest, params: dict[str, Any] | None) -> dict[str, Any]:
    """Check binding params against the manifest; returns the cleaned dict. Raises ConnectorError."""
    params = dict(params or {})
    specs = {p.id: p for p in (manifest.fetch.params if manifest.fetch else [])}
    issues: dict[str, str] = {}
    for key in params:
        if key not in specs:
            issues[str(key)[:64]] = "unknown param"
    clean: dict[str, Any] = {}
    for pid, spec in specs.items():
        value = params.get(pid)
        if value is None or value == "":
            if spec.required:
                issues[pid] = "required"
            continue
        if spec.type == "boolean" and not isinstance(value, bool):
            issues[pid] = "must be true or false"
        elif spec.type == "number" and (isinstance(value, bool) or not isinstance(value, int | float)):
            issues[pid] = "must be a number"
        elif spec.type in ("string", "date") and not isinstance(value, str):
            issues[pid] = "must be text"
        elif spec.type == "date" and not _valid_date(value):
            issues[pid] = "must be a date YYYY-MM-DD"
        elif isinstance(value, str) and len(value) > MAX_PARAM_CHARS:
            issues[pid] = f"longer than {MAX_PARAM_CHARS} characters"
        else:
            clean[pid] = value
    if issues:
        raise ParamsError("invalid params", issues)
    return clean


def _valid_date(value: str) -> bool:
    if not _DATE.match(value):
        return False
    try:
        dt.date.fromisoformat(value)
    except ValueError:
        return False
    return True


def binding_dict(
    row: ConnectorBinding, connector: Connector, slug: str, account_label: str | None = None
) -> dict:
    manifest = manifest_of(connector)
    return {
        "id": row.id,
        "account_id": row.account_id,
        "account_label": account_label,
        "has_commit": row.last_ok_at is not None,
        "connector_id": row.connector_id,
        "connector_name": connector.name,
        "connector_status": connector.status,
        "module": connector.module,
        "params": row.params_json,
        "auto_commit": row.auto_commit,
        "has_cursor": row.cursor is not None,
        "last_run_at": _iso(row.last_run_at),
        "last_status": row.last_status,
        "last_ok_at": _iso(row.last_ok_at),
        "backoff_until": _iso(row.backoff_until),
        "secrets": [{"id": s.id, "label": s.label} for s in manifest.fetch.secrets]
        if manifest.fetch else [],
        "secrets_set": secrets_set(row.connector_id, slug, row.id, manifest.secret_ids),
        "created_at": _iso(row.created_at),
        "updated_at": _iso(row.updated_at),
    }


def _binding(session: Session, profile: Profile, binding_id: int) -> tuple[ConnectorBinding, Connector]:
    row = session.get(ConnectorBinding, binding_id)
    if row is None or row.profile_id != profile.id:  # another profile's binding is not found
        raise NotFound(f"no binding {binding_id}")
    return row, _get(session, row.connector_id)


def list_bindings(profile: Profile) -> list[dict]:
    with get_session() as s:
        rows = s.exec(
            select(ConnectorBinding)
            .where(ConnectorBinding.profile_id == profile.id)
            .order_by(ConnectorBinding.id)
        ).all()
        return [
            binding_dict(r, _get(s, r.connector_id), profile.slug, _account_label(s, r.account_id))
            for r in rows
        ]


def get_binding(profile: Profile, binding_id: int) -> dict:
    with get_session() as s:
        row, connector = _binding(s, profile, binding_id)
        return binding_dict(row, connector, profile.slug, _account_label(s, row.account_id))


def _account_label(session: Session, account_id: int) -> str | None:
    """The account's name for the owner's app (bindings live only in the app; never MCP)."""
    account = session.get(Account, account_id)
    return account.name if account is not None else None


def _check_account(session: Session, profile: Profile, account_id: int, module: str) -> None:
    from .. import profiles

    account = session.get(Account, account_id)
    if account is None or account.profile_id != profile.id or account.removed_at is not None:
        raise NotFound(f"no account {account_id}")
    if module not in profiles.enabled_modules(session, profile.id):
        raise ConnectorError(f"the {module} module is not enabled for this profile")
    if module == "investments" and account.type != BROKERAGE:
        raise ConnectorError("an investments connector needs a brokerage account")
    if module == "budget" and (account.type not in BANK_TYPES or account.bank == "manual"):
        raise ConnectorError("a budget connector needs a bank account")


def create_binding(
    profile: Profile,
    *,
    account_id: int,
    connector_id: str,
    params: dict[str, Any] | None = None,
    secrets: dict[str, str] | None = None,
    auto_commit: bool = False,
) -> dict:
    """Bind a fetch connector to an account of ``profile`` (secrets go to the keychain only)."""
    with get_session() as s:
        connector = _get(s, connector_id)
        if connector.kind != "fetch":
            raise ConnectorError("only fetch connectors are bound to an account")
        refresh(s, connector)
        if connector.status != "approved":
            raise NotApproved(f"the connector is {connector.status}; approve it first")
        manifest = manifest_of(connector)
        _check_account(s, profile, account_id, connector.module)
        clean = validate_params(manifest, params)
        _check_secret_ids(manifest, secrets)
        if s.exec(
            select(ConnectorBinding).where(
                ConnectorBinding.account_id == account_id,
                ConnectorBinding.connector_id == connector_id,
            )
        ).first() is not None:
            raise BindingExists("this account already uses this connector")
        row = ConnectorBinding(
            profile_id=profile.id, account_id=account_id, connector_id=connector_id,
            params_json=clean, auto_commit=bool(auto_commit),
        )
        s.add(row)
        s.flush()
        binding_id = row.id
    if secrets:
        _store_secrets(connector_id, profile.slug, binding_id, secrets)
    return get_binding(profile, binding_id)


def update_binding(
    profile: Profile,
    binding_id: int,
    *,
    params: dict[str, Any] | None = None,
    auto_commit: bool | None = None,
) -> dict:
    with get_session() as s:
        row, connector = _binding(s, profile, binding_id)
        if params is not None:
            row.params_json = validate_params(manifest_of(connector), params)
        if auto_commit is not None:
            row.auto_commit = bool(auto_commit)
        row.updated_at = utcnow()
        s.add(row)
    return get_binding(profile, binding_id)


def _check_secret_ids(manifest: mf.Manifest, values: dict[str, Any] | None) -> None:
    unknown = sorted(set(values or {}) - set(manifest.secret_ids))
    if unknown:
        raise ConnectorError("unknown secrets", issues=[f"{k}: unknown secret" for k in unknown])
    for key, value in (values or {}).items():
        if value is not None and (not isinstance(value, str) or len(value) > 4096):
            raise ConnectorError("invalid secret", issues=[f"{key}: must be text (at most 4096)"])


def _store_secrets(connector_id: str, slug: str, binding_id: int, values: dict[str, str | None]) -> None:
    from .. import secrets

    for sid, value in values.items():
        name = secret_name(connector_id, slug, binding_id, sid)
        if value:
            secrets.set_connector_secret(name, value)
        else:
            secrets.delete_connector_secret(name)


def set_binding_secrets(profile: Profile, binding_id: int, values: dict[str, str | None]) -> list[str]:
    """Write-only: set (text) or clear (null / empty) secrets; returns which ids are set now."""
    with get_session() as s:
        row, connector = _binding(s, profile, binding_id)
        manifest = manifest_of(connector)
        _check_secret_ids(manifest, values)
        cid = row.connector_id
    _store_secrets(cid, profile.slug, binding_id, values)
    return secrets_set(cid, profile.slug, binding_id, manifest.secret_ids)


def delete_binding(profile: Profile, binding_id: int) -> Removed:
    with get_session() as s:
        row, connector = _binding(s, profile, binding_id)
        secret_ids = manifest_of(connector).secret_ids
        cid = row.connector_id
    left = _delete_secrets(cid, profile.slug, binding_id, secret_ids)
    with get_session() as s:
        row = s.get(ConnectorBinding, binding_id)
        if row is not None:
            s.delete(row)
    return Removed(1, left)


def _binding_secrets(connector_id: str, slug: str, binding_id: int, ids: Iterable[str]) -> dict[str, str]:
    from .. import secrets

    out = {}
    for sid in ids:
        value = secrets.get_connector_secret(secret_name(connector_id, slug, binding_id, sid))
        if value is not None:
            out[sid] = value
    return out


def _account_info(session: Session, account_id: int) -> dict[str, str] | None:
    account = session.get(Account, account_id)
    return None if account is None else {"currency": account.currency, "label": account.name}


def _mark_attempt(binding_id: int) -> None:
    """Record the attempt before anything reaches the network (polite scheduling)."""
    with get_session() as s:
        row = s.get(ConnectorBinding, binding_id)
        if row is not None:
            row.last_run_at = row.updated_at = utcnow()
            s.add(row)


def _finish(binding_id: int, result: RunResult) -> None:
    with get_session() as s:
        row = s.get(ConnectorBinding, binding_id)
        if row is not None:
            row.last_status = result.outcome
            row.updated_at = utcnow()
            s.add(row)


def check_binding(profile: Profile, binding_id: int, *, sandbox: ConnectorSandbox | None = None) -> RunResult:
    """Run ``check`` (credentials + reachability, no data) for a binding. Not a sync attempt: it
    never touches ``last_run_at``, so testing a binding never delays its first scheduled sync (the run
    is recorded, ``last_status`` shows its outcome)."""
    with get_session() as s:
        row, connector = _binding(s, profile, binding_id)
        manifest = manifest_of(connector)
        params, account = dict(row.params_json), _account_info(s, row.account_id)
        cid = row.connector_id
    secrets_ = _binding_secrets(cid, profile.slug, binding_id, manifest.secret_ids)
    result = run(
        cid, "check", profile_id=profile.id, binding_id=binding_id, sandbox=sandbox,
        params=params, secrets=secrets_, account=account,
    )
    _finish(binding_id, result)
    return result


@dataclass(frozen=True, slots=True)
class FetchOutcome:
    """A fetch run of a binding: the document and the new cursor when it worked. The cursor is NOT
    saved here: it is saved only when the import it produced is committed or approved."""

    result: RunResult
    document: dict | None
    cursor: str | None
    since: str


def fetch_since(row: ConnectorBinding, manifest: mf.Manifest, today: dt.date | None = None) -> str:
    """``since`` of the next fetch: the day of the last successful fetch, else ``history_days`` back."""
    today = today or dt.datetime.now(dt.UTC).astimezone().date()  # the local calendar day
    if row.last_ok_at is not None:
        return row.last_ok_at.date().isoformat()
    days = manifest.fetch.history_days if manifest.fetch else mf.DEFAULT_HISTORY_DAYS
    return (today - dt.timedelta(days=days)).isoformat()


def run_fetch(
    profile: Profile, binding_id: int, *, sandbox: ConnectorSandbox | None = None
) -> FetchOutcome:
    """Run ``fetch`` for a binding (seam for BE-C3's sync: preview / proposal / commit live there)."""
    with get_session() as s:
        row, connector = _binding(s, profile, binding_id)
        manifest = manifest_of(connector)
        params, account = dict(row.params_json), _account_info(s, row.account_id)
        cursor, since, cid = row.cursor, fetch_since(row, manifest), row.connector_id
    secrets_ = _binding_secrets(cid, profile.slug, binding_id, manifest.secret_ids)
    _mark_attempt(binding_id)
    result = run(
        cid, "fetch", profile_id=profile.id, binding_id=binding_id, sandbox=sandbox,
        params=params, secrets=secrets_, account=account, since=since, cursor=cursor,
    )
    _finish(binding_id, result)
    if result.ok and isinstance(result.response, proto.DocumentResponse):
        return FetchOutcome(result, result.response.document, result.response.cursor, since)
    return FetchOutcome(result, None, None, since)


def run_dict(result: RunResult) -> dict:
    """A run for the owner (the app): kind, message, counts. Never sent to MCP as is (message)."""
    return {
        "run_id": result.run_id,
        "command": result.command,
        "outcome": result.outcome,
        "ok": result.ok,
        "error_kind": result.error_kind,
        "message": result.message,
        "duration_ms": result.duration_ms,
        "records": result.records,
        "denied_hosts": result.denied_hosts,
    }


__all__ = [
    "Conflict",
    "ConnectorError",
    "FetchOutcome",
    "NotFound",
    "approve",
    "check_binding",
    "connectors_root",
    "create_binding",
    "delete_binding",
    "detail_dict",
    "disable",
    "install",
    "list_bindings",
    "list_connectors",
    "read_file",
    "record_run",
    "refresh",
    "remove",
    "run",
    "run_fetch",
    "run_file",
    "runnable",
    "set_binding_secrets",
    "update_binding",
]
