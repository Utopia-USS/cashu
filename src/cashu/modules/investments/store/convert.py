"""Row <-> domain conversions. The pure core uses ``str`` ids; the tables use integer keys."""

from __future__ import annotations

import datetime as dt
from collections.abc import Iterable
from decimal import Decimal

from ..domain import (
    AssetClass,
    Currency,
    FxRate,
    Instrument,
    InstrumentAlias,
    InstrumentRename,
    InstrumentStatus,
    ManualValuation,
    PriceBar,
    Transaction,
    TxnSource,
    TxnType,
    ValuationMode,
)
from ..models import (
    InvFxRate,
    InvInstrument,
    InvInstrumentAlias,
    InvInstrumentRename,
    InvManualValuation,
    InvPriceBar,
    InvTransaction,
)


def sid(pk: int | None) -> str:
    """Domain id of a row key."""
    if pk is None:
        raise ValueError("row has no id yet (flush first)")
    return str(pk)


def pk(domain_id: str | int) -> int:
    """Row key of a domain id (``ValueError`` for a planned, not yet stored id)."""
    return int(domain_id)


def maybe_pk(domain_id: str | int | None) -> int | None:
    if domain_id is None:
        return None
    try:
        return int(domain_id)
    except (TypeError, ValueError):
        return None


def aware(value: dt.datetime) -> dt.datetime:
    """UTC-aware timestamp (the tables refuse naive datetimes)."""
    return value.replace(tzinfo=dt.UTC) if value.tzinfo is None else value.astimezone(dt.UTC)


def instrument(row: InvInstrument, aliases: Iterable[InvInstrumentAlias] = ()) -> Instrument:
    return Instrument(
        id=sid(row.id),
        name=row.name,
        currency=Currency(row.currency),
        asset_class=AssetClass(row.asset_class),
        symbol=row.symbol,
        isin=row.isin,
        mic=row.mic,
        region=row.region,
        sector=row.sector,
        tags=tuple(row.tags or ()),
        needs_classification=row.needs_classification,
        aliases=tuple(
            InstrumentAlias(a.namespace, a.value, a.guessed)
            for a in sorted(aliases, key=lambda a: (a.namespace, a.guessed, a.id or 0))
        ),
        valuation_mode=ValuationMode(row.valuation_mode),
        status=InstrumentStatus(row.status),
    )


def transaction(row: InvTransaction) -> Transaction:
    return Transaction(
        id=sid(row.id),
        account_id=sid(row.account_id),
        type=TxnType(row.type),
        trade_date=row.trade_date,
        currency=Currency(row.currency),
        gross_amount=row.gross_amount,
        cash_amount=row.cash_amount,
        cash_currency=Currency(row.cash_currency),
        instrument_id=None if row.instrument_id is None else sid(row.instrument_id),
        settle_date=row.settle_date,
        quantity=row.quantity,
        price=row.price,
        fee=row.fee if row.fee is not None else Decimal(0),
        tax=row.tax if row.tax is not None else Decimal(0),
        fx_rate=row.fx_rate,
        split_ratio=row.split_ratio,
        note=row.note,
        source=TxnSource(row.source),
        import_batch_id=None if row.import_batch_id is None else sid(row.import_batch_id),
        external_ref=row.external_ref,
        dedup_hash=row.dedup_hash,
        created_at=aware(row.created_at),
    )


def transaction_row(
    txn: Transaction,
    *,
    account_id: int,
    instrument_id: int | None,
    import_batch_id: int | None = None,
    created_at: dt.datetime | None = None,
) -> InvTransaction:
    return InvTransaction(
        account_id=account_id,
        type=txn.type.value,
        trade_date=txn.trade_date,
        settle_date=txn.settle_date,
        instrument_id=instrument_id,
        quantity=txn.quantity,
        price=txn.price,
        currency=str(txn.currency),
        gross_amount=txn.gross_amount,
        fee=txn.fee,
        tax=txn.tax,
        cash_amount=txn.cash_amount,
        cash_currency=str(txn.cash_currency),
        fx_rate=txn.fx_rate,
        split_ratio=txn.split_ratio,
        note=txn.note,
        source=txn.source.value,
        import_batch_id=import_batch_id,
        external_ref=txn.external_ref,
        dedup_hash=txn.dedup_hash,
        created_at=aware(created_at or txn.created_at),
    )


def price_bar(row: InvPriceBar) -> PriceBar:
    return PriceBar(
        instrument_id=sid(row.instrument_id),
        date=row.date,
        close=row.close,
        source=row.source,
        fetched_at=None if row.fetched_at is None else aware(row.fetched_at),
        open=row.open,
        high=row.high,
        low=row.low,
        volume=row.volume,
        currency=None if row.currency is None else Currency(row.currency),
    )


def fx_rate(row: InvFxRate) -> FxRate:
    return FxRate(
        quote=Currency(row.quote),
        date=row.date,
        rate=row.rate,
        source=row.source,
        fetched_at=None if row.fetched_at is None else aware(row.fetched_at),
        base=Currency(row.base),
    )


def manual_valuation(row: InvManualValuation) -> ManualValuation:
    return ManualValuation(
        instrument_id=sid(row.instrument_id),
        as_of=row.as_of,
        unit_value=row.unit_value,
        currency=Currency(row.currency),
        note=row.note,
    )


def rename(row: InvInstrumentRename) -> InstrumentRename:
    return InstrumentRename(
        date=row.date,
        old_instrument_id=sid(row.old_instrument_id),
        new_instrument_id=sid(row.new_instrument_id),
        note=row.note,
    )
