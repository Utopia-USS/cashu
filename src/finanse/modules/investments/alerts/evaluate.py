"""Alert evaluation: one alert against stored prices and the valued portfolio -> one outcome, with the
same meaning as rule outcomes (``Fired`` opens or refreshes the alert's signal, ``NotFired`` lets it
resolve, ``Skipped`` leaves it untouched). Pure: no IO, no clock; deterministic English messages.

Data rules (like the built-in rules): a price alert never fires on a missing or stale close (older than
``max_price_age_days``) or on too short a series; weight alerts skip while portfolio weights are
unreliable; ``custom`` uses the strategy expression language with its three-valued logic.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from decimal import Decimal

from ..domain import (
    AssetClass,
    CalendarDate,
    Instrument,
    InstrumentId,
    PriceBar,
    SignalSeverity,
    days_between,
)
from ..rules import (
    CustomParams,
    CustomRule,
    Fired,
    InstrumentFilter,
    NotFired,
    RuleContext,
    RuleOutcome,
    RuleSpec,
    SignalCandidate,
    SignalPolarity,
    Skipped,
)
from ..rules.expr import Scope, compile_expression
from ..rules.kinds.support import (
    RATIO_EPSILON,
    InstrumentPosition,
    decimal_text,
    format_pct,
    portfolio_data_problem,
    unclassified_problem,
)
from .catalog import AlertKind, AlertScope

ALERT_PREFIX = "alert:"


def alert_rule_id(alert_id: int | str) -> str:
    """Rule id and dedup key of an alert's signal (strategy rule ids cannot contain ``:``)."""
    return f"{ALERT_PREFIX}{alert_id}"


def alert_signal_kind(kind: str) -> str:
    return f"{ALERT_PREFIX}{kind}"


def is_alert_key(value: str | None) -> bool:
    """True for the rule id / dedup key / kind of an alert signal."""
    return bool(value) and value.startswith(ALERT_PREFIX)


def alert_id_of(value: str | None) -> int | None:
    """The alert id in an alert signal's rule id (``alert:12`` -> 12)."""
    if not is_alert_key(value):
        return None
    rest = value[len(ALERT_PREFIX) :]
    return int(rest) if rest.isdigit() else None


@dataclass(frozen=True, slots=True)
class AlertDefinition:
    """What evaluation needs from a stored alert."""

    id: int | str
    kind: AlertKind
    scope: AlertScope
    params: Mapping[str, object]
    title: str
    polarity: SignalPolarity = SignalPolarity.NEUTRAL
    severity: SignalSeverity = SignalSeverity.INFO
    instrument: Instrument | None = None

    @property
    def rule_id(self) -> str:
        return alert_rule_id(self.id)


@dataclass(frozen=True, slots=True)
class AlertData:
    """Inputs of one profile's alert evaluation as of one date."""

    as_of: CalendarDate
    bars: Mapping[InstrumentId, Sequence[PriceBar]]
    """Price series per instrument, oldest first, up to ``as_of``."""
    max_price_age_days: int = 5
    ctx: RuleContext | None = None
    """The profile's valued portfolio (weights, buckets, custom metrics); None when unavailable."""


@dataclass(frozen=True, slots=True)
class AlertCheck:
    outcome: RuleOutcome
    value: Decimal | None = None
    """The measured value (a price for price kinds, a fraction for change / drawdown / weight)."""


def evaluate_alert(alert: AlertDefinition, data: AlertData) -> AlertCheck:
    """One alert's outcome; a failure inside becomes a Skipped outcome (never fires, never resolves)."""
    try:
        return _evaluate(alert, data)
    except Exception as error:  # noqa: BLE001 - one broken alert never aborts the run
        return AlertCheck(Skipped(alert.rule_id, f"Alert failed: {type(error).__name__}: {error}"))


def _evaluate(alert: AlertDefinition, data: AlertData) -> AlertCheck:
    match alert.kind:
        case AlertKind.PRICE_ABOVE | AlertKind.PRICE_BELOW:
            return _price_level(alert, data)
        case AlertKind.CHANGE_PCT:
            return _change_pct(alert, data)
        case AlertKind.DRAWDOWN_FROM_HIGH:
            return _drawdown(alert, data)
        case AlertKind.NEW_HIGH:
            return _new_high(alert, data)
        case AlertKind.SMA_CROSS:
            return _sma_cross(alert, data)
        case AlertKind.WEIGHT_ABOVE | AlertKind.WEIGHT_BELOW:
            return _weight(alert, data)
        case AlertKind.CUSTOM:
            return _custom(alert, data)
    raise AssertionError(f"unknown alert kind {alert.kind}")  # pragma: no cover


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _label(instrument: Instrument) -> str:
    return instrument.symbol or instrument.name


def _price(value: Decimal) -> str:
    return decimal_text(value)


def _skip(alert: AlertDefinition, reason: str) -> AlertCheck:
    return AlertCheck(Skipped(alert.rule_id, reason))


def _not_fired(alert: AlertDefinition, details: dict, value: Decimal | None) -> AlertCheck:
    return AlertCheck(NotFired(alert.rule_id, alert.rule_id, details), value)


def _fired(alert: AlertDefinition, detail: str, payload: dict, value: Decimal | None) -> AlertCheck:
    instrument = alert.instrument
    candidate = SignalCandidate(
        rule_id=alert.rule_id,
        kind=alert_signal_kind(alert.kind.value),
        dedup_key=alert.rule_id,
        severity=alert.severity,
        message=f"{alert.title}: {detail}",
        instrument_id=instrument.id if instrument is not None else None,
        payload=payload,
        polarity=alert.polarity,
    )
    return AlertCheck(Fired(candidate), value)


def _base_payload(alert: AlertDefinition) -> dict:
    payload: dict[str, object] = {
        "alert_id": alert.id,
        "alert_kind": alert.kind.value,
        "title": alert.title,
        "scope": alert.scope.value,
    }
    if alert.instrument is not None:
        payload["instrument_id"] = alert.instrument.id
        payload["symbol"] = alert.instrument.symbol
    return payload


def _series(alert: AlertDefinition, data: AlertData, needed: int) -> Sequence[PriceBar] | str:
    """The last ``needed`` bars (oldest first) or why the alert cannot be judged."""
    instrument = alert.instrument
    if instrument is None:
        return "The alert has no instrument"
    label = _label(instrument)
    if not instrument.fetches_market_data:
        return f"{label} is {instrument.status.value}, so it has no current market prices"
    bars = [b for b in data.bars.get(instrument.id, ()) if b.date <= data.as_of]
    if not bars:
        return f"No prices for {label} yet (the daily check fetches them)"
    last = bars[-1]
    age = days_between(last.date, data.as_of)
    if age > data.max_price_age_days:
        return f"Price of {label} is stale (last close {last.date}, {age} days old)"
    if len(bars) < needed:
        return f"Only {len(bars)} daily closes of {label} are stored ({needed} needed)"
    window = bars[-needed:]
    if any(b.close <= 0 for b in window):
        return f"{label} has a non-positive close in the window"
    return window


def _currency(instrument: Instrument | None, bar: PriceBar) -> str:
    return str(bar.currency or (instrument.currency if instrument else ""))


# --------------------------------------------------------------------------- #
# Price kinds
# --------------------------------------------------------------------------- #


def _price_level(alert: AlertDefinition, data: AlertData) -> AlertCheck:
    window = _series(alert, data, 1)
    if isinstance(window, str):
        return _skip(alert, window)
    last = window[-1]
    level = Decimal(str(alert.params["level"]))
    above = alert.kind == AlertKind.PRICE_ABOVE
    hit = last.close > level if above else last.close < level
    payload = {
        **_base_payload(alert),
        "close": _price(last.close),
        "level": _price(level),
        "price_date": last.date.isoformat(),
        "currency": _currency(alert.instrument, last),
        "unit": "price",
    }
    if not hit:
        return _not_fired(alert, payload, last.close)
    cur = _currency(alert.instrument, last)
    detail = (
        f"{_label(alert.instrument)} closed at {_price(last.close)} {cur} on {last.date}, "
        f"{'above' if above else 'below'} {_price(level)} {cur}."
    )
    return _fired(alert, detail, payload, last.close)


def _change_pct(alert: AlertDefinition, data: AlertData) -> AlertCheck:
    window_days = int(alert.params["window_days"])
    window = _series(alert, data, window_days + 1)
    if isinstance(window, str):
        return _skip(alert, window)
    first, last = window[0], window[-1]
    change = last.close / first.close - 1
    threshold = Decimal(str(alert.params["threshold"]))
    direction = str(alert.params.get("direction", "any"))
    eps = Decimal(str(RATIO_EPSILON))
    if direction == "up":
        hit = change >= threshold - eps
    elif direction == "down":
        hit = change <= -threshold + eps
    else:
        hit = abs(change) >= threshold - eps
    payload = {
        **_base_payload(alert),
        "change": float(change),
        "threshold": float(threshold),
        "direction": direction,
        "window_days": window_days,
        "from_close": _price(first.close),
        "from_date": first.date.isoformat(),
        "close": _price(last.close),
        "price_date": last.date.isoformat(),
        "unit": "ratio",
    }
    if not hit:
        return _not_fired(alert, payload, change)
    verb = "rose" if change > 0 else "fell"
    detail = (
        f"{_label(alert.instrument)} {verb} {format_pct(float(abs(change)))} over {window_days} "
        f"sessions ({_price(first.close)} on {first.date} -> {_price(last.close)} on {last.date})."
    )
    return _fired(alert, detail, payload, change)


def _drawdown(alert: AlertDefinition, data: AlertData) -> AlertCheck:
    window_days = int(alert.params["window_days"])
    window = _series(alert, data, window_days)
    if isinstance(window, str):
        return _skip(alert, window)
    last = window[-1]
    high = max(window, key=lambda b: b.close)
    drawdown = (high.close - last.close) / high.close
    threshold = Decimal(str(alert.params["threshold"]))
    payload = {
        **_base_payload(alert),
        "drawdown": float(drawdown),
        "threshold": float(threshold),
        "window_days": window_days,
        "high": _price(high.close),
        "high_date": high.date.isoformat(),
        "close": _price(last.close),
        "price_date": last.date.isoformat(),
        "unit": "ratio",
    }
    if drawdown < threshold - Decimal(str(RATIO_EPSILON)):
        return _not_fired(alert, payload, drawdown)
    detail = (
        f"{_label(alert.instrument)} is {format_pct(float(drawdown))} below its {window_days}-session "
        f"high ({_price(last.close)} on {last.date}, high {_price(high.close)} on {high.date})."
    )
    return _fired(alert, detail, payload, drawdown)


def _new_high(alert: AlertDefinition, data: AlertData) -> AlertCheck:
    window_days = int(alert.params["window_days"])
    window = _series(alert, data, window_days)
    if isinstance(window, str):
        return _skip(alert, window)
    last = window[-1]
    previous = max(b.close for b in window[:-1])
    payload = {
        **_base_payload(alert),
        "close": _price(last.close),
        "previous_high": _price(previous),
        "window_days": window_days,
        "price_date": last.date.isoformat(),
        "unit": "price",
    }
    if last.close <= previous:
        return _not_fired(alert, payload, last.close)
    detail = (
        f"{_label(alert.instrument)} closed at a new {window_days}-session high of "
        f"{_price(last.close)} on {last.date} (previous high {_price(previous)})."
    )
    return _fired(alert, detail, payload, last.close)


def _sma_cross(alert: AlertDefinition, data: AlertData) -> AlertCheck:
    window_days = int(alert.params["window_days"])
    window = _series(alert, data, window_days)
    if isinstance(window, str):
        return _skip(alert, window)
    last = window[-1]
    sma = sum((b.close for b in window), Decimal(0)) / len(window)
    above = alert.params.get("direction") == "above"
    hit = last.close > sma if above else last.close < sma
    sma_text = _price(sma.quantize(Decimal("0.0001")))
    payload = {
        **_base_payload(alert),
        "close": _price(last.close),
        "sma": sma_text,
        "direction": "above" if above else "below",
        "window_days": window_days,
        "price_date": last.date.isoformat(),
        "unit": "price",
    }
    if not hit:
        return _not_fired(alert, payload, last.close)
    detail = (
        f"{_label(alert.instrument)} closed at {_price(last.close)} on {last.date}, "
        f"{'above' if above else 'below'} its {window_days}-session average of {sma_text}."
    )
    return _fired(alert, detail, payload, last.close)


# --------------------------------------------------------------------------- #
# Weights and custom conditions
# --------------------------------------------------------------------------- #


def _weight(alert: AlertDefinition, data: AlertData) -> AlertCheck:
    ctx = data.ctx
    if ctx is None:
        return _skip(alert, "The portfolio could not be valued")
    problem = portfolio_data_problem(ctx)
    if problem is not None:
        return _skip(alert, problem)
    threshold = float(alert.params["threshold"])
    above = alert.kind == AlertKind.WEIGHT_ABOVE
    payload = {**_base_payload(alert), "threshold": threshold, "unit": "ratio"}
    if alert.scope == AlertScope.BUCKET:
        bucket = str(alert.params.get("bucket"))
        payload["bucket_id"] = bucket
        problem = unclassified_problem(ctx)
        if problem is not None:
            return _skip(alert, problem)
        allocation = next((a for a in ctx.allocations if a.bucket_id == bucket), None)
        if allocation is None:
            return _skip(alert, f"No allocation computed for bucket {bucket} (strategy buckets?)")
        if allocation.cash_history_gap:
            return _skip(
                alert, f"Cash history is incomplete, so bucket {bucket} has no known value"
            )
        weight, subject = allocation.weight, f"Bucket {bucket}"
    else:
        instrument = alert.instrument
        if instrument is None:
            return _skip(alert, "The alert has no instrument")
        holdings = tuple(h for h in ctx.portfolio.valued if h.instrument_id == instrument.id)
        subject = _label(instrument)
        if holdings:
            position = InstrumentPosition(
                instrument, holdings, frozenset(ctx.portfolio.missing_fx_currencies)
            )
            price_problem = position.price_problem
            if price_problem is not None or position.weight is None:
                return _skip(alert, price_problem or f"No weight for {subject}")
            weight = position.weight
        else:
            weight = 0.0
        payload["held"] = bool(holdings)
    payload["weight"] = weight
    hit = weight > threshold + RATIO_EPSILON if above else weight < threshold - RATIO_EPSILON
    value = Decimal(repr(weight))
    if not hit:
        return _not_fired(alert, payload, value)
    detail = (
        f"{subject} is {format_pct(weight)} of the portfolio "
        f"({'above' if above else 'below'} {format_pct(threshold)})."
    )
    return _fired(alert, detail, payload, value)


def _custom(alert: AlertDefinition, data: AlertData) -> AlertCheck:
    ctx = data.ctx
    if ctx is None:
        return _skip(alert, "The portfolio could not be valued")
    scope = Scope(alert.scope.value)
    expression = compile_expression(str(alert.params["expression"]), scope)
    if alert.scope == AlertScope.INSTRUMENT:
        if alert.instrument is None:
            return _skip(alert, "The alert has no instrument")
        params = CustomParams(
            expression=expression,
            scope=scope,
            filter=InstrumentFilter(
                asset_classes=frozenset(AssetClass), instrument_ids=frozenset({alert.instrument.id})
            ),
        )
    elif alert.scope == AlertScope.BUCKET:
        params = CustomParams(
            expression=expression, scope=scope, buckets=(str(alert.params.get("bucket")),)
        )
    else:
        params = CustomParams(expression=expression, scope=scope)
    spec = RuleSpec(alert.rule_id, CustomRule.KIND, params, severity=alert.severity)
    outcomes = CustomRule().evaluate(ctx, spec)
    if not outcomes:
        # Instrument scope looks at a held position: not held means the condition cannot hold.
        return _not_fired(alert, {**_base_payload(alert), "held": False}, None)
    outcome = outcomes[0]
    if isinstance(outcome, Skipped):
        return _skip(alert, outcome.reason)
    if isinstance(outcome, NotFired):
        return _not_fired(alert, {**_base_payload(alert), **dict(outcome.details)}, None)
    assert isinstance(outcome, Fired)
    candidate = replace(
        outcome.candidate,
        kind=alert_signal_kind(alert.kind.value),
        dedup_key=alert.rule_id,
        message=f"{alert.title}: {outcome.candidate.message}",
        payload={**_base_payload(alert), **dict(outcome.candidate.payload)},
        polarity=alert.polarity,
        instrument_id=alert.instrument.id if alert.instrument is not None else None,
    )
    return AlertCheck(Fired(candidate))
