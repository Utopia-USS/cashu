"""Declining-balance depreciation for VEHICLE (and similar) asset accounts.

Kept separate from the loan amortization model: a car is an *asset* that loses
value over time (never a liability). Value is computed on read (like a loan's
outstanding balance), so net worth history shows it declining smoothly.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

DAYS_PER_YEAR = 365.25


def value(
    purchase_price: Decimal | float,
    purchase_date: dt.date,
    annual_rate_pct: Decimal | float,
    as_of: dt.date,
    floor: Decimal | float | None = None,
) -> Decimal:
    """Estimated market value at ``as_of``.

    0 before the purchase date (the asset isn't owned yet), the full price on the
    day, then declining-balance decay toward ``floor`` (or ~0 if no floor)."""
    if as_of < purchase_date:
        return Decimal("0.00")
    years = (as_of - purchase_date).days / DAYS_PER_YEAR
    rate = float(annual_rate_pct) / 100.0
    v = float(purchase_price) * (1.0 - rate) ** years
    if floor is not None:
        v = max(v, float(floor))
    return Decimal(str(round(v, 2)))


def value_of(dep, as_of: dt.date) -> Decimal:
    """Convenience wrapper taking a Depreciation model row."""
    return value(dep.purchase_price, dep.purchase_date, dep.annual_rate, as_of, dep.floor)
