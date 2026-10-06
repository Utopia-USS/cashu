"""Compare positions derived from transactions with a broker position export (pure).

Corrections: missing units become an ``adjustment`` (opens a lot at the broker's average price, or with
unknown cost); surplus units become a ``transfer_out`` (consumes lots FIFO) because transaction
quantities are never negative and an adjustment cannot express a decrease. Both have
``source = reconciliation``, no cash effect and a deterministic dedup hash, so applying the same proposal
twice inserts it once.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal
from enum import StrEnum

from ..domain import (
    EPOCH,
    AccountId,
    CalendarDate,
    Currency,
    InstrumentId,
    PortfolioSnapshot,
    Transaction,
    TxnId,
    TxnSource,
    TxnType,
    divided_by,
    exact_decimals,
)
from .contract import ParsedPosition
from .dedup import reconciliation_hash


class PositionDiffKind(StrEnum):
    """Outcome of comparing one instrument's computed quantity with the broker's."""

    MATCH = "match"
    MISMATCH = "mismatch"
    """Both sides hold the instrument, with different quantities."""
    MISSING_IN_HISTORY = "missing_in_history"
    """The broker reports a position the transaction history does not have."""
    MISSING_AT_BROKER = "missing_at_broker"
    """The history holds a position the broker does not report."""


@dataclass(frozen=True, slots=True, kw_only=True)
class BrokerPosition:
    """A broker position line resolved to an instrument (reconciliation input)."""

    instrument_id: InstrumentId
    quantity: Decimal
    currency: Currency
    as_of: CalendarDate
    avg_price: Decimal | None = None
    market_value: Decimal | None = None

    @staticmethod
    def from_parsed(position: ParsedPosition, instrument_id: InstrumentId) -> BrokerPosition:
        return BrokerPosition(
            instrument_id=instrument_id,
            quantity=position.quantity,
            currency=position.currency,
            as_of=position.as_of,
            avg_price=position.avg_price,
            market_value=position.market_value,
        )


@dataclass(frozen=True, slots=True, kw_only=True)
class PositionDiff:
    """Computed vs broker quantity of one instrument in one account."""

    instrument_id: InstrumentId
    computed_quantity: Decimal
    """Quantity derived from transactions (the snapshot holding), 0 when not held."""
    broker_quantity: Decimal
    """Quantity in the broker's position export, 0 when not reported."""
    currency: Currency
    kind: PositionDiffKind

    @property
    def delta(self) -> Decimal:
        """``broker_quantity - computed_quantity``: positive = units missing from the history."""
        with exact_decimals():
            return self.broker_quantity - self.computed_quantity


@dataclass(frozen=True, slots=True)
class ProposedCorrection:
    """A transaction that would make the history match the broker for one instrument."""

    diff: PositionDiff
    txn: Transaction


@dataclass(frozen=True, slots=True, kw_only=True)
class ReconciliationReport:
    account_id: AccountId
    as_of: CalendarDate
    """Date of the broker positions (the corrections' trade date)."""
    diffs: tuple[PositionDiff, ...] = ()
    """Every instrument held or reported: broker order first, then holdings the broker omits."""
    corrections: tuple[ProposedCorrection, ...] = ()
    warnings: tuple[str, ...] = ()
    """Input problems (mixed position dates, snapshot date differs, currency differs...)."""

    @property
    def mismatches(self) -> tuple[PositionDiff, ...]:
        return tuple(diff for diff in self.diffs if diff.kind != PositionDiffKind.MATCH)

    @property
    def is_clean(self) -> bool:
        return not self.corrections


def _new_txn_id() -> TxnId:
    return str(uuid.uuid4())


def reconcile(
    account_id: AccountId,
    positions: Sequence[BrokerPosition],
    snapshot: PortfolioSnapshot,
    *,
    tolerance: Decimal = Decimal(0),
    now: datetime = EPOCH,
    txn_id_factory: Callable[[], TxnId] = _new_txn_id,
) -> ReconciliationReport:
    """Diffs between ``snapshot``'s holdings of ``account_id`` and one complete broker position export
    of that account, plus proposed corrections. Pure: writes nothing.

    Build ``snapshot`` as of the positions' date. Quantities within ``tolerance`` (absolute units) match.
    Several broker rows of one instrument are summed. Corrections get ``created_at = now + i ms``.
    """
    warnings: list[str] = []
    dates = {position.as_of for position in positions}
    as_of = max(dates) if dates else snapshot.as_of
    if len(dates) > 1:
        warnings.append(f"Broker positions have {len(dates)} different dates; used {as_of}")
    if snapshot.as_of != as_of:
        warnings.append(f"Snapshot is as of {snapshot.as_of} but broker positions as of {as_of}")

    broker: dict[InstrumentId, list[BrokerPosition]] = {}
    for position in positions:
        broker.setdefault(position.instrument_id, []).append(position)
    held = {h.instrument_id: h for h in snapshot.holdings if h.account_id == account_id}

    diffs: list[PositionDiff] = []
    corrections: list[ProposedCorrection] = []

    def add(
        instrument_id: InstrumentId,
        computed: Decimal,
        reported: Decimal,
        currency: Currency,
        avg_price: Decimal | None,
    ) -> None:
        diff = PositionDiff(
            instrument_id=instrument_id,
            computed_quantity=computed,
            broker_quantity=reported,
            currency=currency,
            kind=_kind(computed, reported, tolerance),
        )
        diffs.append(diff)
        if diff.kind == PositionDiffKind.MATCH:
            return
        created_at = now + timedelta(milliseconds=len(corrections))
        txn = _proposal(account_id, as_of, diff, avg_price, created_at, txn_id_factory())
        corrections.append(ProposedCorrection(diff, txn))

    with exact_decimals():
        for instrument_id, rows in broker.items():
            holding = held.get(instrument_id)
            reported = sum((row.quantity for row in rows), Decimal(0))
            currency = rows[0].currency
            if holding is not None and holding.currency != currency:
                warnings.append(
                    f"Currency of {instrument_id} differs: history {holding.currency}, "
                    f"broker {currency}"
                )
            computed = Decimal(0) if holding is None else holding.quantity
            add(instrument_id, computed, reported, currency, _average_price(rows))
        for holding in held.values():
            if holding.instrument_id not in broker:
                add(holding.instrument_id, holding.quantity, Decimal(0), holding.currency, None)

    return ReconciliationReport(
        account_id=account_id,
        as_of=as_of,
        diffs=tuple(diffs),
        corrections=tuple(corrections),
        warnings=tuple(warnings),
    )


def _kind(computed: Decimal, reported: Decimal, tolerance: Decimal) -> PositionDiffKind:
    if abs(reported - computed) <= tolerance:
        return PositionDiffKind.MATCH
    if computed == 0:
        return PositionDiffKind.MISSING_IN_HISTORY
    if reported == 0:
        return PositionDiffKind.MISSING_AT_BROKER
    return PositionDiffKind.MISMATCH


def _average_price(rows: Sequence[BrokerPosition]) -> Decimal | None:
    """Quantity-weighted average of the rows' average prices, None when any is unknown."""
    if len(rows) == 1:
        return rows[0].avg_price
    cost = Decimal(0)
    quantity = Decimal(0)
    for row in rows:
        if row.avg_price is None:
            return None
        cost += row.avg_price * row.quantity
        quantity += row.quantity
    return None if quantity == 0 else divided_by(cost, quantity)


def _proposal(
    account_id: AccountId,
    as_of: CalendarDate,
    diff: PositionDiff,
    avg_price: Decimal | None,
    created_at: datetime,
    txn_id: TxnId,
) -> Transaction:
    increase = diff.delta > 0
    quantity = abs(diff.delta)
    txn_type = TxnType.ADJUSTMENT if increase else TxnType.TRANSFER_OUT
    price = avg_price if increase else None
    if not increase:
        cost = ""
    elif price is None:
        cost = "; cost unknown"
    else:
        cost = f"; cost = broker average price {price}"
    sign = "+" if increase else "-"
    return Transaction(
        id=txn_id,
        account_id=account_id,
        type=txn_type,
        trade_date=as_of,
        currency=diff.currency,
        gross_amount=Decimal(0) if price is None else price * quantity,
        cash_amount=Decimal(0),
        cash_currency=diff.currency,
        instrument_id=diff.instrument_id,
        quantity=quantity,
        price=price,
        source=TxnSource.RECONCILIATION,
        note=(
            f"Reconciliation: broker reports {diff.broker_quantity}, history gives "
            f"{diff.computed_quantity} ({sign}{quantity}){cost}"
        ),
        dedup_hash=reconciliation_hash(account_id, diff.instrument_id, as_of, txn_type, quantity),
        created_at=created_at,
    )


__all__ = [
    "BrokerPosition",
    "PositionDiff",
    "PositionDiffKind",
    "ProposedCorrection",
    "ReconciliationReport",
    "reconcile",
]
