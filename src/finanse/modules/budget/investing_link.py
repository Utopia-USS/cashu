"""Read-only link from the budget to the investments strategy: the planned monthly contribution.

The month close compares the budget surplus with the strategy's ``contributions.monthly_amount``.
The strategy is read through the investments strategy service (``service.strategy.load`` with
``record=False``: nothing is written, no version is stored), and only when the investments module is
enabled for the profile. This is the budget module's only touch point with investments.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from sqlmodel import Session

from finanse.core import profiles
from finanse.core.models import Profile


@dataclass(frozen=True)
class PlannedContribution:
    strategy_state: str
    """missing | valid | partial | invalid (the investments strategy service's states)."""
    amount: Decimal | None = None
    """``contributions.monthly_amount``; None when the strategy has no contributions plan."""
    currency: str | None = None
    """The strategy's base currency (the plan is in it)."""
    day_of_month: int | None = None


def investments_enabled(session: Session, profile: Profile) -> bool:
    if not profile.id:
        return False
    return "investments" in profiles.enabled_modules(session, profile.id)


def planned_contribution(session: Session, profile: Profile) -> PlannedContribution | None:
    """The plan from the profile's strategy; None when investments is off for the profile."""
    if not investments_enabled(session, profile):
        return None
    from finanse.modules.investments.service import strategy as strategy_service

    state = strategy_service.load(session, profile, record=False)
    config = state.config  # the valid config, or the partial one (only some rules inactive)
    plan = config.contributions if config is not None else None
    if plan is None:
        return PlannedContribution(strategy_state=state.state)
    return PlannedContribution(
        strategy_state=state.state,
        amount=Decimal(plan.monthly_amount),
        currency=str(config.base_currency),
        day_of_month=plan.day_of_month,
    )
