"""Builders for rule tests: RuleContext / ValuedPortfolio / BucketAllocation / MarketView built directly
(no dependency on the portfolio math). Port of the Kompas ``rule_fixtures.dart``; synthetic numbers."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from finanse.modules.investments.domain import (
    AssetClass,
    BucketAllocation,
    CashBalance,
    Currency,
    DatedAmount,
    Holding,
    Instrument,
    MarketView,
    Money,
    PortfolioSnapshot,
    PortfolioWarning,
    PriceBar,
    SignalSeverity,
    ValuationMode,
    ValuedCash,
    ValuedHolding,
    ValuedPortfolio,
)
from finanse.modules.investments.rules import (
    ContributionPlan,
    DataQualityPolicy,
    Fired,
    NotFired,
    ParamErrors,
    ParamIssue,
    RuleContext,
    RuleOutcome,
    RuleSpec,
    SignalCandidate,
    Skipped,
)

PROFILE_ID = "profile-1"
ACCOUNT_A = "account-a"
ACCOUNT_B = "account-b"
PLN = Currency.PLN
USD = Currency.USD
AS_OF = date(2026, 10, 2)
"""The evaluation date of every fixture."""


def d(value: str | int) -> Decimal:
    return Decimal(str(value))


def day(iso: str) -> date:
    return date.fromisoformat(iso)


def instrument(
    symbol: str,
    *,
    asset_class: AssetClass = AssetClass.EQUITY,
    tags: tuple[str, ...] = (),
    mic: str | None = "XWAR",
    currency: Currency = PLN,
) -> Instrument:
    """Instrument with a stable id ``i-<symbol>``."""
    return Instrument(
        id=f"i-{symbol}",
        name=f"{symbol} name",
        symbol=symbol,
        mic=mic,
        currency=currency,
        asset_class=asset_class,
        tags=tags,
    )


@dataclass(frozen=True)
class HoldingSpec:
    """``value`` / ``cost`` in base currency (None = unknown price / cost); ``mode`` = valuation mode."""

    instrument: Instrument
    account: str = ACCOUNT_A
    value: str | None = "1000"
    cost: str | None = "800"
    stale: bool = False
    mode: ValuationMode = ValuationMode.MARKET


def h(
    inst: Instrument,
    *,
    value: str | None = "1000",
    cost: str | None = "800",
    stale: bool = False,
    at_cost: bool = False,
    manual: bool = False,
    account: str = ACCOUNT_A,
) -> HoldingSpec:
    mode = (
        ValuationMode.COST if at_cost else ValuationMode.MANUAL if manual else ValuationMode.MARKET
    )
    return HoldingSpec(inst, account, value, cost, stale, mode)


def portfolio(
    holdings: list[HoldingSpec] | tuple[HoldingSpec, ...] = (),
    *,
    cash: str = "0",
    stale_weight: float | None = None,
    deposits: tuple[date, ...] = (),
    missing_fx_currencies: frozenset[Currency] = frozenset(),
    snapshot_warnings: tuple[PortfolioWarning, ...] = (),
    cash_balances: tuple[ValuedCash, ...] | None = None,
) -> ValuedPortfolio:
    """A valued portfolio whose weights, total and stale share derive from ``holdings`` and ``cash``
    (unpriced holdings are excluded from the total, as the valuation does). Holdings of an instrument
    whose currency is in ``missing_fx_currencies`` get ``missing_fx_currency`` set."""
    total = d(cash)
    stale_value = Decimal(0)
    for spec in holdings:
        if spec.value is not None:
            total += d(spec.value)
            if spec.stale:
                stale_value += d(spec.value)
    total_float = float(total)
    valued = []
    for spec in holdings:
        value = None if spec.value is None else d(spec.value)
        cost = None if spec.cost is None else d(spec.cost)
        missing_fx = (
            spec.instrument.currency if spec.instrument.currency in missing_fx_currencies else None
        )
        valued.append(
            ValuedHolding(
                holding=Holding(
                    account_id=spec.account,
                    instrument_id=spec.instrument.id,
                    currency=PLN,
                    quantity=d("10"),
                ),
                instrument=spec.instrument,
                is_stale=spec.stale,
                price=None if value is None else value / 10,
                price_date=None
                if value is None
                else (AS_OF - timedelta(days=10) if spec.stale else AS_OF),
                market_value_base=value,
                cost_basis_base=cost,
                unrealized_pct=(
                    None
                    if value is None or cost is None or cost == 0
                    else float((value - cost) / cost)
                ),
                weight=None if value is None or total_float == 0 else float(value) / total_float,
                valuation_mode=spec.mode,
                price_currency=None if value is None else spec.instrument.currency,
                missing_fx_currency=missing_fx,
            )
        )
    if cash_balances is None:
        cash_balances = (
            (ValuedCash(CashBalance(ACCOUNT_A, PLN, d(cash)), d(cash)),) if d(cash) else ()
        )
    return ValuedPortfolio(
        snapshot=PortfolioSnapshot(
            profile_id=PROFILE_ID,
            as_of=AS_OF,
            deposits=tuple(DatedAmount(ACCOUNT_A, dep, Money(d("1000"), PLN)) for dep in deposits),
            warnings=snapshot_warnings,
        ),
        base_currency=PLN,
        cash_base=d(cash),
        total_base=total,
        stale_weight=(
            stale_weight
            if stale_weight is not None
            else (0.0 if total_float == 0 else float(stale_value) / total_float)
        ),
        valued=tuple(valued),
        cash=cash_balances,
        missing_fx_currencies=frozenset(missing_fx_currencies),
    )


def alloc(
    bucket_id: str,
    *,
    weight: float,
    target: float,
    total: float = 100000,
    cash_history_gap: bool = False,
) -> BucketAllocation:
    """A bucket allocation with derived drift fields for a portfolio worth ``total``."""
    drift = weight - target
    if target == 0:
        drift_rel = float("inf") if weight > 0 else 0.0
    else:
        drift_rel = drift / target
    return BucketAllocation(
        bucket_id=bucket_id,
        weight=weight,
        target=target,
        drift_pp=drift * 100,
        drift_rel=drift_rel,
        value_base=Decimal(f"{weight * total:.2f}"),
        drift_value_base=Decimal(f"{drift * total:.2f}"),
        cash_history_gap=cash_history_gap,
    )


def bars(
    inst: Instrument, closes: list[str], *, last_date: date | None = None
) -> tuple[PriceBar, ...]:
    """Daily bars of ``inst`` with the given closes, one per day, the last one on ``last_date``."""
    last = last_date or AS_OF
    return tuple(
        PriceBar(
            instrument_id=inst.id,
            date=last - timedelta(days=len(closes) - 1 - i),
            close=d(close),
            source="test",
        )
        for i, close in enumerate(closes)
    )


def context(
    *,
    portfolio_value: ValuedPortfolio | None = None,
    allocations: tuple[BucketAllocation, ...] | list[BucketAllocation] = (),
    unclassified: tuple[ValuedHolding, ...] | list[ValuedHolding] = (),
    series: dict[Instrument, tuple[PriceBar, ...]] | None = None,
    data: DataQualityPolicy | None = None,
    contributions: ContributionPlan | None = None,
) -> RuleContext:
    series = series or {}
    return RuleContext(
        profile_id=PROFILE_ID,
        as_of=AS_OF,
        portfolio=portfolio_value or portfolio(),
        market=MarketView(
            as_of=AS_OF,
            instruments={inst.id: inst for inst in series},
            bars={inst.id: closes for inst, closes in series.items()},
        ),
        allocations=tuple(allocations),
        unclassified=tuple(unclassified),
        data=data or DataQualityPolicy(),
        contributions=contributions,
    )


def parse_ok(kind, raw: dict[str, object]):
    """Parses ``raw`` with ``kind`` and fails on any param issue."""
    errors = ParamErrors()
    params = kind.parse_params(raw, errors)
    assert errors.issues == (), f"unexpected param issues: {errors.issues}"
    return params


def parse_issues(kind, raw: dict[str, object]) -> tuple[ParamIssue, ...]:
    errors = ParamErrors()
    kind.parse_params(raw, errors)
    return errors.issues


def run(
    kind,
    ctx: RuleContext,
    params,
    *,
    rule_id: str = "r",
    severity: SignalSeverity = SignalSeverity.INFO,
) -> list[RuleOutcome]:
    """Evaluates ``params`` of ``kind`` as rule ``rule_id``; checks the outcomes are JSON-safe and belong
    to the rule."""
    outcomes = kind.evaluate(ctx, RuleSpec(rule_id, kind.kind, params, severity))
    for outcome in outcomes:
        assert outcome.rule_id == rule_id
        if isinstance(outcome, Fired):
            payload = outcome.candidate.payload
        elif isinstance(outcome, NotFired):
            payload = outcome.details
        else:
            payload = {}
        json.dumps(payload)  # raises when a payload is not JSON-encodable
    return outcomes


def describe(outcome: RuleOutcome) -> str:
    """``fired r|s:bonds``, ``not_fired r|i:x``, ``skipped r``."""
    if isinstance(outcome, Fired):
        return f"fired {outcome.candidate.dedup_key}"
    if isinstance(outcome, NotFired):
        return f"not_fired {outcome.dedup_key or outcome.rule_id}"
    return f"skipped {outcome.dedup_key or outcome.rule_id}"


def candidate(outcome: RuleOutcome) -> SignalCandidate:
    assert isinstance(outcome, Fired), outcome
    return outcome.candidate


def skip_reason(outcome: RuleOutcome) -> str:
    assert isinstance(outcome, Skipped), outcome
    return outcome.reason
