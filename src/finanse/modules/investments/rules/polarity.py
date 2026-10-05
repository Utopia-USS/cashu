"""Signal polarity: whether a finding is an opportunity, a risk or just information.

Each rule kind declares a default (``DEFAULT_POLARITY`` on the kind class); a strategy rule may override
it with an optional ``polarity:`` key, and alerts carry their own. Polarity never changes when or whether
a rule fires; it only tells the UI how to present the signal.
"""

from __future__ import annotations

from enum import StrEnum


class SignalPolarity(StrEnum):
    """``positive``: an opportunity per the owner's own rules (a dip tranche reached on a core holding,
    a gain target met, a price back above a level); ``negative``: a risk or something to review (a loss
    from cost, concentration, cash or deposit gaps, an alert breach); ``neutral``: information or a
    plain review item (allocation drift out of band)."""

    POSITIVE = "positive"
    NEGATIVE = "negative"
    NEUTRAL = "neutral"


def default_polarity(kind: object) -> SignalPolarity:
    """The default polarity a rule kind (object or class) declares; neutral when it declares none."""
    value = getattr(kind, "DEFAULT_POLARITY", None)
    return value if isinstance(value, SignalPolarity) else SignalPolarity.NEUTRAL


def polarity_rank(polarity: str | SignalPolarity) -> int:
    """Sort key for attention lists: negative first, then positive, then neutral (unknown last)."""
    order = {SignalPolarity.NEGATIVE: 0, SignalPolarity.POSITIVE: 1, SignalPolarity.NEUTRAL: 2}
    try:
        return order[SignalPolarity(polarity)]
    except ValueError:
        return 3
