"""``drawdown_from_high``: the last close is far below the highest close of a trailing window."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

from finanse.modules.investments.domain import PriceBar, days_between, divided_by

from ..kind import RuleContext, RuleSpec
from ..outcomes import Fired, NotFired, RuleOutcome, SignalCandidate, Skipped, signal_dedup_key
from ..params import ParamErrors, ParamReader
from .support import (
    RATIO_EPSILON,
    InstrumentFilter,
    InstrumentPosition,
    decimal_text,
    format_pct,
    positions_by_instrument,
)

DEFAULT_WINDOW_DAYS = 252


@dataclass(frozen=True, slots=True)
class DrawdownFromHighParams:
    threshold: float
    """Size of the drop from the high as a fraction (0.15 = 15% below the high)."""
    window_days: int = DEFAULT_WINDOW_DAYS
    """Window length in daily bars (sessions), including the last one; 252 is about one year."""
    filter: InstrumentFilter = field(default_factory=InstrumentFilter)


@dataclass(frozen=True, slots=True)
class WindowBars:
    """A validated trailing window of closes for one instrument."""

    bars: tuple[PriceBar, ...]

    @property
    def last(self) -> PriceBar:
        return self.bars[-1]

    @property
    def high(self) -> PriceBar:
        best = self.bars[0]
        for bar in self.bars:
            if bar.close > best.close:
                best = bar
        return best


def window_bars(
    ctx: RuleContext, position: InstrumentPosition, window_days: int
) -> WindowBars | str:
    """The last ``window_days`` bars of ``position`` or why they cannot be used: valued manually or at
    cost (no market series), no usable FX rate (conservative: not judged at all), no series, stale last
    close (older than ``data.max_price_age_days``), fewer bars than the window, non-positive closes."""
    series_problem = position.series_problem
    if series_problem is not None:
        return series_problem
    fx_problem = position.fx_problem
    if fx_problem is not None:
        return fx_problem
    bars = ctx.market.last_bars(position.id, window_days)
    if not bars:
        return f"No price series for {position.label}"
    last = bars[-1]
    age = days_between(last.date, ctx.as_of)
    if age > ctx.data.max_price_age_days:
        return f"Price of {position.label} is stale (last close {last.date}, {age} days old)"
    if len(bars) < window_days:
        return f"Only {len(bars)} of {window_days} bars for {position.label}"
    if any(bar.close <= 0 for bar in bars):
        return f"Invalid prices for {position.label}"
    return WindowBars(tuple(bars))


class DrawdownFromHighRule:
    """Per held instrument: drawdown = 1 - last close / max(close over the last ``window_days`` bars);
    fires when it is at least ``threshold``.

    Closing prices are used (bars may lack high/low). Skips an instrument (with a reason, never fired)
    when it is valued manually or at cost (treasury bonds, claims, frozen holdings: no market series by
    design), has no series, the series is shorter than the window, the last close is older than
    ``data.max_price_age_days``, or its currency has no usable FX rate. Optional filters ``asset_class``,
    ``tags``, ``instrument_ids`` (AND).
    """

    KIND = "drawdown_from_high"

    @property
    def kind(self) -> str:
        return self.KIND

    @property
    def params_type(self) -> type:
        return DrawdownFromHighParams

    def parse_params(
        self, raw: Mapping[str, object], errors: ParamErrors
    ) -> DrawdownFromHighParams:
        reader = ParamReader(raw, errors)
        params = DrawdownFromHighParams(
            threshold=reader.number(
                "threshold", minimum=0, maximum=1, exclusive_min=True, exclusive_max=True
            ),
            window_days=reader.integer("window_days", fallback=DEFAULT_WINDOW_DAYS, minimum=2),
            filter=InstrumentFilter.read(reader),
        )
        reader.finish()
        return params

    def evaluate(
        self, ctx: RuleContext, spec: RuleSpec[DrawdownFromHighParams]
    ) -> list[RuleOutcome]:
        params = spec.params
        outcomes: list[RuleOutcome] = []
        for position in positions_by_instrument(ctx, params.filter):
            key = signal_dedup_key(spec.id, instrument_id=position.id)
            window = window_bars(ctx, position, params.window_days)
            if isinstance(window, str):
                outcomes.append(Skipped(spec.id, window, key))
                continue
            last, high = window.last, window.high
            drawdown = float(1 - divided_by(last.close, high.close))
            details = {
                **position.payload(),
                "drawdown": drawdown,
                "threshold": params.threshold,
                "window_days": params.window_days,
                "high_close": decimal_text(high.close),
                "high_date": high.date.isoformat(),
                "last_close": decimal_text(last.close),
                "last_date": last.date.isoformat(),
            }
            if drawdown < params.threshold - RATIO_EPSILON:
                outcomes.append(NotFired(spec.id, key, details))
                continue
            outcomes.append(
                Fired(
                    SignalCandidate(
                        rule_id=spec.id,
                        kind=self.kind,
                        dedup_key=key,
                        severity=spec.severity,
                        instrument_id=position.id,
                        payload=details,
                        message=(
                            f"{position.label} closed {format_pct(drawdown)} below its "
                            f"{params.window_days}-day high ({decimal_text(last.close)} on {last.date} vs "
                            f"{decimal_text(high.close)} on {high.date}; "
                            f"threshold {format_pct(params.threshold)})."
                        ),
                    )
                )
            )
        return outcomes
