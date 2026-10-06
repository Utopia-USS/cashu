"""Chronological ranking of the rows of one file (R9), the source of their ``created_at`` order.

Positions are derived in ``chronological_key`` order (trade date, ``created_at``, id), so the import
gives the rows of one file strictly increasing ``created_at`` values in chronological order:

- by trade date;
- rows of the same date by time of day when every row of that date has one (a comparator mixing timed
  and untimed rows would not be transitive);
- then file order, reversed when the file lists newest first (its first row is later than its last by
  date, or by time on the same date), so same-day rows keep their real sequence.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timedelta
from functools import cmp_to_key

from .contract import ParsedTxn

DEFAULT_STEP = timedelta(milliseconds=1)


def is_newest_first(txns: Sequence[ParsedTxn]) -> bool:
    """True when the file lists newest rows first (first row later than the last one)."""
    if len(txns) < 2:
        return False
    first, last = txns[0], txns[-1]
    if first.trade_date != last.trade_date:
        return first.trade_date > last.trade_date
    return (
        first.trade_time is not None
        and last.trade_time is not None
        and first.trade_time > last.trade_time
    )


def chronological_ranks(txns: Sequence[ParsedTxn]) -> tuple[int, ...]:
    """Rank (0-based) of every row in chronological order, in input order."""
    newest_first = is_newest_first(txns)
    timed_dates: dict[object, bool] = {}
    for txn in txns:
        timed_dates[txn.trade_date] = (
            timed_dates.get(txn.trade_date, True) and txn.trade_time is not None
        )

    def compare(a: int, b: int) -> int:
        ta, tb = txns[a], txns[b]
        if ta.trade_date != tb.trade_date:
            return -1 if ta.trade_date < tb.trade_date else 1
        if timed_dates[ta.trade_date]:
            assert ta.trade_time is not None and tb.trade_time is not None
            if ta.trade_time != tb.trade_time:
                return -1 if ta.trade_time < tb.trade_time else 1
        if newest_first:
            return b - a
        return a - b

    order = sorted(range(len(txns)), key=cmp_to_key(compare))
    ranks = [0] * len(txns)
    for rank, index in enumerate(order):
        ranks[index] = rank
    return tuple(ranks)


def created_at_stamps(
    txns: Sequence[ParsedTxn], base: datetime, step: timedelta = DEFAULT_STEP
) -> tuple[datetime, ...]:
    """``created_at`` per row (input order): ``base + rank * step``, strictly increasing in
    chronological order."""
    return tuple(base + rank * step for rank in chronological_ranks(txns))


__all__ = ["DEFAULT_STEP", "chronological_ranks", "created_at_stamps", "is_newest_first"]
