"""``allocation_drift``: a strategy bucket drifted outside its rebalance band.

The payload carries ``bucket_generic`` (F7 owner decision): only generic, asset-class style buckets
(``domain.GENERIC_BUCKET_IDS``) are shown in the app; a drift signal of the owner's own bucket stays a
signal (rules, MCP) but notifications and the weekly digest skip it (:func:`hidden_from_owner`)."""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import Decimal

from finanse.modules.investments.domain import is_generic_bucket

from ..kind import RuleContext, RuleSpec
from ..outcomes import Fired, NotFired, RuleOutcome, SignalCandidate, Skipped, signal_dedup_key
from ..params import ParamErrors, ParamReader
from ..polarity import SignalPolarity
from .support import (
    NO_ALLOCATIONS,
    RATIO_EPSILON,
    bucket_cash_gap_problem,
    decimal_text,
    format_amount,
    format_pct,
    format_pp,
    no_allocation_problem,
    portfolio_data_problem,
    unclassified_problem,
)


@dataclass(frozen=True, slots=True)
class RebalancePolicy:
    """Rebalance bands (``allocation.rebalance`` in strategy.yaml, also the params of allocation_drift).

    A bucket is out of band when |drift| > ``absolute_band_pp`` percentage points OR |relative drift| >
    ``relative_band`` (the "5/25" rule), and only worth a signal when the money to move is at least
    ``min_trade_value`` (base currency).
    """

    absolute_band_pp: float = 5.0
    relative_band: float = 0.25
    min_trade_value: Decimal = Decimal(0)

    KEYS = ("absolute_band_pp", "relative_band", "min_trade_value")

    @staticmethod
    def read(reader: ParamReader) -> RebalancePolicy:
        """Reads the three keys (all optional, defaults above)."""
        return RebalancePolicy(
            absolute_band_pp=reader.number(
                "absolute_band_pp", fallback=5.0, minimum=0, maximum=100, exclusive_min=True
            ),
            relative_band=reader.number(
                "relative_band", fallback=0.25, minimum=0, exclusive_min=True
            ),
            min_trade_value=reader.decimal(
                "min_trade_value", fallback=Decimal(0), minimum=Decimal(0)
            ),
        )

    def to_raw(self) -> dict[str, object]:
        """The values as raw YAML params (used to default allocation_drift params from the strategy)."""
        return {
            "absolute_band_pp": self.absolute_band_pp,
            "relative_band": self.relative_band,
            "min_trade_value": decimal_text(self.min_trade_value),
        }


@dataclass(frozen=True, slots=True)
class AllocationDriftParams:
    bands: RebalancePolicy = field(default_factory=RebalancePolicy)
    buckets: tuple[str, ...] = ()
    """Bucket ids to check; empty = every bucket."""


class AllocationDriftRule:
    """Per bucket: fires when the bucket is outside its band and the drift value is at least the minimum
    trade value.

    Skips the whole rule when portfolio weights are unreliable (stale share above
    ``data.max_stale_weight``, an unpriced holding, a missing FX rate, an empty portfolio), when no
    allocations were computed, or when holdings matching no bucket exceed ``data.max_unclassified_weight``
    (every classified bucket would then look underweight). Skips one bucket holding negative cash.
    Params default from the strategy's ``allocation.rebalance`` (the loader merges them in).
    """

    KIND = "allocation_drift"
    # Owner decision (F6): drift below or above target is neither good nor bad news, just a review.
    DEFAULT_POLARITY = SignalPolarity.NEUTRAL

    @property
    def kind(self) -> str:
        return self.KIND

    @property
    def params_type(self) -> type:
        return AllocationDriftParams

    def parse_params(self, raw: Mapping[str, object], errors: ParamErrors) -> AllocationDriftParams:
        reader = ParamReader(raw, errors)
        bands = RebalancePolicy.read(reader)
        buckets = reader.strings("buckets")
        reader.finish()
        return AllocationDriftParams(bands, buckets)

    def evaluate(
        self, ctx: RuleContext, spec: RuleSpec[AllocationDriftParams]
    ) -> list[RuleOutcome]:
        problem = portfolio_data_problem(ctx)
        if problem is not None:
            return [Skipped(spec.id, problem)]
        if not ctx.allocations:
            return [Skipped(spec.id, NO_ALLOCATIONS)]
        unclassified = unclassified_problem(ctx)
        if unclassified is not None:
            return [Skipped(spec.id, unclassified)]

        bands = spec.params.bands
        by_id = {allocation.bucket_id: allocation for allocation in ctx.allocations}
        bucket_ids = list(spec.params.buckets) or list(by_id)
        currency = str(ctx.portfolio.base_currency)
        outcomes: list[RuleOutcome] = []
        for bucket_id in bucket_ids:
            key = signal_dedup_key(spec.id, scope=bucket_id)
            allocation = by_id.get(bucket_id)
            if allocation is None:
                outcomes.append(Skipped(spec.id, no_allocation_problem(bucket_id), key))
                continue
            if allocation.cash_history_gap:
                outcomes.append(Skipped(spec.id, bucket_cash_gap_problem(bucket_id), key))
                continue
            drift_rel = allocation.drift_rel
            outside_absolute = abs(allocation.drift_pp) > bands.absolute_band_pp + RATIO_EPSILON
            outside_relative = abs(drift_rel) > bands.relative_band + RATIO_EPSILON
            big_enough = abs(allocation.drift_value_base) >= bands.min_trade_value
            details: dict[str, object] = {
                "bucket_id": bucket_id,
                "bucket_generic": is_generic_bucket(bucket_id),
                "weight": allocation.weight,
                "target": allocation.target,
                "drift_pp": allocation.drift_pp,
                "drift_rel": drift_rel if math.isfinite(drift_rel) else None,
                "value_base": decimal_text(allocation.value_base),
                "drift_value_base": decimal_text(allocation.drift_value_base),
                "currency": currency,
                "absolute_band_pp": bands.absolute_band_pp,
                "relative_band": bands.relative_band,
                "min_trade_value": decimal_text(bands.min_trade_value),
            }
            if not (outside_absolute or outside_relative) or not big_enough:
                outcomes.append(NotFired(spec.id, key, details))
                continue
            over = allocation.drift_pp > 0
            direction = "overweight" if over else "underweight"
            amount = f"{format_amount(abs(allocation.drift_value_base))} {currency}"
            gap = f"{amount} ponad cel" if over else f"do celu brakuje {amount}"
            message = (
                f"Koszyk {bucket_id} {'powyżej' if over else 'poniżej'} celu o "
                f"{format_pp(abs(allocation.drift_pp))} ({format_pct(allocation.weight)} wobec "
                f"{format_pct(allocation.target)}, {gap})."
            )
            outcomes.append(
                Fired(
                    SignalCandidate(
                        rule_id=spec.id,
                        kind=self.kind,
                        dedup_key=key,
                        severity=spec.severity,
                        message=message,
                        payload={**details, "direction": direction},
                    )
                )
            )
        return outcomes


def drift_bucket_generic(payload: Mapping[str, object] | None) -> bool:
    """``bucket_generic`` of an allocation_drift payload. Rows stored before the key existed derive it
    from ``bucket_id`` (no bucket id: generic, nothing to name)."""
    data = payload or {}
    flag = data.get("bucket_generic")
    if isinstance(flag, bool):
        return flag
    bucket_id = data.get("bucket_id")
    return bucket_id is None or is_generic_bucket(bucket_id)


def with_bucket_generic(kind: str, payload: dict | None) -> dict | None:
    """``payload`` of a stored signal with ``bucket_generic`` filled in for an allocation_drift row
    stored before the key existed (API reads); any other payload as is."""
    if kind != AllocationDriftRule.KIND or payload is None or "bucket_generic" in payload:
        return payload
    return {**payload, "bucket_generic": drift_bucket_generic(payload)}


def hidden_from_owner(kind: str, payload: Mapping[str, object] | None) -> bool:
    """True for an allocation_drift signal of a non-generic bucket: macOS notifications and the weekly
    digest skip it. The signal itself, the rules and MCP are unchanged."""
    return kind == AllocationDriftRule.KIND and not drift_bucket_generic(payload)
