"""The fixed alert catalog: kinds, their params, the scopes they apply to, and validation with clear,
fixable error messages. Pure: no IO. Alerts are conditions on hard data (prices, weights, the strategy
expression language), never price predictions.

| kind | scope | params |
|---|---|---|
| ``price_above`` / ``price_below`` | instrument | ``level`` (> 0, in the instrument's currency) |
| ``change_pct`` | instrument | ``window_days`` (sessions), ``threshold`` (fraction), ``direction`` up / down / any |
| ``drawdown_from_high`` | instrument | ``window_days`` (default 252), ``threshold`` (0 < t < 1) |
| ``new_high`` | instrument | ``window_days`` (default 252) |
| ``sma_cross`` | instrument | ``window_days`` (default 200), ``direction`` above / below |
| ``weight_above`` / ``weight_below`` | instrument or bucket | ``threshold`` (0 < t <= 1), ``bucket`` for scope bucket |
| ``custom`` | instrument, portfolio or bucket | ``expression`` (EXPRESSIONS.md), ``bucket`` for scope bucket |

``window_days`` counts daily bars (trading sessions), like the ``drawdown_from_high`` rule; the daily
refresh keeps about 400 calendar days, so windows are capped at :data:`MAX_WINDOW_DAYS`.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum

from ..rules.expr import ExpressionError, Scope, compile_expression
from ..rules.hints import did_you_mean
from ..rules.params import ParamErrors, ParamReader


class AlertKind(StrEnum):
    PRICE_ABOVE = "price_above"
    PRICE_BELOW = "price_below"
    CHANGE_PCT = "change_pct"
    DRAWDOWN_FROM_HIGH = "drawdown_from_high"
    NEW_HIGH = "new_high"
    SMA_CROSS = "sma_cross"
    WEIGHT_ABOVE = "weight_above"
    WEIGHT_BELOW = "weight_below"
    CUSTOM = "custom"


class AlertScope(StrEnum):
    INSTRUMENT = "instrument"
    PORTFOLIO = "portfolio"
    BUCKET = "bucket"


class AlertStatus(StrEnum):
    ACTIVE = "active"
    """Evaluated by the daily check."""
    TRIGGERED = "triggered"
    """Its condition holds: its signal is open (still evaluated; back to active when it clears)."""
    SNOOZED = "snoozed"
    """Not evaluated until ``snoozed_until``, then active again."""
    MUTED = "muted"
    """Not evaluated until unmuted."""
    EXPIRED = "expired"
    """``expires_at`` passed; kept as history."""


EVALUATED_STATUSES = (AlertStatus.ACTIVE, AlertStatus.TRIGGERED)
LIVE_STATUSES = (AlertStatus.ACTIVE, AlertStatus.TRIGGERED, AlertStatus.SNOOZED)
"""Statuses that count towards the agent cap (an alert that can still fire)."""


class AlertSource(StrEnum):
    USER = "user"
    AGENT = "agent"


MAX_WINDOW_DAYS = 260
"""Longest window in sessions (about one year of bars; the refresh keeps ~400 calendar days)."""
MAX_CHANGE_THRESHOLD = 10.0
"""``change_pct`` threshold as a fraction (10 = 1000%)."""
MAX_TITLE_LENGTH = 120
MAX_NOTE_LENGTH = 2000
MAX_EXPRESSION_LENGTH = 2000
MAX_COOLDOWN_DAYS = 3650
MAX_EXPIRY_DAYS = 3650

PRICE_KINDS = (
    AlertKind.PRICE_ABOVE,
    AlertKind.PRICE_BELOW,
    AlertKind.CHANGE_PCT,
    AlertKind.DRAWDOWN_FROM_HIGH,
    AlertKind.NEW_HIGH,
    AlertKind.SMA_CROSS,
)
"""Kinds that read one instrument's price series (scope instrument only)."""
WEIGHT_KINDS = (AlertKind.WEIGHT_ABOVE, AlertKind.WEIGHT_BELOW)


@dataclass(frozen=True, slots=True)
class ParamInfo:
    """One param of a kind, for forms and the agent (``GET .../alert-kinds``)."""

    name: str
    type: str  # number | integer | text | choice
    required: bool
    doc: str
    default: object = None
    minimum: float | None = None
    maximum: float | None = None
    choices: tuple[str, ...] = ()

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "type": self.type,
            "required": self.required,
            "doc": self.doc,
            "default": self.default,
            "minimum": self.minimum,
            "maximum": self.maximum,
            "choices": list(self.choices),
        }


@dataclass(frozen=True, slots=True)
class KindInfo:
    kind: AlertKind
    scopes: tuple[AlertScope, ...]
    doc: str
    unit: str
    """Unit of the measured value: ``price`` (instrument currency), ``ratio`` (fraction) or ``none``."""
    params: tuple[ParamInfo, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict:
        return {
            "kind": self.kind.value,
            "scopes": [s.value for s in self.scopes],
            "doc": self.doc,
            "unit": self.unit,
            "params": [p.to_dict() for p in self.params],
        }


_WINDOW = "trading sessions (daily bars), including the last one"
_BUCKET = ParamInfo("bucket", "text", False, "strategy bucket id (scope bucket only)")

CATALOG: dict[AlertKind, KindInfo] = {
    AlertKind.PRICE_ABOVE: KindInfo(
        AlertKind.PRICE_ABOVE,
        (AlertScope.INSTRUMENT,),
        "The last close is above a level.",
        "price",
        (
            ParamInfo(
                "level", "number", True, "price level in the instrument's currency", minimum=0
            ),
        ),
    ),
    AlertKind.PRICE_BELOW: KindInfo(
        AlertKind.PRICE_BELOW,
        (AlertScope.INSTRUMENT,),
        "The last close is below a level.",
        "price",
        (
            ParamInfo(
                "level", "number", True, "price level in the instrument's currency", minimum=0
            ),
        ),
    ),
    AlertKind.CHANGE_PCT: KindInfo(
        AlertKind.CHANGE_PCT,
        (AlertScope.INSTRUMENT,),
        "The close moved by at least threshold over window_days sessions.",
        "ratio",
        (
            ParamInfo("window_days", "integer", True, _WINDOW, minimum=1, maximum=MAX_WINDOW_DAYS),
            ParamInfo(
                "threshold",
                "number",
                True,
                "size of the move as a fraction (0.1 = 10%)",
                minimum=0,
                maximum=MAX_CHANGE_THRESHOLD,
            ),
            ParamInfo(
                "direction",
                "choice",
                False,
                "up, down or any",
                "any",
                choices=("up", "down", "any"),
            ),
        ),
    ),
    AlertKind.DRAWDOWN_FROM_HIGH: KindInfo(
        AlertKind.DRAWDOWN_FROM_HIGH,
        (AlertScope.INSTRUMENT,),
        "The last close is at least threshold below the highest close of the window.",
        "ratio",
        (
            ParamInfo("window_days", "integer", False, _WINDOW, 252, 2, MAX_WINDOW_DAYS),
            ParamInfo(
                "threshold", "number", True, "drop from the high (0.15 = 15%)", minimum=0, maximum=1
            ),
        ),
    ),
    AlertKind.NEW_HIGH: KindInfo(
        AlertKind.NEW_HIGH,
        (AlertScope.INSTRUMENT,),
        "The last close is above every other close of the window.",
        "price",
        (ParamInfo("window_days", "integer", False, _WINDOW, 252, 2, MAX_WINDOW_DAYS),),
    ),
    AlertKind.SMA_CROSS: KindInfo(
        AlertKind.SMA_CROSS,
        (AlertScope.INSTRUMENT,),
        "The last close is above (or below) the simple moving average of the window: the signal "
        "opens on the cross and resolves when the price crosses back.",
        "price",
        (
            ParamInfo("window_days", "integer", False, _WINDOW, 200, 2, MAX_WINDOW_DAYS),
            ParamInfo("direction", "choice", True, "above or below", choices=("above", "below")),
        ),
    ),
    AlertKind.WEIGHT_ABOVE: KindInfo(
        AlertKind.WEIGHT_ABOVE,
        (AlertScope.INSTRUMENT, AlertScope.BUCKET),
        "The instrument's (or bucket's) share of the portfolio is above threshold.",
        "ratio",
        (
            ParamInfo("threshold", "number", True, "weight as a fraction (0.3 = 30%)", None, 0, 1),
            _BUCKET,
        ),
    ),
    AlertKind.WEIGHT_BELOW: KindInfo(
        AlertKind.WEIGHT_BELOW,
        (AlertScope.INSTRUMENT, AlertScope.BUCKET),
        "The instrument's (or bucket's) share of the portfolio is below threshold (an instrument "
        "that is not held weighs 0).",
        "ratio",
        (
            ParamInfo("threshold", "number", True, "weight as a fraction (0.3 = 30%)", None, 0, 1),
            _BUCKET,
        ),
    ),
    AlertKind.CUSTOM: KindInfo(
        AlertKind.CUSTOM,
        (AlertScope.INSTRUMENT, AlertScope.PORTFOLIO, AlertScope.BUCKET),
        "A condition in the strategy expression language (EXPRESSIONS.md), evaluated for the "
        "instrument (held positions only), a bucket or the portfolio.",
        "none",
        (
            ParamInfo("expression", "text", True, 'e.g. "weight > 10%" or "cash_weight >= 5%"'),
            _BUCKET,
        ),
    ),
}

KINDS = tuple(k.value for k in AlertKind)


class AlertValidationError(ValueError):
    """Invalid alert input. ``issues`` are ``(field, message)`` pairs; ``str()`` joins them."""

    def __init__(self, issues: list[tuple[str, str]]) -> None:
        self.issues = issues
        super().__init__("; ".join(f"{key}: {msg}" if key else msg for key, msg in issues))


@dataclass(frozen=True, slots=True)
class ValidatedAlert:
    kind: AlertKind
    scope: AlertScope
    params: dict
    """Normalized params (defaults filled, numbers as JSON numbers)."""
    bucket_refs: tuple[str, ...] = ()
    """Strategy bucket ids the alert names (``bucket`` + bucket literals of a custom expression)."""


def parse_kind(kind: object) -> AlertKind:
    if not isinstance(kind, str) or not kind.strip():
        raise AlertValidationError([("kind", f"kind is required; known: {', '.join(KINDS)}")])
    name = kind.strip()
    if name not in KINDS:
        raise AlertValidationError(
            [
                (
                    "kind",
                    f'Unknown alert kind "{name}"{did_you_mean(name, KINDS)}; known: {", ".join(KINDS)}',
                )
            ]
        )
    return AlertKind(name)


def _scope(
    kind: AlertKind, scope: object, has_instrument: bool, has_bucket: bool, issues: list
) -> AlertScope:
    info = CATALOG[kind]
    allowed = ", ".join(s.value for s in info.scopes)
    if scope is None or scope == "":
        if has_instrument:
            chosen = AlertScope.INSTRUMENT
        elif has_bucket:
            chosen = AlertScope.BUCKET
        elif AlertScope.PORTFOLIO in info.scopes:
            chosen = AlertScope.PORTFOLIO
        else:
            chosen = info.scopes[0]
    elif isinstance(scope, str) and scope in [s.value for s in AlertScope]:
        chosen = AlertScope(scope)
    else:
        names = [s.value for s in AlertScope]
        issues.append(
            (
                "scope",
                f'Unknown scope "{scope}"{did_you_mean(str(scope), names)}; allowed: {allowed}',
            )
        )
        return info.scopes[0]
    if chosen not in info.scopes:
        issues.append(
            ("scope", f"{kind.value} alerts apply to scope {allowed}, not {chosen.value}")
        )
        return chosen
    if chosen == AlertScope.INSTRUMENT and not has_instrument:
        hint = " (add it to the watchlist first if it is not held)" if kind in PRICE_KINDS else ""
        issues.append(("instrument", f"{kind.value} alerts need an instrument{hint}"))
    if chosen != AlertScope.INSTRUMENT and has_instrument:
        issues.append(("instrument", f"scope {chosen.value} takes no instrument"))
    if chosen == AlertScope.BUCKET and not has_bucket:
        issues.append(("params.bucket", "scope bucket needs params.bucket (a strategy bucket id)"))
    if chosen != AlertScope.BUCKET and has_bucket:
        issues.append(("params.bucket", "bucket only applies to scope bucket"))
    return chosen


def validate(
    kind: object,
    params: Mapping[str, object] | None,
    *,
    scope: object = None,
    has_instrument: bool,
) -> ValidatedAlert:
    """Checks ``kind`` against the catalog and its ``params`` (unknown keys are errors, with a
    did-you-mean hint); infers the scope when not given (instrument when one is given, bucket when
    ``params.bucket`` is, else portfolio for ``custom``). Raises :class:`AlertValidationError`."""
    alert_kind = parse_kind(kind)
    if params is None:
        params = {}
    if not isinstance(params, Mapping):
        raise AlertValidationError([("params", "params must be an object")])
    issues: list[tuple[str, str]] = []
    errors = ParamErrors()
    reader = ParamReader(params, errors)
    has_bucket = reader.has("bucket")
    chosen = _scope(alert_kind, scope, has_instrument, has_bucket, issues)
    out: dict[str, object] = {}
    refs: list[str] = []

    match alert_kind:
        case AlertKind.PRICE_ABOVE | AlertKind.PRICE_BELOW:
            out["level"] = reader.number("level", minimum=0, exclusive_min=True)
        case AlertKind.CHANGE_PCT:
            out["window_days"] = reader.integer("window_days", minimum=1, maximum=MAX_WINDOW_DAYS)
            out["threshold"] = reader.number(
                "threshold", minimum=0, maximum=MAX_CHANGE_THRESHOLD, exclusive_min=True
            )
            out["direction"] = _choice(reader, "direction", ("up", "down", "any"), "any")
        case AlertKind.DRAWDOWN_FROM_HIGH:
            out["window_days"] = reader.integer(
                "window_days", fallback=252, minimum=2, maximum=MAX_WINDOW_DAYS
            )
            out["threshold"] = reader.number(
                "threshold", minimum=0, maximum=1, exclusive_min=True, exclusive_max=True
            )
        case AlertKind.NEW_HIGH:
            out["window_days"] = reader.integer(
                "window_days", fallback=252, minimum=2, maximum=MAX_WINDOW_DAYS
            )
        case AlertKind.SMA_CROSS:
            out["window_days"] = reader.integer(
                "window_days", fallback=200, minimum=2, maximum=MAX_WINDOW_DAYS
            )
            out["direction"] = _choice(reader, "direction", ("above", "below"), None)
        case AlertKind.WEIGHT_ABOVE | AlertKind.WEIGHT_BELOW:
            out["threshold"] = reader.number("threshold", minimum=0, maximum=1, exclusive_min=True)
        case AlertKind.CUSTOM:
            expression = reader.optional_string("expression")
            if expression is None or not expression.strip():
                if not errors.has_errors:
                    errors.error("expression", 'expression is required: e.g. "weight > 10%"')
            elif len(expression) > MAX_EXPRESSION_LENGTH:
                errors.error(
                    "expression", f"expression is too long (max {MAX_EXPRESSION_LENGTH} characters)"
                )
            else:
                try:
                    compiled = compile_expression(expression, Scope(chosen.value))
                except ExpressionError as error:
                    errors.error(
                        "expression", f"{error.message} (column {error.column} of the expression)"
                    )
                else:
                    out["expression"] = compiled.normalized
                    refs.extend(bucket for bucket, _ in compiled.bucket_references)
    if has_bucket:
        bucket = reader.optional_string("bucket")
        if bucket is not None and bucket.strip():
            out["bucket"] = bucket.strip()
            refs.insert(0, bucket.strip())
        elif bucket is not None:
            errors.error("bucket", "bucket must not be empty")
    reader.finish()
    for issue in errors.issues:
        # Unknown keys are warnings in strategy.yaml; an alert is short, so they are errors here.
        message = issue.message.replace("; it is ignored", "")
        issues.append((f"params.{issue.key}" if issue.key else "params", message))
    if issues:
        raise AlertValidationError(issues)
    return ValidatedAlert(alert_kind, chosen, out, tuple(dict.fromkeys(refs)))


def _choice(reader: ParamReader, key: str, allowed: tuple[str, ...], fallback: str | None) -> str:
    value = reader.optional_string(key)
    if value is None:
        if fallback is None and not reader.has(key):
            reader.errors.error(key, f"{key} is required: {' or '.join(allowed)}")
        return fallback or allowed[0]
    value = value.strip().lower()
    if value not in allowed:
        reader.errors.error(
            key,
            f'Unknown {key} "{value}"{did_you_mean(value, allowed)}; allowed: {", ".join(allowed)}',
        )
        return fallback or allowed[0]
    return value


def validate_text(
    title: object, note: object, issues: list[tuple[str, str]] | None = None
) -> tuple[str, str | None]:
    """A required one-line title (<= MAX_TITLE_LENGTH) and an optional note."""
    found = issues if issues is not None else []
    clean_title = title.strip() if isinstance(title, str) else ""
    if not clean_title:
        found.append(("title", 'title is required (a short name, e.g. "VWCE below 100")'))
    elif len(clean_title) > MAX_TITLE_LENGTH or "\n" in clean_title:
        found.append(("title", f"title must be one line of at most {MAX_TITLE_LENGTH} characters"))
    clean_note: str | None = None
    if note is not None:
        if not isinstance(note, str):
            found.append(("note", "note must be text"))
        elif len(note) > MAX_NOTE_LENGTH:
            found.append(("note", f"note is too long (max {MAX_NOTE_LENGTH} characters)"))
        else:
            clean_note = note.strip() or None
    if issues is None and found:
        raise AlertValidationError(found)
    return clean_title, clean_note


def catalog_dicts() -> list[dict]:
    """The catalog for forms and the agent."""
    return [info.to_dict() for info in CATALOG.values()]
