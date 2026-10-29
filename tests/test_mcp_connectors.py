"""MCP connector tools (F10 BE-C3): ``propose_connector`` installs a directory of the profile's agent
workspace ``connectors/<id>/`` as pending and never runs anything; the path rules; ``connectors`` lists
status and run outcomes without messages, stderr, params or secrets; ``inspect_export`` is available to a
budget-only profile. Synthetic data."""

from __future__ import annotations

import json
import os
import shutil
import sys

import pytest
from connector_support import ECHO_CONNECTOR, needs_python3, write_connector

from cashu.core import profiles
from cashu.core.connectors import runner, service
from cashu.core.connectors.manifest import SYSTEM_SEARCH_PATH
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
        assert "only after the owner approves it" in text and "never approve" in text
        assert "\u2014" not in text
    test = tools["test_connector"].description
    assert "Nothing is installed, approved or recorded" in test and "no network" in test
    assert "\u2014" not in test
    assert "test_connector" in tools["propose_connector"].description
    assert "cashu connectors test" not in tools["propose_connector"].description
    assert tools["propose_connector"].write and not tools["connectors"].write
    assert not tools["test_connector"].write
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


# --------------------------------------------------------------------------- #
# test_connector: the agent's test loop without a terminal CLI
# --------------------------------------------------------------------------- #


@pytest.fixture
def tester(db_engine, monkeypatch):
    """A profile whose MCP server runs connectors in ``NoSandbox`` (records every spec)."""
    from connector_support import NoSandbox

    box = NoSandbox()
    monkeypatch.setattr(runner, "default_sandbox", lambda: box)
    with get_session() as s:
        p = profiles.create_profile(s, name="Anna Nowak", modules_=["investments", "budget"])
        pid, slug = p.id, p.slug
    return CashuMcp(pid), slug, box


def _sample(slug: str, name: str = "inbox/history.csv", text: str | None = None):
    path = workspace.workspace_path(slug) / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text or "date,type,amount\n2026-01-05,deposit,1000.00\n", encoding="utf-8")
    return path


def _nothing_installed_or_recorded():
    from sqlmodel import select

    from cashu.core.connectors.models import Connector, ConnectorRun

    with get_session() as s:
        assert s.exec(select(Connector)).all() == []
        assert s.exec(select(ConnectorRun)).all() == []
    root = service.connectors_root()
    assert not root.exists() or not any(p for p in root.iterdir() if not p.name.startswith("."))


def test_test_connector_runs_a_private_copy_and_installs_nothing(tester):
    mcp, slug, box = tester
    root = write_connector(ws_connectors(slug) / "test-conn", cid="test-conn")
    result = mcp.call("test_connector", {"path": str(root), "file": str(_sample(slug))})
    assert result.ok, result.error
    d = result.data
    assert d["ok"] is True
    m = d["manifest"]
    assert (m["valid"], m["id"], m["module"], m["kind"]) == (True, "test-conn", "investments", "file")
    assert m["interpreter"].startswith("python3")  # a name, never a path
    assert [(r["command"], r["outcome"]) for r in d["runs"]] == [("detect", "ok"), ("convert", "ok")]
    assert d["detect"]["match"] is True
    doc = d["document"]
    assert doc["valid"] is True and doc["format"] == "cashu-import"
    assert doc["counts"]["transactions"] == 2 and doc["counts"]["errors"] == 0
    assert "propose_connector" in d["note"]
    assert not any("interpreter" in line and "/" in line for line in d["report"])
    # it ran from a private copy, not from the workspace folder, and the copy is gone
    assert len(box.specs) == 2
    for spec in box.specs:
        assert os.path.realpath(spec.connector_dir) != os.path.realpath(root)
        assert not spec.connector_dir.exists()
    _nothing_installed_or_recorded()


def test_test_connector_fetch_runs_offline_with_a_fixture(tester, monkeypatch):
    mcp, slug, box = tester

    def no_proxy(hosts):  # pragma: no cover - must never be called
        raise AssertionError("test_connector opened the egress proxy")

    monkeypatch.setattr(runner, "EgressProxy", no_proxy)
    root = write_connector(ws_connectors(slug) / "test-fetch", cid="test-fetch", kind="fetch")
    fixture = _sample(slug, "connectors/test-fetch/fixtures/answer.json", '{"items": []}')
    result = mcp.call("test_connector", {"path": str(root), "fixture": str(fixture)})
    assert result.ok, result.error
    assert result.data["ok"] is True
    assert [r["command"] for r in result.data["runs"]] == ["fetch"]
    (spec,) = box.specs
    assert spec.proxy_port is None and "HTTPS_PROXY" not in spec.env
    request = json.loads(spec.stdin)
    assert request["params"]["fixture"] == '{"items": []}'
    assert request["secrets"] == {"api_key": "test-not-a-real-secret"}
    _nothing_installed_or_recorded()


def test_test_connector_path_rules(tester, tmp_path):
    mcp, slug, box = tester
    base = ws_connectors(slug)
    good = write_connector(base / "test-conn", cid="test-conn")
    sample = _sample(slug)
    outside_conn = write_connector(tmp_path / "elsewhere" / "test-conn", cid="test-conn")
    outside_file = tmp_path / "elsewhere" / "history.csv"
    outside_file.write_text("date,type,amount\n", encoding="utf-8")
    hidden = _sample(slug, ".private/history.csv")
    linked = workspace.workspace_path(slug) / "inbox" / "linked.csv"
    linked.symlink_to(outside_file)
    from cashu.core import paths

    in_data = paths.data_dir() / "profiles" / "x.csv"
    in_data.parent.mkdir(parents=True, exist_ok=True)
    in_data.write_text("date,type,amount\n", encoding="utf-8")
    cases = {
        "connector outside the workspace": {"path": str(outside_conn), "file": str(sample)},
        "file outside the workspace": {"path": str(good), "file": str(outside_file)},
        "file through a symlink out": {"path": str(good), "file": str(linked)},
        "hidden file": {"path": str(good), "file": str(hidden)},
        "file in the data dir": {"path": str(good), "file": str(in_data)},
        "missing file": {"path": str(good), "file": str(sample.parent / "nope.csv")},
        "no sample": {"path": str(good)},
        "both samples": {"path": str(good), "file": str(sample), "fixture": str(sample)},
    }
    for what, args in cases.items():
        result = mcp.call("test_connector", args)
        assert not result.ok, what
    for name in ("network", "secrets", "approve", "install"):
        refused = mcp.call("test_connector", {"path": str(good), "file": str(sample), name: "x"})
        assert not refused.ok and refused.error_kind == "invalid_arguments", name
    assert box.specs == []  # nothing ran for a refused call
    _nothing_installed_or_recorded()


def test_test_connector_never_reaches_another_profiles_workspace(tester):
    mcp, slug, box = tester
    with get_session() as s:
        other = profiles.create_profile(s, name="Ewa Test", modules_=["investments"])
        other_slug = other.slug
    theirs = write_connector(ws_connectors(other_slug) / "test-conn", cid="test-conn")
    their_sample = _sample(other_slug)
    mine = write_connector(ws_connectors(slug) / "test-conn", cid="test-conn")
    my_sample = _sample(slug)
    assert not mcp.call("test_connector", {"path": str(theirs), "file": str(my_sample)}).ok
    assert not mcp.call("test_connector", {"path": str(mine), "file": str(their_sample)}).ok
    assert box.specs == []
    assert mcp.call("test_connector", {"path": str(mine), "file": str(my_sample)}).ok


def test_test_connector_reports_an_invalid_manifest_without_running(tester):
    mcp, slug, box = tester
    bad = ws_connectors(slug) / "bad-conn"
    write_connector(bad, cid="bad-conn", manifest="api_version: 1\nid: bad-conn\nkind: nope\n")
    result = mcp.call("test_connector", {"path": str(bad), "file": str(_sample(slug))})
    assert result.ok, result.error
    assert result.data["ok"] is False and result.data["manifest"]["valid"] is False
    assert result.data["manifest"]["issues"] and result.data["runs"] == []
    assert box.specs == []


def test_test_connector_messages_are_value_free(tester):
    mcp, slug, _box = tester
    leaky = (
        "import json, sys\nreq = json.load(sys.stdin)\n"
        "text = open(req['file']['path'], encoding='utf-8').read()\n"
        "print(json.dumps({'error': {'kind': 'bad_file', 'message': text}}))\nsys.exit(1)\n"
    )
    root = write_connector(ws_connectors(slug) / "test-conn", cid="test-conn", code=leaky)
    sample = _sample(slug, text=f"date,type,amount\n2026-01-05,{SECRET_MESSAGE},4321.09\n")
    result = mcp.call("test_connector", {"path": str(root), "file": str(sample)})
    assert result.ok, result.error
    assert result.data["ok"] is False
    assert {r["error_kind"] for r in result.data["runs"]} == {"bad_file"}
    blob = json.dumps(result.data)
    for leak in ("Kowalski", "PL6110", "4321", "10901014"):
        assert leak not in blob, leak


# --------------------------------------------------------------------------- #
# R2 end to end: a Deno connector written in the workspace -> test -> propose -> approve -> run
# --------------------------------------------------------------------------- #

_DENO = shutil.which("deno", path=os.pathsep.join(SYSTEM_SEARCH_PATH))
needs_mac_deno = pytest.mark.skipif(
    _DENO is None or sys.platform != "darwin" or not os.path.exists("/usr/bin/sandbox-exec"),
    reason="macOS sandbox-exec and a deno on the fixed search path",
)


@needs_mac_deno
def test_a_deno_connector_goes_from_the_workspace_to_an_approved_run(db_engine):
    """The real sandbox (deno inside sandbox-exec): the example Deno connector copied into a profile's
    workspace passes test_connector, is proposed, approved by the owner and then converts the sample
    as an installed connector."""
    from cashu.core import paths

    with get_session() as s:
        p = profiles.create_profile(s, name="Anna Nowak", modules_=["budget"])
        pid, slug = p.id, p.slug
    mcp = CashuMcp(pid)
    example = paths.PROJECT_ROOT / "examples" / "connectors" / "deno-budget-example"
    root = ws_connectors(slug) / "deno-budget-example"
    shutil.copytree(example, root)
    sample = workspace.workspace_path(slug) / "inbox" / "statement.csv"
    sample.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(example / "sample.csv", sample)

    tested = mcp.call("test_connector", {"path": str(root), "file": str(sample)})
    assert tested.ok, tested.error
    assert tested.data["ok"] is True, tested.data["report"]
    assert tested.data["manifest"]["interpreter"] == "deno"
    assert tested.data["document"]["counts"]["transactions"] == 4

    proposed = mcp.call("propose_connector", {"path": str(root)})
    assert proposed.ok and proposed.data["status"] == "pending"
    with get_session() as s:
        from cashu.core.connectors.models import Connector

        row = s.get(Connector, "deno-budget-example")
        sha, interpreter = row.content_sha256, row.interpreter_path
    service.approve("deno-budget-example", sha, interpreter)  # the owner, in the app
    result = service.run_file("deno-budget-example", "convert", sample, "statement.csv",
                              profile_id=pid)
    assert result.ok, (result.error_kind, result.message, result.stderr_tail)
    assert result.records == 4


@needs_mac_deno
def test_test_connector_reports_a_forbidden_import(db_engine, tmp_path):
    with get_session() as s:
        p = profiles.create_profile(s, name="Anna Nowak", modules_=["budget"])
        pid, slug = p.id, p.slug
    secret = tmp_path / "secret.txt"
    secret.write_text("FAKE SECRET 4321.09", encoding="utf-8")
    manifest = (
        "api_version: 1\nid: deno-leak\nname: Test\nversion: 0.1.0\nmodule: budget\nkind: file\n"
        "run: [deno, connector.ts]\nfile:\n  extensions: [csv]\n"
    )
    code = f'import s from {str(secret)!r} with {{ type: "text" }};\nconsole.log(s);\n'
    root = ws_connectors(slug) / "deno-leak"
    write_connector(root, cid="deno-leak", manifest=manifest, code="", extra={"connector.ts": code})
    (root / "main.py").unlink()
    sample = workspace.workspace_path(slug) / "inbox" / "x.csv"
    sample.parent.mkdir(parents=True, exist_ok=True)
    sample.write_text("a,b\n", encoding="utf-8")
    result = CashuMcp(pid).call("test_connector", {"path": str(root), "file": str(sample)})
    assert result.ok, result.error
    assert result.data["ok"] is False
    assert {r["error_kind"] for r in result.data["runs"]} == {"forbidden_import"}
    blob = json.dumps(result.data)
    assert "FAKE SECRET" not in blob and "4321" not in blob and str(tmp_path) not in blob


def test_test_connector_caps_the_run_time(tester):
    """convert / fetch run at most 120 s inside an MCP call (detect keeps 10 s); a shorter manifest
    timeout is kept as is; the CLI is not capped."""
    from cashu.core.connectors import devtest

    mcp, slug, box = tester
    long = write_connector(ws_connectors(slug) / "slow-conn", cid="slow-conn", timeout=600)
    assert mcp.call("test_connector", {"path": str(long), "file": str(_sample(slug))}).ok
    assert [s.timeout_s for s in box.specs] == [10.0, 120.0]
    box.specs.clear()
    short = write_connector(ws_connectors(slug) / "quick-conn", cid="quick-conn", timeout=30)
    result = mcp.call("test_connector", {"path": str(short), "file": str(_sample(slug))})
    assert result.ok and [s.timeout_s for s in box.specs] == [10.0, 30.0]
    assert "at most 120 s" in all_tools()["test_connector"].description
    box.specs.clear()
    devtest.run_test(long, file=_sample(slug), sandbox=box)  # the CLI path: the manifest's 600 s
    assert [s.timeout_s for s in box.specs] == [10.0, 600.0]


@needs_mac_deno
def test_test_connector_reports_a_module_parse_error(db_engine):
    with get_session() as s:
        p = profiles.create_profile(s, name="Anna Nowak", modules_=["budget"])
        pid, slug = p.id, p.slug
    manifest = (
        "api_version: 1\nid: deno-bad\nname: Test\nversion: 0.1.0\nmodule: budget\nkind: file\n"
        "run: [deno, connector.ts]\nfile:\n  extensions: [csv]\n"
    )
    root = ws_connectors(slug) / "deno-bad"
    write_connector(root, cid="deno-bad", manifest=manifest, code="",
                    extra={"connector.ts": 'import "./lib/parse.ts";\n',
                           "lib/parse.ts": "const secretValue4321 = ;\n"})
    (root / "main.py").unlink()
    sample = workspace.workspace_path(slug) / "inbox" / "x.csv"
    sample.parent.mkdir(parents=True, exist_ok=True)
    sample.write_text("a,b\n", encoding="utf-8")
    result = CashuMcp(pid).call("test_connector", {"path": str(root), "file": str(sample)})
    assert result.ok, result.error
    assert result.data["ok"] is False
    assert {(r["outcome"], r["error_kind"]) for r in result.data["runs"]} == {
        ("refused", "module_parse_error")
    }
    assert any("lib/parse.ts" in (r["message"] or "") and "deno check" in r["message"]
               for r in result.data["runs"])
    assert "secretValue" not in json.dumps(result.data)
