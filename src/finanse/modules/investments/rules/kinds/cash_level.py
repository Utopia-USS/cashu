"""``cash_level``: the cash share of the portfolio is outside [min_weight, max_weight]."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal

from finanse.modules.investments.domain import AssetClass

from ..kind import RuleContext, RuleSpec
from ..outcomes import Fired, NotFired, RuleOutcome, SignalCandidate, Skipped, signal_dedup_key
from ..params import ParamErrors, ParamReader
from ..polarity import SignalPolarity
from .support import (
    RATIO_EPSILON,
    cash_history_problem,
    decimal_text,
    format_pct,
    portfolio_data_problem,
)


@dataclass(frozen=True, slots=True)
class CashLevelParams:
    min_weight: float | None = None
    """Smallest allowed cash share (0.02 = 2%), or None."""
    max_weight: float | None = None
    """Largest allowed cash share (0.15 = 15%), or None."""


def cash_value(ctx: RuleContext) -> Decimal:
    """Counted cash balances plus market values of cash-like instruments (``asset_class: cash``)."""
    cash = ctx.portfolio.cash_base
    for holding in ctx.portfolio.valued:
        if (
            holding.instrument.asset_class == AssetClass.CASH
            and holding.market_value_base is not None
        ):
            cash += holding.market_value_base
    return cash


class CashLevelRule:
    """Whole portfolio: cash share = (cash balances + cash-like instruments) / total. Fires below
    ``min_weight`` or above ``max_weight``. Skips when portfolio weights are unreliable or any account
    has negative cash (``CashHistoryGap``: the real cash balance is unknown)."""

    KIND = "cash_level"
    DEFAULT_POLARITY = SignalPolarity.NEGATIVE  # a cash gap: idle cash or too little of it

    @property
    def kind(self) -> str:
        return self.KIND

    @property
    def params_type(self) -> type:
        return CashLevelParams

    def parse_params(self, raw: Mapping[str, object], errors: ParamErrors) -> CashLevelParams:
        reader = ParamReader(raw, errors)
        min_weight = reader.optional_number("min_weight", minimum=0, maximum=1, exclusive_max=True)
        max_weight = reader.optional_number("max_weight", minimum=0, maximum=1, exclusive_min=True)
        reader.finish()
        if not reader.has("min_weight") and not reader.has("max_weight"):
            errors.error("", "cash_level needs min_weight, max_weight or both")
        elif min_weight is not None and max_weight is not None and min_weight >= max_weight:
            errors.error("min_weight", "min_weight must be below max_weight")
        return CashLevelParams(min_weight, max_weight)

    def evaluate(self, ctx: RuleContext, spec: RuleSpec[CashLevelParams]) -> list[RuleOutcome]:
        problem = portfolio_data_problem(ctx) or cash_history_problem(ctx)
        if problem is not None:
            return [Skipped(spec.id, problem)]
        portfolio = ctx.portfolio
        cash = cash_value(ctx)
        weight = float(cash / portfolio.total_base)
        min_weight = spec.params.min_weight
        max_weight = spec.params.max_weight
        key = signal_dedup_key(spec.id)
        details: dict[str, object] = {
            "cash_weight": weight,
            "cash_base": decimal_text(cash),
            "total_base": decimal_text(portfolio.total_base),
            "currency": str(portfolio.base_currency),
            "min_weight": min_weight,
            "max_weight": max_weight,
        }
        below = min_weight is not None and weight < min_weight - RATIO_EPSILON
        above = max_weight is not None and weight > max_weight + RATIO_EPSILON
        if not below and not above:
            return [NotFired(spec.id, key, details)]
        if below:
            assert min_weight is not None
            message = (
                f"Gotówka: {format_pct(weight)} portfela, poniżej minimum {format_pct(min_weight)}."
            )
        else:
            assert max_weight is not None
            message = f"Gotówka: {format_pct(weight)} portfela, powyżej maksimum {format_pct(max_weight)}."
        return [
            Fired(
                SignalCandidate(
                    rule_id=spec.id,
                    kind=self.kind,
                    dedup_key=key,
                    severity=spec.severity,
                    payload={**details, "direction": "below_min" if below else "above_max"},
                    message=message,
                )
            )
        ]
