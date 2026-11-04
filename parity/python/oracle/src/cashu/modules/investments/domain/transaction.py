"""Account events (trades, cash flows, corporate actions)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal

from .enums import TxnSource, TxnType
from .values import EPOCH, AccountId, CalendarDate, Currency, ImportBatchId, InstrumentId, TxnId


@dataclass(frozen=True, slots=True)
class Transaction:
    """One account event.

    Sign conventions: ``quantity`` and ``gross_amount`` are never negative, the direction comes from
    ``type``. ``cash_amount`` is the signed net effect on the account's cash in ``cash_currency`` (a buy is
    negative, a sell or dividend positive) and is the only field cash balances are computed from.

    Ordering: positions are derived in :func:`chronological_key` order (trade date, ``created_at``, id).
    Importers give the rows of one file strictly increasing ``created_at`` values in chronological order
    (same-day rows ranked by time of day when the export has it), so same-day trades keep their order.
    """

    id: TxnId
    account_id: AccountId
    type: TxnType
    trade_date: CalendarDate
    currency: Currency
    """Currency of ``price``, ``gross_amount``, ``fee`` and ``tax``."""
    gross_amount: Decimal
    """Absolute value of the event before fees and taxes (quantity * price for trades), >= 0."""
    cash_amount: Decimal
    cash_currency: Currency
    instrument_id: InstrumentId | None = None
    """None for pure cash events (deposit, withdrawal, account fee, interest)."""
    settle_date: CalendarDate | None = None
    quantity: Decimal | None = None
    price: Decimal | None = None
    fee: Decimal = Decimal(0)
    tax: Decimal = Decimal(0)
    fx_rate: Decimal | None = None
    """Units of ``cash_currency`` per 1 unit of ``currency`` when they differ (broker conversion rate)."""
    split_ratio: Decimal | None = None
    """For ``SPLIT``: new units per old unit (a 1:4 split is 4)."""
    note: str | None = None
    source: TxnSource = TxnSource.IMPORT
    import_batch_id: ImportBatchId | None = None
    external_ref: str | None = None
    dedup_hash: str = ""
    created_at: datetime = EPOCH

    def __post_init__(self) -> None:
        if self.quantity is not None and self.quantity < 0:
            raise ValueError(f"quantity must be >= 0 (transaction {self.id})")
        if self.gross_amount < 0:
            raise ValueError(f"gross_amount must be >= 0 (transaction {self.id})")


def chronological_key(txn: Transaction) -> tuple[CalendarDate, datetime, TxnId]:
    """Canonical processing order: trade date, then ``created_at``, then id.

    Use it (``sorted(txns, key=chronological_key)``) wherever lots or balances are derived. A naive
    ``created_at`` is read as UTC, so naive and aware timestamps can be mixed.
    """
    created = txn.created_at
    if created.tzinfo is None:
        created = created.replace(tzinfo=UTC)
    return (txn.trade_date, created, txn.id)
