"""Proposals end to end: created by the MCP write tools, listed / inspected / approved / rejected through
the app API. Strategy (files + version, refused when the files changed meanwhile), custom rule (compiler
column, dry run, backtest, merged into strategy.yaml keeping comments), import (preview, commit on
approval) and the refusal of scripts (an MCP call never makes the app run code, F10; F5 R1)."""

from __future__ import annotations

import pytest
from mcp_support import (
    STRATEGY_YAML,
    TODAY,
    write_export_csv,
)
from sqlmodel import select

from cashu.core import proposals
from cashu.core.agent_models import Proposal
from cashu.core.db import get_session
from cashu.core.mcp.server import CashuMcp
from cashu.modules.investments.models import InvStrategyVersion, InvTransaction
from cashu.modules.investments.service import files


@pytest.fixture
def setup(db_engine):
    from conftest import make_client
    from mcp_support import seed_profile

    from cashu.api.app import app

    pid, slug = seed_profile()
    return pid, slug, CashuMcp(pid, today=TODAY), make_client(app)


def _versions(pid: int) -> list[int]:
    with get_session() as s:
        return [
            v.version
            for v in s.exec(select(InvStrategyVersion).where(InvStrategyVersion.profile_id == pid))
        ]


# --------------------------------------------------------------------------- #
# Strategy
# --------------------------------------------------------------------------- #


def test_strategy_proposal_approve_writes_files_and_a_version(setup):
    pid, slug, host, api = setup
    new_yaml = STRATEGY_YAML.replace("max_weight: 0.20", "max_weight: 0.25")
    dry = host.call("propose_strategy", {"yaml": new_yaml, "dry_run": True}).data
    assert dry["valid"] and not dry["stored"]
    assert api.get(f"/api/p/{slug}/proposals").json() == []
    stored = host.call("propose_strategy", {"yaml": new_yaml, "reason": "luzniejszy limit"}).data
    assert stored["stored"] and stored["yaml_diff"] == {"lines_added": 1, "lines_removed": 1}
    pid_ = stored["proposal_id"]
    listed = api.get(f"/api/p/{slug}/proposals?status=pending").json()
    assert [p["id"] for p in listed] == [pid_] and listed[0]["kind"] == "strategy"
    detail = api.get(f"/api/p/{slug}/proposals/{pid_}").json()
    assert "+    params: { max_weight: 0.25 }" in detail["diff"]["yaml"]
    assert detail["base_changed"] is False and detail["reason"] == "luzniejszy limit"
    approved = api.post(f"/api/p/{slug}/proposals/{pid_}/approve").json()
    assert approved["status"] == "approved" and approved["result"]["version"] == 2
    assert files.strategy_yaml_path(slug).read_text() == new_yaml
    assert _versions(pid) == [1, 2]
    again = api.post(f"/api/p/{slug}/proposals/{pid_}/approve")
    assert again.status_code == 409


def test_invalid_strategy_is_not_stored_and_reports_line_column(setup):
    _pid, slug, host, api = setup
    result = host.call(
        "propose_strategy", {"yaml": "version: 1\nbase_currency: PLN\nrules: 5\n"}
    ).data
    assert not result["valid"] and not result["stored"]
    assert any(i["line"] for i in result["issues"])
    assert api.get(f"/api/p/{slug}/proposals").json() == []


def test_strategy_approval_fails_when_files_changed_meanwhile(setup):
    _pid, slug, host, api = setup
    pid_ = host.call("propose_strategy", {"yaml": STRATEGY_YAML + "\n# v2\n"}).data["proposal_id"]
    files.write_text_private(files.strategy_yaml_path(slug), STRATEGY_YAML + "\n# edited by hand\n")
    response = api.post(f"/api/p/{slug}/proposals/{pid_}/approve")
    assert response.status_code == 422 and "changed" in response.json()["detail"]
    detail = api.get(f"/api/p/{slug}/proposals/{pid_}").json()
    assert detail["status"] == "failed" and "changed" in detail["result"]["error"]
    assert "edited by hand" in files.strategy_yaml_path(slug).read_text()


def test_reject_and_profile_scoping(setup):
    _pid, slug, host, api = setup
    pid_ = host.call("propose_strategy", {"yaml": STRATEGY_YAML + "\n"}).data["proposal_id"]
    with get_session() as s:
        from cashu.core import profiles

        other = profiles.create_profile(s, name="Inny", modules_=["investments"])
        other_slug = other.slug
    assert api.get(f"/api/p/{other_slug}/proposals/{pid_}").status_code == 404
    assert api.post(f"/api/p/{other_slug}/proposals/{pid_}/approve").status_code == 404
    assert api.post(f"/api/p/{other_slug}/proposals/{pid_}/reject").status_code == 404
    rejected = api.post(f"/api/p/{slug}/proposals/{pid_}/reject", json={"note": "nie teraz"}).json()
    assert rejected["status"] == "rejected" and rejected["result"] == {"note": "nie teraz"}
    assert api.post(f"/api/p/{slug}/proposals/{pid_}/approve").status_code == 409
    assert api.get(f"/api/p/{slug}/proposals?status=bogus").status_code == 422


# --------------------------------------------------------------------------- #
# Custom rules
# --------------------------------------------------------------------------- #


def test_custom_rule_expression_error_has_a_column(setup):
    _pid, _slug, host, _api = setup
    result = host.call(
        "propose_custom_rule",
        {"kind_or_expression": "weight >> 10%", "params": {"scope": "instrument"}},
    ).data
    assert not result["valid"] and not result["stored"]
    assert result["issues"][0]["column"] == 9
    unknown = host.call(
        "propose_custom_rule", {"kind_or_expression": "no_such_metric > 1", "params": {}}
    ).data
    assert not unknown["valid"]


def test_custom_rule_dry_run_backtest_then_approve_merges_into_yaml(setup):
    pid, slug, host, api = setup
    args = {
        "kind_or_expression": "weight > 15%",
        "params": {
            "scope": "instrument",
            "message": "Pozycja ponad 15%",
            "id": "big_position",
            "severity": "action",
            "cooldown_days": 14,
        },
        "reason": "kontrola koncentracji",
    }
    dry = host.call("propose_custom_rule", args | {"dry_run": True}).data
    assert dry["valid"] and not dry["stored"] and dry["rule_id"] == "big_position"
    bt = dry["backtest"]
    assert bt["evaluated"] > 50 and bt["step_days"] == 7
    assert bt["episodes"] >= 1 and bt["points_fired"] >= bt["episodes"]
    assert set(bt["instruments"]) <= {"PKO", "AAPL", "EUNL"}
    assert api.get(f"/api/p/{slug}/proposals").json() == []
    stored = host.call("propose_custom_rule", args).data
    assert stored["stored"] and stored["backtest"] == bt
    detail = api.get(f"/api/p/{slug}/proposals/{stored['proposal_id']}").json()
    assert (
        "kind: custom" in detail["rule_yaml"] and detail["backtest"]["episodes"] == bt["episodes"]
    )
    assert "+  - id: big_position" in detail["diff"]["yaml"]
    duplicate = host.call("propose_custom_rule", args).data
    assert duplicate["stored"]  # the id is free until one of them is approved
    approved = api.post(f"/api/p/{slug}/proposals/{stored['proposal_id']}/approve").json()
    assert approved["status"] == "approved" and approved["result"]["rule_id"] == "big_position"
    text = files.strategy_yaml_path(slug).read_text()
    assert "# owner's note: the IKE account" in text and "# trailing comment block" in text
    assert text.index("id: big_position") < text.index("# trailing comment block")
    status = host.call("strategy_status", {}).data
    assert status["state"] == "valid" and "big_position" in [
        r["rule"] for r in status["facts"]["rules"]
    ]
    assert _versions(pid) == [1, 2]
    late = api.post(f"/api/p/{slug}/proposals/{duplicate['proposal_id']}/approve")
    assert late.status_code == 422 and "already has a rule" in late.json()["detail"]
    taken = host.call("propose_custom_rule", args)
    assert not taken.ok and "already exists" in taken.error


def test_builtin_kind_rule_and_no_strategy(setup):
    _pid, slug, host, _api = setup
    result = host.call(
        "propose_custom_rule",
        {"kind_or_expression": "loss_from_cost", "params": {"threshold": 0.3}, "dry_run": True},
    ).data
    assert result["valid"] and result["kind"] == "loss_from_cost"
    bad = host.call(
        "propose_custom_rule",
        {"kind_or_expression": "loss_from_cost", "params": {"thresold": 0.3}, "dry_run": True},
    ).data
    assert not bad["valid"] and bad["issues"]
    files.strategy_yaml_path(slug).unlink()
    missing = host.call("propose_custom_rule", {"kind_or_expression": "weight > 1%"})
    assert not missing.ok and missing.error_kind == "no_strategy"


def test_merge_rule_variants():
    from cashu.core.mcp.tools.investments_proposals import merge_rule
    from cashu.modules.investments.strategy import load_strategy

    entry = {"id": "x", "kind": "cash_level", "params": {"max_weight": 0.3}}
    base = STRATEGY_YAML.split("rules:")[0]
    for text in (
        base,
        base + "rules: []\n",
        base + "rules:\n- id: a\n  kind: cash_level\n  params: {max_weight: 0.5}\n",
    ):
        merged = merge_rule(text, entry)
        result = load_strategy(merged)
        assert result.config is not None, (merged, result.issues)
        assert result.config.rule("x") is not None


# --------------------------------------------------------------------------- #
# Imports
# --------------------------------------------------------------------------- #


NEW_DEPOSIT = (
    "format_version,record,date,time,type,external_ref,symbol,isin,name,exchange,quantity,price,"
    "currency,gross_amount,fee,tax,cash_amount,cash_currency,fx_rate,split_ratio,source\n"
    "1,txn,2026-01-05,,deposit,N-1,,,,,,,PLN,,,,1000.00,,,,\n"
)


def _txn_count(pid: int) -> int:
    from cashu.modules.investments.store.transactions import brokerage_accounts

    with get_session() as s:
        ids = [a.id for a in brokerage_accounts(s, pid)]
        return len(s.exec(select(InvTransaction).where(InvTransaction.account_id.in_(ids))).all())


def test_import_proposal_previews_and_commits_on_approval(setup, tmp_path):
    pid, slug, host, api = setup
    path = tmp_path / "new.csv"
    path.write_text(NEW_DEPOSIT)
    label = host.call("portfolio_overview", {}).data["accounts"][0]["account"]
    result = host.call("propose_import", {"path": str(path), "account": label}).data
    assert result["stored"] and result["preview"]["new"] == 1
    before = _txn_count(pid)
    detail = api.get(f"/api/p/{slug}/proposals/{result['proposal_id']}").json()
    assert detail["preview"]["new"] == 1 and detail["file_name"] == "new.csv"
    approved = api.post(f"/api/p/{slug}/proposals/{result['proposal_id']}/approve").json()
    assert approved["status"] == "approved" and approved["result"]["inserted"] == 1
    assert _txn_count(pid) == before + 1
    unknown = host.call("propose_import", {"path": str(path), "account": "nope"})
    assert not unknown.ok and unknown.error_kind == "not_found"


def test_import_with_blocking_errors_is_not_stored(setup, tmp_path):
    _pid, slug, host, api = setup
    export = write_export_csv(tmp_path)
    label = host.call("portfolio_overview", {}).data["accounts"][0]["account"]
    result = host.call("propose_import", {"path": str(export), "account": label}).data
    assert not result["stored"] and result["preview"]["errors"] >= 1
    assert api.get(f"/api/p/{slug}/proposals").json() == []


# --------------------------------------------------------------------------- #
# No agent-written code in the app (F5 R1)
# --------------------------------------------------------------------------- #

MARKER_SCRIPT = (
    "import pathlib, sys\npathlib.Path(sys.argv[0]).with_suffix('.ran').write_text('ran')\n"
)


def test_converter_argument_is_refused_with_a_clear_error(setup, tmp_path):
    _pid, slug, host, api = setup
    export = write_export_csv(tmp_path)
    label = host.call("portfolio_overview", {}).data["accounts"][0]["account"]
    for tool, args in (
        ("validate_import", {"path": str(export), "converter": "broker_x"}),
        ("propose_import", {"path": str(export), "account": label, "converter": "broker_x"}),
    ):
        result = host.call(tool, args)
        assert not result.ok and result.error_kind == "invalid_arguments", (tool, result)
        assert "never make the app run code" in result.error and "python3" in result.error
    assert api.get(f"/api/p/{slug}/proposals").json() == []


def test_script_paths_are_refused_and_never_run(setup, tmp_path):
    _pid, slug, host, api = setup
    label = host.call("portfolio_overview", {}).data["accounts"][0]["account"]
    script = tmp_path / "import_broker.py"
    script.write_text(MARKER_SCRIPT)
    for suffix in (".py", ".sh", ".js"):
        path = script.with_suffix(suffix)
        path.write_text(MARKER_SCRIPT)
        for tool, args in (
            ("validate_import", {"path": str(path)}),
            ("propose_import", {"path": str(path), "account": label}),
            ("validate_import", {"path": str(write_export_csv(tmp_path)), "mapping": str(path)}),
        ):
            result = host.call(tool, args)
            assert not result.ok and result.error_kind == "script_refused", (tool, suffix)
            assert "never make the app run code" in result.error
    assert not list(tmp_path.glob("*.ran"))
    assert api.get(f"/api/p/{slug}/proposals").json() == []


def test_import_tools_have_no_converter_argument():
    from cashu.core.mcp.registry import all_tools

    tools = all_tools()
    for name in ("validate_import", "propose_import"):
        assert "converter" not in tools[name].input_schema["properties"]
        assert "converter" in tools[name].refused
    with pytest.raises(ModuleNotFoundError):
        __import__("cashu.core.mcp.tools.converters")


def test_stored_converter_proposal_cannot_be_approved(setup, tmp_path):
    """A pending import stored before F5 R1 (with a converter) is never run: approving fails with
    a code, and its stored export is removed."""
    from cashu.core import paths

    pid, slug, host, api = setup
    label = host.call("portfolio_overview", {}).data["accounts"][0]["account"]
    path = tmp_path / "new.csv"
    path.write_text(NEW_DEPOSIT)
    stored = host.call("propose_import", {"path": str(path), "account": label}).data
    with get_session() as s:
        row = s.get(Proposal, stored["proposal_id"])
        row.payload = dict(row.payload) | {"converter": {"name": "broker_x", "sha256": "0" * 64}}
        s.add(row)
        staged = paths.data_dir() / row.payload["staged"]
    detail = api.get(f"/api/p/{slug}/proposals/{stored['proposal_id']}").json()
    assert detail["converter_unsupported"] is True and "never runs" in detail["detail_error"]
    before = _txn_count(pid)
    response = api.post(f"/api/p/{slug}/proposals/{stored['proposal_id']}/approve")
    assert response.status_code == 422
    assert response.headers["X-Cashu-Error-Code"] == "converter_unsupported"
    assert _txn_count(pid) == before
    assert not staged.exists()


def test_proposal_kinds_registered():
    assert set(proposals.kinds()) == {"strategy", "custom_rule", "import", "budget_import"}


def test_rejected_import_removes_the_stored_export(setup, tmp_path):
    from cashu.core import paths

    _pid, slug, host, api = setup
    path = tmp_path / "new.csv"
    path.write_text(NEW_DEPOSIT)
    label = host.call("portfolio_overview", {}).data["accounts"][0]["account"]
    stored = host.call("propose_import", {"path": str(path), "account": label}).data
    with get_session() as s:
        staged = paths.data_dir() / s.get(Proposal, stored["proposal_id"]).payload["staged"]
    assert staged.is_file() and staged.stat().st_mode & 0o077 == 0
    api.post(f"/api/p/{slug}/proposals/{stored['proposal_id']}/reject")
    assert not staged.exists()


def test_two_import_proposals_of_one_file_never_share_the_stored_export(setup, tmp_path):
    """BE-2: rejecting one proposal never removes the file another one approves from."""
    _pid, slug, host, api = setup
    path = tmp_path / "new.csv"
    path.write_text(NEW_DEPOSIT)
    label = host.call("portfolio_overview", {}).data["accounts"][0]["account"]
    first, second = (
        host.call("propose_import", {"path": str(path), "account": label}).data["proposal_id"]
        for _ in range(2)
    )
    with get_session() as s:
        assert s.get(Proposal, first).payload["staged"] != s.get(Proposal, second).payload["staged"]
    api.post(f"/api/p/{slug}/proposals/{first}/reject")
    approved = api.post(f"/api/p/{slug}/proposals/{second}/approve")
    assert approved.status_code == 200, approved.text
    assert approved.json()["result"]["inserted"] == 1


# --------------------------------------------------------------------------- #
# Approval with a partial current strategy (relay from the UI track)
# --------------------------------------------------------------------------- #

BROKEN_RULE = """
  - id: broken_rule
    kind: cash_level
    params: { max_weight: lots }
"""


def _with_broken_rule(text: str = STRATEGY_YAML) -> str:
    return text.replace("\n# trailing comment block", BROKEN_RULE + "\n# trailing comment block")


def test_pre_existing_inactive_rule_does_not_block_approval(setup):
    pid, slug, host, api = setup
    files.write_text_private(files.strategy_yaml_path(slug), _with_broken_rule())
    assert host.call("strategy_status", {}).data["state"] == "partial"
    rule = host.call(
        "propose_custom_rule",
        {"kind_or_expression": "cash_level", "params": {"min_weight": 0.01, "id": "min_cash"}},
    ).data
    assert rule["valid"] and rule["stored"]
    approved = api.post(f"/api/p/{slug}/proposals/{rule['proposal_id']}/approve").json()
    assert approved["status"] == "approved", approved
    assert approved["result"]["warnings"] == [
        {
            "code": "inactive_rule",
            "rule_id": "broken_rule",
            "message": "rule broken_rule was already inactive before this change; fix it in "
            "strategy.yaml",
        }
    ]
    text = files.strategy_yaml_path(slug).read_text()
    assert "id: min_cash" in text and "id: broken_rule" in text
    # A whole-strategy proposal that keeps the same inactive rule is accepted with a warning ...
    current = files.strategy_yaml_path(slug).read_text()
    edited = current.replace("max_weight: 0.20", "max_weight: 0.22")
    proposed = host.call("propose_strategy", {"yaml": edited}).data
    assert proposed["valid"] and proposed["stored"]
    assert proposed["warnings"] == [{"code": "inactive_rule", "rule": "broken_rule"}]
    ok = api.post(f"/api/p/{slug}/proposals/{proposed['proposal_id']}/approve").json()
    assert ok["status"] == "approved" and ok["result"]["warnings"][0]["rule_id"] == "broken_rule"
    assert _versions(pid) == [1, 2, 3]
    # ... but one that breaks another rule is not stored.
    worse = edited.replace("max_weight: 0.22", "max_weight: plenty")
    refused = host.call("propose_strategy", {"yaml": worse}).data
    assert not refused["valid"] and not refused["stored"]
    assert refused["error_code"] == "rules_made_inactive"


def test_broken_proposed_rule_blocks_approval_with_a_code(setup):
    _pid, slug, host, api = setup
    stored = host.call(
        "propose_custom_rule",
        {"kind_or_expression": "cash_level", "params": {"max_weight": 0.5, "id": "later_bad"}},
    ).data
    # The owner edits the file so the rule id collides before approval.
    files.write_text_private(
        files.strategy_yaml_path(slug),
        STRATEGY_YAML.replace("id: idle_cash", "id: later_bad"),
    )
    response = api.post(f"/api/p/{slug}/proposals/{stored['proposal_id']}/approve")
    assert response.status_code == 422
    assert response.headers["X-Cashu-Error-Code"] == "rule_exists"
    failed = api.get(f"/api/p/{slug}/proposals/{stored['proposal_id']}").json()
    assert failed["status"] == "failed" and failed["result"]["error_code"] == "rule_exists"


def test_list_carries_summary_code_and_params(setup):
    _pid, slug, host, api = setup
    host.call("propose_strategy", {"yaml": STRATEGY_YAML + "\n"})
    (row,) = api.get(f"/api/p/{slug}/proposals").json()
    assert row["summary_code"] == "strategy"
    assert row["summary_params"] == {"rules": 5, "buckets": 2, "inactive_rules": 0}
    assert row["summary"].startswith("Strategy: 5 rules")
