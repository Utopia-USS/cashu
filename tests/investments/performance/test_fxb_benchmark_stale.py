"""F6 review V2: a benchmark proxy whose stored closes end before the range end is flagged
(``benchmark_stale`` with its last date), no excess figure compares it with the portfolio, the
simulation waits for the next priced day, and the worker's post-run backfill brings the proxy up to
date."""

from __future__ import annotations

import datetime as dt

import pytest
from perf_support import AS_OF, days, household, sources
from sqlmodel import delete, select

from finanse.core.db import get_session
from finanse.core.mcp.server import FinanseMcp
from finanse.core.worker import runner
from finanse.modules.investments.models import InvInstrument, InvPriceBar
from finanse.modules.investments.performance import backfill, report, service
from finanse.modules.investments.performance.benchmark import simulate
from finanse.modules.investments.performance.series import Combined
from finanse.modules.investments.service import daily, portfolio

LAST_BAR = dt.date(2025, 8, 31)


@pytest.fixture
def client(api_empty, monkeypatch):
    monkeypatch.setattr(portfolio, "today", lambda: AS_OF)
    monkeypatch.setattr(daily, "default_sources", lambda: sources())
    service.clear_cache()
    yield api_empty
    service.clear_cache()


def _proxy_id() -> int:
    with get_session() as s:
        return s.exec(select(InvInstrument.id).where(InvInstrument.symbol == "BNCH")).one()


def _proxy_newest() -> dt.date:
    with get_session() as s:
        return max(
            s.exec(select(InvPriceBar.date).where(InvPriceBar.instrument_id == _proxy_id())).all()
        )


def _perf(client, slug: str) -> dict:
    r = client.get(f"/api/p/{slug}/investments/performance?range=max")
    assert r.status_code == 200, r.text
    return r.json()


def test_simulation_waits_for_the_next_priced_day_and_holds_the_cash_meanwhile():
    ds = days("2025-01-01", "2025-01-05")
    # 10 units at 100; the 500 deposit on 01-03 has no price until 01-05 (110)
    sim = simulate(ds, [100.0, 100.0, None, None, 110.0], 1000.0, [0.0, 0.0, 500.0, 0.0, 0.0])
    assert sim.values == pytest.approx([1000.0, 1000.0, 1500.0, 1500.0, 1600.0])
    assert sim.with_fees == pytest.approx([1000.0, 1000.0, 1500.0, 1500.0, 1600.0])


def test_rolling_windows_ending_on_a_stale_benchmark_tail_compare_nothing():
    ds = days("2024-01-01", "2025-03-31")
    n = len(ds)
    c = Combined(
        values=[1000.0] * n, flows=[0.0] * n, fees=[0.0] * n, complete=[True] * n, implied=[0.0] * n
    )
    twr = report.returns.twr_index(c.values, c.flows, c.complete)
    stale_from = ds.index(dt.date(2025, 3, 10))
    bench = [100.0] * stale_from + [None] * (n - stale_from)
    windows = report.rolling(ds, c, twr, bench, 12)
    assert windows[-2].date == dt.date(2025, 2, 28) and windows[-2].excess == pytest.approx(0.0)
    assert windows[-1].date == dt.date(2025, 3, 31)
    assert windows[-1].benchmark is None and windows[-1].excess is None


def test_a_year_ending_on_a_stale_benchmark_tail_has_no_benchmark_return():
    ds = days("2024-01-01", "2025-03-31")
    n = len(ds)
    twr = [1.0] * n
    stale_from = ds.index(dt.date(2025, 3, 10))
    bench = [100.0] * stale_from + [None] * (n - stale_from)
    years = report.per_year(ds, twr, bench)
    assert years[0].year == 2024 and years[0].benchmark == pytest.approx(0.0)
    assert years[-1].year == 2025 and years[-1].benchmark is None
    assert years[-1].portfolio == pytest.approx(0.0)


def test_stale_benchmark_tail_is_flagged_and_drops_the_excess(client):
    pid, slug, _ = household("Anna")
    backfill.run_backfill(profile_ids=[pid], as_of=AS_OF, sources=sources())
    fresh = _perf(client, slug)
    assert fresh["benchmark"]["covers_range_end"] is True
    assert fresh["benchmark"]["last_priced"] == AS_OF.isoformat()
    assert fresh["benchmark"]["excess_twr"] is not None
    assert fresh["benchmark"]["simulation"]["end_value"] is not None
    assert fresh["benchmark"]["simulation"]["mwr"] is not None
    assert [n["code"] for n in fresh["data_quality"]["notes"]] == []
    fresh_attr = client.get(f"/api/p/{slug}/investments/performance/attribution?range=max").json()
    assert fresh_attr["concentration"]["benchmark_pnl_pct_of_contributions"] is not None

    with get_session() as s:
        s.exec(
            delete(InvPriceBar).where(
                InvPriceBar.instrument_id == _proxy_id(), InvPriceBar.date > LAST_BAR
            )
        )
        s.commit()
    service.clear_cache()

    d = _perf(client, slug)
    b = d["benchmark"]
    assert b["status"] == "ok"
    assert b["covers_range_end"] is False
    # the newest close (08-31) stays usable for max_price_age_days (5) more days
    assert b["last_priced"] == "2025-09-05"
    assert b["twr"] is not None  # the benchmark's own figures, up to its last priced day
    assert b["excess_twr"] is None and b["excess_value"] is None
    assert b["excess_vs_simulation"] is None
    # F7 review R4: the same-cash-flow simulation is a comparison figure as well
    sim = b["simulation"]
    assert sim["end_value"] is None and sim["end_value_with_fees"] is None
    assert sim["pnl"] is None and sim["xirr"] is None and sim["mwr"] is None
    # the benchmark's own TWR is annualized over the days it covers, not to the range end
    first, last = dt.date.fromisoformat(b["first_priced"]), dt.date.fromisoformat(b["last_priced"])
    assert b["twr_annualized"] == pytest.approx(
        report.returns.annualized(b["twr"], (last - first).days), abs=1e-6
    )
    attribution = client.get(f"/api/p/{slug}/investments/performance/attribution?range=max")
    assert attribution.status_code == 200, attribution.text
    concentration = attribution.json()["concentration"]
    assert concentration["benchmark_pnl"] is None
    assert concentration["benchmark_pnl_pct_of_contributions"] is None
    assert concentration["pnl_pct_of_contributions"] is not None
    notes = {n["code"]: n for n in d["data_quality"]["notes"]}
    assert notes["benchmark_stale"]["params"] == {"last_date": LAST_BAR.isoformat()}
    assert d["data_quality"]["benchmark_newest_price"] == LAST_BAR.isoformat()
    # every note carries a code and params
    assert all(set(n) == {"code", "params", "message"} for n in d["data_quality"]["notes"])

    result = FinanseMcp(pid, today=AS_OF).call("history_metrics", {})
    assert result.ok, result.error
    bench = result.data["performance"]["benchmark"]
    assert bench["covers_to_date"] is False and bench["excess_twr"] is None
    assert bench["last_priced"] == "2025-09-05"
    assert bench["simulation_money_weighted"] is None and bench["simulation_xirr"] is None
    profit = result.data["performance"]["profit_concentration"]
    assert profit["benchmark_pnl_pct_of_contributions"] is None
    assert profit["pnl_pct_of_contributions"] is not None


def test_worker_post_run_backfill_refreshes_the_benchmark_proxy(client):
    pid, slug, _ = household("Anna")
    backfill.run_backfill(profile_ids=[pid], as_of=LAST_BAR, sources=sources())
    assert _proxy_newest() == LAST_BAR

    now = dt.datetime(2025, 9, 30, 7, 30, tzinfo=dt.timezone(dt.timedelta(hours=2)))
    report = runner.run_worker(
        notifier=None, now=now, as_of=AS_OF, investments_sources=sources()
    )
    assert report.status == "ok"
    assert _proxy_newest() == AS_OF
    service.clear_cache()
    d = _perf(client, slug)
    assert d["benchmark"]["covers_range_end"] is True
    assert "benchmark_stale" not in {n["code"] for n in d["data_quality"]["notes"]}
