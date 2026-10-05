"""From a synthetic import through the backfill (fake sources) to the endpoints: hand-computed values,
incremental second backfill, cache invalidation, benchmark states, token and profile isolation."""

from __future__ import annotations

import math

import pytest
from perf_support import (
    AS_OF,
    BENCH_STRATEGY,
    HEADER,
    FakeFx,
    FakePrices,
    day,
    household,
    sources,
)

from finanse.core import profiles, security
from finanse.core.db import get_session
from finanse.modules.investments.importing import ImportFile
from finanse.modules.investments.models import InvInstrument
from finanse.modules.investments.performance import backfill, service
from finanse.modules.investments.service import daily, files, imports, portfolio


@pytest.fixture
def client(api_empty, monkeypatch):
    monkeypatch.setattr(portfolio, "today", lambda: AS_OF)
    monkeypatch.setattr(daily, "default_sources", lambda: sources())
    service.clear_cache()
    yield api_empty
    service.clear_cache()


def bench(d: str) -> float:
    """The fake proxy close in PLN (EUR at 4.3)."""
    return (50 + 0.01 * (day(d) - day("2024-12-01")).days) * 4.3


def perf(client, slug: str, query: str = "range=max") -> dict:
    r = client.get(f"/api/p/{slug}/investments/performance?{query}")
    assert r.status_code == 200, r.text
    return r.json()


def test_import_backfill_endpoint(client):
    pid, slug, _aid = household()
    prices, fx = FakePrices(), FakeFx()
    report = backfill.run_backfill(profile_ids=[pid], as_of=AS_OF, sources=sources(prices, fx))

    # the benchmark proxy was unknown: probed in PLN (the base currency), the source said EUR
    assert [(b.status, b.proxy) for b in report.benchmarks] == [("added", "BNCH.DE")]
    with get_session() as s:
        proxy = s.get(InvInstrument, report.benchmarks[0].instrument_id)
        assert (proxy.currency, proxy.symbol) == ("EUR", "BNCH")
    roles = {i.label: (i.role, i.need_from.isoformat(), i.status) for i in report.instruments}
    assert roles == {
        "ABC": ("sold", "2024-12-27", "ok"),  # first trade 2025-01-03 minus 7 days
        "WRLD": ("held", "2024-12-30", "ok"),
        "BNCH": ("benchmark", "2024-12-26", "ok"),  # first transaction 2025-01-02 minus 7 days
    }
    assert report.rates_written > 0

    d = perf(client, slug)
    s = d["summary"]
    # cash 10000 - 5000 - 4300 + 6000 + 2000 = 8700, WRLD 10 * 110 EUR * 4.3 = 4730
    assert s["end_value"] == 13430.0
    overview = client.get(f"/api/p/{slug}/investments/overview").json()
    assert overview["kpis"]["value"]["total"] == s["end_value"]
    assert (s["start_value"], s["net_contributions"], s["pnl"]) == (0.0, 12000.0, 1430.0)
    # no flows between 01-02 and 07-01, so the index telescopes: 11430 / 10000; the 07-01 deposit
    # day is flat: (13430 - 2000) / 11430
    assert s["twr"] == pytest.approx(0.143, abs=1e-6)
    assert s["xirr"] is None and s["twr_annualized"] is None  # 272 days
    x = math.log1p(s["mwr"]) / 271  # money-weighted: -10000 on 01-02, -2000 on 07-01, +13430
    assert -10000 - 2000 * math.exp(-x * 180) + 13430 * math.exp(-x * 271) == pytest.approx(
        0, abs=1.0
    )
    assert s["max_drawdown"]["depth"] == 0.0
    assert d["start"] == "2025-01-01" and d["step"] == "day" and len(d["points"]) == 273
    first = d["points"][1]
    assert (first["date"], first["value"], first["flow"]) == ("2025-01-02", 10000.0, 10000.0)

    b = d["benchmark"]
    assert b["status"] == "ok" and b["proxy"] == "BNCH.DE" and b["currency"] == "EUR"
    assert b["twr"] == pytest.approx(bench("2025-09-30") / bench("2025-01-01") - 1, abs=1e-6)
    units = 10000 / bench("2025-01-02") + 2000 / bench("2025-07-01")
    assert b["simulation"]["end_value"] == pytest.approx(units * bench("2025-09-30"), abs=0.01)
    assert b["excess_value"] == pytest.approx(13430 - units * bench("2025-09-30"), abs=0.01)
    assert d["data_quality"]["notes"] == [] and d["data_quality"]["incomplete_days"] == 0

    # 3 months: base 06-30 = 6700 cash + 4730; the only move is the 2000 deposit
    q = perf(client, slug, "range=3m")["summary"]
    assert (q["start_value"], q["end_value"], q["net_contributions"]) == (11430.0, 13430.0, 2000.0)
    assert q["pnl"] == 0.0 and q["twr"] == pytest.approx(0.0, abs=1e-9)

    a = client.get(f"/api/p/{slug}/investments/performance/attribution").json()
    rows = {r["label"]: r for r in a["instruments"]}
    assert (rows["ABC"]["pnl"], rows["ABC"]["held"]) == (1000.0, False)
    assert (rows["WRLD"]["pnl"], rows["WRLD"]["end_value"]) == (430.0, 4730.0)
    assert a["total_pnl"] == 1430.0 and a["other"] == 0.0
    assert a["buckets"] == [
        {"bucket": "stocks", "pnl": 1430.0, "share_of_pnl": 1.0, "instruments": 2}
    ]
    conc = a["concentration"]
    assert conc["top"][0] == {"n": 1, "share": round(1000 / 1430, 6)}
    assert conc["benchmark_pnl"] == pytest.approx(units * bench("2025-09-30") - 12000, abs=0.01)

    # a second backfill only asks for what is new (the last day again, no history)
    prices2, fx2 = FakePrices(), FakeFx()
    again = backfill.run_backfill(profile_ids=[pid], as_of=AS_OF, sources=sources(prices2, fx2))
    assert {c[1] for c in prices2.calls} == {AS_OF} and len(prices2.calls) == 3
    assert {c[1] for c in fx2.calls} == {AS_OF}
    assert all(i.head is None for i in again.instruments)
    assert [b.status for b in again.benchmarks] == ["found"]


def test_new_data_invalidates_the_cache(client):
    pid, slug, aid = household()
    backfill.run_backfill(profile_ids=[pid], as_of=AS_OF, sources=sources())
    assert perf(client, slug)["summary"]["end_value"] == 13430.0
    row = "1,txn,2025-09-15,09:00,deposit,P-9,,,,,,,PLN,,,,500.00,,,,"
    with get_session() as s:
        profile = s.get(profiles.Profile, pid)
        preview = imports.preview(
            s,
            profile,
            imports.ImportRequest(ImportFile("more.csv", f"{HEADER}\n{row}\n".encode()), aid),
        )
    imports.commit(preview)
    after = perf(client, slug)["summary"]
    assert after["end_value"] == 13930.0 and after["net_contributions"] == 12500.0


def test_accounts_filter_range_and_errors(client):
    pid, slug, aid = household()
    _other_pid, _other_slug, other_aid = household("Druga")
    backfill.run_backfill(profile_ids=[pid], as_of=AS_OF, sources=sources())
    whole = perf(client, slug)
    only = perf(client, slug, f"range=max&accounts={aid}")
    assert only["summary"] == whole["summary"] and only["accounts_filter"] == [aid]
    assert [a["account_id"] for a in only["accounts"]] == [aid]
    assert only["accounts"][0]["values"][-1] == 13430.0
    base = f"/api/p/{slug}/investments/performance"
    assert client.get(f"{base}?accounts={other_aid}").status_code == 404  # another profile's
    assert client.get(f"{base}?accounts=x").status_code == 404
    assert client.get(f"{base}?range=5y").status_code == 422
    assert client.get(f"{base}/attribution?accounts={other_aid}").status_code == 404
    assert client.get(f"{base}/attribution?range=week").status_code == 422
    bare = client.get(base, headers={security.TOKEN_HEADER: "nope"})
    assert bare.status_code == 401


def test_profiles_do_not_leak(client):
    pid, slug, _ = household("Anna")
    backfill.run_backfill(profile_ids=[pid], as_of=AS_OF, sources=sources())
    reference = perf(client, slug)
    with get_session() as s:
        empty = profiles.create_profile(s, name="Pusty", modules_=["investments"]).slug
    e = perf(client, empty)
    assert e["points"] == [] and e["summary"] is None and e["accounts"] == []
    ea = client.get(f"/api/p/{empty}/investments/performance/attribution").json()
    assert ea["instruments"] == [] and ea["total_pnl"] is None
    assert perf(client, slug) == reference  # unchanged by the other profile's requests
    # legacy alias = the default (oldest) profile
    legacy = client.get("/api/investments/performance?range=max").json()
    assert legacy == reference


def test_benchmark_states(client):
    pid, slug, _ = household("Bez", strategy=None)
    d = perf(client, slug)
    assert d["benchmark"]["status"] == "no_strategy" and d["benchmark"]["twr"] is None
    assert d["summary"]["end_value"] is not None  # valued from last trade prices, no bars yet
    files.write_text_private(
        files.strategy_yaml_path(slug), BENCH_STRATEGY.replace("BNCH.DE", "IE00B4L5Y983")
    )
    d = perf(client, slug)
    assert d["benchmark"]["status"] == "proxy_not_found"
    report = backfill.run_backfill(profile_ids=[pid], as_of=AS_OF, sources=sources())
    assert [b.status for b in report.benchmarks] == ["not_found"]
    files.write_text_private(
        files.strategy_yaml_path(slug),
        BENCH_STRATEGY.replace("benchmark:\n  id: msci_acwi\n  proxy: BNCH.DE\n", ""),
    )
    assert perf(client, slug)["benchmark"]["status"] == "not_configured"


def test_unknown_proxy_symbol_is_an_error_not_an_instrument(client):
    pid, slug, _ = household(strategy=BENCH_STRATEGY.replace("BNCH.DE", "NOPE.XX"))
    report = backfill.run_backfill(profile_ids=[pid], as_of=AS_OF, sources=sources())
    assert [b.status for b in report.benchmarks] == ["error"]
    with get_session() as s:
        assert service.find_proxy(s, "NOPE.XX") is None
    assert perf(client, slug)["benchmark"]["status"] == "proxy_not_found"


def test_backfill_is_exclusive(client):
    from finanse.core import locks

    with locks.run_lock(backfill.LOCK_NAME), pytest.raises(backfill.BackfillBusy):
        backfill.run_backfill(as_of=AS_OF, sources=sources())
