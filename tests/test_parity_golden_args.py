"""``parity/python/golden.py`` arguments of the bridge harness (S31a spec 9.3 step 9): ``--check``
globs and the ``--source-dir`` guard. No dataset is read."""

from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from parity.python import golden  # a namespace package under the repo root


def test_check_takes_names_and_globs():
    assert golden.selects("store.table.alerts", ["store.table.*"])
    assert golden.selects("core.networth", ["core.networth"])
    assert golden.selects("anything", [])
    assert not golden.selects("core.networth", ["store.table.*"])
    assert not golden.selects("store.tables", ["store.table.*"])


def test_source_dir_must_be_inside_the_parity_tree(tmp_path, monkeypatch):
    parity = tmp_path / "cashu-lab" / "parity"
    (parity / "bridge-run-1" / "data").mkdir(parents=True)
    monkeypatch.setattr(golden, "PARITY_ROOT", parity)
    assert golden.source_dir_allowed(parity / "bridge-run-1" / "data")
    assert golden.source_dir_allowed(Path(str(parity).replace("parity", "PARITY")) / "bridge-run-1" / "data")
    assert not golden.source_dir_allowed(parity)
    assert not golden.source_dir_allowed(tmp_path / "cashu-lab" / "data")
    assert not golden.source_dir_allowed(parity / ".." / "data")
    link = parity / "escape"
    link.symlink_to(tmp_path)
    assert not golden.source_dir_allowed(link / "x")


def test_source_dir_is_refused_before_anything_runs(tmp_path, capsys):
    assert golden.main(["--dataset", "lab", "--source-dir", str(tmp_path), "--out", str(tmp_path / "out")]) == 1
    assert golden.main(["--dataset", "all", "--source-dir", str(tmp_path)]) == 1
    assert not (tmp_path / "out").exists()
