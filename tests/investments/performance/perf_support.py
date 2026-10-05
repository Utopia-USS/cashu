"""Helpers for the performance tests: pure transaction / bar builders and a synthetic household for
the DB pipeline (fake price and FX sources, no live HTTP). Every value here is invented."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

from finanse.core import profiles
from finanse.core.db import get_session
from finanse.core.models import utcnow
from finanse.modules.investments.domain import (
    AssetClass,
    Currency,
    FxRate,
    Instrument,
    PriceBar,
    Transaction,
    TxnType,
)
from finanse.modules.investments.importing import ImportFile
from finanse.modules.investments.market import (
    PriceHistory,
    PriceSource,
    QuoteCurrencyMismatchException,
)
from finanse.modules.investments.service import accounts, files, imports
from finanse.modules.investments.service.daily import MarketSources

D = Decimal
PLN, EUR, USD = Currency.PLN, Currency.EUR, Currency.USD


def day(text: str) -> dt.date:
    return dt.date.fromisoformat(text)


def days(start: str, end: str) -> list[dt.date]:
    a, b = day(start), day(end)
    return [a + dt.timedelta(days=i) for i in range((b - a).days + 1)]


_seq = iter(range(1, 10**6))


def txn(
    kind: str,
    when: str,
    cash: str | Decimal = "0",
    *,
    account: str = "1",
    instrument: str | None = None,
    quantity: str | None = None,
    price: str | None = None,
    currency: Currency = PLN,
    cash_currency: Currency | None = None,
    gross: str | None = None,
    fee: str = "0",
    ratio: str | None = None,
    tid: str | None = None,
) -> Transaction:
    q = None if quantity is None else D(quantity)
    p = None if price is None else D(price)
    g = D(gross) if gross is not None else (q * p if q is not None and p is not None else D(0))
    return Transaction(
        id=tid or f"t{next(_seq)}",
        account_id=account,
        type=TxnType(kind),
        trade_date=day(when),
        currency=currency,
        gross_amount=abs(g),
        cash_amount=D(cash),
        cash_currency=cash_currency or currency,
        instrument_id=instrument,
        quantity=q,
        price=p,
        fee=D(fee),
        split_ratio=None if ratio is None else D(ratio),
    )


def instrument(
    iid: str,
    currency: Currency = PLN,
    asset_class: AssetClass = AssetClass.ETF,
    *,
    tags: tuple[str, ...] = (),
) -> Instrument:
    return Instrument(
        id=iid, name=f"Instrument {iid}", currency=currency, asset_class=asset_class, tags=tags
    )


def bars(iid: str, closes: dict[str, str | float]) -> list[PriceBar]:
    return [
        PriceBar(instrument_id=iid, date=day(k), close=D(str(v)), source="test")
        for k, v in sorted(closes.items())
    ]


def daily_bars(iid: str, start: str, end: str, close) -> list[PriceBar]:
    """A bar for every day (weekends too) with ``close(date)``."""
    return [
        PriceBar(instrument_id=iid, date=d, close=D(str(close(d))), source="test")
        for d in days(start, end)
    ]


def rates(quote: Currency, values: dict[str, str]) -> list[FxRate]:
    return [FxRate(quote=quote, date=day(k), rate=D(v), source="test") for k, v in values.items()]


# --------------------------------------------------------------------------- #
# DB pipeline household
# --------------------------------------------------------------------------- #

AS_OF = dt.date(2025, 9, 30)

HEADER = (
    "format_version,record,date,time,type,external_ref,symbol,isin,name,exchange,quantity,price,"
    "currency,gross_amount,fee,tax,cash_amount,cash_currency,fx_rate,split_ratio,source"
)
ROWS = [
    "1,txn,2025-01-02,09:00,deposit,P-1,,,,,,,PLN,,,,10000.00,,,,",
    "1,txn,2025-01-03,10:00,buy,P-2,ABC,PLABC0000016,ABC Example SA,XWAR,50,100.00,PLN,5000.00,,,-5000.00,,,,",
    "1,txn,2025-01-06,10:00,buy,P-3,WRLD,IE00BEXAMPL1,World Equity UCITS ETF,XETR,10,100.00,EUR,1000.00,,,-4300.00,PLN,4.3,,",
    "1,txn,2025-06-02,10:00,sell,P-4,ABC,PLABC0000016,ABC Example SA,XWAR,50,120.00,PLN,6000.00,,,6000.00,,,,",
    "1,txn,2025-07-01,09:00,deposit,P-5,,,,,,,PLN,,,,2000.00,,,,",
]

BENCH_STRATEGY = """\
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
benchmark:
  id: msci_acwi
  proxy: BNCH.DE
"""


def canonical_csv(rows: list[str] | None = None) -> bytes:
    return ("\n".join([HEADER, *(ROWS if rows is None else rows)]) + "\n").encode()


def abc_close(d: dt.date) -> Decimal:
    """ABC: 100 on 2025-01-01, +0.1 PLN per calendar day."""
    return D(100) + D("0.1") * (d - dt.date(2025, 1, 1)).days


def wrld_close(d: dt.date) -> Decimal:
    """WRLD: 100 EUR flat until 2025-03-31, then 110."""
    return D(100) if d < dt.date(2025, 4, 1) else D(110)


def bench_close(d: dt.date) -> Decimal:
    """Benchmark proxy: 50 EUR, +0.01 per calendar day from 2024-12-01."""
    return D(50) + D("0.01") * (d - dt.date(2024, 12, 1)).days


PRICE_FUNCTIONS = {"ABC.WA": abc_close, "WRLD.DE": wrld_close, "BNCH.DE": bench_close}
QUOTE_CURRENCIES = {"ABC.WA": PLN, "WRLD.DE": EUR, "BNCH.DE": EUR}


class FakePrices(PriceSource):
    """A bar for every calendar day per Yahoo symbol; rejects a wrong instrument currency like Yahoo."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dt.date, dt.date]] = []
        self.fetched_at = utcnow()

    @property
    def id(self) -> str:
        return "yahoo"

    def history(self, instrument: Instrument, start: dt.date, end: dt.date) -> list[PriceBar]:
        return list(self.fetch(instrument, start, end).bars)

    def fetch(self, instrument: Instrument, start: dt.date, end: dt.date) -> PriceHistory:
        symbol = instrument.alias("yahoo") or ""
        self.calls.append((symbol, start, end))
        close = PRICE_FUNCTIONS.get(symbol)
        if close is None:
            return PriceHistory()
        quote = QUOTE_CURRENCIES[symbol]
        if instrument.currency != quote:
            raise QuoteCurrencyMismatchException(
                "yahoo",
                f"quoted in {quote}",
                quote_currency=quote,
                instrument_currency=instrument.currency,
            )
        n = (end - start).days + 1
        out = tuple(
            PriceBar(
                instrument_id=instrument.id,
                date=start + dt.timedelta(days=i),
                close=close(start + dt.timedelta(days=i)),
                source="yahoo",
                fetched_at=self.fetched_at,
                currency=quote,
            )
            for i in range(max(0, n))
        )
        return PriceHistory(bars=out, currency=quote)


class FakeFx:
    """EUR at 4.3 PLN every calendar day."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dt.date, dt.date]] = []

    @property
    def id(self) -> str:
        return "nbp"

    def rates(self, quote: Currency, start: dt.date, end: dt.date) -> list[FxRate]:
        self.calls.append((str(quote), start, end))
        if str(quote) != "EUR":
            return []
        return [
            FxRate(quote=EUR, date=start + dt.timedelta(days=i), rate=D("4.3"), source="nbp")
            for i in range((end - start).days + 1)
        ]


def sources(prices: FakePrices | None = None, fx: FakeFx | None = None) -> MarketSources:
    return MarketSources(prices or FakePrices(), fx or FakeFx())


def household(
    name: str = "Inwestor", strategy: str | None = BENCH_STRATEGY
) -> tuple[int, str, int]:
    """A profile with one brokerage account and the synthetic history imported (no prices yet)."""
    with get_session() as s:
        p = profiles.create_profile(s, name=name, modules_=["investments"])
        pid, slug = p.id, p.slug
    with get_session() as s:
        aid = accounts.add_account(s, pid, name="Konto Test", broker="dif").id
    with get_session() as s:
        profile = s.get(profiles.Profile, pid)
        preview = imports.preview(
            s, profile, imports.ImportRequest(ImportFile("history.csv", canonical_csv()), aid)
        )
    imports.commit(preview)
    if strategy is not None:
        files.write_text_private(files.strategy_yaml_path(slug), strategy)
    return pid, slug, aid
