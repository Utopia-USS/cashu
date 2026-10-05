"""Values of the metric catalog for one evaluation scope.

Each resolver applies the same data-quality rules as the built-in kinds: a metric whose inputs are stale,
missing or untrustworthy resolves to :class:`Unknown` with the reason the built-in rule would give (short
Polish text: it becomes the custom rule's skip reason, which the owner and the agent can see).
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal

from finanse.modules.investments.domain import AssetClass, BucketAllocation, days_between

from ..kind import RuleContext
from ..kinds.cash_level import cash_value
from ..kinds.contribution_gap import NO_CONTRIBUTIONS_PLAN, last_deposit_date
from ..kinds.drawdown_from_high import window_bars
from ..kinds.support import (
    NO_ALLOCATIONS,
    InstrumentPosition,
    bucket_cash_gap_problem,
    cash_history_problem,
    has_all_tags,
    no_allocation_problem,
    portfolio_data_problem,
    portfolio_value_problem,
    positions_by_instrument,
    unclassified_problem,
    unknown_cost_problem,
)
from ..kinds.tagged_weight import tagged_weight
from .catalog import METRICS
from .checker import MetricRef
from .evaluator import Unknown, Value


@dataclass(frozen=True, slots=True)
class MetricEnv:
    """What one evaluation sees: the context plus the instrument or bucket being evaluated."""

    ctx: RuleContext
    position: InstrumentPosition | None = None
    bucket_id: str | None = None
    allocation: BucketAllocation | None = None

    def resolve(self, ref: MetricRef) -> Value:
        """Value of one metric use (the checker guarantees name, scope and argument types)."""
        return _RESOLVERS[ref.name](self, ref.args)


def _unknown(reason: str) -> Unknown:
    return Unknown((reason,))


def _ratio(value: float | None, reason: str) -> Value:
    if value is None or not math.isfinite(value):
        return _unknown(reason)
    return Decimal(repr(value))


def _count(value: int) -> Decimal:
    return Decimal(value)


# --- portfolio ----------------------------------------------------------------------------------


def _total_value(env: MetricEnv, _: tuple) -> Value:
    problem = portfolio_value_problem(env.ctx)
    return _unknown(problem) if problem else env.ctx.portfolio.total_base


def _cash_value(env: MetricEnv, _: tuple) -> Value:
    problem = portfolio_value_problem(env.ctx) or cash_history_problem(env.ctx)
    return _unknown(problem) if problem else cash_value(env.ctx)


def _cash_weight(env: MetricEnv, _: tuple) -> Value:
    ctx = env.ctx
    problem = portfolio_data_problem(ctx) or cash_history_problem(ctx)
    if problem:
        return _unknown(problem)
    return cash_value(ctx) / ctx.portfolio.total_base


def _stale_weight(env: MetricEnv, _: tuple) -> Value:
    return _ratio(env.ctx.portfolio.stale_weight, "Udział nieaktualnych cen nieznany")


def _unclassified_weight(env: MetricEnv, _: tuple) -> Value:
    ctx = env.ctx
    problem = portfolio_data_problem(ctx)
    if problem:
        return _unknown(problem)
    if not ctx.allocations:
        return _unknown(NO_ALLOCATIONS)
    return _ratio(
        sum(h.weight or 0.0 for h in ctx.unclassified), "Udział pozycji bez koszyka nieznany"
    )


def _max_position_weight(env: MetricEnv, _: tuple) -> Value:
    ctx = env.ctx
    problem = portfolio_data_problem(ctx)
    if problem:
        return _unknown(problem)
    best = 0.0
    for position in positions_by_instrument(ctx):
        position_problem = position.price_problem
        weight = position.weight
        if position_problem or weight is None:
            return _unknown(position_problem or f"Brak wagi: {position.label}")
        best = max(best, weight)
    return _ratio(best, "Waga największej pozycji nieznana")


def _holdings_count(env: MetricEnv, _: tuple) -> Value:
    return _count(len(positions_by_instrument(env.ctx)))


def _days_since_last_deposit(env: MetricEnv, _: tuple) -> Value:
    last = last_deposit_date(env.ctx)
    if last is None:
        return _unknown("Brak zapisanych wpłat")
    return _count(days_between(last, env.ctx.as_of))


def _monthly_contribution(env: MetricEnv, _: tuple) -> Value:
    plan = env.ctx.contributions
    if plan is None:
        return _unknown(NO_CONTRIBUTIONS_PLAN)
    return plan.monthly_amount


def _bucket(
    env: MetricEnv, bucket_id: str, *, needs_weights: bool = True
) -> BucketAllocation | Unknown:
    ctx = env.ctx
    if needs_weights:
        problem = portfolio_data_problem(ctx)
        if problem:
            return _unknown(problem)
    if not ctx.allocations:
        return _unknown(NO_ALLOCATIONS)
    if needs_weights:
        problem = unclassified_problem(ctx)
        if problem:
            return _unknown(problem)
    allocation = next((a for a in ctx.allocations if a.bucket_id == bucket_id), None)
    if allocation is None:
        return _unknown(no_allocation_problem(bucket_id))
    if needs_weights and allocation.cash_history_gap:
        return _unknown(bucket_cash_gap_problem(bucket_id))
    return allocation


def _bucket_field(
    field_name: str, *, needs_weights: bool = True
) -> Callable[[MetricEnv, tuple], Value]:
    def resolve(env: MetricEnv, args: tuple) -> Value:
        allocation = _bucket(env, str(args[0]), needs_weights=needs_weights)
        if isinstance(allocation, Unknown):
            return allocation
        return _allocation_value(allocation, field_name)

    return resolve


def _allocation_value(allocation: BucketAllocation, field_name: str) -> Value:
    match field_name:
        case "weight":
            return _ratio(allocation.weight, f"Waga koszyka {allocation.bucket_id} nieznana")
        case "target":
            return _ratio(allocation.target, f"Cel koszyka {allocation.bucket_id} nieznany")
        case "drift_pp":
            return _ratio(allocation.drift_pp, f"Dryf koszyka {allocation.bucket_id} nieznany")
        case "drift_rel":
            return _ratio(
                allocation.drift_rel,
                f"Względny dryf koszyka {allocation.bucket_id} nieokreślony (cel 0)",
            )
        case "value":
            return allocation.value_base
        case _:
            return allocation.drift_value_base


def _tagged_weight(env: MetricEnv, args: tuple) -> Value:
    ctx = env.ctx
    problem = portfolio_data_problem(ctx) or unclassified_problem(ctx)
    if problem:
        return _unknown(problem)
    weight, _labels = tagged_weight(ctx, tuple(str(arg) for arg in args))
    return _ratio(weight, "Waga tagów nieznana")


def _asset_class_weight(env: MetricEnv, args: tuple) -> Value:
    ctx = env.ctx
    asset_class = AssetClass(str(args[0]))
    is_cash = asset_class == AssetClass.CASH
    problem = portfolio_data_problem(ctx) or (cash_history_problem(ctx) if is_cash else None)
    if problem:
        return _unknown(problem)
    if is_cash:
        return cash_value(ctx) / ctx.portfolio.total_base
    weight = sum(
        h.weight or 0.0 for h in ctx.portfolio.valued if h.instrument.asset_class == asset_class
    )
    return _ratio(weight, f"Waga klasy aktywów {asset_class} nieznana")


# --- instrument ---------------------------------------------------------------------------------


def _position(env: MetricEnv) -> InstrumentPosition:
    assert env.position is not None, "instrument metric outside the instrument scope"
    return env.position


def _symbol(env: MetricEnv, _: tuple) -> Value:
    return _position(env).label


def _asset_class(env: MetricEnv, _: tuple) -> Value:
    return _position(env).instrument.asset_class.value


def _currency(env: MetricEnv, _: tuple) -> Value:
    return str(_position(env).instrument.currency)


def _mic(env: MetricEnv, _: tuple) -> Value:
    position = _position(env)
    mic = position.instrument.mic
    return mic.upper() if mic else _unknown(f"{position.label}: brak kodu giełdy (mic)")


def _weight(env: MetricEnv, args: tuple) -> Value:
    if env.allocation is not None or env.bucket_id is not None:
        assert env.bucket_id is not None
        allocation = _bucket(env, env.bucket_id)
        return (
            allocation
            if isinstance(allocation, Unknown)
            else _allocation_value(allocation, "weight")
        )
    position = _position(env)
    problem = portfolio_data_problem(env.ctx) or position.price_problem
    if problem:
        return _unknown(problem)
    return _ratio(position.weight, f"Brak wagi: {position.label}")


def _market_value(env: MetricEnv, _: tuple) -> Value:
    position = _position(env)
    problem = position.price_problem
    value = position.market_value_base
    if problem or value is None:
        return _unknown(problem or f"Brak ceny: {position.label}")
    return value


def _cost_basis(env: MetricEnv, _: tuple) -> Value:
    position = _position(env)
    cost = position.cost_basis_base
    if cost is None:
        return _unknown(unknown_cost_problem(position.label))
    return cost


def _unrealized_pct(env: MetricEnv, _: tuple) -> Value:
    position = _position(env)
    problem = position.manual_problem or position.price_problem or position.cost_problem
    if problem:
        return _unknown(problem)
    return _ratio(position.unrealized_pct, f"Brak wyniku niezrealizowanego: {position.label}")


def _unrealized_value(env: MetricEnv, _: tuple) -> Value:
    position = _position(env)
    value = position.market_value_base
    cost = position.cost_basis_base
    problem = position.manual_problem or position.price_problem
    if problem or value is None:
        return _unknown(problem or f"Brak ceny: {position.label}")
    if cost is None:
        return _unknown(unknown_cost_problem(position.label))
    return value - cost


def _window_metric(compute: Callable[[tuple], Decimal]) -> Callable[[MetricEnv, tuple], Value]:
    def resolve(env: MetricEnv, args: tuple) -> Value:
        window_days = int(args[0]) if args else 1
        window = window_bars(env.ctx, _position(env), window_days)
        if isinstance(window, str):
            return _unknown(window)
        return compute(window.bars)

    return resolve


def _last_close(bars: tuple) -> Decimal:
    return bars[-1].close


def _drawdown(bars: tuple) -> Decimal:
    high = max(bar.close for bar in bars)
    return 1 - bars[-1].close / high


def _price_change(bars: tuple) -> Decimal:
    return bars[-1].close / bars[0].close - 1


def _price_vs_sma(bars: tuple) -> Decimal:
    average = sum((bar.close for bar in bars), Decimal(0)) / len(bars)
    return bars[-1].close / average - 1


def _holding_has_tag(env: MetricEnv, args: tuple) -> Value:
    return has_all_tags(_position(env).instrument, [str(args[0])])


# --- bucket -------------------------------------------------------------------------------------


def _bucket_id(env: MetricEnv, _: tuple) -> Value:
    assert env.bucket_id is not None, "bucket metric outside the bucket scope"
    return env.bucket_id


def _scoped_bucket_field(
    field_name: str, *, needs_weights: bool = True
) -> Callable[[MetricEnv, tuple], Value]:
    def resolve(env: MetricEnv, _: tuple) -> Value:
        assert env.bucket_id is not None, "bucket metric outside the bucket scope"
        allocation = _bucket(env, env.bucket_id, needs_weights=needs_weights)
        if isinstance(allocation, Unknown):
            return allocation
        return _allocation_value(allocation, field_name)

    return resolve


_RESOLVERS: dict[str, Callable[[MetricEnv, tuple], Value]] = {
    "total_value": _total_value,
    "cash_value": _cash_value,
    "cash_weight": _cash_weight,
    "stale_weight": _stale_weight,
    "unclassified_weight": _unclassified_weight,
    "max_position_weight": _max_position_weight,
    "holdings_count": _holdings_count,
    "days_since_last_deposit": _days_since_last_deposit,
    "monthly_contribution": _monthly_contribution,
    "bucket_weight": _bucket_field("weight"),
    "bucket_target": _bucket_field("target", needs_weights=False),
    "bucket_drift_pp": _bucket_field("drift_pp"),
    "bucket_value": _bucket_field("value"),
    "tagged_weight": _tagged_weight,
    "asset_class_weight": _asset_class_weight,
    "symbol": _symbol,
    "asset_class": _asset_class,
    "currency": _currency,
    "mic": _mic,
    "weight": _weight,
    "market_value": _market_value,
    "cost_basis": _cost_basis,
    "unrealized_pct": _unrealized_pct,
    "unrealized_value": _unrealized_value,
    "last_close": _window_metric(_last_close),
    "drawdown_from_high": _window_metric(_drawdown),
    "price_change": _window_metric(_price_change),
    "price_vs_sma": _window_metric(_price_vs_sma),
    "holding_has_tag": _holding_has_tag,
    "bucket_id": _bucket_id,
    "target": _scoped_bucket_field("target", needs_weights=False),
    "drift_pp": _scoped_bucket_field("drift_pp"),
    "drift_rel": _scoped_bucket_field("drift_rel"),
    "value": _scoped_bucket_field("value"),
    "drift_value": _scoped_bucket_field("drift_value"),
}

assert set(_RESOLVERS) == set(METRICS), "every catalog metric needs exactly one resolver"
