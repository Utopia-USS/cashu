"""The fixed metric catalog of custom-rule expressions: names, argument specs, types, units, scopes.

Only names listed here exist in an expression; there is no other way to reach data or code. Values are
computed in :mod:`.metrics` (one resolver per entry, checked by a test). EXPRESSIONS.md documents the same
catalog for users.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from finanse.modules.investments.domain.enums import AssetClass

from .limits import MAX_FUNCTION_ARGS, MAX_WINDOW_DAYS


class Scope(StrEnum):
    """What one evaluation of a custom rule looks at (``params.scope``)."""

    PORTFOLIO = "portfolio"
    """Once for the whole portfolio (one signal per rule)."""
    INSTRUMENT = "instrument"
    """Once per held instrument, summed across accounts (one signal per instrument)."""
    BUCKET = "bucket"
    """Once per strategy bucket (one signal per bucket)."""


class ValueType(StrEnum):
    NUMBER = "number"
    BOOLEAN = "boolean"
    TEXT = "text"


class Unit(StrEnum):
    """How a numeric metric is shown in messages."""

    RATIO = "ratio"
    """A fraction shown as a percentage (0.153 -> 15.3%)."""
    PP = "pp"
    """Percentage points (2.5 -> 2.5 pp)."""
    AMOUNT = "amount"
    """Base-currency amount (shown in whole units)."""
    PRICE = "price"
    """A price in the instrument's currency."""
    DAYS = "days"
    COUNT = "count"
    TEXT = "text"
    FLAG = "flag"


@dataclass(frozen=True, slots=True)
class ArgSpec:
    """One argument of a metric function. Arguments must be literals."""

    name: str
    type: ValueType
    minimum: int | None = None
    maximum: int | None = None
    choices: tuple[str, ...] | None = None
    reference: str | None = None
    """``bucket`` when the argument names a strategy bucket (cross-checked by the strategy loader)."""
    variadic: bool = False
    """The last argument may repeat (1 to MAX_FUNCTION_ARGS values)."""


@dataclass(frozen=True, slots=True)
class MetricSpec:
    name: str
    type: ValueType
    unit: Unit
    scopes: frozenset[Scope]
    doc: str
    args: tuple[ArgSpec, ...] | None = None
    """None for a variable; a tuple (possibly empty) for a function."""
    choices: tuple[str, ...] | None = None
    """Allowed values of a TEXT variable (literals compared with it are checked against them)."""

    @property
    def is_function(self) -> bool:
        return self.args is not None

    def signature(self) -> str:
        if self.args is None:
            return self.name
        parts = [f"{arg.name}, ..." if arg.variadic else arg.name for arg in self.args]
        return f"{self.name}({', '.join(parts)})"


ALL_SCOPES = frozenset(Scope)
_INSTRUMENT = frozenset({Scope.INSTRUMENT})
_BUCKET = frozenset({Scope.BUCKET})

ASSET_CLASS_NAMES = tuple(value.value for value in AssetClass)

_WINDOW = ArgSpec("window_days", ValueType.NUMBER, minimum=2, maximum=MAX_WINDOW_DAYS)
_BUCKET_ARG = ArgSpec("bucket", ValueType.TEXT, reference="bucket")

_SPECS: tuple[MetricSpec, ...] = (
    # --- portfolio metrics (every scope) -------------------------------------------------------
    MetricSpec(
        "total_value",
        ValueType.NUMBER,
        Unit.AMOUNT,
        ALL_SCOPES,
        "Portfolio value in the base currency (holdings + cash).",
    ),
    MetricSpec(
        "cash_value",
        ValueType.NUMBER,
        Unit.AMOUNT,
        ALL_SCOPES,
        "Cash balances plus cash-like instruments (asset_class cash), base currency.",
    ),
    MetricSpec(
        "cash_weight",
        ValueType.NUMBER,
        Unit.RATIO,
        ALL_SCOPES,
        "cash_value / total_value (same definition as the cash_level rule).",
    ),
    MetricSpec(
        "stale_weight",
        ValueType.NUMBER,
        Unit.RATIO,
        ALL_SCOPES,
        "Share of the portfolio valued with stale prices.",
    ),
    MetricSpec(
        "unclassified_weight",
        ValueType.NUMBER,
        Unit.RATIO,
        ALL_SCOPES,
        "Share of the portfolio in holdings that match no strategy bucket.",
    ),
    MetricSpec(
        "max_position_weight",
        ValueType.NUMBER,
        Unit.RATIO,
        ALL_SCOPES,
        "Weight of the largest instrument position (cash-like instruments excluded).",
    ),
    MetricSpec(
        "holdings_count",
        ValueType.NUMBER,
        Unit.COUNT,
        ALL_SCOPES,
        "Number of distinct instruments held (cash-like instruments excluded).",
    ),
    MetricSpec(
        "days_since_last_deposit",
        ValueType.NUMBER,
        Unit.DAYS,
        ALL_SCOPES,
        "Calendar days since the newest deposit in any account.",
    ),
    MetricSpec(
        "monthly_contribution",
        ValueType.NUMBER,
        Unit.AMOUNT,
        ALL_SCOPES,
        "contributions.monthly_amount from the strategy.",
    ),
    MetricSpec(
        "bucket_weight",
        ValueType.NUMBER,
        Unit.RATIO,
        ALL_SCOPES,
        "Current weight of a bucket.",
        args=(_BUCKET_ARG,),
    ),
    MetricSpec(
        "bucket_target",
        ValueType.NUMBER,
        Unit.RATIO,
        ALL_SCOPES,
        "Target weight of a bucket (allocation.targets).",
        args=(_BUCKET_ARG,),
    ),
    MetricSpec(
        "bucket_drift_pp",
        ValueType.NUMBER,
        Unit.PP,
        ALL_SCOPES,
        "Bucket weight minus target in percentage points (positive = overweight).",
        args=(_BUCKET_ARG,),
    ),
    MetricSpec(
        "bucket_value",
        ValueType.NUMBER,
        Unit.AMOUNT,
        ALL_SCOPES,
        "Value of a bucket in the base currency.",
        args=(_BUCKET_ARG,),
    ),
    MetricSpec(
        "tagged_weight",
        ValueType.NUMBER,
        Unit.RATIO,
        ALL_SCOPES,
        "Summed weight of holdings that carry ALL the given tags.",
        args=(ArgSpec("tag", ValueType.TEXT, variadic=True),),
    ),
    MetricSpec(
        "asset_class_weight",
        ValueType.NUMBER,
        Unit.RATIO,
        ALL_SCOPES,
        "Summed weight of holdings of one asset class (cash also counts cash balances).",
        args=(ArgSpec("asset_class", ValueType.TEXT, choices=ASSET_CLASS_NAMES),),
    ),
    # --- instrument scope ----------------------------------------------------------------------
    MetricSpec(
        "symbol",
        ValueType.TEXT,
        Unit.TEXT,
        _INSTRUMENT,
        "Ticker symbol (or the name when there is no symbol).",
    ),
    MetricSpec(
        "asset_class",
        ValueType.TEXT,
        Unit.TEXT,
        _INSTRUMENT,
        'Asset class wire name, e.g. "etf".',
        choices=ASSET_CLASS_NAMES,
    ),
    MetricSpec("currency", ValueType.TEXT, Unit.TEXT, _INSTRUMENT, 'Trading currency, e.g. "USD".'),
    MetricSpec("mic", ValueType.TEXT, Unit.TEXT, _INSTRUMENT, 'Exchange code, e.g. "XWAR".'),
    MetricSpec(
        "weight",
        ValueType.NUMBER,
        Unit.RATIO,
        _INSTRUMENT | _BUCKET,
        "Instrument scope: the instrument's weight across accounts. Bucket scope: the bucket's weight.",
    ),
    MetricSpec(
        "market_value",
        ValueType.NUMBER,
        Unit.AMOUNT,
        _INSTRUMENT,
        "Market value across accounts, base currency.",
    ),
    MetricSpec(
        "cost_basis",
        ValueType.NUMBER,
        Unit.AMOUNT,
        _INSTRUMENT,
        "Cost basis across accounts, base currency at trade-date FX.",
    ),
    MetricSpec(
        "unrealized_pct",
        ValueType.NUMBER,
        Unit.RATIO,
        _INSTRUMENT,
        "(market_value - cost_basis) / cost_basis; -0.25 = down 25% from cost.",
    ),
    MetricSpec(
        "unrealized_value",
        ValueType.NUMBER,
        Unit.AMOUNT,
        _INSTRUMENT,
        "market_value - cost_basis, base currency.",
    ),
    MetricSpec(
        "last_close",
        ValueType.NUMBER,
        Unit.PRICE,
        _INSTRUMENT,
        "Newest close in the instrument's currency.",
    ),
    MetricSpec(
        "drawdown_from_high",
        ValueType.NUMBER,
        Unit.RATIO,
        _INSTRUMENT,
        "1 - last close / highest close of the last window_days bars (0.15 = 15% below the high).",
        args=(_WINDOW,),
    ),
    MetricSpec(
        "price_change",
        ValueType.NUMBER,
        Unit.RATIO,
        _INSTRUMENT,
        "last close / first close of the last window_days bars - 1 (0.1 = up 10%).",
        args=(_WINDOW,),
    ),
    MetricSpec(
        "price_vs_sma",
        ValueType.NUMBER,
        Unit.RATIO,
        _INSTRUMENT,
        "last close / average close of the last window_days bars - 1 (negative = below the average).",
        args=(_WINDOW,),
    ),
    MetricSpec(
        "holding_has_tag",
        ValueType.BOOLEAN,
        Unit.FLAG,
        _INSTRUMENT,
        "True when the instrument carries the tag.",
        args=(ArgSpec("tag", ValueType.TEXT),),
    ),
    # --- bucket scope --------------------------------------------------------------------------
    MetricSpec(
        "bucket_id", ValueType.TEXT, Unit.TEXT, _BUCKET, "Id of the bucket being evaluated."
    ),
    MetricSpec("target", ValueType.NUMBER, Unit.RATIO, _BUCKET, "Target weight of the bucket."),
    MetricSpec(
        "drift_pp",
        ValueType.NUMBER,
        Unit.PP,
        _BUCKET,
        "weight - target in percentage points (positive = overweight).",
    ),
    MetricSpec(
        "drift_rel",
        ValueType.NUMBER,
        Unit.RATIO,
        _BUCKET,
        "(weight - target) / target; unknown when the target is 0.",
    ),
    MetricSpec("value", ValueType.NUMBER, Unit.AMOUNT, _BUCKET, "Bucket value, base currency."),
    MetricSpec(
        "drift_value",
        ValueType.NUMBER,
        Unit.AMOUNT,
        _BUCKET,
        "value - target x total_value: positive = above target (to sell), negative = to buy.",
    ),
)

METRICS: dict[str, MetricSpec] = {spec.name: spec for spec in _SPECS}
"""Every metric by name, in documentation order."""

assert len(METRICS) == len(_SPECS), "duplicate metric names"
assert all(spec.args is None or len(spec.args) <= MAX_FUNCTION_ARGS for spec in _SPECS), (
    "too many declared arguments"
)


def names_in_scope(scope: Scope) -> list[str]:
    """Metric names usable in ``scope``, in documentation order."""
    return [spec.name for spec in _SPECS if scope in spec.scopes]
