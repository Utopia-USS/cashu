"""F6 MCP additions on the synthetic sensitive profile: the ``signals`` tool carries polarity, source
and snooze for rule and alert signals in strict and amounts mode; soft-deleted alerts stay out of
the agent's view and its cap."""

from __future__ import annotations

import pytest
from mcp_support import TODAY, seed_profile, sources

from finanse.core.db import get_session
from finanse.core.mcp.server import FinanseMcp
from finanse.core.models import Profile
from finanse.modules.investments.service import alerts as alert_service
from finanse.modules.investments.service import daily


@pytest.fixture
def host(db_engine):
    pid, _slug = seed_profile()
    return pid, FinanseMcp(pid, today=TODAY)


def _alert(mcp, level: float = 10, title: str = "PKO above 10") -> int:
    result = mcp.call(
        "add_alert",
        {
            "kind": "price_above",
            "params": {"level": level},
            "instrument": "PKO",
            "polarity": "positive",
            "severity": "action",
            "title": title,
        },
    )
    assert result.ok, result.error
    return result.data["alert"]["alert_id"]


def test_signals_tool_returns_polarity_source_and_snooze(host):
    pid, mcp = host
    _alert(mcp)
    daily.run_daily_check("manual", as_of=TODAY, sources=sources())
    for privacy in ("strict", "amounts"):
        with get_session() as s:
            p = s.get(Profile, pid)
            p.mcp_privacy = privacy
            s.add(p)
        result = mcp.call("signals", {})
        assert result.ok, result.error
        rows = result.data["signals"]
        assert rows and all(r["polarity"] in {"positive", "negative", "neutral"} for r in rows)
        alert_rows = [r for r in rows if r["source"] == "alert"]
        assert [r["polarity"] for r in alert_rows] == ["positive"], privacy
        assert all(r["source"] in {"rule", "alert"} for r in rows)
        assert all("snoozed_until" in r and r["snoozed_until"] is None for r in rows)


def test_soft_deleted_alerts_are_hidden_from_the_agent_and_its_cap(host, monkeypatch):
    pid, mcp = host
    monkeypatch.setattr(alert_service, "AGENT_ALERT_LIMIT", 1)
    first = _alert(mcp)
    assert not mcp.call(
        "add_alert",
        {"kind": "price_above", "params": {"level": 11}, "instrument": "PKO", "title": "x"},
    ).ok
    with get_session() as s:
        alert_service.delete(s, s.get(Profile, pid), first)
    assert mcp.call("alerts", {"status": "all"}).data["alerts"] == []
    assert _alert(mcp, 12, "second") != first  # the deleted one freed the slot
