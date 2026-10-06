"""Fixtures of the alert tests: the rule fixtures (synthetic instruments, bars, valued portfolios,
contexts) re-exported, plus alert builders. Every value is invented."""

from __future__ import annotations

import sys
from pathlib import Path

_RULES = Path(__file__).resolve().parents[1] / "rules"
if str(_RULES) not in sys.path:
    sys.path.insert(0, str(_RULES))

from rules_fixtures import (
    AS_OF,
    alloc,
    bars,
    context,
    d,
    h,
    instrument,
    portfolio,
)

from cashu.modules.investments.alerts import (
    AlertData,
    AlertDefinition,
    AlertKind,
    AlertScope,
    evaluate_alert,
    validate,
)
from cashu.modules.investments.domain import SignalSeverity
from cashu.modules.investments.rules import SignalPolarity

__all__ = [
    "AS_OF",
    "alert",
    "alloc",
    "bars",
    "check",
    "context",
    "d",
    "h",
    "instrument",
    "portfolio",
]


def alert(
    kind: str,
    params: dict,
    *,
    inst=None,
    scope: str | None = None,
    title: str = "Test alert",
    polarity: SignalPolarity = SignalPolarity.NEGATIVE,
    severity: SignalSeverity = SignalSeverity.ACTION,
    alert_id: int = 7,
) -> AlertDefinition:
    """An alert validated by the catalog (so the params are the normalized ones)."""
    valid = validate(kind, params, scope=scope, has_instrument=inst is not None)
    return AlertDefinition(
        id=alert_id,
        kind=AlertKind(valid.kind),
        scope=AlertScope(valid.scope),
        params=valid.params,
        title=title,
        polarity=polarity,
        severity=severity,
        instrument=inst,
    )


def check(definition: AlertDefinition, *, series=None, ctx=None, max_age: int = 5):
    data = AlertData(
        as_of=AS_OF,
        bars={inst.id: closes for inst, closes in (series or {}).items()},
        max_price_age_days=max_age,
        ctx=ctx,
    )
    return evaluate_alert(definition, data)
