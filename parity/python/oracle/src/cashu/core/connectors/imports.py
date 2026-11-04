"""File connectors in the in-app imports (both modules): which approved connectors read a file,
``detect`` for the ``auto`` importer and ``convert`` for ``connector:<id>``.

The module services never run a connector themselves: the HTTP layer calls :func:`convert` (or
:func:`detect_and_convert` for ``auto``) BEFORE it opens a database session, and hands the converted
document bytes to the module's normal preview / commit (investments ``CanonicalImporter``, budget
``from_document``). The staged file of such a preview is the converted document, so the commit never
runs the connector again.

A failed run is :class:`ConnectorRunFailed`: the owner's app gets a 422 with the header
``X-Cashu-Error-Code: connector_<kind>`` and a ``detail`` object (kind, the connector's own message,
the redacted stderr tail, the timeout, the connector's id and name). MCP never reaches this module (an
MCP call can never make the app run code), so the message and the stderr tail stay in the owner's app.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlmodel import select

from .. import paths
from ..db import get_session
from . import manifest as mf
from . import protocol as proto
from . import service
from .models import Connector
from .runner import RunResult
from .sandbox import ConnectorSandbox

PREFIX = "connector:"
MAX_DETECT = 5  # connectors asked per auto-detect (each detect is capped at 10 s)
MIN_CONFIDENCE = 0.5


def connector_id_of(choice: str | None) -> str | None:
    """``connector:<id>`` -> ``<id>`` (None for any other importer choice)."""
    value = (choice or "").strip()
    if not value.lower().startswith(PREFIX):
        return None
    return value[len(PREFIX):].strip()


def choice_of(connector_id: str) -> str:
    return f"{PREFIX}{connector_id}"


class ConnectorRunFailed(Exception):
    """A connector could not convert the file (owner-only details, never MCP)."""

    status = 422

    def __init__(
        self,
        kind: str,
        message: str | None,
        *,
        connector_id: str,
        name: str | None = None,
        stderr_tail: str | None = None,
        timeout_s: int | None = None,
    ) -> None:
        super().__init__(f"connector {connector_id}: {kind}")
        self.kind = kind
        self.message = message
        self.connector_id = connector_id
        self.name = name
        self.stderr_tail = stderr_tail
        self.timeout_s = timeout_s

    @property
    def code(self) -> str:
        return f"connector_{self.kind}"

    def detail(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "message": self.message,
            "stderr_tail": self.stderr_tail,
            "timeout_s": self.timeout_s,
            "connector": {"id": self.connector_id, "name": self.name or self.connector_id},
        }


def http_error(e: ConnectorRunFailed):
    """The owner's 422 (header ``X-Cashu-Error-Code: connector_<kind>``, ``detail`` an object)."""
    from fastapi import HTTPException

    return HTTPException(
        status_code=e.status, detail=e.detail(), headers={"X-Cashu-Error-Code": e.code}
    )


def owner_kind(result: RunResult, status: str | None) -> str:
    """The error kind the owner sees: a refused run says why in the connector's own status words
    (``not_approved`` = pending, ``changed``, ``disabled``)."""
    kind = result.error_kind or "internal"
    if result.outcome == "refused" and kind in ("not_approved", "interpreter_changed"):
        if kind == "interpreter_changed" or status == "changed":
            return "changed"
        if status == "disabled":
            return "disabled"
        return "not_approved"
    return kind


@dataclass(frozen=True, slots=True)
class Candidate:
    id: str
    name: str
    status: str
    extensions: tuple[str, ...]
    timeout_s: int


def file_connectors(module: str, file_name: str | None = None, *, approved_only: bool = True) -> list[Candidate]:
    """File connectors of ``module`` (status re-checked from disk), optionally only those whose
    extensions include ``file_name``'s; ordered by id."""
    ext = Path(file_name).suffix.lower().lstrip(".") if file_name else None
    out = []
    with get_session() as s:
        rows = s.exec(
            select(Connector)
            .where(Connector.module == module, Connector.kind == "file")
            .order_by(Connector.id)
        ).all()
        for row in rows:
            service.refresh(s, row)
            if approved_only and row.status != "approved":
                continue
            m = row.manifest_json
            extensions = tuple((m.get("file") or {}).get("extensions") or ())
            if ext is not None and ext not in extensions:
                continue
            out.append(Candidate(
                row.id, row.name, row.status, extensions, int(m.get("timeout_s", mf.DEFAULT_TIMEOUT_S))
            ))
    return out


def _row_facts(connector_id: str) -> tuple[str | None, str | None, str | None, str | None, int | None]:
    """(name, status, module, kind, timeout_s) of an installed connector, Nones when unknown."""
    with get_session() as s:
        row = s.get(Connector, connector_id)
        if row is None:
            return None, None, None, None, None
        service.refresh(s, row)
        timeout = int(row.manifest_json.get("timeout_s", mf.DEFAULT_TIMEOUT_S))
        return row.name, row.status, row.module, row.kind, timeout


@dataclass(frozen=True, slots=True)
class Converted:
    """A connector's ``convert`` output: the document as JSON bytes, ready for the module parser."""

    connector_id: str
    name: str
    content: bytes
    document: dict
    run_id: int | None
    detected: bool = False
    confidence: float | None = None


def convert(
    connector_id: str,
    module: str,
    path: Path,
    file_name: str,
    *,
    profile_id: int | None = None,
    account: dict[str, str] | None = None,
    sandbox: ConnectorSandbox | None = None,
) -> Converted:
    """Run ``convert`` of an approved file connector of ``module`` (no database transaction is open
    during the run). Raises :class:`ConnectorRunFailed`."""
    name, status, row_module, kind, timeout = _row_facts(connector_id)
    if name is None:
        raise ConnectorRunFailed("not_approved", "no such connector", connector_id=connector_id)
    if row_module != module or kind != "file":
        raise ConnectorRunFailed(
            "bad_request", f"the connector is a {row_module} {kind} connector",
            connector_id=connector_id, name=name, timeout_s=timeout,
        )
    result = service.run_file(
        connector_id, "convert", path, file_name,
        profile_id=profile_id, account=account, sandbox=sandbox,
    )
    if not result.ok or not isinstance(result.response, proto.DocumentResponse):
        raise ConnectorRunFailed(
            owner_kind(result, status), result.message,
            connector_id=connector_id, name=name, stderr_tail=result.stderr_tail, timeout_s=timeout,
        )
    document = result.response.document
    content = proto.document_bytes(document)
    return Converted(connector_id, name, content, document, result.run_id)


def detect(
    module: str,
    path: Path,
    file_name: str,
    *,
    profile_id: int | None = None,
    prefer: str | None = None,
    sandbox: ConnectorSandbox | None = None,
) -> tuple[str, float] | None:
    """``auto``: ask approved file connectors of ``module`` reading this extension (``prefer`` = the
    account's remembered connector first; at most :data:`MAX_DETECT`, one after another, 10 s each)
    and return the most confident match with confidence >= :data:`MIN_CONFIDENCE`. A failing detect
    counts as "no" (it is recorded in the run log)."""
    candidates = file_connectors(module, file_name)
    if prefer:
        candidates.sort(key=lambda c: c.id != prefer)
    best: tuple[str, float] | None = None
    for c in candidates[:MAX_DETECT]:
        result = service.run_file(
            c.id, "detect", path, file_name, profile_id=profile_id, sandbox=sandbox
        )
        response = result.response
        if not result.ok or not isinstance(response, proto.DetectResponse) or not response.match:
            continue
        if response.confidence >= MIN_CONFIDENCE and (best is None or response.confidence > best[1]):
            best = (c.id, response.confidence)
    return best


def detect_and_convert(
    module: str,
    path: Path,
    file_name: str,
    *,
    profile_id: int | None = None,
    prefer: str | None = None,
    account: dict[str, str] | None = None,
    sandbox: ConnectorSandbox | None = None,
) -> Converted | None:
    """``auto`` after the built-in importers found nothing: detect, then convert with the winner
    (None when no connector claims the file; :class:`ConnectorRunFailed` when the winner fails)."""
    found = detect(
        module, path, file_name, profile_id=profile_id, prefer=prefer, sandbox=sandbox
    )
    if found is None:
        return None
    out = convert(
        found[0], module, path, file_name, profile_id=profile_id, account=account, sandbox=sandbox
    )
    return Converted(
        out.connector_id, out.name, out.content, out.document, out.run_id, True, found[1]
    )


@contextmanager
def upload_file(content: bytes, file_name: str) -> Iterator[Path]:
    """An uploaded file as a private temp file under the data dir (``tmp/connectors/``), removed on
    exit: what :func:`convert` / :func:`detect` read (the run gets its own copy)."""
    from .runner import runs_dir

    base = runs_dir()
    current = paths.ensure_private_dir(paths.data_dir())
    for part in ("tmp", "connectors"):
        current = paths.ensure_private_dir(current / part)
    ext = Path(file_name).suffix.lower().lstrip(".")
    path = base / f"upload-{uuid.uuid4().hex}{'.' + ext if ext.isalnum() and len(ext) <= 10 else ''}"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(content)
        yield path
    finally:
        path.unlink(missing_ok=True)


def connector_name(connector_id: str) -> str:
    name = _row_facts(connector_id)[0]
    return name or connector_id


def importer_entries(module: str) -> list[dict[str, Any]]:
    """Importer choices for a module's import drawer: every file connector of the module, approved
    ones ``available``."""
    return [
        {
            "id": choice_of(c.id),
            "name": c.name,
            "kind": "connector",
            "available": c.status == "approved",
            "status": c.status,
            "extensions": list(c.extensions),
            "timeout_s": c.timeout_s,
        }
        for c in file_connectors(module, approved_only=False)
    ]


__all__ = [
    "PREFIX",
    "ConnectorRunFailed",
    "Converted",
    "choice_of",
    "connector_id_of",
    "convert",
    "detect",
    "detect_and_convert",
    "file_connectors",
    "http_error",
    "importer_entries",
    "owner_kind",
]
