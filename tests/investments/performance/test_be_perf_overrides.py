"""Performance uses the profile's own view of shared instruments (F6): a per-profile valuation mode
override changes this profile's performance (equal to its overview) and invalidates the cache, while
another profile holding the same instrument keeps the shared default."""

from __future__ import annotations

import pytest
from perf_support import AS_OF, household, sources

from finanse.modules.investments.performance import backfill, service
from finanse.modules.investments.service import daily, portfolio


@pytest.fixture
def client(api_empty, monkeypatch):
    monkeypatch.setattr(portfolio, "today", lambda: AS_OF)
    monkeypatch.setattr(daily, "default_sources", lambda: sources())
    service.clear_cache()
    yield api_empty
    service.clear_cache()


def _end_value(client, slug: str) -> float:
    r = client.get(f"/api/p/{slug}/investments/performance?range=max")
    assert r.status_code == 200, r.text
    return r.json()["summary"]["end_value"]


def _total(client, slug: str) -> float:
    return client.get(f"/api/p/{slug}/investments/overview").json()["kpis"]["value"]["total"]


def test_per_profile_valuation_override_reaches_performance(client):
    pid_a, slug_a, _ = household("Anna")
    pid_b, slug_b, _ = household("Basia")
    backfill.run_backfill(profile_ids=[pid_a, pid_b], as_of=AS_OF, sources=sources())
    assert _end_value(client, slug_a) == _end_value(client, slug_b) == 13430.0

    wrld = next(
        i["id"]
        for i in client.get(f"/api/p/{slug_a}/investments/instruments").json()
        if i["symbol"] == "WRLD"
    )
    r = client.patch(
        f"/api/p/{slug_a}/investments/instruments/{wrld}", json={"valuation_mode": "cost"}
    )
    assert r.status_code == 200, r.text

    # A: WRLD at cost (10 x 100 EUR at the trade-date rate 4.3) instead of the market close
    assert _end_value(client, slug_a) == _total(client, slug_a) == 8700.0 + 4300.0
    # B keeps the shared market valuation
    assert _end_value(client, slug_b) == _total(client, slug_b) == 13430.0


def _history_twr(pid: int) -> float:
    from finanse.core.mcp.server import FinanseMcp

    result = FinanseMcp(pid, today=AS_OF).call("history_metrics", {})
    assert result.ok, result.error
    return result.data["performance"]["return"]["twr"]


def test_frozen_and_renamed_in_one_profile_reaches_every_performance_reader(client):
    """F6 review V1: freeze + rename WRLD in A only; overview, performance, attribution and MCP
    history_metrics all follow A's view (also after a warm cache), B keeps the shared one."""
    pid_a, slug_a, _ = household("Anna")
    pid_b, slug_b, _ = household("Basia")
    backfill.run_backfill(profile_ids=[pid_a, pid_b], as_of=AS_OF, sources=sources())
    # warm every cache first
    assert _end_value(client, slug_a) == _end_value(client, slug_b) == 13430.0
    assert _history_twr(pid_a) == _history_twr(pid_b)

    wrld = next(
        i["id"]
        for i in client.get(f"/api/p/{slug_a}/investments/instruments").json()
        if i["symbol"] == "WRLD"
    )
    r = client.patch(
        f"/api/p/{slug_a}/investments/instruments/{wrld}",
        json={"status": "frozen", "name": "Anna private label"},
    )
    assert r.status_code == 200, r.text

    # A: a frozen holding without a manual valuation is worth 0, like in the overview
    assert _total(client, slug_a) == 8700.0
    assert _end_value(client, slug_a) == 8700.0
    assert _end_value(client, slug_b) == _total(client, slug_b) == 13430.0

    def wrld_row(slug: str) -> dict:
        rows = client.get(f"/api/p/{slug}/investments/performance/attribution").json()
        return next(row for row in rows["instruments"] if row["symbol"] == "WRLD")

    assert wrld_row(slug_a)["name"] == "Anna private label"
    assert wrld_row(slug_a)["end_value"] == 0.0
    assert wrld_row(slug_b)["name"] == "World Equity UCITS ETF"
    assert wrld_row(slug_b)["end_value"] == 4730.0

    assert _history_twr(pid_a) != _history_twr(pid_b)
