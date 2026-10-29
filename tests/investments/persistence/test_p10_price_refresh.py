"""The batched price refresh (P10, ``service.prices`` + ``POST /investments/prices/refresh``): stores the
latest quotes without rules or signals, throttles, respects the daily lock, can be turned off, never
reaches the network in tests (fake Yahoo spark, fake per-instrument and FX sources)."""

from __future__ import annotations

import datetime as dt
import json
from decimal import Decimal

import pytest
from invp_support import (
    AS_OF,
    STRATEGY_YAML,
    FakeFx,
    FakePrices,
    add_account,
    canonical_csv,
    import_file,
    make_profile,
    sources,
    weekdays,
)
from sqlmodel import func, select

from cashu.core import locks
from cashu.core.db import get_session
from cashu.core.models import Profile
from cashu.modules.investments.domain import Currency, FxRate
from cashu.modules.investments.market import NbpFxSource, YahooPriceSource
from cashu.modules.investments.models import (
    InvPriceBar,
    InvRuleRun,
    InvSignal,
    InvStrategyVersion,
)
from cashu.modules.investments.service import daily, files, prices
from cashu.modules.investments.store import market

NOW = dt.datetime(2026, 3, 2, 15, 0, tzinfo=dt.UTC)


class FakeSpark(YahooPriceSource):
    """``spark`` answers from a close per symbol (sessions 13:30 UTC on the weekdays of the last four
    weeks up to ``AS_OF``); nothing goes over HTTP."""

    def __init__(self, closes: dict[str, Decimal], currency: dict[str, str]) -> None:
        super().__init__(http=None)  # type: ignore[arg-type] - never used
        self.closes, self.currency = closes, currency
        self.calls: list[list[str]] = []

    def spark(self, symbols, *, range_=YahooPriceSource.SPARK_RANGE):
        self.calls.append(list(symbols))
        days = list(weekdays(AS_OF - dt.timedelta(days=28), AS_OF))
        stamp = [
            int(dt.datetime(d.year, d.month, d.day, 13, 30, tzinfo=dt.UTC).timestamp())
            for d in days
        ]
        out = {}
        for s in symbols:
            if s not in self.closes:
                continue
            result = {
                "meta": {"currency": self.currency[s], "symbol": s, "gmtoffset": 0},
                "timestamp": stamp,
                "indicators": {"quote": [{"close": [float(self.closes[s])] * len(days)}]},
            }
            out[s] = json.dumps({"chart": {"result": [result], "error": None}})
        return out


SPARK = {"ABC.WA": Decimal(61), "WRLD.DE": Decimal(111), "XMPL": Decimal(102)}
CURRENCY = {"ABC.WA": "PLN", "WRLD.DE": "EUR", "XMPL": "USD"}


def price_sources(spark=None, fallback=None, fx=None) -> prices.PriceSources:
    return prices.PriceSources(
        fallback or FakePrices(), fx or FakeFx(), spark or FakeSpark(SPARK, CURRENCY)
    )


@pytest.fixture
def investor(db_engine):
    pid, slug = make_profile()
    aid = add_account(pid)
    import_file(pid, aid, canonical_csv())
    return pid, slug


def profile(pid: int) -> Profile:
    with get_session() as s:
        return s.get(Profile, pid)


def refresh(pid: int, **kwargs) -> prices.PriceRefresh:
    kwargs.setdefault("sources", price_sources())
    kwargs.setdefault("clock", lambda: NOW)
    return prices.refresh_prices(profile(pid), as_of=AS_OF, **kwargs)


def close_on(symbol_close: Decimal, day: dt.date = AS_OF) -> int:
    with get_session() as s:
        return s.exec(
            select(func.count()).where(InvPriceBar.date == day, InvPriceBar.close == symbol_close)
        ).one()


def count(model) -> int:
    with get_session() as s:
        return s.exec(select(func.count()).select_from(model)).one()


def test_refresh_stores_batched_quotes_without_rules_or_signals(investor):
    pid, _slug = investor
    daily.run_daily_check("worker", as_of=AS_OF, sources=sources())  # the stored history
    runs, signals = count(InvRuleRun), count(InvSignal)
    spark = FakeSpark(SPARK, CURRENCY)
    fallback = FakePrices()
    fallback.calls.clear()

    result = refresh(pid, sources=price_sources(spark=spark, fallback=fallback))

    assert result.status == "ok", result.errors
    assert result.updated == 3 and not result.cached
    # one spark request for every yahoo symbol; ABC (XWAR, stooq first) still goes per instrument
    # while stooq is not blocked (the fake fallback has no stooq at all)
    assert spark.calls == [["ABC.WA", "WRLD.DE", "XMPL"]]
    assert [c[0] for c in fallback.calls] == ["ABC.WA"]
    assert result.requests == {"spark": 1, "batched": 2, "per_instrument": 1, "fx_tables": 0}
    assert close_on(Decimal(111)) == 1 and close_on(Decimal(102)) == 1
    assert (count(InvRuleRun), count(InvSignal)) == (runs, signals)  # no rules, no signals
    body = result.to_dict()
    assert set(body) >= {"updated", "skipped", "errors", "as_of", "finished_at", "status", "cached"}
    assert body["as_of"] == AS_OF.isoformat()


def test_a_close_only_bar_keeps_the_stored_open_high_low(investor):
    pid, _slug = investor
    daily.run_daily_check("worker", as_of=AS_OF, sources=sources())
    with get_session() as s:
        row = s.exec(
            select(InvPriceBar).where(InvPriceBar.date == AS_OF, InvPriceBar.currency == "USD")
        ).one()
        row.open, row.high = Decimal(59), Decimal(63)
        s.add(row)
        iid, close_before = row.instrument_id, row.close
    refresh(pid)
    with get_session() as s:
        after = s.exec(
            select(InvPriceBar).where(InvPriceBar.instrument_id == iid, InvPriceBar.date == AS_OF)
        ).one()
    assert after.close != close_before
    assert (after.open, after.high) == (Decimal(59), Decimal(63))


def test_nothing_stored_yet_goes_the_per_instrument_way(investor):
    pid, _slug = investor
    fallback = FakePrices()
    result = refresh(pid, sources=price_sources(fallback=fallback))
    assert result.status == "ok" and result.updated == 3
    assert len(fallback.calls) == 3  # the 400-day backfill is older than the spark window
    assert result.requests["per_instrument"] == 3


def test_throttle_answers_the_last_result_without_network(investor):
    pid, _slug = investor
    first = refresh(pid)
    spark = FakeSpark(SPARK, CURRENCY)
    fallback = FakePrices()
    again = refresh(pid, sources=price_sources(spark=spark, fallback=fallback),
                    clock=lambda: NOW + dt.timedelta(minutes=9))
    assert again.cached and again.finished_at == first.finished_at
    assert spark.calls == [] and fallback.calls == []
    later = refresh(pid, sources=price_sources(spark=spark, fallback=fallback),
                    clock=lambda: NOW + dt.timedelta(minutes=11))
    assert not later.cached and spark.calls
    forced = refresh(pid, force=True, clock=lambda: NOW + dt.timedelta(minutes=12))
    assert not forced.cached


def test_a_held_daily_lock_answers_busy_without_network(investor):
    pid, _slug = investor
    spark = FakeSpark(SPARK, CURRENCY)
    fallback = FakePrices()
    with locks.run_lock(daily.LOCK_NAME):
        result = refresh(pid, sources=price_sources(spark=spark, fallback=fallback))
    assert result.status == "busy"
    assert spark.calls == [] and fallback.calls == []
    assert refresh(pid).status == "ok"  # a busy answer is not cached


def test_disabled_by_env(investor, monkeypatch):
    pid, _slug = investor
    monkeypatch.setenv("CASHU_PRICE_REFRESH", "0")
    spark = FakeSpark(SPARK, CURRENCY)
    result = refresh(pid, sources=price_sources(spark=spark))
    assert result.status == "disabled" and spark.calls == []


def test_default_sources_in_tests_are_offline_and_never_raise(investor):
    pid, _slug = investor
    result = prices.refresh_prices(profile(pid), as_of=AS_OF)
    assert result.status == "failed" and result.updated == 0 and result.errors
    assert count(InvPriceBar) == 0


def test_a_broken_source_is_a_result_not_an_exception(investor):
    pid, _slug = investor

    def boom():
        raise RuntimeError("no client")

    result = refresh(pid, sources=boom)
    assert result.status == "failed" and "RuntimeError" in result.errors[0]


def test_the_refresh_records_no_strategy_version(investor):
    pid, slug = investor
    files.write_text_private(files.strategy_yaml_path(slug), STRATEGY_YAML)
    refresh(pid)
    assert count(InvStrategyVersion) == 0


def test_last_closes_reads_the_newest_bar(investor):
    _pid, _slug = investor
    daily.run_daily_check("worker", as_of=AS_OF, sources=sources())
    with get_session() as s:
        ids = list(s.exec(select(InvPriceBar.instrument_id).distinct()).all())
        newest = market.last_closes(s, ids)
    assert {d for d, _c in newest.values()} == {AS_OF}
    assert sorted(c for _d, c in newest.values()) == [Decimal(60), Decimal(100), Decimal(110)]


def test_endpoint(investor, monkeypatch):
    from conftest import make_client

    from cashu.api.app import app

    _pid, slug = investor
    monkeypatch.setattr(prices, "default_sources", price_sources)
    client = make_client(app)
    body = client.post(f"/api/p/{slug}/investments/prices/refresh", json={}).json()
    assert body["status"] == "ok" and body["updated"] == 3 and body["cached"] is False
    again = client.post(f"/api/p/{slug}/investments/prices/refresh").json()
    assert again["cached"] is True
    forced = client.post(f"/api/p/{slug}/investments/prices/refresh", json={"force": True}).json()
    assert forced["cached"] is False


class FakeTables(NbpFxSource):
    """``table_rates`` answers EUR and USD on every weekday of the range; nothing goes over HTTP."""

    def __init__(self) -> None:
        super().__init__(http=None)  # type: ignore[arg-type] - never used
        self.calls: list[tuple[dt.date, dt.date]] = []

    def table_rates(self, start, end):
        self.calls.append((start, end))
        return {
            Currency(code): [
                FxRate(quote=Currency(code), date=d, rate=Decimal(rate), source="nbp")
                for d in weekdays(start, end)
            ]
            for code, rate in (("EUR", "4.31"), ("USD", "4.01"))
        }


def test_fx_comes_from_one_table_request(investor):
    pid, _slug = investor
    daily.run_daily_check("worker", as_of=AS_OF, sources=sources())
    tables, fx = FakeTables(), FakeFx()
    fx.calls.clear()
    result = refresh(pid, sources=prices.PriceSources(
        FakePrices(), fx, FakeSpark(SPARK, CURRENCY), tables))
    assert result.status == "ok" and result.fx_updated == 2
    assert tables.calls == [(AS_OF, AS_OF)] and fx.calls == []
    assert result.requests["fx_tables"] == 1
