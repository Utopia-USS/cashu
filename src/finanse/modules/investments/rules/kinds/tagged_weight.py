"""``tagged_weight``: holdings carrying a set of tags are together too large a share of the portfolio."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from ..kind import RuleContext, RuleSpec
from ..outcomes import Fired, NotFired, RuleOutcome, SignalCandidate, Skipped, signal_dedup_key
from ..params import ParamErrors, ParamReader
from ..polarity import SignalPolarity
from .support import (
    RATIO_EPSILON,
    format_pct,
    has_all_tags,
    instrument_label,
    portfolio_data_problem,
    unclassified_problem,
)


@dataclass(frozen=True, slots=True)
class TaggedWeightParams:
    tags: tuple[str, ...]
    """Every holding carrying ALL of these tags counts (case-insensitive, like bucket ``match.tags``)."""
    max_weight: float
    """Largest allowed summed weight (0.30 = 30%)."""


def tagged_weight(ctx: RuleContext, tags: tuple[str, ...]) -> tuple[float, list[str]]:
    """Summed weight of holdings carrying all ``tags`` and their labels (sorted). Weights must be
    trustworthy (check :func:`portfolio_data_problem` first)."""
    total = 0.0
    labels: set[str] = set()
    for holding in ctx.portfolio.valued:
        if has_all_tags(holding.instrument, tags):
            total += holding.weight or 0.0
            labels.add(instrument_label(holding.instrument))
    return total, sorted(labels)


class TaggedWeightRule:
    """Whole portfolio: fires once for the tag set when the summed weight of holdings carrying all
    ``tags`` exceeds ``max_weight``. Same skip rules as the other weight-based kinds (stale share,
    unpriced holdings, missing FX, empty portfolio), plus holdings matching no bucket above
    ``data.max_unclassified_weight``: such fresh imports usually lack tags, so the sum would be too low."""

    KIND = "tagged_weight"
    DEFAULT_POLARITY = SignalPolarity.NEGATIVE  # a tagged group out of its weight range

    @property
    def kind(self) -> str:
        return self.KIND

    @property
    def params_type(self) -> type:
        return TaggedWeightParams

    def parse_params(self, raw: Mapping[str, object], errors: ParamErrors) -> TaggedWeightParams:
        reader = ParamReader(raw, errors)
        tags = reader.strings("tags")
        if not tags and not reader.has("tags"):
            errors.error("tags", "tags is required (one tag or a list of tags)")
        max_weight = reader.number("max_weight", minimum=0, maximum=1, exclusive_min=True)
        reader.finish()
        return TaggedWeightParams(tags, max_weight)

    def evaluate(self, ctx: RuleContext, spec: RuleSpec[TaggedWeightParams]) -> list[RuleOutcome]:
        problem = portfolio_data_problem(ctx) or unclassified_problem(ctx)
        if problem is not None:
            return [Skipped(spec.id, problem)]
        params = spec.params
        weight, labels = tagged_weight(ctx, params.tags)
        key = signal_dedup_key(spec.id)
        details: dict[str, object] = {
            "tags": list(params.tags),
            "weight": weight,
            "max_weight": params.max_weight,
            "instruments": labels,
        }
        if weight <= params.max_weight + RATIO_EPSILON:
            return [NotFired(spec.id, key, details)]
        tag_text = ", ".join(params.tags)
        return [
            Fired(
                SignalCandidate(
                    rule_id=spec.id,
                    kind=self.kind,
                    dedup_key=key,
                    severity=spec.severity,
                    payload=details,
                    message=(
                        f"Pozycje z tagami {tag_text}: {format_pct(weight)} portfela "
                        f"(maks {format_pct(params.max_weight)}): {', '.join(labels)}."
                    ),
                )
            )
        ]
