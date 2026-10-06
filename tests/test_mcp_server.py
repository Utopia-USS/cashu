"""The MCP server host: bound to one profile, module gating, privacy level read per call, audit rows
without argument values, fail-closed refusals (rolled back), the official SDK round trip in process
and over a real stdio subprocess, and the ``cashu mcp`` command."""

from __future__ import annotations

import json
import os
import sys

import anyio
import pytest
from mcp_support import TODAY, investments_account_id, seed_profile
from sqlmodel import select
from typer.testing import CliRunner

from cashu.core import profiles
from cashu.core.agent_models import McpCall, Review
from cashu.core.db import get_session
from cashu.core.mcp import labels as L
from cashu.core.mcp.registry import ToolSpec
from cashu.core.mcp.server import CashuMcp, build_server
from cashu.core.models import Profile
from cashu.modules.investments.store import journal, signals

SECRET = "B-SECRET-THESIS"


@pytest.fixture
def api_factory():
    from conftest import make_client

    from cashu.api.app import app

    return lambda: make_client(app)


@pytest.fixture
def two(db_engine):
    a, a_slug = seed_profile("Marta Kowalczyk")
    b, b_slug = seed_profile("Piotr Zielinski")
    with get_session() as s:
        from cashu.modules.investments.store.instruments import profile_instrument_ids

        iid = min(profile_instrument_ids(s, b))
        journal.create_thesis(s, b, iid, {"entry_type": "trend", "thesis": SECRET})
    return a, a_slug, b, b_slug


def _set(pid: int, **fields) -> None:
    with get_session() as s:
        p = s.get(Profile, pid)
        for k, v in fields.items():
            setattr(p, k, v)
        s.add(p)


def test_server_serves_only_its_profile(two):
    a, _a_slug, b, _b_slug = two
    host = CashuMcp(a, today=TODAY)
    for spec in host.list_tools():
        if spec.write or spec.properties.keys() & {"path", "module"}:
            continue
        result = host.call(spec.name, {})
        assert result.ok, (spec.name, result.error)
        assert SECRET not in json.dumps(result.data), spec.name
    # No profile argument exists on any tool.
    refused = host.call("positions", {"profile": "piotr-zielinski"})
    assert not refused.ok and refused.error_kind == "invalid_arguments"
    # Write tools cannot reach B's rows.
    with get_session() as s:
        b_signal = signals.open_signal_rows(s, b)[0]
        before = (b_signal.id, b_signal.status)
    result = host.call("record_decision", {"signal_id": b_signal.id, "action": "held"})
    assert not result.ok and result.error_kind == "not_found"
    with get_session() as s:
        row = signals.open_signal_rows(s, b)
        assert (row[0].id, row[0].status) == before or before in [(r.id, r.status) for r in row]
        assert not journal.decisions(s, b)
    # The binding is by id: renaming A's slug does not move the server to another profile.
    _set(a, slug="renamed")
    overview = host.call("profile_overview", {})
    assert overview.ok
    with get_session() as s:
        assert {c.profile_id for c in s.exec(select(McpCall)).all()} == {a}


def test_for_slug_requires_an_existing_profile(db_engine):
    with pytest.raises(profiles.ProfileNotFound):
        CashuMcp.for_slug("nobody")


def test_disabled_module_tools_are_hidden_and_refused(db_engine):
    pid, _slug = seed_profile(run_daily=False)
    with get_session() as s:
        profiles.set_modules(s, s.get(Profile, pid), ["budget"])
    host = CashuMcp(pid, today=TODAY)
    names = {t.name for t in host.list_tools()}
    assert (
        "spending_breakdown" in names and "positions" not in names and "loans_summary" not in names
    )
    result = host.call("positions", {})
    assert not result.ok and result.error_kind == "module_disabled"
    review = host.call("mark_review_done", {"notes": "x"})
    assert not review.ok  # investments is off


def test_privacy_level_is_read_on_every_call(db_engine):
    pid, _slug = seed_profile(run_daily=False)
    host = CashuMcp(pid, today=TODAY)
    strict = host.call("networth_breakdown", {}).data
    assert all("assets" not in c for c in strict["currencies"])
    _set(pid, mcp_privacy="amounts")
    amounts = host.call("networth_breakdown", {}).data
    assert all("assets" in c for c in amounts["currencies"])
    assert host.call("profile_overview", {}).data["privacy"] == "amounts"


def test_every_call_is_audited_without_argument_values(db_engine, api_factory):
    pid, slug = seed_profile(run_daily=False)
    host = CashuMcp(pid, today=TODAY)
    secret_note = "notatka-ZOFIA-WISNIEWSKA-4321.09"
    host.call("profile_overview", {})
    host.call("mark_review_done", {"notes": secret_note})
    host.call("set_merchant_category", {"merchant": "MERCHANT-SECRET", "category": "groceries"})
    host.call("setup_status", {"module": "nope"})
    host.call("no_such_tool", {"x": secret_note})
    host.call("positions", {"surprise-key-ZOFIA": 1})
    with get_session() as s:
        rows = s.exec(select(McpCall).order_by(McpCall.id)).all()
    assert [r.tool for r in rows] == [
        "profile_overview",
        "mark_review_done",
        "set_merchant_category",
        "setup_status",
        "(unknown)",
        "positions",
    ]
    assert [r.outcome for r in rows] == ["ok", "ok", "error", "error", "error", "error"]
    assert rows[1].args == {"notes": "string"}
    assert rows[5].args == {"_unknown": 1}
    assert all(r.privacy == "strict" and r.profile_id == pid for r in rows)
    blob = json.dumps([r.model_dump(mode="json") for r in rows])
    for value in (secret_note, "MERCHANT-SECRET", "ZOFIA", "nope"):
        assert value not in blob
    api = api_factory()
    listed = api.get(f"/api/p/{slug}/mcp/calls?limit=3").json()
    assert [c["tool"] for c in listed] == ["positions", "(unknown)", "setup_status"]
    info = api.get(f"/api/p/{slug}/mcp").json()
    assert (
        info["claude_mcp_add"] == f"claude mcp add cashu-{slug} -- cashu mcp --profile {slug}"
    )
    assert {"profile_overview", "positions"} <= {t["name"] for t in info["tools"]}


def test_internal_errors_send_no_exception_text(db_engine):
    pid, _slug = seed_profile(run_daily=False)
    host = CashuMcp(pid, today=TODAY)

    def boom(ctx):
        raise ValueError("PL61109010140000071219812874 Zofia")

    host._tools["profile_overview"] = ToolSpec("profile_overview", "core", "x", boom)
    result = host.call("profile_overview", {})
    assert not result.ok and result.error_kind == "internal"
    assert "PL61" not in result.error and "Zofia" not in result.error


def test_unlabelled_or_leaky_answers_are_refused_and_rolled_back(db_engine):
    pid, _slug = seed_profile(run_daily=False)
    host = CashuMcp(pid, today=TODAY)

    def writes_then(value):
        def handler(ctx):
            ctx.session.add(Review(profile_id=ctx.profile_id, module="budget", notes="x"))
            ctx.session.flush()
            return {"x": value}

        return handler

    cases = {
        "unlabelled": writes_then(123.45),
        "privacy_check": writes_then(L.pct(12345678901)),
    }
    for kind, handler in cases.items():
        host._tools["mark_review_done"] = ToolSpec(
            "mark_review_done", "core", "x", handler, write=True
        )
        result = host.call("mark_review_done", {})
        assert not result.ok and result.error_kind == kind
    with get_session() as s:
        assert s.exec(select(Review)).all() == []
        outcomes = [r.outcome for r in s.exec(select(McpCall)).all()]
    assert outcomes == ["refused", "refused"]


def test_sdk_round_trip_in_process(db_engine):
    from mcp import Client

    pid, slug = seed_profile(run_daily=False)
    server = build_server(CashuMcp(pid, today=TODAY), f"cashu-{slug}")

    async def main():
        async with Client(server) as client:
            tools = await client.list_tools()
            names = {t.name for t in tools.tools}
            assert {"profile_overview", "positions", "propose_strategy"} <= names
            spec = next(t for t in tools.tools if t.name == "propose_strategy")
            assert spec.input_schema["additionalProperties"] is False
            assert spec.annotations.read_only_hint is False
            ok = await client.call_tool("profile_overview", {})
            assert not ok.is_error
            assert ok.structured_content["privacy"] == "strict"
            assert json.loads(ok.content[0].text)["base_currency"] == "PLN"
            bad = await client.call_tool("setup_status", {})
            assert bad.is_error and "module" in bad.content[0].text

    anyio.run(main)


def test_stdio_subprocess_end_to_end(db_engine, tmp_path):
    from mcp import Client, StdioServerParameters

    _pid, slug = seed_profile(run_daily=False)
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(tmp_path),
        "CASHU_DATA_DIR": str(tmp_path / "data"),
        "CASHU_DATABASE_URL": f"sqlite:///{tmp_path / 'cashu.db'}",
    }
    params = StdioServerParameters(
        command=sys.executable, args=["-m", "cashu.cli", "mcp", "--profile", slug], env=env
    )

    async def main():
        with anyio.fail_after(60):
            async with Client(params) as client:
                names = {t.name for t in (await client.list_tools()).tools}
                assert "networth_breakdown" in names
                result = await client.call_tool("networth_breakdown", {})
                assert not result.is_error
                assert "987654" not in result.content[0].text

    anyio.run(main)
    with get_session() as s:
        assert [r.tool for r in s.exec(select(McpCall)).all()] == ["networth_breakdown"]


def test_cli_requires_an_existing_profile(db_engine):
    from cashu.cli import app

    runner = CliRunner()
    missing = runner.invoke(app, ["mcp"])
    assert missing.exit_code == 2
    unknown = runner.invoke(app, ["mcp", "--profile", "nobody"])
    assert unknown.exit_code == 1
    clash = runner.invoke(app, ["--profile", "a", "mcp", "--profile", "b"])
    assert clash.exit_code == 2


def test_investments_account_label_used_for_imports(db_engine):
    pid, _slug = seed_profile(run_daily=False)
    host = CashuMcp(pid, today=TODAY)
    label = host.call("portfolio_overview", {}).data["accounts"][0]["account"]
    assert label == "DIF Broker brokerage 1"
    assert investments_account_id(pid) > 0


def test_no_audit_row_no_call(db_engine, monkeypatch):
    from cashu.core.mcp import audit

    pid, _slug = seed_profile(run_daily=False)
    host = CashuMcp(pid, today=TODAY)

    def broken(*_a, **_k):
        raise audit.AuditUnavailable("OperationalError")

    monkeypatch.setattr(audit, "start", broken)
    result = host.call("mark_review_done", {"notes": "x"})
    assert not result.ok and result.error_kind == "audit_unavailable"
    with get_session() as s:
        assert s.exec(select(Review)).all() == []
