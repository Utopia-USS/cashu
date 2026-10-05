"""Alert and watchlist MCP tools (F5) on the synthetic sensitive profile: agent alerts are created active
with source agent and audited, price levels and percentages are sent in strict mode (not personal
amounts) while owner-named instruments stay masked, the 50-alert cap, errors the agent can fix, profile
binding."""

from __future__ import annotations

import json

import pytest
from mcp_support import (
    CLAIM_NAME,
    TODAY,
    add_claim,
    investments_account_id,
    seed_profile,
    sources,
)
from sqlmodel import select

from finanse.core.agent_models import McpCall
from finanse.core.db import get_session
from finanse.core.mcp.server import FinanseMcp
from finanse.core.models import Profile
from finanse.modules.investments.models import InvAlert
from finanse.modules.investments.service import daily


@pytest.fixture
def host(db_engine):
    pid, _slug = seed_profile()
    return pid, FinanseMcp(pid, today=TODAY)


def price_alert(**extra) -> dict:
    return {
        "kind": "price_above",
        "params": {"level": 10},
        "instrument": "PKO",
        "polarity": "positive",
        "severity": "action",
        "title": "PKO above 10",
        **extra,
    }


def test_add_alert_creates_an_active_agent_alert_and_is_audited(host):
    pid, mcp = host
    result = mcp.call("add_alert", price_alert(note="dip plan", expires_in_days=30))
    assert result.ok, result.error
    alert = result.data["alert"]
    assert (alert["status"], alert["source"], alert["created_by"]) == ("active", "agent", "mcp")
    assert alert["params"] == {"level": 10.0}  # a price level is sent in strict mode
    assert alert["instrument"]["symbol"] == "PKO" and alert["instrument"]["owner_named"] is False
    assert result.data["limits"] == {"agent_live": 1, "agent_max": 50}
    with get_session() as s:
        (row,) = s.exec(select(InvAlert)).all()
        assert (row.source, row.created_by, row.profile_id) == ("agent", "mcp", pid)
        audit = s.exec(select(McpCall).where(McpCall.tool == "add_alert")).one()
        assert audit.outcome == "ok" and audit.privacy == "strict"
        assert audit.args == {
            "kind": "string",
            "params": "object",
            "instrument": "string",
            "polarity": "string",
            "severity": "string",
            "title": "string",
            "note": "string",
            "expires_in_days": "integer",
        }
        assert "PKO" not in json.dumps(audit.args)

    daily.run_daily_check("manual", as_of=TODAY, sources=sources())
    (listed,) = mcp.call("alerts", {}).data["alerts"]
    assert listed["status"] == "triggered" and listed["signal"]["status"] == "active"
    assert isinstance(listed["last_value"], float) and listed["last_value"] > 10
    assert mcp.call("alerts", {"status": "muted"}).data["alerts"] == []


def test_agent_errors_are_fixable(host):
    _pid, mcp = host
    bad_kind = mcp.call("add_alert", price_alert(kind="price_abve"))
    assert not bad_kind.ok and bad_kind.error_kind == "invalid_arguments"
    typo = mcp.call("add_alert", price_alert(params={"levle": 10}))
    assert not typo.ok and "params.levle" in typo.error and 'did you mean "level"' in typo.error
    unknown = mcp.call("add_alert", price_alert(instrument="NOPE"))
    assert not unknown.ok and unknown.error_kind == "not_found"
    assert "add it to the watchlist first" in unknown.error
    missing = mcp.call("add_alert", {"kind": "price_above", "params": {"level": 1}})
    assert not missing.ok and missing.error_kind == "invalid_arguments"
    assert mcp.call("mute_alert", {"id": 999}).error_kind == "not_found"
    assert mcp.call("remove_from_watchlist", {"id": 999}).error_kind == "not_found"


def test_the_agent_cap_counts_live_agent_alerts(host):
    _pid, mcp = host
    first = None
    for i in range(50):
        result = mcp.call("add_alert", price_alert(params={"level": 10 + i}, title=f"a{i}"))
        assert result.ok, (i, result.error)
        first = first or result.data["alert"]["alert_id"]
    over = mcp.call("add_alert", price_alert(params={"level": 99}))
    assert not over.ok and over.error_kind == "limit" and "At most 50" in over.error
    muted = mcp.call("mute_alert", {"id": first})
    assert muted.ok and muted.data == {"alert_id": first, "status": "muted"}
    assert mcp.call("add_alert", price_alert(params={"level": 99})).ok


def test_watchlist_tools(host):
    _pid, mcp = host
    added = mcp.call("add_to_watchlist", {"symbol_or_isin": "CDR.WA", "note": "idea"})
    assert added.ok, added.error
    item = added.data["item"]
    assert added.data["created_instrument"] is True and added.data["warnings"]
    assert item["instrument"]["symbol"] == "CDR" and item["source"] == "agent"
    conflict = mcp.call("add_to_watchlist", {"symbol_or_isin": "CDR.WA"})
    assert not conflict.ok and conflict.error_kind == "conflict"
    held = mcp.call("add_to_watchlist", {"symbol_or_isin": "EUNL.DE"}).data["item"]
    assert held["held"] is True
    daily.run_daily_check("manual", as_of=TODAY, sources=sources())
    rows = {r["instrument"]["symbol"]: r for r in mcp.call("watchlist", {}).data["items"]}
    assert isinstance(rows["EUNL"]["last_close"], float)  # a market level, sent in strict
    assert rows["EUNL"]["change_1m"] is not None and rows["CDR"]["last_close"] is None
    removed = mcp.call("remove_from_watchlist", {"id": item["item_id"]})
    assert removed.ok and removed.data == {"item_id": item["item_id"], "removed": True}
    assert {r["instrument"]["symbol"] for r in mcp.call("watchlist", {}).data["items"]} == {"EUNL"}


def test_owner_named_instruments_keep_their_levels_and_names_private(host):
    pid, mcp = host
    claim = add_claim(pid, investments_account_id(pid))
    created = mcp.call(
        "add_alert",
        {
            "kind": "price_below",
            "params": {"level": 950},
            "instrument": str(claim),
            "polarity": "negative",
            "severity": "info",
            "title": "loan check",
        },
    )
    assert created.ok, created.error
    alert = created.data["alert"]
    assert alert["instrument"]["owner_named"] is True
    assert "level" not in alert["params"] and "symbol" not in alert["instrument"]
    assert "950" not in json.dumps(created.data) and "Nowak" not in json.dumps(created.data)
    with get_session() as s:
        p = s.get(Profile, pid)
        p.mcp_privacy = "amounts"
        s.add(p)
    shown = mcp.call("alerts", {}).data["alerts"]
    loan = next(a for a in shown if a["title"] == "loan check")
    assert loan["params"]["level"] == 950.0  # amounts mode sends it as an amount
    assert CLAIM_NAME not in json.dumps(shown)


def test_tools_are_bound_to_their_profile(host):
    _pid, mcp = host
    alert_id = mcp.call("add_alert", price_alert()).data["alert"]["alert_id"]
    item_id = mcp.call("add_to_watchlist", {"symbol_or_isin": "CDR.WA"}).data["item"]["item_id"]
    other, _ = seed_profile("Ewa Testowa", run_daily=False)
    stranger = FinanseMcp(other, today=TODAY)
    assert stranger.call("alerts", {"status": "all"}).data["alerts"] == []
    assert stranger.call("watchlist", {}).data["items"] == []
    assert stranger.call("mute_alert", {"id": alert_id}).error_kind == "not_found"
    assert stranger.call("remove_from_watchlist", {"id": item_id}).error_kind == "not_found"
    assert mcp.call("alerts", {}).data["alerts"][0]["status"] == "active"
