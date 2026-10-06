"""Export copies kept only until an import is decided are pruned (F5 R9): abandoned preview uploads
after a day, proposal exports once no pending proposal references them; at app start and in every
worker run. Committed archives are never touched."""

from __future__ import annotations

import os
import time

import pytest

from cashu.core import profiles, proposals
from cashu.core.db import get_session
from cashu.modules.investments.service import files, staging

DAY = 24 * 3600


def _write(path, age_seconds: float = 0.0):
    files.write_private(path, b"Data;Konto PL61 1090 1014 0000 0712 1981 2874\n")
    if age_seconds:
        t = time.time() - age_seconds
        os.utime(path, (t, t))
    return path


@pytest.fixture
def layout(db_engine):
    """One profile with old / fresh uploads, a pending proposal's export, orphaned exports and an
    archived (committed) file."""
    with get_session() as s:
        profile = profiles.create_profile(s, name="Staging", modules_=["investments"])
        pid, slug = profile.id, profile.slug
    imports = files.imports_dir(slug)
    paths = {
        "old_upload": _write(imports / ".staging" / ("a" * 64 + ".csv"), 2 * DAY),
        "fresh_upload": _write(imports / ".staging" / ("b" * 64 + ".csv"), 60),
        "pending_export": _write(imports / ".proposals" / ("c" * 64 + ".csv"), 30 * DAY),
        "rejected_export": _write(imports / ".proposals" / ("d" * 64 + ".csv"), 2 * 3600),
        "fresh_orphan": _write(imports / ".proposals" / ("e" * 64 + ".csv"), 60),
        "archive": _write(imports / ("f" * 64 + ".csv"), 90 * DAY),
    }
    with get_session() as s:
        for key, status in (("pending_export", "pending"), ("rejected_export", "failed")):
            row = proposals.create(
                s,
                pid,
                "import",
                {"staged": files.relative_to_data_dir(paths[key])},
                summary="Import",
            )
            row.status = status
            s.add(row)
    return paths


def _alive(paths) -> set[str]:
    return {k for k, p in paths.items() if p.exists()}


def test_prune_removes_abandoned_uploads_and_unreferenced_exports(layout):
    report = staging.prune()
    assert _alive(layout) == {"fresh_upload", "pending_export", "fresh_orphan", "archive"}
    assert report.stats() == {"removed": 2, "kept": 3, "errors": 0}
    assert staging.prune().removed == 0  # idempotent


def test_prune_keeps_every_proposal_export_when_proposals_cannot_be_listed(layout):
    def broken():
        raise RuntimeError("database is locked")

    staging.prune(session_factory=broken)
    assert {"pending_export", "rejected_export", "fresh_orphan"} <= _alive(layout)
    assert "old_upload" not in _alive(layout)  # uploads only depend on their age


def test_worker_run_prunes(layout, tmp_path):
    from cashu.core.worker import runner

    runner.run_worker(notifier=None, offline=True, budget=False, state_path=tmp_path / "s.json")
    assert "old_upload" not in _alive(layout) and "rejected_export" not in _alive(layout)
    assert "pending_export" in _alive(layout)


def test_app_start_prunes(layout):
    from fastapi.testclient import TestClient

    from cashu.api.app import app

    with TestClient(app):  # runs the lifespan (init_db + pruning)
        pass
    assert "old_upload" not in _alive(layout) and "rejected_export" not in _alive(layout)
    assert {"fresh_upload", "pending_export", "archive"} <= _alive(layout)
