"""Value types of the investments domain: ids, calendar dates, currencies, money, exact decimals."""

from __future__ import annotations

import re
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import ROUND_DOWN, ROUND_HALF_UP, Context, Decimal, localcontext
from functools import wraps
from typing import Self

# Ids are plain strings (UUIDs or any stable key chosen by the persistence layer).
type ProfileId = str
type AccountId = str
type InstrumentId = str
type TxnId = str
type ImportBatchId = str

# A calendar date (no time, no zone), e.g. a trade date or the exchange date of a bar.
type CalendarDate = date

# Neutral timestamp used where a source or test does not care (ordering ties fall back to the id).
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)

_CURRENCY = re.compile(r"^[A-Z]{3}$")


class Currency(str):
    """An ISO 4217 code, always three upper-case letters (``PLN``, ``USD``).

    A ``str`` subclass: ``Currency("usd") == "USD"`` and it works as a dict key next to plain strings.
    The constructor normalizes (trim, upper-case) and raises ``ValueError`` for anything else.
    """

    __slots__ = ()

    def __new__(cls, code: str) -> Self:
        normalized = str(code).strip().upper()
        if not _CURRENCY.match(normalized):
            raise ValueError(f"Not an ISO 4217 currency code: {code!r}")
        return super().__new__(cls, normalized)

    PLN: Currency
    EUR: Currency
    USD: Currency
    GBP: Currency
    CHF: Currency


Currency.PLN = Currency("PLN")
Currency.EUR = Currency("EUR")
Currency.USD = Currency("USD")
Currency.GBP = Currency("GBP")
Currency.CHF = Currency("CHF")


@dataclass(frozen=True, slots=True)
class Money:
    """An exact amount in one currency. Adding or subtracting two currencies raises ``ValueError``."""

    amount: Decimal
    currency: Currency

    @staticmethod
    def zero(currency: Currency) -> Money:
        return Money(Decimal(0), currency)

    def _same(self, other: Money) -> Money:
        if other.currency != self.currency:
            raise ValueError(f"Currency mismatch: {self.currency} vs {other.currency}")
        return other

    def __add__(self, other: Money) -> Money:
        return Money(self.amount + self._same(other).amount, self.currency)

    def __sub__(self, other: Money) -> Money:
        return Money(self.amount - self._same(other).amount, self.currency)

    def __neg__(self) -> Money:
        return Money(-self.amount, self.currency)

    def __str__(self) -> str:
        return f"{self.amount} {self.currency}"


# --- exact decimal arithmetic -------------------------------------------------------------------

DIVISION_SCALE = 10
"""Decimal places kept by :func:`divided_by` (unit costs, split-adjusted prices, inverse FX rates)."""

EXACT_CONTEXT = Context(prec=60, rounding=ROUND_HALF_UP)
"""Context the portfolio math runs in: 60 significant digits, so products of amounts never round."""


@contextmanager
def exact_decimals():
    """Run a block in :data:`EXACT_CONTEXT` (the global decimal context is left untouched)."""
    with localcontext(EXACT_CONTEXT) as ctx:
        yield ctx


def exact[**P, R](function: Callable[P, R]) -> Callable[P, R]:
    """Decorator: run ``function`` inside :func:`exact_decimals`."""

    @wraps(function)
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
        with exact_decimals():
            return function(*args, **kwargs)

    return wrapper


def divided_by(dividend: Decimal, divisor: Decimal, scale: int = DIVISION_SCALE) -> Decimal:
    """``dividend / divisor`` rounded half-up (ties away from zero) to ``scale`` decimal places.

    Matches the Dart ``DecimalOps.dividedBy`` of Kompas: the quotient is truncated far beyond ``scale``
    first, then rounded once, so the result equals exact rational rounding. Raises on division by zero.
    """
    with localcontext(Context(prec=80, rounding=ROUND_DOWN)):
        quotient = Decimal(dividend) / Decimal(divisor)
        return quotient.quantize(Decimal(1).scaleb(-scale), rounding=ROUND_HALF_UP)


def ratio(part: Decimal | None, total: Decimal) -> float | None:
    """``part / total`` as a float, or None when ``part`` is None or ``total`` is zero."""
    if part is None or total == 0:
        return None
    with localcontext(Context(prec=40)):
        return float(Decimal(part) / Decimal(total))


def days_between(start: CalendarDate, end: CalendarDate) -> int:
    """Whole days from ``start`` to ``end`` (positive when ``end`` is later)."""
    return (end - start).days
