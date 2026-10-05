"""Approving and rejecting proposals: the shared approval lock (F5 R3) and the strategy approval that
records the version together with the proposal status and writes the files only after the commit
(F5 R8)."""

from __future__ import annotations

import dataclasses
import threading
from pathlib import Path

import pytest
from mcp_support import STRATEGY_YAML, TODAY
from sqlalchemy.exc import OperationalError
from sqlmodel import select

from finanse.core import locks, proposals
from finanse.core.agent_models import Proposal
from finanse.core.db import get_session
from finanse.core.mcp.server import FinanseMcp
from finanse.core.mcp.tools import investments_proposals
from finanse.core.models import Profile
from finanse.modules.investments.models import InvStrategyVersion
from finanse.modules.investments.service import files

NEW_DEPOSIT = (
    "format_version,record,date,time,type,external_ref,symbol,isin,name,exchange,quantity,price,"
    "currency,gross_amount,fee,tax,cash_amount,cash_currency,fx_rate,split_ratio,source\n"
    "1,txn,2026-01-05,,deposit,N-1,,,,,,,PLN,,,,1000.00,,,,\n"
)


@pytest.fixture
def setup(db_engine):
    from conftest import make_client
    from mcp_support import seed_profile

    from finanse.api.app import app

    pid, slug = seed_profile(run_daily=False)
    return pid, slug, FinanseMcp(pid, today=TODAY), make_client(app)


def _profile(pid: int) -> Profile:
    with get_session() as s:
        return s.get(Profile, pid)


def _status(proposal_id: int) -> str:
    with get_session() as s:
        return s.get(Proposal, proposal_id).status


def _versions(pid: int) -> list[int]:
    with get_session() as s:
        rows = s.exec(select(InvStrategyVersion).where(InvStrategyVersion.profile_id == pid))
        return sorted(v.version for v in rows)


def _propose_strategy(host, slug) -> tuple[int, str]:
    from finanse.modules.investments.service import strategy as strategy_files

    with get_session() as s:  # version 1 = the current files
        strategy_files.load(
            s, s.exec(select(Profile).where(Profile.slug == slug)).one(), record=True
        )
    new_yaml = STRATEGY_YAML.replace("max_weight: 0.20", "max_weight: 0.25")
    stored = host.call("propose_strategy", {"yaml": new_yaml}).data
    assert stored["stored"], stored
    return stored["proposal_id"], new_yaml


class SlowApply:
    """Wraps a kind's ``apply`` so a test can act while the approval is applying it."""

    def __init__(self, monkeypatch, kind: str) -> None:
        self.started, self.release = threading.Event(), threading.Event()
        original = proposals.kinds()[kind]

        def apply(profile, row):
            self.started.set()
            assert self.release.wait(10)
            return original.apply(profile, row)

        monkeypatch.setitem(proposals.kinds(), kind, dataclasses.replace(original, apply=apply))

    def approve_in_thread(
        self, profile: Profile, proposal_id: int
    ) -> tuple[threading.Thread, list]:
        out: list = []

        def run():
            try:
                out.append(proposals.approve(profile, proposal_id))
            except Exception as e:  # noqa: BLE001 - asserted by the test
                out.append(e)

        thread = threading.Thread(target=run)
        thread.start()
        assert self.started.wait(10)
        return thread, out


# --------------------------------------------------------------------------- #
# R3: reject takes the approval lock
# --------------------------------------------------------------------------- #


def test_reject_during_an_approval_answers_busy_and_the_approval_wins(setup, monkeypatch):
    pid, slug, host, api = setup
    proposal_id, new_yaml = _propose_strategy(host, slug)
    slow = SlowApply(monkeypatch, "strategy")
    monkeypatch.setattr(proposals, "REJECT_WAIT", 0.2)
    thread, out = slow.approve_in_thread(_profile(pid), proposal_id)
    try:
        assert api.get(f"/api/p/{slug}/proposals/{proposal_id}").json()["status"] == "applying"
        response = api.post(f"/api/p/{slug}/proposals/{proposal_id}/reject", json={"note": "nie"})
        assert response.status_code == 409
        assert response.headers["X-Finanse-Error-Code"] == "busy"
    finally:
        slow.release.set()
        thread.join(10)
    assert isinstance(out[0], Proposal) and out[0].status == "approved"
    assert _status(proposal_id) == "approved"
    assert files.strategy_yaml_path(slug).read_text() == new_yaml
    late = api.post(f"/api/p/{slug}/proposals/{proposal_id}/reject")
    assert late.status_code == 409 and late.headers["X-Finanse-Error-Code"] == "not_pending"


def test_reject_waits_for_the_running_approval_and_never_overwrites_it(setup, monkeypatch):
    pid, slug, host, _api = setup
    proposal_id, new_yaml = _propose_strategy(host, slug)
    slow = SlowApply(monkeypatch, "strategy")
    thread, out = slow.approve_in_thread(_profile(pid), proposal_id)
    rejected: list = []

    def reject():
        try:
            rejected.append(proposals.reject(pid, proposal_id, "za późno"))
        except Exception as e:  # noqa: BLE001
            rejected.append(e)

    rejecter = threading.Thread(target=reject)
    rejecter.start()
    rejecter.join(0.5)
    assert rejecter.is_alive()  # waiting for the approval lock
    slow.release.set()
    thread.join(10)
    rejecter.join(10)
    assert isinstance(rejected[0], proposals.ProposalConflict)
    assert out[0].status == "approved" and _status(proposal_id) == "approved"
    assert files.strategy_yaml_path(slug).read_text() == new_yaml
    assert _versions(pid) == [1, 2]


def test_reject_never_deletes_the_staged_export_mid_apply(setup, monkeypatch, tmp_path):
    from finanse.core import paths

    pid, slug, host, api = setup
    path = tmp_path / "new.csv"
    path.write_text(NEW_DEPOSIT)
    label = host.call("portfolio_overview", {}).data["accounts"][0]["account"]
    proposal_id = host.call("propose_import", {"path": str(path), "account": label}).data[
        "proposal_id"
    ]
    with get_session() as s:
        staged = paths.data_dir() / s.get(Proposal, proposal_id).payload["staged"]
    slow = SlowApply(monkeypatch, "import")
    monkeypatch.setattr(proposals, "REJECT_WAIT", 0.2)
    thread, out = slow.approve_in_thread(_profile(pid), proposal_id)
    try:
        response = api.post(f"/api/p/{slug}/proposals/{proposal_id}/reject")
        assert response.status_code == 409
        assert staged.is_file()  # still there for the running approval
    finally:
        slow.release.set()
        thread.join(10)
    assert out[0].status == "approved" and out[0].result["inserted"] == 1
    assert not staged.exists()  # removed by the commit (archived)


def test_an_interrupted_approval_is_closed_out_as_failed(setup):
    _pid, slug, host, api = setup
    first, _ = _propose_strategy(host, slug)
    second = host.call("propose_strategy", {"yaml": STRATEGY_YAML + "\n# two\n"}).data
    with get_session() as s:  # an approval that died with the process
        row = s.get(Proposal, first)
        row.status = "applying"
        s.add(row)
    rejected = api.post(f"/api/p/{slug}/proposals/{second['proposal_id']}/reject")
    assert rejected.status_code == 200
    detail = api.get(f"/api/p/{slug}/proposals/{first}").json()
    assert detail["status"] == "failed" and detail["result"]["error_code"] == "interrupted"
    assert api.get(f"/api/p/{slug}/proposals?status=applying").json() == []


# --------------------------------------------------------------------------- #
# R8: version + status in one transaction, files after the commit
# --------------------------------------------------------------------------- #


def test_strategy_approval_records_the_version_once(setup):
    from finanse.modules.investments.service import strategy as strategy_files

    pid, slug, host, api = setup
    proposal_id, new_yaml = _propose_strategy(host, slug)
    approved = api.post(f"/api/p/{slug}/proposals/{proposal_id}/approve").json()
    assert approved["status"] == "approved"
    assert approved["result"]["version"] == 2 and approved["result"]["state"] == "valid"
    assert files.strategy_yaml_path(slug).read_text() == new_yaml
    assert files.strategy_yaml_path(slug).stat().st_mode & 0o077 == 0
    assert not list(files.profile_dir(slug).glob(".*approving"))
    with get_session() as s:  # the daily check / a reload records nothing new
        state = strategy_files.load(s, s.get(Profile, pid), record=True)
        assert state.version.version == 2 and not state.changed
    assert _versions(pid) == [1, 2]


def test_a_db_failure_leaves_files_versions_and_a_failed_proposal(setup, monkeypatch):
    pid, slug, host, api = setup
    proposal_id, _new_yaml = _propose_strategy(host, slug)
    before = files.strategy_yaml_path(slug).read_text()

    def locked(*_a, **_k):
        raise OperationalError("INSERT INTO inv_strategy_versions", {}, Exception("locked"))

    monkeypatch.setattr(investments_proposals, "_record_version", locked)
    response = api.post(f"/api/p/{slug}/proposals/{proposal_id}/approve")
    assert response.status_code == 422
    assert response.headers["X-Finanse-Error-Code"] == "apply_failed"
    assert _status(proposal_id) == "failed"
    assert files.strategy_yaml_path(slug).read_text() == before
    assert _versions(pid) == [1]


def test_a_file_failure_removes_the_version_and_keeps_the_old_files(setup, monkeypatch):
    pid, slug, host, api = setup
    proposal_id, _new_yaml = _propose_strategy(host, slug)
    before = files.strategy_yaml_path(slug).read_text()

    def disk_full(_writes):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(investments_proposals, "replace_files", disk_full)
    response = api.post(f"/api/p/{slug}/proposals/{proposal_id}/approve")
    assert response.status_code == 422
    assert response.headers["X-Finanse-Error-Code"] == "write_failed"
    detail = api.get(f"/api/p/{slug}/proposals/{proposal_id}").json()
    assert detail["status"] == "failed" and detail["result"]["error_code"] == "write_failed"
    assert files.strategy_yaml_path(slug).read_text() == before
    assert _versions(pid) == [1]


def test_replace_files_puts_back_what_it_replaced(tmp_path, monkeypatch):
    yaml_path, md_path = tmp_path / "strategy.yaml", tmp_path / "strategy.md"
    yaml_path.write_text("old yaml")
    calls = []
    real_replace = Path.replace

    def flaky(self, target):
        calls.append(self.name)
        if len(calls) == 2:
            raise OSError("rename failed")
        return real_replace(self, target)

    monkeypatch.setattr(Path, "replace", flaky)
    with pytest.raises(OSError):
        investments_proposals.replace_files(
            [(yaml_path, "new yaml", "old yaml"), (md_path, "new md", None)]
        )
    monkeypatch.setattr(Path, "replace", real_replace)
    assert yaml_path.read_text() == "old yaml"
    assert not md_path.exists()
    assert sorted(p.name for p in tmp_path.iterdir()) == ["strategy.yaml"]


def test_approval_waits_for_the_daily_check_then_stays_pending(setup, monkeypatch):
    from finanse.modules.investments.service.daily import LOCK_NAME

    pid, slug, host, api = setup
    proposal_id, _new_yaml = _propose_strategy(host, slug)
    before = files.strategy_yaml_path(slug).read_text()
    monkeypatch.setattr(investments_proposals, "STRATEGY_LOCK_WAIT", 0.2)
    with locks.run_lock(LOCK_NAME):
        response = api.post(f"/api/p/{slug}/proposals/{proposal_id}/approve")
    assert response.status_code == 409 and response.headers["X-Finanse-Error-Code"] == "busy"
    assert _status(proposal_id) == "pending"
    assert files.strategy_yaml_path(slug).read_text() == before
    assert _versions(pid) == [1]
    assert api.post(f"/api/p/{slug}/proposals/{proposal_id}/approve").status_code == 200
