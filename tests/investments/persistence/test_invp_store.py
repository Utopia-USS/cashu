"""Repositories: the DB StoredMarketData, applying fetch reports (split re-fetch replaces the stored
window in one transaction), the DB instrument lookup."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
from invp_support import FakeFx, FakePrices, weekdays
from sqlmodel import select

from finanse.core.db import get_session
from finanse.modules.investments.domain import (
    AliasNamespace,
    AssetClass,
    Currency,
    FxRate,
    Instrument,
    InstrumentAlias,
    PriceBar,
)
from finanse.modules.investments.market import (
    FetchReport,
    FetchStatus,
    InstrumentFetch,
    MarketDataRefresher,
    SplitEvent,
)
from finanse.modules.investments.models import InvPriceBar
from finanse.modules.investments.store import convert, instruments, market

UTC = dt.UTC


def stored_instrument(symbol: str = "XMPL", isin: str = "US0000000001", yahoo: str = "XMPL") -> str:
    with get_session() as s:
        row = instruments.insert(
            s,
            Instrument(
                id="planned",
                name=f"{symbol} Corp",
                currency=Currency.USD,
                asset_class=AssetClass.EQUITY,
                symbol=symbol,
                isin=isin,
                mic="XNAS",
                aliases=(
                    InstrumentAlias(AliasNamespace.YAHOO, yahoo, guessed=True),
                    InstrumentAlias("examplebroker", symbol),
                ),
            ),
        )
        return convert.sid(row.id)


def bars(instrument_id: str, start: dt.date, end: dt.date, close: str, fetched: dt.datetime):
    return tuple(
        PriceBar(
            instrument_id=instrument_id,
            date=d,
            close=Decimal(close),
            source="yahoo",
            fetched_at=fetched,
            currency=Currency.USD,
        )
        for d in weekdays(start, end)
    )


def stored_closes(instrument_id: str) -> dict[dt.date, Decimal]:
    with get_session() as s:
        rows = s.exec(
            select(InvPriceBar).where(InvPriceBar.instrument_id == int(instrument_id))
        ).all()
        return {r.date: r.close for r in rows}


def test_db_stored_market_data_answers_like_the_reference(db_engine):
    iid = stored_instrument()
    early = dt.datetime(2026, 1, 1, tzinfo=UTC)
    with get_session() as s:
        market.upsert_bars(
            s, bars(iid, dt.date(2026, 1, 5), dt.date(2026, 1, 9), "100", early), now=early
        )
        market.upsert_rates(
            s, [FxRate(Currency.USD, dt.date(2026, 1, 5), Decimal("4.0"), "nbp")], now=early
        )
    stored = market.DbStoredMarketData()
    assert stored.first_bar_date(iid) == dt.date(2026, 1, 5)
    assert stored.last_bar_date(iid) == dt.date(2026, 1, 9)
    assert stored.has_bars_fetched_before(
        iid, dated_before=dt.date(2026, 1, 7), fetched_before=dt.datetime(2026, 1, 2, tzinfo=UTC)
    )
    assert not stored.has_bars_fetched_before(
        iid, dated_before=dt.date(2026, 1, 7), fetched_before=dt.datetime(2025, 12, 31, tzinfo=UTC)
    )
    assert not stored.has_bars_fetched_before(
        iid, dated_before=dt.date(2026, 1, 5), fetched_before=dt.datetime(2026, 1, 2, tzinfo=UTC)
    )
    assert (
        stored.last_rate_date(Currency.USD)
        == stored.first_rate_date(Currency.USD)
        == dt.date(2026, 1, 5)
    )
    assert stored.has_rate_on_or_before(Currency.USD, dt.date(2026, 1, 6))
    assert not stored.has_rate_on_or_before(Currency.USD, dt.date(2026, 1, 4))
    assert stored.last_rate_date(Currency.EUR) is None


def test_upsert_replaces_by_key(db_engine):
    iid = stored_instrument()
    t = dt.datetime(2026, 2, 1, tzinfo=UTC)
    with get_session() as s:
        market.upsert_bars(s, bars(iid, dt.date(2026, 1, 5), dt.date(2026, 1, 6), "100", t), now=t)
        market.upsert_bars(s, bars(iid, dt.date(2026, 1, 6), dt.date(2026, 1, 7), "101", t), now=t)
    assert stored_closes(iid) == {
        dt.date(2026, 1, 5): Decimal(100),
        dt.date(2026, 1, 6): Decimal(101),
        dt.date(2026, 1, 7): Decimal(101),
    }


def test_split_refetch_replaces_the_stored_window(db_engine):
    """Bars stored before a split are unadjusted; the source reports the split, the refresher
    re-fetches the whole stored window and the store replaces it (old bars outside the new window's
    dates are gone too)."""
    iid = stored_instrument()
    before_split = dt.datetime(2026, 1, 20, tzinfo=UTC)
    with get_session() as s:
        # unadjusted closes, including a bar on a day the adjusted source no longer serves (a holiday)
        market.upsert_bars(
            s,
            bars(iid, dt.date(2026, 1, 5), dt.date(2026, 1, 16), "400", before_split),
            now=before_split,
        )
        s.add(
            InvPriceBar(
                instrument_id=int(iid),
                date=dt.date(2026, 1, 10),
                close=Decimal(400),
                source="yahoo",
                fetched_at=before_split,
            )
        )  # a Saturday bar
    prices = FakePrices(
        {"XMPL": Decimal(100)}, splits={"XMPL": (SplitEvent(dt.date(2026, 2, 2), Decimal(4)),)}
    )
    with get_session() as s:
        inst = instruments.load(s, [int(iid)])[int(iid)]
    report = MarketDataRefresher(prices, FakeFx()).refresh(
        market.DbStoredMarketData(), [inst], [], dt.date(2026, 2, 6)
    )
    (item,) = report.instruments
    assert item.refetched_for_split and item.replace_from == dt.date(2026, 1, 5)
    with get_session() as s:
        stats = market.apply_fetch_report(s, report, now=dt.datetime(2026, 2, 6, 20, tzinfo=UTC))
    assert stats["bars_replaced"] == 11  # 10 weekdays + the Saturday bar
    closes = stored_closes(iid)
    assert set(closes.values()) == {Decimal(100)}
    assert dt.date(2026, 1, 10) not in closes
    assert min(closes) == dt.date(2026, 1, 5) and max(closes) == dt.date(2026, 2, 6)


def test_split_window_replacement_is_one_transaction(db_engine, monkeypatch):
    iid = stored_instrument()
    t = dt.datetime(2026, 1, 20, tzinfo=UTC)
    with get_session() as s:
        market.upsert_bars(s, bars(iid, dt.date(2026, 1, 5), dt.date(2026, 1, 9), "400", t), now=t)
    report = FetchReport(
        as_of=dt.date(2026, 1, 9),
        instruments=(
            InstrumentFetch(
                instrument_id=iid,
                label="XMPL",
                status=FetchStatus.OK,
                start=dt.date(2026, 1, 5),
                end=dt.date(2026, 1, 9),
                bars=bars(iid, dt.date(2026, 1, 5), dt.date(2026, 1, 9), "100", t),
                refetched_for_split=True,
                replace_from=dt.date(2026, 1, 5),
            ),
        ),
    )

    def broken_upsert(*_a, **_k):
        raise RuntimeError("insert failed after the delete")

    monkeypatch.setattr(market, "upsert_bars", broken_upsert)
    with pytest.raises(RuntimeError), get_session() as s:
        market.apply_fetch_report(s, report, now=t)
    assert set(stored_closes(iid).values()) == {Decimal(400)}  # the delete was rolled back


def test_a_refetch_without_bars_never_wipes_the_window(db_engine):
    iid = stored_instrument()
    t = dt.datetime(2026, 1, 20, tzinfo=UTC)
    with get_session() as s:
        market.upsert_bars(s, bars(iid, dt.date(2026, 1, 5), dt.date(2026, 1, 9), "400", t), now=t)
        report = FetchReport(
            as_of=dt.date(2026, 1, 9),
            instruments=(
                InstrumentFetch(
                    instrument_id=iid,
                    label="XMPL",
                    status=FetchStatus.ERROR,
                    replace_from=dt.date(2026, 1, 5),
                ),
            ),
        )
        market.apply_fetch_report(s, report, now=t)
    assert len(stored_closes(iid)) == 5


def test_db_instrument_lookup(db_engine):
    iid = stored_instrument()
    with get_session() as s:
        lookup = instruments.DbInstrumentLookup(s)
        assert lookup.by_isin("us0000000001").id == iid
        assert lookup.by_alias("isin", "US0000000001").id == iid
        assert lookup.by_alias("examplebroker", "XMPL").id == iid
        assert lookup.by_alias("yahoo", "XMPL").id == iid  # guessed aliases count for planning
        assert [i.id for i in lookup.by_symbol("xmpl", "XNAS")] == [iid]
        assert lookup.by_symbol("XMPL", "XWAR") == []
        confirmed = instruments.DbInstrumentLookup(s, confirmed_only=True)
        assert confirmed.by_alias("yahoo", "XMPL") is None
        planned = Instrument(
            id="new-1",
            name="?",
            currency=Currency.USD,
            asset_class=AssetClass.OTHER,
            aliases=(InstrumentAlias("yahoo", "XMPL", guessed=True),),
        )
        assert instruments.find_confirmed(s, planned) is None  # guessed aliases never re-resolve
        planned = Instrument(
            id="new-2",
            name="?",
            currency=Currency.USD,
            asset_class=AssetClass.OTHER,
            aliases=(InstrumentAlias("examplebroker", "XMPL"),),
        )
        assert instruments.find_confirmed(s, planned).id == iid


def test_classify_and_aliases(db_engine):
    iid = stored_instrument()
    other = stored_instrument("ABC", "PLABC0000016", "ABC.WA")
    with get_session() as s:
        row = instruments.classify(
            s,
            int(iid),
            asset_class="etf",
            tags=["global_equity", " ", "global_equity"],
            aliases=[InstrumentAlias("yahoo", "XMPL")],
        )
        assert (row.asset_class, row.tags, row.needs_classification) == (
            "etf",
            ["global_equity"],
            False,
        )
        inst = instruments.load_one(s, int(iid))
        assert inst.alias("yahoo") == "XMPL" and not any(
            a.guessed for a in inst.aliases if a.namespace == "yahoo"
        )
        with pytest.raises(instruments.ClassificationError):
            instruments.classify(s, int(iid), aliases=[InstrumentAlias("yahoo", "ABC.WA")])
        with pytest.raises(instruments.ClassificationError):
            instruments.classify(s, int(other), valuation_mode="guess")
        row = instruments.classify(s, int(other), asset_class="treasury_bond")
        assert row.valuation_mode == "cost"  # follows the class default when it was the default
