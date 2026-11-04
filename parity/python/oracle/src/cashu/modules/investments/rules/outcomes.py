"""Results of evaluating rules: one outcome per checked scope (a bucket, an instrument, the portfolio).

Lifecycle meaning (see :mod:`.lifecycle`): :class:`Fired` creates or refreshes the signal with its dedup
key; :class:`NotFired` lets an open signal of that scope resolve; :class:`Skipped` leaves open signals of
that scope untouched (it never counts as "condition cleared").
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

from cashu.modules.investments.domain import AccountId, InstrumentId, SignalSeverity

from .polarity import SignalPolarity


@dataclass(frozen=True, slots=True)
class SignalCandidate:
    """What a fired rule wants to become (or refresh) as a stored signal."""

    rule_id: str
    kind: str
    dedup_key: str
    """Stable identity of the finding over time; build it with :func:`signal_dedup_key`."""
    severity: SignalSeverity
    message: str
    """Short, Polish (the owner sees it in notifications and the signal list), deterministic (same input
    -> same text)."""
    instrument_id: InstrumentId | None = None
    account_id: AccountId | None = None
    payload: Mapping[str, object] = field(default_factory=dict, hash=False)
    """JSON-encodable measured values, thresholds and context."""
    polarity: SignalPolarity = SignalPolarity.NEUTRAL
    """Opportunity / risk / information; the engine sets it from the rule (``polarity:``) or the kind's
    default."""


@dataclass(frozen=True, slots=True)
class Fired:
    """The condition holds: a signal candidate."""

    candidate: SignalCandidate

    @property
    def rule_id(self) -> str:
        return self.candidate.rule_id

    @property
    def dedup_key(self) -> str:
        return self.candidate.dedup_key


@dataclass(frozen=True, slots=True)
class NotFired:
    """The rule was evaluated on good data and the condition does not hold."""

    rule_id: str
    dedup_key: str | None = None
    """Scope this outcome covers (the key a Fired outcome would have used); None = the whole rule."""
    details: Mapping[str, object] = field(default_factory=dict, hash=False)
    """JSON-encodable measured values and thresholds (for logs / UI)."""


@dataclass(frozen=True, slots=True)
class Skipped:
    """The rule could not be evaluated (stale or missing data, an error). Never "condition cleared"."""

    rule_id: str
    reason: str
    """Short Polish reason (``Nieaktualna cena: X (ostatnie zamknięcie 2026-09-25, 7 dni temu)``);
    programming errors (an exception, a wrong params type) stay English."""
    dedup_key: str | None = None
    """Scope this outcome covers; None = the whole rule."""


RuleOutcome = Fired | NotFired | Skipped


def signal_dedup_key(
    rule_id: str,
    *,
    instrument_id: InstrumentId | None = None,
    account_id: AccountId | None = None,
    scope: str | None = None,
) -> str:
    """Canonical dedup key: ``rule_id``, then optional ``i:<instrument>``, ``a:<account>``, ``s:<scope>``
    (e.g. a bucket id), joined by ``|``. Use it for Fired candidates and NotFired / Skipped scopes alike."""
    parts = [rule_id]
    if instrument_id is not None:
        parts.append(f"i:{instrument_id}")
    if account_id is not None:
        parts.append(f"a:{account_id}")
    if scope is not None:
        parts.append(f"s:{scope}")
    return "|".join(parts)


def outcome_scope(outcome: RuleOutcome) -> str | None:
    """The dedup key an outcome covers (None = the whole rule)."""
    if isinstance(outcome, Fired):
        return outcome.candidate.dedup_key
    return outcome.dedup_key
