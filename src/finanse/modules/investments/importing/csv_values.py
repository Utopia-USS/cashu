"""Cell value parsing for CSV-like exports: locale-aware decimals and pattern-based dates."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, time
from decimal import Decimal

_PLAIN_NUMBER = re.compile(r"^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$")
_SPACES = re.compile("[   ]")

DECIMAL_SEPARATORS: tuple[str, ...] = (".", ",")
THOUSANDS_SEPARATORS: tuple[str, ...] = ("", " ", ".", ",", "'")


@dataclass(frozen=True, slots=True)
class DecimalFormat:
    """Parses locale-formatted decimal numbers such as ``1 234,56``, ``1.234,56`` or ``-1,234.56``.

    ``decimal_separator`` is ``.`` or ``,``; ``thousands_separator`` is empty (none) or one of
    ``" "``, ``.``, ``,``, ``'`` and differs from the decimal separator. A space thousands separator also
    accepts no-break spaces (U+00A0, U+202F).
    """

    decimal_separator: str = "."
    thousands_separator: str = ""

    def __post_init__(self) -> None:
        if self.decimal_separator not in DECIMAL_SEPARATORS:
            raise ValueError(f"decimal_separator must be one of {DECIMAL_SEPARATORS}")
        if self.thousands_separator not in THOUSANDS_SEPARATORS:
            raise ValueError(f"thousands_separator must be one of {THOUSANDS_SEPARATORS}")
        if self.thousands_separator == self.decimal_separator:
            raise ValueError("thousands_separator must differ from decimal_separator")

    def parse(self, raw: str) -> Decimal | None:
        """Parse ``raw``; None for a blank cell, ``ValueError`` for anything that is not a number here.

        Accepts a leading ``+`` / ``-`` / U+2212 minus, a trailing minus (``12,50-``) and accounting
        parentheses (``(12,50)``).
        """
        text = raw.strip()
        if not text:
            return None
        negative = False
        if text.startswith("(") and text.endswith(")"):
            negative = True
            text = text[1:-1].strip()
        text = text.replace("−", "-")
        if text.endswith("-") and not text.startswith("-"):
            negative = not negative
            text = text[:-1].strip()
        if self.thousands_separator == " ":
            text = _SPACES.sub("", text)
        elif self.thousands_separator:
            text = text.replace(self.thousands_separator, "")
        if self.decimal_separator != ".":
            if "." in text:
                raise ValueError(
                    f'Unexpected "." in a number with decimal "{self.decimal_separator}": {raw!r}'
                )
            text = text.replace(self.decimal_separator, ".")
        if not _PLAIN_NUMBER.match(text):
            raise ValueError(f"Not a number: {raw!r}")
        value = Decimal(text.removesuffix(".") if text.endswith(".") else text)
        return -value if negative else value


# Longest first, so ``MM`` wins over ``M``.
_TOKENS: tuple[str, ...] = ("yyyy", "MM", "M", "dd", "d", "HH", "H", "mm", "ss")
_TOKEN_REGEX: dict[str, str] = {
    "yyyy": r"([0-9]{4})",
    "MM": r"([0-9]{2})",
    "M": r"([0-9]{1,2})",
    "dd": r"([0-9]{2})",
    "d": r"([0-9]{1,2})",
    "HH": r"([0-9]{2})",
    "H": r"([0-9]{1,2})",
    "mm": r"([0-9]{2})",
    "ss": r"([0-9]{2})",
}
_TRAILING_TIME = re.compile(r"^([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?")


@dataclass(frozen=True, slots=True)
class DatePattern:
    """A date pattern like ``dd.MM.yyyy`` or ``yyyy-MM-dd HH:mm:ss``.

    Tokens: ``yyyy`` (4-digit year), ``MM`` / ``M`` (month), ``dd`` / ``d`` (day), ``HH`` / ``H``
    (hour), ``mm`` (minute), ``ss`` (second); every other character is a literal. The date is the calendar
    date as written; the time of day (from the time tokens, or from extra ``HH:mm[:ss]`` text after the
    pattern separated by a space or ``T``) is only kept as a same-day sort key.

    Raises ``ValueError`` unless the pattern has a year, a month and a day token.
    """

    pattern: str
    _regex: re.Pattern[str] = field(init=False, repr=False, compare=False)
    _groups: tuple[str, ...] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        parts = ["^"]
        groups: list[str] = []
        i = 0
        while i < len(self.pattern):
            token = next((t for t in _TOKENS if self.pattern.startswith(t, i)), None)
            if token is None:
                parts.append(re.escape(self.pattern[i]))
                i += 1
                continue
            parts.append(_TOKEN_REGEX[token])
            groups.append(token)
            i += len(token)
        parts.append(r"(?:[ T](.*))?$")
        has_year = "yyyy" in groups
        has_month = "MM" in groups or "M" in groups
        has_day = "dd" in groups or "d" in groups
        if not (has_year and has_month and has_day):
            raise ValueError(
                f"A date pattern needs yyyy, MM (or M) and dd (or d): {self.pattern!r}"
            )
        object.__setattr__(self, "_regex", re.compile("".join(parts), re.DOTALL))
        object.__setattr__(self, "_groups", tuple(groups))

    def try_parse(self, raw: str) -> date | None:
        """The date in ``raw``, or None when it does not match or is not a real date."""
        parsed = self.try_parse_datetime(raw)
        return None if parsed is None else parsed[0]

    def try_parse_datetime(self, raw: str) -> tuple[date, time | None] | None:
        """The date in ``raw`` and its time of day when the cell carries a valid one, or None when
        ``raw`` does not match this pattern or is not a real date."""
        match = self._regex.match(raw.strip())
        if match is None:
            return None
        values: dict[str, int] = {}
        for index, token in enumerate(self._groups):
            values[token[0]] = int(match.group(index + 1))
        try:
            day = date(values["y"], values["M"], values["d"])
        except ValueError:
            return None
        hour = values.get("H")
        minute = values.get("m")
        second = values.get("s")
        if hour is None:
            trailing = _TRAILING_TIME.match(match.group(len(self._groups) + 1) or "")
            if trailing is not None:
                hour = int(trailing.group(1))
                minute = int(trailing.group(2))
                second = int(trailing.group(3)) if trailing.group(3) else None
        return day, _time_of_day(hour, minute, second)


def _time_of_day(hour: int | None, minute: int | None, second: int | None) -> time | None:
    if hour is None or hour > 23 or (minute or 0) > 59 or (second or 0) > 59:
        return None
    return time(hour, minute or 0, second or 0)


def parse_date_with_patterns(raw: str, patterns: list[DatePattern]) -> date | None:
    """``raw`` parsed with the first matching pattern; None for a blank cell, ``ValueError`` when no
    pattern matches."""
    parsed = parse_datetime_with_patterns(raw, patterns)
    return None if parsed is None else parsed[0]


def parse_datetime_with_patterns(
    raw: str, patterns: list[DatePattern]
) -> tuple[date, time | None] | None:
    """Like :func:`parse_date_with_patterns`, also returning the time of day when the cell has one."""
    text = raw.strip()
    if not text:
        return None
    for pattern in patterns:
        parsed = pattern.try_parse_datetime(text)
        if parsed is not None:
            return parsed
    raise ValueError(f"Date does not match {' / '.join(p.pattern for p in patterns)}")


__all__ = [
    "DECIMAL_SEPARATORS",
    "THOUSANDS_SEPARATORS",
    "DatePattern",
    "DecimalFormat",
    "parse_date_with_patterns",
    "parse_datetime_with_patterns",
]
