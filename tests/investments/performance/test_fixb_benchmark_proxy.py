"""A strategy's benchmark proxy that the owner neither holds nor watches (F7 owner report): it is
registered as a shared reference instrument (market data only) when the strategy is recorded or in the
price backfill, its bars are backfilled, and a market default currency is settled at the source.
``proxy_not_found`` stays only for a proxy nothing can resolve. Fake sources, no live HTTP."""

from __future__ import annotations

import perf_support
import pytest
from perf_support import AS_OF, BENCH_STRATEGY, EUR, USD, bench_close, household, sources
from sqlmodel import select

from cashu.core.db import get_session
from cashu.core.models import Profile
from cashu.modules.investments.domain import AliasNamespace, Currency
from cashu.modules.investments.models import InvInstrument, InvPriceBar
from cashu.modules.investments.performance import backfill, service
from cashu.modules.investments.performance.proxy import reference_instrument
from cashu.modules.investments.service import daily, portfolio
from cashu.modules.investments.service import strategy as strategy_files
from cashu.modules.investments.store.instruments import profile_instrument_ids


@pytest.fixture
def client(api_empty, monkeypatch):
    monkeypatch.setattr(portfolio, "today", lambda: AS_OF)
    monkeypatch.setattr(daily, "default_sources", lambda: sources())
    monkeypatch.setitem(perf_support.PRICE_FUNCTIONS, "REFX.DE", bench_close)
    monkeypatch.setitem(perf_support.QUOTE_CURRENCIES, "REFX.DE", EUR)
    monkeypatch.setitem(perf_support.PRICE_FUNCTIONS, "REFL.L", bench_close)
    monkeypatch.setitem(perf_support.QUOTE_CURRENCIES, "REFL.L", USD)  # an LSE line quoted in USD
    service.clear_cache()
    yield api_empty
    service.clear_cache()


def _strategy(proxy: str) -> str:
    return BENCH_STRATEGY.replace("proxy: BNCH.DE", f"proxy: {proxy}")


def _bench(client, slug: str) -> dict:
    service.clear_cache()
    r = client.get(f"/api/p/{slug}/investments/performance?range=max")
    assert r.status_code == 200, r.text
    return r.json()["benchmark"]


def _instrument(symbol: str) -> InvInstrument | None:
    with get_session() as s:
        return s.exec(select(InvInstrument).where(InvInstrument.symbol == symbol)).first()


def test_reference_instrument_follows_the_market_symbol_conventions():
    planned = reference_instrument("IUSQ.DE")
    assert (planned.symbol, planned.mic, planned.currency) == ("IUSQ", "XETR", Currency.EUR)
    assert planned.alias(AliasNamespace.YAHOO) == "IUSQ.DE"
    assert planned.alias(AliasNamespace.STOOQ) == "iusq.de"
    assert not planned.needs_classification
    assert reference_instrument("IE00B3RBWM25") is None  # an ISIN must be a stored instrument
    assert reference_instrument("SPY") is None  # no market suffix: left to the online probe
    assert reference_instrument(" ") is None


def test_recorded_strategy_registers_the_proxy_and_the_backfill_fills_it(client):
    pid, slug, _aid = household("Ref", strategy=_strategy("REFX.DE"))
    with get_session() as s:
        strategy_files.load(s, s.get(Profile, pid), record=True)
    inst = _instrument("REFX")
    assert inst is not None and (inst.currency, inst.mic) == ("EUR", "XETR")
    with get_session() as s:
        assert inst.id not in profile_instrument_ids(s, pid)  # no position, watchlist or signal
    positions = client.get(f"/api/p/{slug}/investments/positions").json()
    assert "REFX" not in str(positions)
    # registered but no bars yet: "no prices", not "instrument not found"
    assert _bench(client, slug)["status"] == "no_prices"

    report = backfill.run_backfill(profile_ids=[pid], as_of=AS_OF, sources=sources())
    assert [(b.proxy, b.status) for b in report.benchmarks] == [("REFX.DE", "found")]
    b = _bench(client, slug)
    assert b["status"] == "ok" and b["last_priced"] == AS_OF.isoformat()
    assert b["covers_range_end"] is True and b["twr"] is not None
    with get_session() as s:
        assert s.exec(select(InvPriceBar).where(InvPriceBar.instrument_id == inst.id)).first()
        assert inst.id not in profile_instrument_ids(s, pid)


def test_backfill_registers_and_settles_the_quote_currency(client):
    pid, slug, _aid = household("Lon", strategy=_strategy("REFL.L"))
    report = backfill.run_backfill(profile_ids=[pid], as_of=AS_OF, sources=sources())
    assert [(b.proxy, b.status) for b in report.benchmarks] == [("REFL.L", "added")]
    inst = _instrument("REFL")
    assert inst is not None and inst.currency == "USD"  # XLON default GBP corrected at the source
    with get_session() as s:
        bars = s.exec(select(InvPriceBar).where(InvPriceBar.instrument_id == inst.id)).all()
    assert bars and {b.currency for b in bars} == {"USD"}
    # the fake FX source has no USD rates, so the comparison waits for them, but it is found
    assert _bench(client, slug)["status"] in ("ok", "no_prices")


def test_an_unresolvable_proxy_stays_not_found(client):
    pid, slug, _aid = household("Isin", strategy=_strategy("IE00BEXAMPL9"))
    with get_session() as s:
        strategy_files.load(s, s.get(Profile, pid), record=True)
    backfill.run_backfill(profile_ids=[pid], as_of=AS_OF, sources=sources())
    assert _bench(client, slug)["status"] == "proxy_not_found"
    assert _instrument("IE00BEXAMPL9") is None
