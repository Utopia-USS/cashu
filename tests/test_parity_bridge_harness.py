"""Python helpers of the bridge harness (S31a spec 9): golden.py ``--manifest`` / ``--copy-dataset``,
``bridge_env.py`` and the data-dir guard of ``bridge_writes.py``. Synthetic files in temp dirs only."""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))
HERE = REPO / "parity" / "python"
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import bridge_env  # the harness imports these as scripts next to golden.py
import bridge_writes
import golden


@pytest.fixture
def lab(tmp_path, monkeypatch):
    """A fake ``~/cashu-lab`` with a tiny synthetic dataset."""
    root = tmp_path / "cashu-lab"
    parity = root / "parity"
    source = parity / "demo-data"
    (source / "profiles" / "p").mkdir(parents=True)
    conn = sqlite3.connect(source / "cashu.db")
    conn.execute("CREATE TABLE t (x)")
    conn.execute("INSERT INTO t VALUES (1)")
    conn.commit()
    conn.close()
    (source / "profiles" / "p" / "budget.json").write_text("{}")
    datasets = {"lab": root / "data", "demo": source}
    for mod in (golden, bridge_env.golden):
        monkeypatch.setattr(mod, "PARITY_ROOT", parity)
        monkeypatch.setattr(mod, "DATASETS", datasets)
    monkeypatch.setattr(bridge_writes, "PARITY_ROOT", parity)
    monkeypatch.setattr(bridge_writes, "DEMO_SOURCE", source)
    return parity


def test_manifest_and_copy_dataset(lab, capsys):
    assert golden.main(["--manifest", "demo"]) == 0
    first = json.loads(capsys.readouterr().out)
    assert first["files"] == 2 and len(first["manifest"]) == 64
    dest = lab / "bridge-run-1" / "data"
    assert golden.main(["--copy-dataset", "demo", "--to", str(dest)]) == 0
    assert json.loads(capsys.readouterr().out) == first
    assert (dest / "profiles" / "p" / "budget.json").is_file()
    assert golden.manifest(dest) == (first["files"], first["manifest"])
    assert golden.main(["--copy-dataset", "demo", "--to", str(dest)]) == 1  # exists
    assert golden.main(["--copy-dataset", "demo", "--to", str(lab.parent / "elsewhere")]) == 1
    assert golden.main(["--manifest", "lab"]) == 1  # no dataset there


def test_copy_dataset_refuses_a_broken_database(lab, capsys):
    (lab / "demo-data" / "cashu.db").write_bytes(b"not a database" * 100)
    assert golden.main(["--copy-dataset", "demo", "--to", str(lab / "run" / "data")]) == 2
    assert "quick_check" in capsys.readouterr().out


def test_bridge_env(lab, capsys):
    run = lab / "bridge-run-2"
    run.mkdir()
    assert bridge_env.main(["--run", str(run), "--dataset", "demo"]) == 0
    env = json.loads(capsys.readouterr().out)
    assert env["CASHU_DATA_DIR"] == str(run.resolve() / "data")
    assert env["HOME"] == str(run.resolve() / "home") and (run / "home").is_dir() and (run / "workspaces").is_dir()
    assert env["PYTHON_KEYRING_BACKEND"] == "parity.python.lab_keyring.FileKeyring"
    assert env["CASHU_LAB_KEYRING"] == str(run.resolve() / "keys" / "keyring.json")
    assert oct((run / "keys").stat().st_mode & 0o777) == "0o700"
    assert env["CASHU_PARITY_CLOCK"] == golden.CLOCKS["demo"] and env["PYTHONPATH"] == str(REPO)
    assert "CASHU_SYNC" not in env
    assert bridge_env.main(["--run", str(run), "--dataset", "demo", "--sync"]) == 0
    assert json.loads(capsys.readouterr().out)["CASHU_SYNC"] == "1"
    assert bridge_env.main(["--run", str(lab.parent), "--dataset", "demo"]) == 1
    assert bridge_env.main(["--run", str(lab / "demo-data"), "--dataset", "demo"]) == 1


def test_bridge_writes_runs_only_on_a_run_copy(lab):
    assert bridge_writes.data_dir_allowed(lab / "bridge-run-3" / "data")
    assert not bridge_writes.data_dir_allowed(lab / "demo-data")
    assert not bridge_writes.data_dir_allowed(lab / "demo-data" / "x")
    assert not bridge_writes.data_dir_allowed(lab.parent / "data")
    assert not bridge_writes.data_dir_allowed(lab)
