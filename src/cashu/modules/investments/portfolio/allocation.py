"""Maps valued holdings and cash to strategy buckets and measures drift against the targets. Pure."""

from __future__ import annotations

import math
from collections.abc import Collection
from decimal import Decimal

from ..domain import (
    AccountId,
    AllocationPlan,
    AllocationResult,
    AssetClass,
    BucketAllocation,
    BucketDef,
    BucketMatch,
    Currency,
    Instrument,
    ValuedHolding,
    ValuedPortfolio,
    exact,
    ratio,
)


def matches_bucket(match: BucketMatch, instrument: Instrument) -> bool:
    """Whether ``instrument`` satisfies ``match``: every non-empty criterion must hold; within a
    criterion any element matches, except tags, which must all be present. MICs and tags compare
    case-insensitively. An empty match accepts every instrument."""
    if match.asset_classes and instrument.asset_class not in match.asset_classes:
        return False
    if match.instrument_ids and instrument.id not in match.instrument_ids:
        return False
    if match.currencies and instrument.currency not in match.currencies:
        return False
    if match.mics:
        mic = instrument.mic.upper() if instrument.mic else None
        if mic is None or all(m.upper() != mic for m in match.mics):
            return False
    if match.tags:
        tags = {tag.lower() for tag in instrument.tags}
        if any(tag.lower() not in tags for tag in match.tags):
            return False
    return True


def matches_cash_bucket(match: BucketMatch, currency: Currency) -> bool:
    """Whether raw cash in ``currency`` matches ``match``: cash is treated like an instrument of asset
    class ``cash`` in ``currency`` without tags, MIC or id. So a bucket listing ``cash`` (and, if it lists
    currencies, ``currency``) takes it, and so does a catch-all ``match: {}``; buckets with tags, MICs or
    instrument ids never do."""
    return (
        (not match.asset_classes or AssetClass.CASH in match.asset_classes)
        and not match.tags
        and not match.mics
        and not match.instrument_ids
        and (not match.currencies or currency in match.currencies)
    )


def _first_match(buckets: tuple[BucketDef, ...], instrument: Instrument) -> BucketDef | None:
    return next((b for b in buckets if matches_bucket(b.match, instrument)), None)


@exact
def allocate(
    portfolio: ValuedPortfolio,
    plan: AllocationPlan,
    *,
    account_ids: Collection[AccountId] | None = None,
) -> AllocationResult:
    """Allocates ``portfolio`` to the buckets of ``plan``.

    Each holding goes to the first bucket (declaration order) it matches; holdings matching none are
    unclassified (R1: ``AllocationResult.unclassified`` / ``unclassified_weight`` let rules skip when
    they are too large). Each cash balance goes to the first bucket that matches cash in its currency;
    cash matching none is unallocated. Weights are values / total, where total = valued holdings + all
    counted cash in scope (a negative balance counts as 0 and flags its bucket ``cash_history_gap``,
    R2). Cash without a usable FX rate is left out (valuation already listed its currency). Buckets
    without a target get target 0; targets without a bucket get a zero allocation. A bucket id declared
    twice is one bucket whose definitions are alternative matches, each at its own position.

    With ``account_ids``, only holdings and cash of those accounts count (weights relative to their
    total).
    """
    holdings = [v for v in portfolio.valued if account_ids is None or v.account_id in account_ids]
    cash = [
        (c.currency, c.counted_base, c.amount_base < 0)
        for c in portfolio.cash
        if (account_ids is None or c.account_id in account_ids) and c.amount_base is not None
    ]

    bucket_ids: list[str] = []
    values: dict[str, Decimal] = {}
    for bucket in plan.buckets:
        if bucket.id not in values:
            bucket_ids.append(bucket.id)
            values[bucket.id] = Decimal(0)

    holdings_by_bucket: dict[str, list[ValuedHolding]] = {}
    unclassified: list[ValuedHolding] = []
    unclassified_value = Decimal(0)
    total = Decimal(0)
    for holding in holdings:
        value = holding.market_value_base or Decimal(0)
        total += value
        bucket = _first_match(plan.buckets, holding.instrument)
        if bucket is None:
            unclassified.append(holding)
            unclassified_value += value
            continue
        values[bucket.id] += value
        holdings_by_bucket.setdefault(bucket.id, []).append(holding)

    unallocated_cash = Decimal(0)
    cash_gap_buckets: set[str] = set()
    for currency, amount, negative in cash:
        total += amount
        bucket = next((b for b in plan.buckets if matches_cash_bucket(b.match, currency)), None)
        if bucket is None:
            unallocated_cash += amount
        else:
            values[bucket.id] += amount
            if negative:
                cash_gap_buckets.add(bucket.id)

    for target_id in plan.targets:
        if target_id not in values:
            bucket_ids.append(target_id)
            values[target_id] = Decimal(0)

    return AllocationResult(
        total_base=total,
        unclassified_value_base=unclassified_value,
        unallocated_cash_base=unallocated_cash,
        allocations=tuple(
            _allocation(
                bucket_id,
                values[bucket_id],
                float(plan.targets.get(bucket_id, 0.0)),
                total,
                cash_history_gap=bucket_id in cash_gap_buckets,
            )
            for bucket_id in bucket_ids
        ),
        holdings_by_bucket={k: tuple(v) for k, v in holdings_by_bucket.items()},
        unclassified=tuple(unclassified),
    )


def _allocation(
    bucket_id: str, value: Decimal, target: float, total: Decimal, *, cash_history_gap: bool
) -> BucketAllocation:
    weight = ratio(value, total) or 0.0
    drift = weight - target
    if target != 0:
        drift_rel = drift / target
    else:
        drift_rel = math.inf if weight > 0 else 0.0
    return BucketAllocation(
        bucket_id=bucket_id,
        weight=weight,
        target=target,
        drift_pp=drift * 100,
        drift_rel=drift_rel,
        value_base=value,
        drift_value_base=value - Decimal(str(target)) * total,
        cash_history_gap=cash_history_gap,
    )
