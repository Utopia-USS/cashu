"""Pruning of the export copies kept only until an import is decided (F5 R9).

Broker exports carry account numbers and names, so copies the app no longer needs do not stay in the
data dir:

- ``<data dir>/imports/<slug>/.staging/``: uploads kept between the preview and the commit (the commit
  re-previews the staged file and removes it). An upload older than ``STAGING_MAX_AGE`` was abandoned.
- ``<data dir>/imports/<slug>/.proposals/``: the export of an import proposal (an agent's, or a fetch
  connector's document, also ``budget_import``). Kept while a
  pending (or applying) proposal references it; any other file older than ``PROPOSAL_GRACE`` is removed
  (the grace covers a proposal being stored right now: its file is written before its row commits).

Committed imports are archived elsewhere (``imports/<slug>/<sha256>.<ext>``) and never touched here.
``prune`` runs at app start and in every worker run; it never raises (a pruning problem is logged and
counted, the next run tries again).
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from cashu.core import paths
from cashu.core.db import get_session

STAGING_MAX_AGE = 24 * 3600.0  # seconds
PROPOSAL_GRACE = 3600.0  # seconds
_log = logging.getLogger("cashu.investments.staging")


@dataclass
class PruneReport:
    removed: int = 0
    kept: int = 0
    errors: int = 0

    def stats(self) -> dict[str, int]:
        return {"removed": self.removed, "kept": self.kept, "errors": self.errors}


def _referenced(session_factory: Callable) -> set[Path] | None:
    """Staged files of pending / applying import proposals (None: unknown, keep every one)."""
    from sqlmodel import select

    from cashu.core.agent_models import Proposal

    root = paths.data_dir().resolve()
    try:
        with session_factory() as s:
            rows = s.exec(
                select(Proposal).where(
                    Proposal.kind.in_(("import", "budget_import")),
                    Proposal.status.in_(("pending", "applying")),
                )
            ).all()
            staged = [str((row.payload or {}).get("staged") or "") for row in rows]
    except Exception:  # noqa: BLE001 - without the list nothing in .proposals is removed
        _log.exception("cannot list the pending import proposals")
        return None
    return {(root / rel).resolve() for rel in staged if rel}


def prune(*, now: float | None = None, session_factory: Callable = get_session) -> PruneReport:
    """Remove abandoned preview uploads and unreferenced proposal exports (see the module doc)."""
    report = PruneReport()
    root = paths.data_dir() / "imports"
    if not root.is_dir():
        return report
    clock = time.time() if now is None else now
    referenced = _referenced(session_factory)
    for folder in sorted(root.iterdir()):
        if folder.is_symlink() or not folder.is_dir():
            continue
        for name, max_age, keep in (
            (".staging", STAGING_MAX_AGE, set()),
            (".proposals", PROPOSAL_GRACE, referenced),
        ):
            staged = folder / name
            if staged.is_symlink() or not staged.is_dir():
                continue
            for path in sorted(staged.iterdir()):
                try:
                    if path.is_symlink() or not path.is_file():
                        continue
                    if keep is None or path.resolve() in keep:
                        report.kept += 1
                        continue
                    if clock - path.stat().st_mtime < max_age:
                        report.kept += 1
                        continue
                    path.unlink(missing_ok=True)
                    report.removed += 1
                except OSError:
                    _log.exception("cannot prune %s", path.name)
                    report.errors += 1
    return report


def prune_quietly() -> PruneReport | None:
    """``prune`` for startup and the worker: never raises."""
    try:
        return prune()
    except Exception:  # noqa: BLE001 - housekeeping must never stop the app or the worker
        _log.exception("pruning staged imports failed")
        return None
