"""S31a coverage guard (lead decision: coverage guard (b)): every synced Python column and explicit op is
classified by the TS outbox bridge.

TRANSITIONAL(S49). ``packages/store/src/bridge/coverage.json`` is the bridge's coverage table (kept equal
to the code by ``coverage.test.ts``). A new synced column, a new synced table or a new explicit-op site
fails here until the bridge maps it to an event (or names why it is not shipped)."""

from __future__ import annotations

import json
from pathlib import Path

from sqlmodel import SQLModel

from cashu.core import sync_outbox

COVERAGE = Path(__file__).resolve().parents[1] / "packages/store/src/bridge/coverage.json"

# Where Python emits each explicit op (S30 checkpoint): the bridge must handle the op on that table.
EXPLICIT_SITES = {
    ("inv_instruments", "merge"),
    ("inv_decisions", "undo"),
    ("reviews", "undo"),
    ("transactions", "leg_delete"),
}


def _coverage() -> dict:
    return json.loads(COVERAGE.read_text(encoding="utf-8"))["tables"]


def _kind(spec: sync_outbox.Spec) -> str:
    return "global" if spec.profile == "global" else spec.gid


def test_every_synced_table_is_bridged_with_its_gid_kind():
    tables = _coverage()
    assert set(tables) == set(sync_outbox.SPECS)
    for name, spec in sync_outbox.SPECS.items():
        assert tables[name]["gid"] == _kind(spec), name


def test_every_synced_column_is_classified():
    tables = _coverage()
    missing = []
    for name in sync_outbox.SPECS:
        table = SQLModel.metadata.tables[name]
        for col in sync_outbox._synced_columns(name, table):
            if col.name not in tables[name]["columns"]:
                missing.append(f"{name}.{col.name}")
    assert missing == []


def test_every_explicit_op_site_is_handled():
    tables = _coverage()
    assert {op for _, op in EXPLICIT_SITES} == set(sync_outbox.EXPLICIT_OPS)
    for table, op in sorted(EXPLICIT_SITES):
        assert op in tables[table]["ops"], f"{table}.{op}"
