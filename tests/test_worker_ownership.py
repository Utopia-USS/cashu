"""Synthetic native/Python job switch checks, without opening a profile database."""

from __future__ import annotations

import json
import os

from cashu.core.worker import ownership


def _native_record(root, vault: str = "a" * 32) -> None:
    directory = root / "worker"
    directory.mkdir(mode=0o700, exist_ok=True)
    path = directory / "ownership.json"
    path.write_text(json.dumps({
        "version": 1,
        "generation": 1,
        "jobs": {
            "investments.daily": {"owner": "native", "vaults": [vault]},
            "connectors.fetch": {"owner": "native", "vaults": [vault]},
            "budget.sync": {"owner": "native", "vaults": [vault]},
        },
    }), encoding="utf-8")
    os.chmod(path, 0o600)


def test_missing_switch_keeps_python_owner(tmp_path, monkeypatch):
    monkeypatch.setattr(ownership.paths, "data_dir", lambda: tmp_path)
    assert ownership.python_owns("investments.daily")
    assert ownership.python_owns("budget.sync")
    assert not ownership.python_owns("unknown")


def test_native_daily_connector_and_bank_switch_exclude_python(tmp_path, monkeypatch):
    monkeypatch.setattr(ownership.paths, "data_dir", lambda: tmp_path)
    _native_record(tmp_path)
    assert not ownership.python_owns("investments.daily")
    assert not ownership.python_owns("budget.sync")
    assert not ownership.python_owns("connectors.fetch")
    assert ownership.python_owns("notifications")


def test_missing_connector_job_is_malformed_and_refuses_python(tmp_path, monkeypatch):
    monkeypatch.setattr(ownership.paths, "data_dir", lambda: tmp_path)
    _native_record(tmp_path)
    path = tmp_path / "worker" / "ownership.json"
    value = json.loads(path.read_text(encoding="utf-8"))
    del value["jobs"]["connectors.fetch"]
    path.write_text(json.dumps(value), encoding="utf-8")
    assert not ownership.python_owns("investments.daily")
    assert not ownership.python_owns("connectors.fetch")


def test_corrupt_or_symlinked_switch_refuses_all_jobs(tmp_path, monkeypatch):
    monkeypatch.setattr(ownership.paths, "data_dir", lambda: tmp_path)
    _native_record(tmp_path)
    path = tmp_path / "worker" / "ownership.json"
    path.write_text("{broken", encoding="utf-8")
    assert not ownership.python_owns("investments.daily")
    assert not ownership.python_owns("budget.sync")
    path.unlink()
    other = tmp_path / "other"
    other.write_text("{}", encoding="utf-8")
    path.symlink_to(other)
    assert not ownership.python_owns("investments.daily")
