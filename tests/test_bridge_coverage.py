"""S31a coverage guard (lead decision: coverage guard (b)): every synced Python column and explicit op is
classified by the TS outbox bridge.

TRANSITIONAL(S49). ``packages/store/src/bridge/coverage.json`` is the bridge's coverage table (kept equal
to the code by ``coverage.test.ts``). A new synced column, a new synced table or a new explicit-op site
fails here until the bridge maps it to an event (or names why it is not shipped)."""

from __future__ import annotations

import ast
import json
from pathlib import Path

from sqlmodel import SQLModel

from cashu.core import sync_outbox

REPO = Path(__file__).resolve().parents[1]
COVERAGE = REPO / "packages/store/src/bridge/coverage.json"
SRC = REPO / "src" / "cashu"

# Where Python emits each explicit op (S30 checkpoint): the bridge must handle the op on that table.
EXPLICIT_SITES = {
    ("inv_instruments", "merge"),
    ("inv_decisions", "undo"),
    ("reviews", "undo"),
    ("transactions", "leg_delete"),
    ("inv_strategy_versions", "undo"),  # an approval's own version undone (S31c F5)
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


# --------------------------------------------------------------------------- #
# F7: the explicit-op sites are derived from the source, not only listed by hand
# --------------------------------------------------------------------------- #

_EMITS = {"emit_row", "emit", "emit_instrument_merge"}


def _model_tables() -> dict[str, str]:
    import cashu.models  # noqa: F401  (registers every model)

    return {
        m.class_.__name__: m.class_.__tablename__
        for m in SQLModel._sa_registry.mappers
        if getattr(m.class_, "__tablename__", None)
    }


def _name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.BinOp):  # ``Profile | int``
        return _name(node.left)
    return None


def _obj_model(func: ast.AST, var: str, returns: dict[str, str]) -> str | None:
    """The model class an ``emit_row`` object is, inside its function: a parameter annotation, an
    assignment from ``session.get(Model, ...)`` / ``Model(...)``, or from a same-module function whose
    return annotation is a model."""
    for arg in (*func.args.args, *func.args.kwonlyargs):
        if arg.arg == var and arg.annotation is not None:
            return _name(arg.annotation)
    for node in ast.walk(func):
        if not (isinstance(node, ast.Assign) and isinstance(node.value, ast.Call)):
            continue
        if not any(isinstance(t, ast.Name) and t.id == var for t in node.targets):
            continue
        call = node.value
        callee = _name(call.func)
        if isinstance(call.func, ast.Attribute) and callee == "get" and call.args:
            return _name(call.args[0])  # session.get(Model, ...)
        if callee in returns:
            return returns[callee]
        if callee and callee[:1].isupper():
            return callee
    return None


def explicit_sites(root: Path) -> tuple[set[tuple[str, str]], list[str]]:
    """``(table, op)`` of every explicit emit call under ``root`` and the sites that could not be
    resolved (``path:line``)."""
    models = _model_tables()
    sites: set[tuple[str, str]] = set()
    unresolved: list[str] = []
    for path in sorted(root.rglob("*.py")):
        if path.name == "sync_outbox.py":
            continue
        source = path.read_text(encoding="utf-8")
        if not any(e in source for e in _EMITS):
            continue
        tree = ast.parse(source)
        returns = {
            f.name: _name(f.returns)
            for f in ast.walk(tree)
            if isinstance(f, ast.FunctionDef) and f.returns is not None and _name(f.returns)
        }
        for func in (f for f in ast.walk(tree) if isinstance(f, ast.FunctionDef | ast.AsyncFunctionDef)):
            for call in (c for c in ast.walk(func) if isinstance(c, ast.Call)):
                callee = _name(call.func)
                if not (
                    callee in _EMITS
                    and isinstance(call.func, ast.Attribute)
                    and _name(call.func.value) == "sync_outbox"
                ):
                    continue
                where = f"{path.relative_to(root)}:{call.lineno}"
                if callee == "emit_instrument_merge":
                    sites.add(("inv_instruments", "merge"))
                    continue
                literals = [a.value for a in call.args if isinstance(a, ast.Constant) and isinstance(a.value, str)]
                if callee == "emit":
                    if len(literals) >= 2:
                        sites.add((literals[0], literals[1]))
                    else:
                        unresolved.append(where)
                    continue
                obj = call.args[1] if len(call.args) > 1 else None
                model = _obj_model(func, obj.id, returns) if isinstance(obj, ast.Name) else None
                if model in models and literals:
                    sites.add((models[model], literals[0]))
                else:
                    unresolved.append(where)
    return sites, unresolved


def test_the_explicit_op_sites_in_the_source_are_the_listed_ones():
    sites, unresolved = explicit_sites(SRC)
    assert unresolved == [], "emit sites whose table / op the guard cannot read; make them explicit"
    assert sites - EXPLICIT_SITES == set(), "a new explicit-op site: list it and map it in the bridge"
    assert sites == EXPLICIT_SITES


def test_the_site_guard_sees_a_planted_site(tmp_path):
    (tmp_path / "planted.py").write_text(
        "from cashu.core import sync_outbox\n"
        "from cashu.modules.investments.models import InvAlert\n\n"
        "def drop(session, alert_id):\n"
        "    row = session.get(InvAlert, alert_id)\n"
        '    sync_outbox.emit_row(session, row, "undo")\n\n'
        "def raw(session):\n"
        '    sync_outbox.emit(session, "research_notes", "merge", "1")\n\n'
        "def unknown(session, thing):\n"
        '    sync_outbox.emit_row(session, thing, "undo")\n',
        encoding="utf-8",
    )
    sites, unresolved = explicit_sites(tmp_path)
    assert sites == {("alerts", "undo"), ("research_notes", "merge")}
    assert unresolved == ["planted.py:12"]
    assert sites - EXPLICIT_SITES  # the real test would fail on them
