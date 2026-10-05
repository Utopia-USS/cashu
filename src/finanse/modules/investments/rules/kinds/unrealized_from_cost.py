"""``loss_from_cost`` and ``gain_from_cost``: an instrument's unrealized result (across accounts, in the
base currency) crossed a threshold."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

from ..kind import RuleContext, RuleSpec
from ..outcomes import Fired, NotFired, RuleOutcome, SignalCandidate, Skipped, signal_dedup_key
from ..params import ParamErrors, ParamReader
from ..polarity import SignalPolarity
from .support import (
    RATIO_EPSILON,
    InstrumentFilter,
    decimal_text,
    format_pct,
    positions_by_instrument,
)


@dataclass(frozen=True, slots=True)
class UnrealizedThresholdParams:
    threshold: float
    """Size of the move as a positive fraction of the cost basis (0.25 = 25%)."""
    filter: InstrumentFilter = field(default_factory=InstrumentFilter)


class _UnrealizedFromCostRule:
    """Per instrument: (value - cost) / cost across accounts; fires when it reaches the threshold in the
    rule's direction. Skips an instrument that is valued manually (a frozen holding at 0 would show
    -100%), whose price is stale or missing, whose currency has no usable FX rate, or whose cost basis is
    unknown or zero."""

    KIND = ""
    IS_LOSS = True
    MAX_THRESHOLD: float | None = 1.0

    @property
    def kind(self) -> str:
        return self.KIND

    @property
    def params_type(self) -> type:
        return UnrealizedThresholdParams

    def parse_params(
        self, raw: Mapping[str, object], errors: ParamErrors
    ) -> UnrealizedThresholdParams:
        reader = ParamReader(raw, errors)
        params = UnrealizedThresholdParams(
            threshold=reader.number(
                "threshold",
                minimum=0,
                maximum=self.MAX_THRESHOLD,
                exclusive_min=True,
                exclusive_max=True,
            ),
            filter=InstrumentFilter.read(reader),
        )
        reader.finish()
        return params

    def evaluate(
        self, ctx: RuleContext, spec: RuleSpec[UnrealizedThresholdParams]
    ) -> list[RuleOutcome]:
        threshold = spec.params.threshold
        currency = str(ctx.portfolio.base_currency)
        outcomes: list[RuleOutcome] = []
        for position in positions_by_instrument(ctx, spec.params.filter):
            key = signal_dedup_key(spec.id, instrument_id=position.id)
            problem = position.manual_problem or position.price_problem or position.cost_problem
            pct = position.unrealized_pct
            if problem is not None or pct is None:
                outcomes.append(Skipped(spec.id, problem or "Brak wyniku niezrealizowanego", key))
                continue
            value = position.market_value_base
            cost = position.cost_basis_base
            assert value is not None and cost is not None
            details = {
                **position.payload(),
                "unrealized_pct": pct,
                "threshold": threshold,
                "market_value_base": decimal_text(value),
                "cost_basis_base": decimal_text(cost),
                "currency": currency,
            }
            hit = (
                pct <= -threshold + RATIO_EPSILON
                if self.IS_LOSS
                else pct >= threshold - RATIO_EPSILON
            )
            if not hit:
                outcomes.append(NotFired(spec.id, key, details))
                continue
            if self.IS_LOSS:
                message = (
                    f"{position.label}: -{format_pct(-pct)} od kosztu "
                    f"(próg -{format_pct(threshold)})."
                )
            else:
                message = f"{position.label}: +{format_pct(pct)} od kosztu (próg +{format_pct(threshold)})."
            outcomes.append(
                Fired(
                    SignalCandidate(
                        rule_id=spec.id,
                        kind=self.kind,
                        dedup_key=key,
                        severity=spec.severity,
                        instrument_id=position.id,
                        payload=details,
                        message=message,
                    )
                )
            )
        return outcomes


class LossFromCostRule(_UnrealizedFromCostRule):
    """Fires when (value - cost) / cost <= -threshold (``threshold: 0.25`` = a 25% loss, 0 < t < 1)."""

    KIND = "loss_from_cost"
    DEFAULT_POLARITY = SignalPolarity.NEGATIVE  # a loss from cost to review
    IS_LOSS = True
    MAX_THRESHOLD = 1.0


class GainFromCostRule(_UnrealizedFromCostRule):
    """Fires when (value - cost) / cost >= threshold (``threshold: 0.5`` = a 50% gain; > 1 allowed)."""

    KIND = "gain_from_cost"
    DEFAULT_POLARITY = SignalPolarity.POSITIVE  # a gain target met
    IS_LOSS = False
    MAX_THRESHOLD = None
