"""MCP connector tools (F10 BE-C3): ``propose_connector`` installs a directory of the profile's agent
workspace ``connectors/<id>/`` as pending and never runs anything; the path rules; ``connectors`` lists
status and run outcomes without messages, stderr, params or secrets; ``inspect_export`` is available to a
budget-only profile. Synthetic data."""

from __future__ import annotations

import json
import os

import pytest
from connector_support import ECHO_CONNECTOR, needs_python3, write_connector

from cashu.core import profiles
from cashu.core.connectors import runner, service
from cashu.core.connectors.runner import RunResult
from cashu.core.db import get_session
from cashu.core.mcp.registry import all_tools
from cashu.core.mcp.server import CashuMcp
from cashu.core.workspace import service as workspace

pytestmark = needs_python3

SECRET_MESSAGE = "Jan Kowalski PL61109010140000071219812874 kwota 4321.09"


class Forbidden:
    """A sandbox that fails the test when anything tries to run."""

    name = "forbidden"

    def run(self, spec):  # pragma: no cover - must never be called
        raise AssertionError("an MCP call ran a connector")


@pytest.fixture
def host(db_engine, monkeypatch):
    monkeypatch.setattr(runner, "default_sandbox", lambda: Forbidden())
    with get_session() as s:
        p = profiles.create_profile(s, name="Anna Nowak", modules_=["investments", "budget"])
        pid, slug = p.id, p.slug
    return CashuMcp(pid), slug


def ws_connectors(slug: str):
    return workspace.workspace_path(slug) / "connectors"


def test_propose_connector_installs_pending_and_runs_nothing(host):
    mcp, slug = host
    root = write_connector(ws_connectors(slug) / "test-fetch", cid="test-fetch", kind="fetch")
    result = mcp.call("propose_connector", {"path": str(root)})
    assert result.ok, result.error
    d = result.data
    assert (d["id"], d["status"], d["module"], d["kind"]) == ("test-fetch", "pending", "investments", "fetch")
    assert d["replaced"] is False and len(d["content_sha256"]) == 12
    assert d["hosts"] == ["api.example.com"] and d["secret_ids"] == ["api_key"]
    assert "Ustawienia > Konektory" in d["note"]
    with get_session() as s:
        from sqlmodel import select

        from cashu.core.connectors.models import Connector, ConnectorRun

        row = s.get(Connector, "test-fetch")
        assert row.status == "pending" and row.source == "mcp" and row.approved_sha256 is None
        assert s.exec(select(ConnectorRun)).all() == []
    assert (service.connectors_root() / "test-fetch" / "main.py").is_file()


def test_reproposing_an_approved_connector_needs_approval_again(host):
    mcp, slug = host
    root = write_connector(ws_connectors(slug) / "test-conn", cid="test-conn")
    assert mcp.call("propose_connector", {"path": str(root)}).ok
    with get_session() as s:
        from cashu.core.connectors.models import Connector

        row = s.get(Connector, "test-conn")
        sha, interp = row.content_sha256, row.interpreter_path
    service.approve("test-conn", sha, interp)
    (root / "main.py").write_text(ECHO_CONNECTOR + "\n# v2\n", encoding="utf-8")
    again = mcp.call("propose_connector", {"path": str(root)})
    assert again.ok and again.data["replaced"] is True and again.data["status"] == "changed"


def test_propose_connector_path_rules(host, tmp_path):
    mcp, slug = host
    base = ws_connectors(slug)
    outside = write_connector(tmp_path / "elsewhere" / "test-conn", cid="test-conn")
    nested = write_connector(base / "group" / "test-conn", cid="test-conn")
    misnamed = write_connector(base / "other-name", cid="test-conn")
    linked = base / "test-conn"
    linked.symlink_to(outside, target_is_directory=True)
    hidden = write_connector(base / ".hidden-conn", cid="hidden-conn")
    from cashu.core import paths

    in_data = write_connector(paths.data_dir() / "x" / "test-conn", cid="test-conn")
    cases = {
        "outside the workspace": str(outside),
        "nested": str(nested),
        "misnamed": str(misnamed),
        "symlink out": str(linked),
        "hidden": str(hidden),
        "data dir": str(in_data),
        "a file": str(nested / "connector.yaml"),
        "missing": str(base / "nope"),
        "empty": "",
    }
    for what, path in cases.items():
        result = mcp.call("propose_connector", {"path": path})
        assert not result.ok, what
    assert service.connectors_root().exists() is False or not any(
        p for p in service.connectors_root().iterdir() if not p.name.startswith(".")
    )
    invalid = base / "bad-conn"
    write_connector(invalid, cid="bad-conn", manifest="api_version: 1\nid: bad-conn\nkind: nope\n")
    result = mcp.call("propose_connector", {"path": str(invalid)})
    assert not result.ok and "not valid" in result.error
    for name in ("converter", "approve"):
        refused = mcp.call("propose_connector", {"path": str(invalid), name: "x"})
        assert not refused.ok and refused.error_kind == "invalid_arguments"


def test_connectors_tool_never_returns_messages_stderr_params_or_secrets(host, memory_keyring_like):
    mcp, slug = host
    root = write_connector(ws_connectors(slug) / "test-fetch", cid="test-fetch", kind="fetch")
    assert mcp.call("propose_connector", {"path": str(root)}).ok
    service.record_run(
        RunResult("fetch", "failed", "auth_failed", message=SECRET_MESSAGE,
                  stderr_tail=SECRET_MESSAGE, records=0),
        "test-fetch",
    )
    result = mcp.call("connectors", {})
    assert result.ok, result.error
    (item,) = result.data["connectors"]
    assert (item["id"], item["status"], item["bindings"]) == ("test-fetch", "pending", 0)
    assert item["last_run"]["outcome"] == "failed" and item["last_run"]["error_kind"] == "auth_failed"
    blob = json.dumps(result.data)
    for leak in ("Kowalski", "PL6110", "4321", "api.example.com", "fixture"):
        assert leak not in blob, leak
    assert "Ustawienia > Konektory" in result.data["rule"]


def test_connectors_tool_shows_only_this_profiles_last_run(host):
    """BE-12: runs are per profile; another profile's sync (time, kind, records) never shows."""
    mcp, slug = host
    root = write_connector(ws_connectors(slug) / "test-fetch", cid="test-fetch", kind="fetch")
    assert mcp.call("propose_connector", {"path": str(root)}).ok
    with get_session() as s:
        other = profiles.create_profile(s, name="Ewa Test", modules_=["investments"]).id
    service.record_run(RunResult("check", "ok"), "test-fetch", profile_id=mcp.profile_id)
    service.record_run(RunResult("fetch", "ok", records=37), "test-fetch", profile_id=other)
    (item,) = mcp.call("connectors", {}).data["connectors"]
    assert item["last_run"]["command"] == "check" and item["last_run"]["records"] == 0
    service.record_run(RunResult("convert", "failed", "bad_file"), "test-fetch")  # a dev test run
    (item,) = mcp.call("connectors", {}).data["connectors"]
    assert item["last_run"]["command"] == "convert"
    other_mcp = CashuMcp(other)
    (item,) = other_mcp.call("connectors", {}).data["connectors"]
    assert item["last_run"]["command"] == "convert"  # never Anna's check


@pytest.fixture
def memory_keyring_like(monkeypatch):
    import keyring
    from connector_support import MemoryKeyring

    previous = keyring.get_keyring()
    keyring.set_keyring(MemoryKeyring())
    yield
    keyring.set_keyring(previous)


def test_tool_descriptions_state_the_rule():
    tools = all_tools()
    for name in ("propose_connector", "connectors"):
        text = tools[name].description
        assert "only after the owner approves it" in text and "never run code" in text
        assert "\u2014" not in text
    assert tools["propose_connector"].write and not tools["connectors"].write
    for name, spec in tools.items():
        assert "never open the export" not in spec.description.lower(), name
    assert "converter" in tools["validate_import"].refused  # the converter refusal stays
    assert "converter" in tools["propose_import"].refused


def test_inspect_export_and_budget_validation_for_a_budget_only_profile(db_engine, tmp_path):
    with get_session() as s:
        p = profiles.create_profile(s, name="Ola Nowak", modules_=["budget"])
        pid = p.id
    mcp = CashuMcp(pid)
    export = tmp_path / "statement.csv"
    export.write_text("Data;Opis;Kwota\n2026-09-01;OPEN BUY Jan Kowalski;-12,50\n", encoding="utf-8")
    result = mcp.call("inspect_export", {"path": str(export)})
    assert result.ok, result.error
    assert "Kowalski" not in json.dumps(result.data)
    doc = tmp_path / "doc.json"
    doc.write_text(json.dumps({
        "format": "cashu-budget-import", "format_version": 1, "account": {"currency": "PLN"},
        "transactions": [{"booking_date": "2026-09-01", "amount": "-12.50", "currency": "PLN",
                          "counterparty_name": "Jan Kowalski", "transaction_id": "t1"}]}))
    ok = mcp.call("validate_budget_import", {"path": str(doc)})
    assert ok.ok and ok.data["ok"] is True and ok.data["transactions"] == 1
    assert "Kowalski" not in json.dumps(ok.data)
    assert mcp.call("validate_import", {"path": str(doc)}).error_kind == "module_disabled"
    assert os.environ.get("CASHU_WORKSPACES_DIR")  # never the real ~/Documents


def test_a_headerless_csv_never_echoes_its_first_row(db_engine, tmp_path):
    """BE-11: a raw statement (first line = data) passed to the budget validation, ``inspect_export``
    and ``connectors test``: a third party's name, a transfer title, an IBAN and an amount never come
    back as column names (strict profile)."""
    from cashu.modules.budget.ingestion.canonical import validate_budget_document

    with get_session() as s:
        p = profiles.create_profile(s, name="Ola Nowak", modules_=["budget"])
        pid = p.id
    mcp = CashuMcp(pid)
    raw = ("2026-09-01,Krzysztof Wisniewski,PL61109010140000071219812874,-1234.56,"
           "Czynsz za mieszkanie\n2026-09-02,Sklep TEST,,-5.00,Zakupy\n")
    export = tmp_path / "export.csv"
    export.write_text(raw, encoding="utf-8")
    leaks = ("wisniewski", "krzysztof", "czynsz", "mieszkanie", "1234", "pl61", "[number]", "2026-09")
    for tool in ("validate_budget_import", "inspect_export"):
        result = mcp.call(tool, {"path": str(export)})
        assert result.ok, result.error
        headers = json.dumps(result.data.get("issues") or [
            c["header"] for sheet in result.data["sheets"] for c in sheet["columns"]
        ]).lower()
        for leak in leaks:
            assert leak not in headers, (tool, leak, headers)
    report = validate_budget_document(raw.encode(), "export.csv")
    assert not report.ok and len(report.issues) == 1 and report.issues[0].kind == "file_format"
    assert "Wisniewski" not in report.summary() and "Czynsz" not in report.summary()
    # a real header with one unknown column: named by position when it looks like data
    mixed = (b"format_version,booking_date,amount,currency,Krzysztof Wisniewski,opis\n"
             b"1,2026-09-01,-1.00,PLN,x,y\n")
    fields = {i.field for i in validate_budget_document(mixed, "m.csv").issues}
    assert fields == {"column 5", "opis"}
