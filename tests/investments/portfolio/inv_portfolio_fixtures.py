"""Transaction, bar and FX builders for the portfolio math tests (synthetic, hand-computable numbers).

Port of the Kompas ``portfolio_fixtures.dart``. Every builder takes the next value of a shared counter
as ``created_at``, so transactions on the same day keep the order in which a test creates them (the lot
engine sorts by trade date, then created at).
"""

from __future__ import annotations

import itertools
from collections.abc import Iterable
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from uuid import uuid4

from finanse.modules.investments.domain import (
    AssetClass,
    Currency,
    FxRate,
    Instrument,
    InstrumentAlias,
    InstrumentStatus,
    ManualValuation,
    MarketView,
    PriceBar,
    Transaction,
    TxnSource,
    TxnType,
    ValuationMode,
)
from finanse.modules.investments.portfolio import InMemoryFxLookup

PLN = Currency.PLN
USD = Currency.USD
EUR = Currency.EUR
GBP = Currency.GBP

_sequence = itertools.count(1)


def d(value: str | int) -> Decimal:
    return Decimal(str(value))


def day(iso: str) -> date:
    return date.fromisoformat(iso)


def new_id() -> str:
    return str(uuid4())


def next_created_at() -> datetime:
    return datetime(2026, 1, 1, tzinfo=UTC) + timedelta(seconds=next(_sequence))


def build_txn(
    account_id: str,
    instrument_id: str | None = None,
    *,
    txn_id: str | None = None,
    type: TxnType = TxnType.BUY,
    trade_date: str = "2026-01-05",
    quantity: str | None = "10",
    price: str | None = "100",
    currency: Currency = PLN,
    gross_amount: str | None = None,
    fee: str = "0",
    tax: str = "0",
    cash_amount: str | None = None,
    cash_currency: Currency | None = None,
    source: TxnSource = TxnSource.IMPORT,
    split_ratio: str | None = None,
    fx_rate: str | None = None,
    created_at: datetime | None = None,
) -> Transaction:
    """A buy of ``quantity`` at ``price`` by default; override ``type`` and amounts for other events."""
    if gross_amount is not None:
        gross = d(gross_amount)
    elif quantity is not None and price is not None:
        gross = d(quantity) * d(price)
    else:
        gross = Decimal(0)
    return Transaction(
        id=txn_id or new_id(),
        account_id=account_id,
        instrument_id=instrument_id,
        type=type,
        trade_date=day(trade_date),
        quantity=None if quantity is None else d(quantity),
        price=None if price is None else d(price),
        currency=currency,
        gross_amount=gross,
        fee=d(fee),
        tax=d(tax),
        cash_amount=d(cash_amount) if cash_amount is not None else -(gross + d(fee)),
        cash_currency=cash_currency or currency,
        source=source,
        split_ratio=None if split_ratio is None else d(split_ratio),
        fx_rate=None if fx_rate is None else d(fx_rate),
        created_at=created_at or next_created_at(),
    )


def buy(account, instrument, trade_date, quantity, price, *, fee="0", tax="0", currency=PLN):
    gross = d(quantity) * d(price)
    return build_txn(
        account,
        instrument,
        trade_date=trade_date,
        quantity=quantity,
        price=price,
        fee=fee,
        tax=tax,
        currency=currency,
        cash_amount=str(-(gross + d(fee) + d(tax))),
    )


def sell(account, instrument, trade_date, quantity, price, *, fee="0", tax="0", currency=PLN):
    gross = d(quantity) * d(price)
    return build_txn(
        account,
        instrument,
        type=TxnType.SELL,
        trade_date=trade_date,
        quantity=quantity,
        price=price,
        fee=fee,
        tax=tax,
        currency=currency,
        cash_amount=str(gross - d(fee) - d(tax)),
    )


def split(account, instrument, trade_date, ratio):
    return build_txn(
        account,
        instrument,
        type=TxnType.SPLIT,
        trade_date=trade_date,
        quantity=None,
        price=None,
        cash_amount="0",
        split_ratio=ratio,
    )


def transfer_in(account, instrument, trade_date, quantity, *, price=None):
    return build_txn(
        account,
        instrument,
        type=TxnType.TRANSFER_IN,
        trade_date=trade_date,
        quantity=quantity,
        price=price,
        gross_amount="0",
        cash_amount="0",
    )


def transfer_out(account, instrument, trade_date, quantity):
    return build_txn(
        account,
        instrument,
        type=TxnType.TRANSFER_OUT,
        trade_date=trade_date,
        quantity=quantity,
        price=None,
        gross_amount="0",
        cash_amount="0",
    )


def cash_txn(account, trade_date, amount, *, type=TxnType.DEPOSIT, currency=PLN):
    return build_txn(
        account,
        type=type,
        trade_date=trade_date,
        quantity=None,
        price=None,
        currency=currency,
        gross_amount=str(abs(d(amount))),
        cash_amount=amount,
    )


def instrument(
    instrument_id: str | None = None,
    *,
    name: str = "Orlen",
    symbol: str | None = "PKN",
    mic: str | None = "XWAR",
    currency: Currency = PLN,
    asset_class: AssetClass = AssetClass.EQUITY,
    tags: Iterable[str] = (),
    needs_classification: bool = False,
    aliases: Iterable[InstrumentAlias] = (),
    valuation_mode: ValuationMode | None = None,
    status: InstrumentStatus = InstrumentStatus.ACTIVE,
) -> Instrument:
    return Instrument(
        id=instrument_id or new_id(),
        name=name,
        symbol=symbol,
        mic=mic,
        currency=currency,
        asset_class=asset_class,
        tags=tuple(tags),
        needs_classification=needs_classification,
        aliases=tuple(aliases),
        valuation_mode=valuation_mode,
        status=status,
    )


def bar(instrument_id: str, on: str, close: str) -> PriceBar:
    return PriceBar(
        instrument_id=instrument_id,
        date=day(on),
        close=d(close),
        source="test",
        fetched_at=datetime(2026, 1, 1, tzinfo=UTC),
    )


def fx_rate(quote: Currency, on: str, rate: str, *, base: Currency = PLN) -> FxRate:
    return FxRate(
        quote=quote,
        base=base,
        date=day(on),
        rate=d(rate),
        source="test",
        fetched_at=datetime(2026, 1, 1, tzinfo=UTC),
    )


def manual(
    instrument_id: str, on: str, unit_value: str, currency: Currency = PLN
) -> ManualValuation:
    return ManualValuation(
        instrument_id=instrument_id, as_of=day(on), unit_value=d(unit_value), currency=currency
    )


def market_view(
    as_of: str,
    *,
    instruments: Iterable[Instrument] = (),
    bars: Iterable[PriceBar] = (),
    manual_valuations: Iterable[ManualValuation] = (),
) -> MarketView:
    """A market view with ``instruments``, their ``bars`` and manual valuations (grouped, sorted)."""
    by_instrument: dict[str, list[PriceBar]] = {}
    for item in bars:
        by_instrument.setdefault(item.instrument_id, []).append(item)
    by_valuation: dict[str, list[ManualValuation]] = {}
    for item in manual_valuations:
        by_valuation.setdefault(item.instrument_id, []).append(item)
    return MarketView(
        as_of=day(as_of),
        instruments={i.id: i for i in instruments},
        bars={k: tuple(sorted(v, key=lambda b: b.date)) for k, v in by_instrument.items()},
        manual_valuations={
            k: tuple(sorted(v, key=lambda m: m.as_of)) for k, v in by_valuation.items()
        },
    )


NO_FX = InMemoryFxLookup([])
"""A lookup with no rates (identity only)."""
