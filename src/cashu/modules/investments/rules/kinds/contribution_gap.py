"""``contribution_gap``: planned deposits stopped (the "stopped paying in" pattern)."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from cashu.modules.investments.domain import CalendarDate, days_between

from ..kind import RuleContext, RuleSpec
from ..outcomes import Fired, NotFired, RuleOutcome, SignalCandidate, Skipped, signal_dedup_key
from ..params import ParamErrors, ParamReader
from ..polarity import SignalPolarity
from .support import days_phrase, decimal_text, format_decimal

DEFAULT_PERIOD_DAYS = 31
DEFAULT_GRACE_DAYS = 10
NO_CONTRIBUTIONS_PLAN = "Strategia nie ma planu wpłat"


@dataclass(frozen=True, slots=True)
class ContributionGapParams:
    period_days: int = DEFAULT_PERIOD_DAYS
    """Expected days between deposits (31 for a monthly plan)."""
    grace_days: int = DEFAULT_GRACE_DAYS
    """Extra days tolerated before the gap fires."""


def last_deposit_date(ctx: RuleContext) -> CalendarDate | None:
    """Date of the newest deposit in any account, or None when there is none."""
    dates = [deposit.date for deposit in ctx.portfolio.snapshot.deposits]
    return max(dates) if dates else None


class ContributionGapRule:
    """Whole profile: fires when the days since the last deposit (any account) exceed ``period_days +
    grace_days``; with a contributions plan and no deposit at all it fires "No deposits yet". Needs the
    strategy's ``contributions:`` plan: without one it skips (the loader warns about that)."""

    KIND = "contribution_gap"
    DEFAULT_POLARITY = SignalPolarity.NEGATIVE  # a deposit gap

    @property
    def kind(self) -> str:
        return self.KIND

    @property
    def params_type(self) -> type:
        return ContributionGapParams

    def parse_params(self, raw: Mapping[str, object], errors: ParamErrors) -> ContributionGapParams:
        reader = ParamReader(raw, errors)
        params = ContributionGapParams(
            period_days=reader.integer("period_days", fallback=DEFAULT_PERIOD_DAYS, minimum=1),
            grace_days=reader.integer("grace_days", fallback=DEFAULT_GRACE_DAYS, minimum=0),
        )
        reader.finish()
        return params

    def evaluate(
        self, ctx: RuleContext, spec: RuleSpec[ContributionGapParams]
    ) -> list[RuleOutcome]:
        plan = ctx.contributions
        key = signal_dedup_key(spec.id)
        if plan is None:
            return [Skipped(spec.id, NO_CONTRIBUTIONS_PLAN, key)]
        params = spec.params
        allowed_days = params.period_days + params.grace_days
        plan_details: dict[str, object] = {
            "monthly_amount": decimal_text(plan.monthly_amount),
            "day_of_month": plan.day_of_month,
            "period_days": params.period_days,
            "grace_days": params.grace_days,
        }
        last = last_deposit_date(ctx)
        if last is None:
            return [
                Fired(
                    SignalCandidate(
                        rule_id=spec.id,
                        kind=self.kind,
                        dedup_key=key,
                        severity=spec.severity,
                        payload={
                            **plan_details,
                            "last_deposit": None,
                            "days_since_last_deposit": None,
                        },
                        message=(
                            f"Brak wpłat, choć plan zakłada {format_decimal(plan.monthly_amount)} "
                            f"{ctx.portfolio.base_currency} miesięcznie."
                        ),
                    )
                )
            ]
        days = days_between(last, ctx.as_of)
        details = {
            **plan_details,
            "last_deposit": last.isoformat(),
            "days_since_last_deposit": days,
        }
        if days <= allowed_days:
            return [NotFired(spec.id, key, details)]
        return [
            Fired(
                SignalCandidate(
                    rule_id=spec.id,
                    kind=self.kind,
                    dedup_key=key,
                    severity=spec.severity,
                    payload=details,
                    message=(
                        f"Brak wpłaty od {days_phrase(days)} (ostatnia {last}); plan dopuszcza "
                        f"{days_phrase(allowed_days)}."
                    ),
                )
            )
        ]
