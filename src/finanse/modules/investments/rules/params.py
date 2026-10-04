"""Typed, range-checked reading of a raw ``params:`` map (and of the strategy.yaml sections that share the
same shape: ``data``, ``contributions``, ``allocation.rebalance``, ``buckets[].match``, ``benchmark``,
``notifications``)."""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from enum import StrEnum

from finanse.modules.investments.domain import AssetClass, Currency

from .hints import did_you_mean


@dataclass(frozen=True, slots=True)
class ParamIssue:
    """One problem with a params map."""

    key: str
    """Param name or path relative to the map (``threshold``, ``tags[1]``); empty for the map itself."""
    message: str
    is_error: bool
    """Errors reject the strategy; warnings (e.g. an unknown key) are only reported."""
    offset: int | None = None
    """0-based character offset inside the value's text (an expression error), so the loader can point
    at the exact YAML column; None for the value as a whole."""


class ParamErrors:
    """Collector passed to ``RuleKind.parse_params``; the strategy loader maps keys to YAML lines."""

    def __init__(self) -> None:
        self._issues: list[ParamIssue] = []

    @property
    def issues(self) -> tuple[ParamIssue, ...]:
        return tuple(self._issues)

    @property
    def has_errors(self) -> bool:
        return any(issue.is_error for issue in self._issues)

    @property
    def error_count(self) -> int:
        return sum(1 for issue in self._issues if issue.is_error)

    def error(self, key: str, message: str) -> None:
        self._issues.append(ParamIssue(key, message, True))

    def error_at(self, key: str, message: str, offset: int) -> None:
        """An error at ``offset`` (0-based) inside the text value of ``key``."""
        self._issues.append(ParamIssue(key, message, True, offset))

    def warning(self, key: str, message: str) -> None:
        self._issues.append(ParamIssue(key, message, False))


class ParamReader:
    """Reads values out of a raw YAML-derived map and records problems in a :class:`ParamErrors`.

    Every read registers its key as known; :meth:`finish` then warns about the remaining (unknown) keys
    with a closest-known-key hint. Reads never raise: on a problem they record an error and return a
    fallback, so a caller can always build its params object (the loader discards it when any error was
    recorded). Required values (no ``fallback``) report ``<key> is required`` when missing; ``optional_*``
    reads return None. YAML ``null`` counts as missing.
    """

    def __init__(self, raw: Mapping[str, object], errors: ParamErrors) -> None:
        self.raw = raw
        self.errors = errors
        self._known: list[str] = []

    @property
    def known_keys(self) -> tuple[str, ...]:
        return tuple(self._known)

    def has(self, key: str) -> bool:
        """True when ``key`` is present with a non-null value (also marks it as known)."""
        self._mark(key)
        return self.raw.get(key) is not None

    def number(
        self,
        key: str,
        *,
        fallback: float | None = None,
        minimum: float | None = None,
        maximum: float | None = None,
        exclusive_min: bool = False,
        exclusive_max: bool = False,
    ) -> float:
        """A number (int or float). When missing: ``fallback``, or an error if there is none."""
        value = self._number(key, minimum, maximum, exclusive_min, exclusive_max, fallback is None)
        if value is not None:
            return value
        return fallback if fallback is not None else 0.0

    def optional_number(
        self,
        key: str,
        *,
        minimum: float | None = None,
        maximum: float | None = None,
        exclusive_min: bool = False,
        exclusive_max: bool = False,
    ) -> float | None:
        return self._number(key, minimum, maximum, exclusive_min, exclusive_max, False)

    def integer(
        self,
        key: str,
        *,
        fallback: int | None = None,
        minimum: int | None = None,
        maximum: int | None = None,
    ) -> int:
        """A whole number. When missing: ``fallback``, or an error if there is none."""
        value = self._integer(key, minimum, maximum, fallback is None)
        if value is not None:
            return value
        return fallback if fallback is not None else 0

    def optional_integer(
        self, key: str, *, minimum: int | None = None, maximum: int | None = None
    ) -> int | None:
        return self._integer(key, minimum, maximum, False)

    def decimal(
        self,
        key: str,
        *,
        fallback: Decimal | None = None,
        minimum: Decimal | None = None,
        exclusive_min: bool = False,
    ) -> Decimal:
        """An exact amount (YAML number or numeric text). When missing: ``fallback``, or an error."""
        self._mark(key)
        value = self.raw.get(key)
        if value is None:
            if fallback is None:
                self.errors.error(key, f"{key} is required")
            return fallback if fallback is not None else Decimal(0)
        parsed = _to_decimal(value)
        if parsed is None:
            self.errors.error(key, f"{key} must be a number, got {_show(value)}")
            return fallback if fallback is not None else Decimal(0)
        if minimum is not None and (parsed <= minimum if exclusive_min else parsed < minimum):
            relation = "greater than" if exclusive_min else "at least"
            self.errors.error(key, f"{key} must be {relation} {minimum}, got {parsed}")
            return fallback if fallback is not None else Decimal(0)
        return parsed

    def optional_string(self, key: str) -> str | None:
        """A text value, or None when missing."""
        self._mark(key)
        value = self.raw.get(key)
        if value is None:
            return None
        if isinstance(value, str):
            return value
        self.errors.error(key, f"{key} must be text, got {_show(value)}")
        return None

    def strings(self, key: str) -> tuple[str, ...]:
        """One text or a list of texts (``tags: a`` or ``tags: [a, b]``), trimmed, duplicates dropped;
        empty when missing."""
        self._mark(key)
        value = self.raw.get(key)
        if value is None:
            return ()
        items = value if isinstance(value, list) else [value]
        result: list[str] = []
        for index, item in enumerate(items):
            item_key = f"{key}[{index}]" if isinstance(value, list) else key
            if isinstance(item, str) and item.strip():
                text = item.strip()
            elif _is_number(item):
                text = str(item)
            else:
                self.errors.error(
                    item_key, f"{key} must be text or a list of texts, got {_show(item)}"
                )
                continue
            if text not in result:
                result.append(text)
        return tuple(result)

    def asset_classes(self, key: str) -> frozenset[AssetClass]:
        """One asset class or a list of them, by wire name (``treasury_bond``); empty when missing."""
        names = [value.value for value in AssetClass]
        result: set[AssetClass] = set()
        for name in self.strings(key):
            if name in names:
                result.add(AssetClass(name))
            else:
                self.errors.error(
                    key,
                    f'Unknown asset class "{name}"{did_you_mean(name, names)}; known: {", ".join(names)}',
                )
        return frozenset(result)

    def currencies(self, key: str) -> frozenset[Currency]:
        """One currency code or a list of them; empty when missing."""
        result: set[Currency] = set()
        for code in self.strings(key):
            currency = parse_currency(code)
            if currency is None:
                self.errors.error(key, f'"{code}" is not a three-letter ISO currency code')
            else:
                result.add(currency)
        return frozenset(result)

    def enum_value[E: StrEnum](self, key: str, enum: type[E], *, fallback: E) -> E:
        """One enum value by wire name, ``fallback`` when missing."""
        name = self.optional_string(key)
        if name is None:
            return fallback
        values = [member.value for member in enum]
        if name in values:
            return enum(name)
        self.errors.error(
            key,
            f'Unknown value "{name}" for {key}{did_you_mean(name, values)}; allowed: {", ".join(values)}',
        )
        return fallback

    def finish(self, also_known: Iterable[str] = ()) -> None:
        """Warns about every key that was never read (typo hint against the read keys + ``also_known``)."""
        known = [*self._known, *(key for key in also_known if key not in self._known)]
        for key in self.raw:
            if key not in known:
                self.errors.warning(
                    key, f'Unknown key "{key}"{did_you_mean(key, known)}; it is ignored'
                )

    # --- internals -----------------------------------------------------------------------------

    def _mark(self, key: str) -> None:
        if key not in self._known:
            self._known.append(key)

    def _number(
        self,
        key: str,
        minimum: float | None,
        maximum: float | None,
        exclusive_min: bool,
        exclusive_max: bool,
        required: bool,
    ) -> float | None:
        self._mark(key)
        value = self.raw.get(key)
        if value is None:
            if required:
                self.errors.error(key, f"{key} is required")
            return None
        if not _is_number(value):
            self.errors.error(key, f"{key} must be a number, got {_show(value)}")
            return None
        number = float(value)  # type: ignore[arg-type]
        if not math.isfinite(number):
            self.errors.error(key, f"{key} must be a finite number")
            return None
        problem = _range_problem(number, minimum, maximum, exclusive_min, exclusive_max)
        if problem is not None:
            hint = " (fractions: 0.15 = 15%)" if maximum == 1 and number > 1 else ""
            self.errors.error(key, f"{key} must be {problem}, got {format_number(number)}{hint}")
            return None
        return number

    def _integer(
        self, key: str, minimum: int | None, maximum: int | None, required: bool
    ) -> int | None:
        self._mark(key)
        value = self.raw.get(key)
        if value is None:
            if required:
                self.errors.error(key, f"{key} is required")
            return None
        if not isinstance(value, int) or isinstance(value, bool):
            self.errors.error(key, f"{key} must be a whole number, got {_show(value)}")
            return None
        problem = _range_problem(value, minimum, maximum, False, False)
        if problem is not None:
            self.errors.error(key, f"{key} must be {problem}, got {value}")
            return None
        return value


def parse_currency(code: str) -> Currency | None:
    """A validated currency, or None when ``code`` is not three letters."""
    try:
        return Currency(code)
    except ValueError:
        return None


def format_number(value: float) -> str:
    """``5`` for 5.0, ``0.25`` for 0.25."""
    if isinstance(value, float) and value.is_integer() and abs(value) < 1e15:
        return str(int(value))
    return str(value)


def _range_problem(
    value: float,
    minimum: float | None,
    maximum: float | None,
    exclusive_min: bool,
    exclusive_max: bool,
) -> str | None:
    too_low = minimum is not None and (value <= minimum if exclusive_min else value < minimum)
    too_high = maximum is not None and (value >= maximum if exclusive_max else value > maximum)
    if not too_low and not too_high:
        return None
    parts: list[str] = []
    if minimum is not None:
        parts.append(f"{'greater than' if exclusive_min else 'at least'} {format_number(minimum)}")
    if maximum is not None:
        parts.append(f"{'less than' if exclusive_max else 'at most'} {format_number(maximum)}")
    return " and ".join(parts)


def _is_number(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def _to_decimal(value: object) -> Decimal | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        return Decimal(repr(value)) if math.isfinite(value) else None
    if isinstance(value, str):
        try:
            parsed = Decimal(value.strip())
        except InvalidOperation:
            return None
        return parsed if parsed.is_finite() else None
    return None


def _show(value: object) -> str:
    if isinstance(value, str):
        return f'"{value}"'
    if isinstance(value, Mapping):
        return "a mapping"
    if isinstance(value, list):
        return "a list"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, date):
        return value.isoformat()
    return str(value)
