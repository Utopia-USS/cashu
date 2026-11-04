"""Signal lifecycle as a pure function: one run's rule outcomes + the stored open signals -> actions.

Persistence is the caller's job: it loads the open signals (and, for cooldowns, the newest closed signal
of each dedup key), calls :func:`reconcile_signals`, and applies the returned actions in one transaction.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from cashu.modules.investments.domain import SignalSeverity, SignalStatus, severity_rank

from .kind import RuleSpec
from .outcomes import Fired, NotFired, RuleOutcome, SignalCandidate, Skipped


@dataclass(frozen=True, slots=True)
class OpenSignal:
    """A stored open signal (status active or acknowledged) as a plain record."""

    signal_id: object
    """Persistence id, passed back in the actions untouched."""
    rule_id: str
    dedup_key: str
    severity: SignalSeverity
    status: SignalStatus = SignalStatus.ACTIVE
    last_seen_at: datetime | None = None
    """When a run last confirmed it (fired); drives the ``max_unverified_days`` expiry."""


@dataclass(frozen=True, slots=True)
class ClosedSignal:
    """The newest closed (resolved or expired) signal of one dedup key, for cooldowns."""

    dedup_key: str
    resolved_at: datetime
    """When it was resolved (for an expired signal: when it expired)."""


@dataclass(frozen=True, slots=True)
class CreateSignal:
    """A new active signal (eligible for one notification)."""

    candidate: SignalCandidate
    created_at: datetime


@dataclass(frozen=True, slots=True)
class RefreshSignal:
    """The open signal still fires at the same or a lower severity: update last seen, message, payload
    and severity (a lower severity after a rule edit is stored as a plain refresh)."""

    signal_id: object
    candidate: SignalCandidate
    seen_at: datetime


@dataclass(frozen=True, slots=True)
class EscalateSignal:
    """The open signal fires at a higher severity: update it like a refresh and notify again; an
    acknowledged signal becomes active again (``reactivate``)."""

    signal_id: object
    candidate: SignalCandidate
    previous_severity: SignalSeverity
    reactivate: bool
    seen_at: datetime


@dataclass(frozen=True, slots=True)
class ResolveSignal:
    """The open signal's scope was evaluated on good data and no longer fires."""

    signal_id: object
    rule_id: str
    dedup_key: str
    resolved_at: datetime


@dataclass(frozen=True, slots=True)
class ExpireSignal:
    """The open signal's rule is no longer in the strategy, or (``reason`` :data:`UNVERIFIED`) no run
    confirmed it for longer than ``max_unverified_days``."""

    signal_id: object
    rule_id: str
    dedup_key: str
    expired_at: datetime
    reason: str | None = None
    """None for a removed rule; :data:`UNVERIFIED` for an age-based close (stored as the payload's
    ``closed_reason`` and ``closed_by``, so it never starts a cooldown)."""


@dataclass(frozen=True, slots=True)
class SuppressCandidate:
    """A fired candidate not stored: a signal with the same key closed within the rule's cooldown."""

    candidate: SignalCandidate
    cooldown_until: datetime


UNVERIFIED = "unverified"
"""``closed_reason`` / ``closed_by`` of a signal closed because no run confirmed it for too long."""

SignalAction = (
    CreateSignal | RefreshSignal | EscalateSignal | ResolveSignal | ExpireSignal | SuppressCandidate
)


@dataclass(frozen=True, slots=True)
class SignalReconciliation:
    """What one run changes, in order: fired candidates first (outcome order), then resolutions and
    expiries (open-signal order). Open signals not mentioned stay untouched."""

    actions: tuple[SignalAction, ...] = ()
    untouched: tuple[OpenSignal, ...] = field(default=())
    """Open signals left as they are (rule skipped, or rule absent from the outcomes)."""

    def _of[T](self, action_type: type[T]) -> list[T]:
        return [action for action in self.actions if isinstance(action, action_type)]

    @property
    def created(self) -> list[CreateSignal]:
        return self._of(CreateSignal)

    @property
    def refreshed(self) -> list[RefreshSignal]:
        return self._of(RefreshSignal)

    @property
    def escalated(self) -> list[EscalateSignal]:
        return self._of(EscalateSignal)

    @property
    def resolved(self) -> list[ResolveSignal]:
        return self._of(ResolveSignal)

    @property
    def expired(self) -> list[ExpireSignal]:
        return self._of(ExpireSignal)

    @property
    def suppressed(self) -> list[SuppressCandidate]:
        return self._of(SuppressCandidate)

    @property
    def stats(self) -> dict[str, int]:
        """Counters for the rule-run record."""
        return {
            "signals_new": len(self.created),
            "signals_escalated": len(self.escalated),
            "signals_refreshed": len(self.refreshed),
            "signals_resolved": len(self.resolved),
            "signals_expired": len(self.expired),
            "signals_suppressed": len(self.suppressed),
        }


def reconcile_signals(
    *,
    open_signals: Iterable[OpenSignal],
    outcomes: Iterable[RuleOutcome],
    rules: Sequence[RuleSpec[object]],
    clock: Callable[[], datetime],
    closed_signals: Iterable[ClosedSignal] = (),
    max_unverified_days: int | None = None,
) -> SignalReconciliation:
    """Turns one run's ``outcomes`` (from the engine over ``rules``) into lifecycle actions.

    - Fired with a new dedup key -> :class:`CreateSignal`, unless the newest closed signal of that key
      was resolved less than the rule's ``cooldown_days`` ago -> :class:`SuppressCandidate`.
    - Fired with an open signal -> :class:`EscalateSignal` when the severity goes up, else
      :class:`RefreshSignal`. Several candidates with one key: the highest severity wins, then the first.
    - An open signal that did not fire, whose rule produced outcomes in this run and no Skipped for its
      scope or for the whole rule -> :class:`ResolveSignal` (covers NotFired of its scope, a whole-rule
      NotFired and a scope that disappeared, e.g. an instrument sold).
    - Skipped (scope or whole rule), or a rule absent from the outcomes -> untouched.
    - An open signal whose rule id is not in ``rules`` (rule removed) -> :class:`ExpireSignal`.
    - An open signal that would stay untouched and whose ``last_seen_at`` is more than
      ``max_unverified_days`` days before ``now`` -> :class:`ExpireSignal` with ``reason``
      :data:`UNVERIFIED` (None: never; a signal without ``last_seen_at`` never expires this way).

    ``clock`` is called once; all timestamps of the run use that instant.
    """
    now = clock()
    open_list = list(open_signals)
    open_by_key: dict[str, OpenSignal] = {}
    for signal in open_list:
        if signal.dedup_key in open_by_key:
            raise ValueError(f"Two open signals share the dedup key {signal.dedup_key!r}")
        open_by_key[signal.dedup_key] = signal
    last_closed: dict[str, datetime] = {}
    for closed in closed_signals:
        previous = last_closed.get(closed.dedup_key)
        if previous is None or closed.resolved_at > previous:
            last_closed[closed.dedup_key] = closed.resolved_at
    cooldowns = {rule.id: rule.cooldown_days for rule in rules}

    fired: dict[str, SignalCandidate] = {}
    evaluated_rules: set[str] = set()
    skipped_rules: set[str] = set()
    skipped_keys: set[str] = set()
    for outcome in outcomes:
        evaluated_rules.add(outcome.rule_id)
        match outcome:
            case Fired(candidate=candidate):
                current = fired.get(candidate.dedup_key)
                if current is None or severity_rank(candidate.severity) > severity_rank(
                    current.severity
                ):
                    fired[candidate.dedup_key] = candidate
            case NotFired():
                pass
            case Skipped(rule_id=rule_id, dedup_key=dedup_key):
                if dedup_key is None:
                    skipped_rules.add(rule_id)
                else:
                    skipped_keys.add(dedup_key)

    actions: list[SignalAction] = []
    for candidate in fired.values():
        existing = open_by_key.get(candidate.dedup_key)
        if existing is not None:
            if severity_rank(candidate.severity) > severity_rank(existing.severity):
                actions.append(
                    EscalateSignal(
                        existing.signal_id,
                        candidate,
                        existing.severity,
                        existing.status == SignalStatus.ACKNOWLEDGED,
                        now,
                    )
                )
            else:
                actions.append(RefreshSignal(existing.signal_id, candidate, now))
            continue
        cooldown_days = cooldowns.get(candidate.rule_id)
        closed_at = last_closed.get(candidate.dedup_key)
        if cooldown_days and closed_at is not None:
            until = closed_at + timedelta(days=cooldown_days)
            if now < until:
                actions.append(SuppressCandidate(candidate, until))
                continue
        actions.append(CreateSignal(candidate, now))

    untouched: list[OpenSignal] = []
    for signal in open_list:
        if signal.dedup_key in fired:
            continue
        if signal.rule_id not in cooldowns:
            actions.append(ExpireSignal(signal.signal_id, signal.rule_id, signal.dedup_key, now))
            continue
        if (
            signal.rule_id not in evaluated_rules
            or signal.rule_id in skipped_rules
            or signal.dedup_key in skipped_keys
        ):
            if _unverified_too_long(signal, now, max_unverified_days):
                actions.append(
                    ExpireSignal(
                        signal.signal_id, signal.rule_id, signal.dedup_key, now, UNVERIFIED
                    )
                )
            else:
                untouched.append(signal)
            continue
        actions.append(ResolveSignal(signal.signal_id, signal.rule_id, signal.dedup_key, now))
    return SignalReconciliation(tuple(actions), tuple(untouched))


def _unverified_too_long(signal: OpenSignal, now: datetime, max_days: int | None) -> bool:
    if max_days is None or signal.last_seen_at is None:
        return False
    seen = signal.last_seen_at
    if seen.tzinfo is None and now.tzinfo is not None:
        seen = seen.replace(tzinfo=now.tzinfo)
    return now - seen > timedelta(days=max_days)
