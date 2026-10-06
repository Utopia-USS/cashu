"""Proposal kind ``budget_import``: a bank statement fetched by a connector, waiting for the owner.

Created only by a fetch sync (``connectors.sync``; never by MCP): the converted
``finanse-budget-import`` document is stored in ``<data dir>/imports/<slug>/.proposals/budget-<sha>-<token>.json``
and the payload carries the binding's sync state at fetch time and the cursor to save. Approving
re-checks the binding (``binding_missing``, ``connector_not_approved``, ``cursor_conflict``), commits the
stored document into the bound account with the budget import service (nothing runs: the document is
already converted) and saves the cursor in the approval transaction. Rejecting removes the stored
document. Kinds of this module are loaded lazily by ``core.proposals`` (``KIND_PROVIDERS``).
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from sqlmodel import Session

from ..agent_models import Proposal
from ..db import get_session
from ..models import Profile
from ..proposals import ProposalError, ProposalKind, Staged


def _staged_file(relative: str) -> Path:
    from .. import paths
    from ..mcp.tools.exports import inside

    root = paths.data_dir().resolve()
    path = (root / (relative or "")).resolve()
    if not relative or not inside(path, root):
        raise ProposalError("the stored file path is invalid", "staged_missing")
    return path


def _detail(session: Session, profile: Profile, row: Proposal) -> dict[str, Any]:
    p = row.payload or {}
    return {
        "account": p.get("account_label"),
        "account_label": p.get("account_label"),
        "connector_name": p.get("connector_name"),
        "since": p.get("since"),
        "preview": p.get("preview"),
        "file_name": p.get("file_name"),
    }


def _apply(profile: Profile, row: Proposal) -> Staged:
    from finanse.modules.budget import imports as budget_imports

    from . import sync

    p = row.payload or {}
    sync.check_proposal(p)
    staged = _staged_file(p.get("staged") or "")
    if not staged.is_file():
        raise ProposalError("the stored statement is gone; synchronise again", "staged_missing")
    if hashlib.sha256(staged.read_bytes()).hexdigest() != p.get("file_sha256"):
        raise ProposalError("the stored statement changed; synchronise again", "staged_changed")
    upload = budget_imports.Upload(p["file_sha256"], p.get("file_name") or staged.name, staged)
    try:
        result = budget_imports.commit(
            get_session,
            profile,
            upload,
            importer=f"connector:{p.get('connector_id')}",
            account_id=p.get("account_id"),
        )
    except budget_imports.ImportProblem as e:
        raise ProposalError(str(e), "import_failed") from None
    out = {
        "batch_id": result["batch_id"],
        "inserted": result["inserted"],
        "duplicates": result["duplicates"],
        "categorized": result["categorized"],
    }
    return Staged(
        out,
        record=lambda s: sync.record_approved(s, p, row.id, f"budget:{result['batch_id']}"),
    )


def _discard(row: Proposal) -> None:
    try:
        _staged_file((row.payload or {}).get("staged") or "").unlink(missing_ok=True)
    except (ProposalError, OSError):
        pass


KINDS = (ProposalKind("budget_import", _detail, _apply, _discard),)
