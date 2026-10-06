"""The model recommendation per instrument.

The legacy module and column names use ``plan`` for migration compatibility. The value is generated
by the connected model from research, thesis health, portfolio construction and strategy. It is not
the owner's decision and it never places an order. The owner records a decision separately.

Values (wire names, stored in ``inv_profile_instruments.plan``; None = no plan):

=============  ==================  ==========  =========
value          held label          watched     held only
=============  ==================  ==========  =========
``buy_asap``   dokup asap          kup asap    no
``buy``        dokup               kup         no
``hold``       trzymaj             czekam      no
``reduce``     redukuj             -           yes
``exit_asap``  pozbądź się asap    -           yes
=============  ==================  ==========  =========

A reduce / exit recommendation is stale when the position is gone or was reopened after generation.
Views then emit it as None; the stored value stays for auditability.
"""

from __future__ import annotations

import datetime as dt

PLAN_VALUES = ("buy_asap", "buy", "hold", "reduce", "exit_asap")
HELD_ONLY_PLANS = frozenset({"reduce", "exit_asap"})
BUY_PLANS = frozenset({"buy", "buy_asap"})

PLAN_LABEL_HELD = {
    "buy_asap": "dokup asap",
    "buy": "dokup",
    "hold": "trzymaj",
    "reduce": "redukuj",
    "exit_asap": "pozbądź się asap",
}
"""Polish labels of a held instrument's plan (the dashboard shows the same)."""

PLAN_LABEL_WATCHED = {"buy_asap": "kup asap", "buy": "kup", "hold": "czekam"}
"""Polish labels of a watched (not held) instrument's plan."""


def is_plan(value: object) -> bool:
    return isinstance(value, str) and value in PLAN_VALUES


def effective_plan(
    plan: str | None,
    *,
    held: bool | None,
    plan_at: dt.datetime | None = None,
    opened: dt.date | None = None,
) -> str | None:
    """The plan as views and checks use it: a held-only plan (reduce / exit_asap) is None when the
    instrument is not held, or when ``plan_at`` (UTC) falls on a day before ``opened`` (the day the
    current holding last reopened from zero, :func:`opened_on`). ``held=None`` (unknown) keeps it; a
    plan written on the opening day counts as current."""
    if plan is None or not is_plan(plan):
        return None
    if plan in HELD_ONLY_PLANS:
        if held is False:
            return None
        if held and plan_at is not None and opened is not None and plan_at.date() < opened:
            return None
    return plan


def opened_on(holdings, realized=()) -> dt.date | None:
    """The day the current holding of one instrument last reopened from zero: the first buy after the
    quantity was last 0 (for a never-closed position, its first lot). ``holdings``: its
    ``domain.Holding`` rows (any accounts); ``realized``: ``domain.RealizedTrade`` rows (other
    instruments are ignored). A closed lot part held on the day before the candidate date (opened
    before it, closed on or after it) means the position was not at zero: the date moves back to its
    open date, until no closed part bridges the gap (a sell-out and a re-buy on the same day count as
    continuous). None without open lots."""
    holdings = list(holdings)
    dates = [lot.open_date for h in holdings for lot in h.lots]
    if not dates:
        return None
    start = min(dates)
    ids = {h.instrument_id for h in holdings}
    spans = sorted((r.open_date, r.close_date) for r in realized if r.instrument_id in ids)
    moved = True
    while moved:
        moved = False
        for opened, closed in spans:
            if opened < start <= closed:
                start, moved = opened, True
    return start


def plan_label(plan: str | None, *, held: bool) -> str | None:
    """Polish label of ``plan`` for a held or a watched instrument (None: no plan / not allowed)."""
    if plan is None:
        return None
    return (PLAN_LABEL_HELD if held else PLAN_LABEL_WATCHED).get(plan)


__all__ = [
    "BUY_PLANS",
    "HELD_ONLY_PLANS",
    "PLAN_LABEL_HELD",
    "PLAN_LABEL_WATCHED",
    "PLAN_VALUES",
    "effective_plan",
    "is_plan",
    "opened_on",
    "plan_label",
]
