"""Sensitivity labels. Every value a tool returns is wrapped in a :class:`Labelled` (built with the
helpers below); the redaction layer decides per label and privacy level what may be sent. A raw
(unlabelled) leaf in a tool's result is a programming error and the call fails closed.

Labels (contract F4, plus ``count``, ``ref``, ``flag``, ``account`` and ``level`` (F5)):

| label | strict | amounts |
|---|---|---|
| ``identifier`` (IBAN, account number, person name, file names with numbers) | dropped | dropped |
| ``amount`` (money values, quantities, prices x quantity) | dropped | sent |
| ``merchant`` (payee names; private persons -> opaque ref) | sent | sent |
| ``percent``, ``date``, ``category``, ``symbol`` (public tickers / ISINs) | sent | sent |
| ``level`` (a market price level of a public instrument: an alert level, a close) | sent | sent |
| ``text`` (scrubbed: identifiers always, money amounts in strict) | sent | sent |
| ``count`` (non-money integers: counts, days, row numbers) | sent | sent |
| ``ref`` (local row ids the write tools take back) | sent | sent |
| ``flag`` (booleans) | sent | sent |
| ``account`` (the generated "<institution> <type> <n>" label, never the stored name) | sent | sent |

Percent values are either fractions (``weight`` 0.153 = 15.3 %) or percentage points (``*_pp``); the
key name says which. Amounts in strict mode are replaced by shares of a base the tool names.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum
from typing import Any


class Sensitivity(StrEnum):
    IDENTIFIER = "identifier"
    AMOUNT = "amount"
    MERCHANT = "merchant"
    PERCENT = "percent"
    DATE = "date"
    CATEGORY = "category"
    TEXT = "text"
    SYMBOL = "symbol"
    COUNT = "count"
    REF = "ref"
    FLAG = "flag"
    ACCOUNT = "account"
    LEVEL = "level"


@dataclass(frozen=True, slots=True)
class Labelled:
    value: Any
    label: Sensitivity


def identifier(value: Any) -> Labelled:
    return Labelled(value, Sensitivity.IDENTIFIER)


def amount(value: Decimal | float | None) -> Labelled:
    return Labelled(value, Sensitivity.AMOUNT)


def merchant(value: str | None) -> Labelled:
    return Labelled(value, Sensitivity.MERCHANT)


def pct(value: Decimal | float | None, digits: int = 6) -> Labelled:
    if value is not None:
        value = round(float(value), digits)
    return Labelled(value, Sensitivity.PERCENT)


def date(value: dt.date | dt.datetime | str | None) -> Labelled:
    return Labelled(value, Sensitivity.DATE)


def category(value: str | None) -> Labelled:
    return Labelled(value, Sensitivity.CATEGORY)


def text(value: str | None) -> Labelled:
    return Labelled(value, Sensitivity.TEXT)


def symbol(value: str | None) -> Labelled:
    return Labelled(value, Sensitivity.SYMBOL)


def count(value: int | None) -> Labelled:
    return Labelled(value, Sensitivity.COUNT)


def ref(value: int | str | None) -> Labelled:
    return Labelled(value, Sensitivity.REF)


def flag(value: bool | None) -> Labelled:
    return Labelled(value, Sensitivity.FLAG)


def account(value: str | None) -> Labelled:
    return Labelled(value, Sensitivity.ACCOUNT)


def level(value: Decimal | float | None) -> Labelled:
    """A market price level of a public instrument (per unit, never times a quantity): not a
    personal amount, sent in both modes. Owner-named instruments' prices stay ``amount``."""
    if value is not None:
        value = float(value)
    return Labelled(value, Sensitivity.LEVEL)


def share(part: Decimal | float | None, base: Decimal | float | None) -> Labelled:
    """``part / base`` as a percent fraction (None when either is missing or the base is 0)."""
    if part is None or base is None or not base:
        return pct(None)
    return pct(Decimal(str(part)) / Decimal(str(base)))
