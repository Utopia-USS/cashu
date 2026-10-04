"""Last known trade prices per instrument: the valuation fallback when no market bar exists (funds,
anything without a price source). Pure, no IO."""

from __future__ import annotations

from collections.abc import Collection, Iterable, Sequence
from decimal import Decimal

from ..domain import (
    AccountId,
    CalendarDate,
    DatedPrice,
    InstrumentId,
    InstrumentRename,
    Transaction,
    TxnSource,
    TxnType,
    chronological_key,
    days_between,
    divided_by,
    exact,
)

SPLIT_DEDUP_WINDOW_DAYS = 31
"""Split transactions of one instrument with the same ratio within this many days are one corporate
action (brokers book a split on slightly different days in different accounts)."""


@exact
def last_trade_prices(
    txns: Iterable[Transaction],
    *,
    as_of: CalendarDate | None = None,
    account_ids: Collection[AccountId] | None = None,
    renames: Sequence[InstrumentRename] = (),
) -> dict[InstrumentId, DatedPrice]:
    """The newest positive ``price`` per instrument among market trades (``buy`` and ``sell``) dated
    on/before ``as_of`` (all when None), of ``account_ids`` when given.

    Only real trade prices count (R13): a ``transfer_in`` or ``adjustment`` carries a cost price, not a
    market price, and rows with ``source = reconciliation`` are skipped too.

    Later splits divide the price by their ratio (the date stays the trade date). One split is applied
    once per instrument (R11): a split with the same ratio within :data:`SPLIT_DEDUP_WINDOW_DAYS` days of
    an already applied one is the same corporate action booked in another account, so it is skipped.

    A rename (effective at the start of its date) hands the old instrument's price to the new one when
    the new one has none yet; later rows naming the old instrument count for the new one.
    """
    selected = [
        t
        for t in txns
        if (account_ids is None or t.account_id in account_ids)
        and (as_of is None or t.trade_date <= as_of)
    ]
    events: list[tuple[tuple, Transaction | InstrumentRename]] = [
        ((t.trade_date, 1, chronological_key(t)), t) for t in selected
    ]
    events += [
        ((r.date, 0, (index,)), r)
        for index, r in enumerate(renames)
        if as_of is None or r.date <= as_of
    ]
    events.sort(key=lambda item: item[0])

    prices: dict[InstrumentId, DatedPrice] = {}
    applied_splits: dict[InstrumentId, list[tuple[CalendarDate, Decimal]]] = {}
    redirect: dict[InstrumentId, InstrumentId] = {}

    def resolve(instrument_id: InstrumentId | None) -> InstrumentId | None:
        seen: set[InstrumentId] = set()
        while instrument_id is not None and instrument_id in redirect and instrument_id not in seen:
            seen.add(instrument_id)
            instrument_id = redirect[instrument_id]
        return instrument_id

    for _, event in events:
        if isinstance(event, InstrumentRename):
            old, new = resolve(event.old_instrument_id), resolve(event.new_instrument_id)
            if old is None or new is None or old == new:
                continue
            redirect[old] = new
            if old in prices and new not in prices:
                prices[new] = prices[old]
            continue
        instrument_id = resolve(event.instrument_id)
        if instrument_id is None:
            continue
        if event.type in (TxnType.BUY, TxnType.SELL):
            price = event.price
            if event.source != TxnSource.RECONCILIATION and price is not None and price > 0:
                prices[instrument_id] = DatedPrice(
                    date=event.trade_date, price=price, currency=event.currency
                )
        elif event.type == TxnType.SPLIT:
            ratio = event.split_ratio
            if ratio is None or ratio <= 0:
                continue
            applied = applied_splits.setdefault(instrument_id, [])
            same_action = any(
                r == ratio and abs(days_between(d, event.trade_date)) <= SPLIT_DEDUP_WINDOW_DAYS
                for d, r in applied
            )
            if same_action:
                continue
            applied.append((event.trade_date, ratio))
            last = prices.get(instrument_id)
            if last is not None:
                prices[instrument_id] = DatedPrice(
                    date=last.date, price=divided_by(last.price, ratio), currency=last.currency
                )
    return prices
