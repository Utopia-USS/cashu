"""``position_concentration``: one instrument is too large a share of the portfolio."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

from ..kind import RuleContext, RuleSpec
from ..outcomes import Fired, NotFired, RuleOutcome, SignalCandidate, Skipped, signal_dedup_key
from ..params import ParamErrors, ParamReader
from .support import (
    RATIO_EPSILON,
    InstrumentFilter,
    format_pct,
    portfolio_data_problem,
    positions_by_instrument,
)


@dataclass(frozen=True, slots=True)
class PositionConcentrationParams:
    max_weight: float
    """Largest allowed weight of one instrument across accounts (0.10 = 10%)."""
    filter: InstrumentFilter = field(default_factory=InstrumentFilter)


class PositionConcentrationRule:
    """Per instrument (summed across accounts): fires when its weight exceeds ``max_weight``.

    Skips the whole rule when portfolio weights are unreliable; skips one instrument when its own price
    is stale or missing. No instrument in scope -> no outcome (the engine reports a whole-rule NotFired).
    Optional filters ``asset_class``, ``tags``, ``instrument_ids`` (AND).
    """

    KIND = "position_concentration"

    @property
    def kind(self) -> str:
        return self.KIND

    @property
    def params_type(self) -> type:
        return PositionConcentrationParams

    def parse_params(
        self, raw: Mapping[str, object], errors: ParamErrors
    ) -> PositionConcentrationParams:
        reader = ParamReader(raw, errors)
        params = PositionConcentrationParams(
            max_weight=reader.number("max_weight", minimum=0, maximum=1, exclusive_min=True),
            filter=InstrumentFilter.read(reader),
        )
        reader.finish()
        return params

    def evaluate(
        self, ctx: RuleContext, spec: RuleSpec[PositionConcentrationParams]
    ) -> list[RuleOutcome]:
        positions = positions_by_instrument(ctx, spec.params.filter)
        if not positions:
            return []
        problem = portfolio_data_problem(ctx)
        if problem is not None:
            return [Skipped(spec.id, problem)]

        max_weight = spec.params.max_weight
        outcomes: list[RuleOutcome] = []
        for position in positions:
            key = signal_dedup_key(spec.id, instrument_id=position.id)
            weight = position.weight
            price_problem = position.price_problem
            if price_problem is None and weight is None:
                price_problem = f"No weight for {position.label}"
            if price_problem is not None or weight is None:
                outcomes.append(Skipped(spec.id, price_problem or "No weight", key))
                continue
            details = {**position.payload(), "weight": weight, "max_weight": max_weight}
            if weight <= max_weight + RATIO_EPSILON:
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
                            f"{position.label} is {format_pct(weight)} of the portfolio "
                            f"(max {format_pct(max_weight)})."
                        ),
                    )
                )
            )
        return outcomes
