"""Sensitivity labels. Every value a tool returns is wrapped in a :class:`Labelled` (built with the
helpers below); the redaction layer decides per label and privacy level what may be sent. A raw
(unlabelled) leaf in a tool's result is a programming error and the call fails closed.

Labels (contract F4, plus ``count``, ``ref``, ``flag``, ``account`` and ``level`` (F5), ``market`` (P6)):

| label | strict | amounts |
|---|---|---|
| ``identifier`` (IBAN, account number, person name, file names with numbers) | dropped | dropped |
| ``amount`` (money values, quantities, prices x quantity) | dropped | sent |
| ``merchant`` (payee names; private persons -> opaque ref) | sent | sent |
| ``percent``, ``date``, ``category``, ``symbol`` (public tickers / ISINs) | sent | sent |
| ``level`` (a market price level of a public instrument: an alert level, a close) | sent | sent |
| ``text`` (scrubbed: identifiers always, money amounts in strict) | sent | sent |
| ``market`` (server-made text about public market data, e.g. ``USA 10 lat`` / ``4,23 %``; identifiers scrubbed, never amounts) | sent | sent |
| ``count`` (non-money integers: counts, days, row numbers) | sent | sent |
| ``ref`` (local row ids the write tools take back) | sent | sent |
| ``flag`` (booleans) | sent | sent |
| ``account`` (the generated "<institution> <type> <n>" label, never the stored name) | sent | sent |

Percent values are either fractions (``weight`` 0.153 = 15.3 %) or percentage points (``*_pp``); the
key name says which. Amounts in strict mode are replaced by shares of a base the tool names.
"""

from __future__ import annotations

import datetime as dt
import re
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
    MARKET = "market"


@dataclass(frozen=True, slots=True)
class Labelled:
    value: Any
    label: Sensitivity


def identifier(value: Any) -> Labelled:
    return Labelled(value, Sensitivity.IDENTIFIER)


def _rounded(value: Any, digits: int) -> Any:
    """Floats and Decimals rounded to ``digits`` places (ints, None and anything else unchanged):
    an unrounded float (FX conversions, 0.1 + 0.2) would otherwise carry a 10+ digit fraction that
    the final leak check rightly takes for an account number and withholds the whole answer."""
    if isinstance(value, (float, Decimal)):
        return round(float(value), digits)
    return value


def amount(value: Decimal | float | None, digits: int = 2) -> Labelled:
    """Money (2 places by default); quantities and per-unit prices pass ``digits=8``."""
    return Labelled(_rounded(value, digits), Sensitivity.AMOUNT)


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


MARKET_LABELS: frozenset[str] = frozenset(
    {
        "ACWI wobec 200 sesji",
        "od szczytu",
        "S&P 500 od szczytu",
        "DXY",
        "6 mies.",
        "USD/PLN 6 mies.",
        "EEM wobec ACWI 6 mies.",
        "EEM 6 mies.",
        "DBC 12 mies.",
        "wobec ACWI 12 mies.",
        "USA 10 lat",
        "3 mies. zmiana",
        "krzywa 10l-3m",
    }
)
"""The macro metric labels (P6, ``investments.macro.regimes.METRIC_LABELS``; a test keeps them equal):
the only words a ``market`` value may carry."""
_MARKET_NUMBER = re.compile(r"^[+-]?\d{1,3}(?: \d{3})*(?:,\d+)?(?: (?:%|pp|bp|mln|mld))?$")
COMPACT_FROM = 1_000_000
"""From this absolute value a screening threshold is written compactly (:func:`compact_number`)."""


def compact_number(value: float) -> str:
    """A large number as short Polish text, ``1 mld`` / ``1,5 mld`` / ``500 mln`` / ``2 500 mld``
    (3 significant digits at most, decimal comma, no trailing zeros): it never forms the long digit
    run the leak check takes for an account number."""
    number = float(value)
    scale, unit = (1e9, "mld") if abs(number) >= 1e9 else (1e6, "mln")
    if unit == "mln" and round(abs(number) / 1e6) >= 1000:  # 999 999 999 -> 1 mld
        scale, unit = 1e9, "mld"
    scaled = number / scale
    decimals = 0 if abs(scaled) >= 100 else 1 if abs(scaled) >= 10 else 2
    text = f"{abs(scaled):,.{decimals}f}".replace(",", " ")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    sign = "-" if number < 0 and text.strip("0 .") else ""
    return f"{sign}{text.replace('.', ',')} {unit}"


def market_ok(value: object) -> bool:
    """A ``market`` value is a known macro metric label, a formatted number (digits, sign, spaces,
    decimal comma, ``%`` / ``pp`` / ``bp`` / ``mln`` / ``mld``) or a macro card summary (P7: only the summary builder's
    vocabulary, numbers and punctuation): nothing else may use the strict-mode exemption."""
    if not isinstance(value, str):
        return False
    if value in MARKET_LABELS or _MARKET_NUMBER.match(value):
        return True
    from cashu.modules.investments.macro.texts import summary_ok

    return summary_ok(value)


def market(value: str | None) -> Labelled:
    """Text the server builds from public market data only (a macro metric's label and its formatted
    value, P6; a macro card summary, P7): never personal, so the same in both modes (identifiers are still scrubbed). Anything
    but :func:`market_ok` text is refused here and again by the redactor (the call fails closed)."""
    if value is not None and not market_ok(value):
        raise ValueError("not a macro metric label or a formatted market number")
    return Labelled(value, Sensitivity.MARKET)


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
        value = round(float(value), 8)
    return Labelled(value, Sensitivity.LEVEL)


def share(part: Decimal | float | None, base: Decimal | float | None) -> Labelled:
    """``part / base`` as a percent fraction (None when either is missing or the base is 0)."""
    if part is None or base is None or not base:
        return pct(None)
    return pct(Decimal(str(part)) / Decimal(str(base)))
