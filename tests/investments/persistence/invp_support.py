"""Helpers for the investments persistence tests: synthetic canonical files, fake market sources
(no live HTTP), profile / account setup through the services. Every value here is invented."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

from finanse.core import profiles
from finanse.core.db import get_session
from finanse.core.models import utcnow
from finanse.modules.investments.domain import Currency, FxRate, Instrument, PriceBar
from finanse.modules.investments.importing import ImportFile
from finanse.modules.investments.market import PriceHistory, PriceSource, SplitEvent
from finanse.modules.investments.service import accounts, imports
from finanse.modules.investments.service.daily import MarketSources

AS_OF = dt.date(2026, 3, 2)  # a Monday after the synthetic history

HEADER = (
    "format_version,record,date,time,type,external_ref,symbol,isin,name,exchange,quantity,price,"
    "currency,gross_amount,fee,tax,cash_amount,cash_currency,fx_rate,split_ratio,source"
)
ROWS = [
    "1,txn,2026-01-05,09:00,deposit,T-1,,,,,,,PLN,,,,20000.00,,,,examplebroker",
    "1,txn,2026-01-07,09:15,buy,T-2,ABC,PLABC0000016,ABC Example SA,XWAR,100,50.00,PLN,5000.00,5.00,,-5005.00,,,,",
    "1,txn,2026-01-12,10:30,buy,T-3,WRLD,IE00BEXAMPL1,World Equity UCITS ETF,XETR,10,100.00,EUR,1000.00,,,-4300.00,PLN,4.3,,",
    "1,txn,2026-01-14,16:00,buy,T-4,XMPL,US0000000001,Example Corp,XNAS,20,100.00,USD,2000.00,,,-8000.00,PLN,4.0,,",
    "1,txn,2026-01-25,,dividend,T-5,XMPL,US0000000001,Example Corp,XNAS,,,USD,10.00,,1.50,8.50,,,,",
]


def position_rows(xmpl_quantity: int = 20, as_of: str = "2026-02-27") -> list[str]:
    return [
        f"1,position,{as_of},,,,ABC,PLABC0000016,ABC Example SA,XWAR,100,,PLN,,,,,,,,",
        f"1,position,{as_of},,,,WRLD,IE00BEXAMPL1,World Equity UCITS ETF,XETR,10,,EUR,,,,,,,,",
        f"1,position,{as_of},,,,XMPL,US0000000001,Example Corp,XNAS,{xmpl_quantity},,USD,,,,,,,,",
    ]


def canonical_csv(
    *, positions: bool = True, xmpl_quantity: int = 20, extra: list[str] = ()
) -> bytes:
    lines = [HEADER, *ROWS, *extra]
    if positions:
        lines += position_rows(xmpl_quantity)
    return ("\n".join(lines) + "\n").encode("utf-8")


def split_row(date: str = "2026-02-10", ratio: str = "4") -> str:
    return f"1,txn,{date},,split,T-9,XMPL,US0000000001,Example Corp,XNAS,,,USD,,,,,,,{ratio},"


STRATEGY_YAML = """\
version: 1
base_currency: PLN
data:
  max_price_age_days: 5
  max_stale_weight: 1.0
  max_unclassified_weight: 1.0
buckets:
  - id: stocks
    match: { asset_class: [equity, etf] }
  - id: cash
    match: { asset_class: cash }
allocation:
  targets: { stocks: 0.9, cash: 0.1 }
rules:
  - id: concentration
    kind: position_concentration
    severity: action
    params: { max_weight: 0.30 }
  - id: idle_cash
    kind: cash_level
    params: { max_weight: 0.15 }
"""

PRICES = {"ABC.WA": Decimal(60), "WRLD.DE": Decimal(110), "XMPL": Decimal(100)}
FX = {"EUR": Decimal("4.3"), "USD": Decimal("4.0")}


def weekdays(start: dt.date, end: dt.date):
    day = start
    while day <= end:
        if day.weekday() < 5:
            yield day
        day += dt.timedelta(days=1)


class FakePrices(PriceSource):
    """Daily bars at a fixed close per Yahoo symbol; optional reported splits."""

    def __init__(self, prices: dict[str, Decimal] | None = None, splits=None) -> None:
        self.prices = dict(PRICES if prices is None else prices)
        self.splits: dict[str, tuple[SplitEvent, ...]] = splits or {}
        self.calls: list[tuple[str, dt.date, dt.date]] = []
        self.fetched_at = utcnow()

    @property
    def id(self) -> str:
        return "yahoo"

    def history(self, instrument: Instrument, start: dt.date, end: dt.date) -> list[PriceBar]:
        return list(self.fetch(instrument, start, end).bars)

    def fetch(self, instrument: Instrument, start: dt.date, end: dt.date) -> PriceHistory:
        symbol = instrument.alias("yahoo")
        self.calls.append((symbol or "", start, end))
        close = self.prices.get(symbol or "")
        if close is None:
            return PriceHistory()
        bars = tuple(
            PriceBar(
                instrument_id=instrument.id,
                date=day,
                close=close,
                source="yahoo",
                fetched_at=self.fetched_at,
                currency=instrument.currency,
            )
            for day in weekdays(start, end)
        )
        splits = tuple(s for s in self.splits.get(symbol or "", ()) if start <= s.date <= end)
        return PriceHistory(bars=bars, splits=splits, currency=instrument.currency)


class FakeFx:
    def __init__(self, rates: dict[str, Decimal] | None = None) -> None:
        self.rates_by_code = dict(FX if rates is None else rates)
        self.calls: list[tuple[str, dt.date, dt.date]] = []

    @property
    def id(self) -> str:
        return "nbp"

    def rates(self, quote: Currency, start: dt.date, end: dt.date) -> list[FxRate]:
        self.calls.append((str(quote), start, end))
        rate = self.rates_by_code.get(str(quote))
        if rate is None:
            return []
        return [
            FxRate(quote=Currency(quote), date=day, rate=rate, source="nbp")
            for day in weekdays(start, end)
        ]


def sources(prices: FakePrices | None = None, fx: FakeFx | None = None) -> MarketSources:
    return MarketSources(prices or FakePrices(), fx or FakeFx())


def make_profile(name: str = "Inwestor", modules=("investments",)) -> tuple[int, str]:
    with get_session() as s:
        p = profiles.create_profile(s, name=name, modules_=list(modules))
        return p.id, p.slug


def add_account(profile_id: int, name: str = "Konto DIF", broker: str = "dif") -> int:
    with get_session() as s:
        return accounts.add_account(s, profile_id, name=name, broker=broker).id


def import_file(
    profile_id: int, account_id: int, content: bytes, name: str = "history.csv", corrections=()
) -> imports.CommitResult:
    with get_session() as s:
        profile = s.get(profiles.Profile, profile_id)
        preview = imports.preview(
            s, profile, imports.ImportRequest(ImportFile(name, content), account_id)
        )
    return imports.commit(preview, corrections=corrections)
