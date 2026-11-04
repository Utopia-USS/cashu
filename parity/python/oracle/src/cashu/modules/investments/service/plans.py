"""The model recommendation per instrument (P1): persistence and recommendation-check signal
lifecycle.

The checks (pure, ``investments.plan``) run over every held instrument in the daily check
(:func:`evaluate_profile`, next to the alert and research passes) and again for one instrument right
after the owner writes its plan or its thesis, or a research note of it is stored, dismissed or
restored (:func:`sync_instrument`, :func:`sync_after_note`), so a signal appears or resolves without
waiting for the next run. Both go through ``rules.reconcile_signals`` +
``store.signals.apply_reconciliation`` with the profile's notification policy (default: action only).

Savepoints: pysqlite emits ``BEGIN`` only before the first DML, so a ``SAVEPOINT`` issued before any
write would become the outermost transaction and its ``RELEASE`` would commit it. :func:`isolated`
therefore opens a savepoint only when the driver connection already holds a transaction (the daily
run flushed its run row, the API flushed the plan / thesis write); otherwise it runs without one.

Facts per held instrument (and, P2, per watched instrument not held: ``plan_vs_thesis`` only, no
unrealized result): the plan (the profile's view of the instrument; a stale held-only plan
counts as none, ``domain.effective_plan``), the thesis health as of
``now`` (``research.views.health_by_instrument``, the summary's computation), whether the newest thesis
has a non-blank ``exit_plan``, and the unrealized result vs cost from the valued portfolio (base
currency, every account; None when a value or cost is unknown, stale when any price is stale).
"""

from __future__ import annotations

import datetime as dt
import logging
from collections import defaultdict
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from decimal import Decimal

from sqlmodel import Session

from cashu.core.models import Profile, utcnow

from ..domain import SignalSeverity, ValuedHolding, ValuedPortfolio, effective_plan, opened_on
from ..plan import PlanFacts, evaluate, is_plan_key, rule_specs
from ..plan.checks import CHECKS
from ..plan.keys import plan_dedup_key, plan_rule_id
from ..research import service as research_service
from ..research import views as research_views
from ..research.scoring import CANDIDATE_KIND
from ..rules import DataQualityPolicy, Fired, NotFired, RuleOutcome, Skipped, reconcile_signals
from ..store import convert, signals
from ..store import instruments as instrument_store
from ..strategy import NotificationPolicy, StrategyConfig

_log = logging.getLogger("cashu.investments.plans")


@dataclass
class PlanRun:
    created: list[int] = field(default_factory=list)
    escalated: list[int] = field(default_factory=list)
    resolved: list[int] = field(default_factory=list)
    notified: list[int] = field(default_factory=list)
    stats: dict = field(default_factory=dict)


def _unrealized(held: list[ValuedHolding]) -> tuple[float | None, bool]:
    """(value - cost) / cost over every account's holding of one instrument, and whether a price is
    stale (None when any value or cost is unknown, or the cost is zero)."""
    stale = any(v.is_stale for v in held)
    values = [v.market_value_base for v in held]
    costs = [v.cost_basis_base for v in held]
    if any(x is None for x in values) or any(x is None for x in costs):
        return None, stale
    value = sum(values, Decimal(0))
    cost = sum(costs, Decimal(0))
    if not cost:
        return None, stale
    return float((value - cost) / cost), stale


def facts(
    session: Session,
    profile_id: int,
    valued: ValuedPortfolio,
    now: dt.datetime,
    *,
    only: int | None = None,
) -> list[PlanFacts]:
    """The checks' input for every held instrument, then every watched one not held (``only``: that
    one alone)."""
    grouped: dict[int, list[ValuedHolding]] = defaultdict(list)
    for v in valued.valued:
        key = convert.pk(v.instrument_id)
        if only is None or key == only:
            grouped[key].append(v)
    watched = {
        iid
        for iid in research_service.watched_instrument_ids(session, profile_id)
        if iid not in grouped and (only is None or iid == only)
    }
    if not grouped and not watched:
        return []
    health = research_views.health_by_instrument(session, profile_id, set(grouped) | watched, now)
    out: list[PlanFacts] = []
    for iid, held in sorted(grouped.items()):
        inst = held[0].instrument
        result, thesis = health[iid]
        unrealized, stale = _unrealized(held)
        out.append(
            PlanFacts(
                instrument_id=iid,
                label=inst.label,
                symbol=inst.symbol,
                # a stale held-only plan (written before the current holding opened) is no plan
                plan=effective_plan(
                    inst.plan,
                    held=True,
                    plan_at=inst.plan_at,
                    opened=opened_on((v.holding for v in held), valued.snapshot.realized),
                ),
                health=result.state.value,
                has_exit_plan=bool(thesis is not None and (thesis.exit_plan or "").strip()),
                unrealized=unrealized,
                price_stale=stale,
            )
        )
    loaded = instrument_store.load(session, watched, profile_id=profile_id) if watched else {}
    for iid in sorted(watched):
        inst = loaded.get(iid)
        if inst is None:
            continue
        result, thesis = health[iid]
        out.append(
            PlanFacts(
                instrument_id=iid,
                label=inst.label,
                symbol=inst.symbol,
                plan=effective_plan(inst.plan, held=False),
                health=result.state.value,
                has_exit_plan=bool(thesis is not None and (thesis.exit_plan or "").strip()),
                unrealized=None,
                held=False,
            )
        )
    return out


def _apply(
    session: Session,
    profile: Profile,
    outcomes: list[RuleOutcome],
    *,
    now: dt.datetime,
    run_id: int | None,
    notify: frozenset[SignalSeverity],
    max_unverified_days: int | None,
    instrument_id: int | None = None,
) -> tuple[PlanRun, object]:
    assert profile.id is not None
    open_plan = [o for o in signals.open_signals(session, profile.id) if is_plan_key(o.dedup_key)]
    if instrument_id is not None:
        keys = {plan_dedup_key(check, instrument_id) for check in CHECKS}
        open_plan = [o for o in open_plan if o.dedup_key in keys]
    reconciliation = reconcile_signals(
        open_signals=open_plan,
        outcomes=outcomes,
        rules=rule_specs(),
        clock=lambda: now,
        max_unverified_days=max_unverified_days,
    )
    applied = signals.apply_reconciliation(
        session, profile.id, reconciliation, run_id=run_id, notify=notify
    )
    run = PlanRun(
        created=list(applied.created),
        escalated=list(applied.escalated),
        resolved=list(applied.resolved),
        notified=list(applied.notified),
    )
    return run, reconciliation


def evaluate_profile(
    session: Session,
    profile: Profile,
    *,
    valued: ValuedPortfolio,
    now: dt.datetime,
    config: StrategyConfig | None,
    run_id: int | None,
) -> PlanRun:
    """The daily pass: both checks over every held and watched instrument, in the caller's
    transaction. Open plan signals of instruments neither held nor watched any more resolve (each check also reports a whole-check NotFired)."""
    assert profile.id is not None
    now = convert.aware(now)
    found = facts(session, profile.id, valued, now)
    outcomes = evaluate(found)
    # A whole-check NotFired: an open signal of an instrument that is gone resolves; a Skipped of
    # its own scope still protects it.
    outcomes += [NotFired(plan_rule_id(check)) for check in CHECKS]
    run, reconciliation = _apply(
        session,
        profile,
        outcomes,
        now=now,
        run_id=run_id,
        notify=(config.notifications if config is not None else NotificationPolicy()).immediate,
        max_unverified_days=(
            config.data.max_unverified_days
            if config is not None
            else DataQualityPolicy().max_unverified_days
        ),
    )
    run.stats = {
        "plan_checked": len(found),
        "plan_fired": sum(isinstance(o, Fired) for o in outcomes),
        "plan_skipped": sum(isinstance(o, Skipped) for o in outcomes),
        "plan_signals_new": len(reconciliation.created),
        "plan_signals_resolved": len(reconciliation.resolved),
        "plan_notifications": len(run.notified),
    }
    return run


def driver_in_transaction(session: Session) -> bool:
    """Whether the session's DB-API connection holds an open transaction (a write was issued)."""
    dbapi = session.connection().connection.dbapi_connection
    return bool(getattr(dbapi, "in_transaction", False))


@contextmanager
def isolated(session: Session) -> Iterator[bool]:
    """A savepoint around the block when the driver already holds a transaction (yields True: an
    exception rolls the block back and re-raises, the caller's earlier writes stay); otherwise no
    savepoint (yields False: the block's writes belong to the caller's transaction)."""
    if driver_in_transaction(session):
        with session.begin_nested():
            yield True
    else:
        yield False


def sync_instrument(
    session: Session, profile: Profile, instrument_id: int, *, now: dt.datetime | None = None
) -> PlanRun | None:
    """Re-run both checks for one instrument right after its plan or thesis changed (a portfolio
    valuation from stored data, no network), in the caller's transaction.

    Two phases: computing the outcomes only reads (a failure there is logged, nothing is written,
    None returned, the next daily check catches up); writing the signals runs in :func:`isolated`:
    with a savepoint (the caller already wrote, the normal case) a failure is rolled back to it,
    logged and None returned; without one (precondition not met: nothing was written yet) a failure
    propagates, since a partial write could not be undone separately."""
    from . import portfolio
    from . import strategy as strategy_files

    assert profile.id is not None
    now = convert.aware(now or utcnow())
    try:
        config = strategy_files.load(session, profile).config
        state = portfolio.build(session, profile, strategy=config)
        found = facts(session, profile.id, state.valued, now, only=instrument_id)
        if found:
            outcomes = evaluate(found)
        else:  # neither held nor watched (any more): its open plan signals resolve
            outcomes = [
                NotFired(plan_rule_id(check), plan_dedup_key(check, instrument_id))
                for check in CHECKS
            ]
    except Exception:  # noqa: BLE001 - nothing written; the daily check re-evaluates
        _log.exception("plan check sync failed for instrument %s", instrument_id)
        return None
    savepoint = False
    try:
        with isolated(session) as savepoint:
            run, _ = _apply(
                session,
                profile,
                outcomes,
                now=now,
                run_id=None,
                notify=(
                    config.notifications if config is not None else NotificationPolicy()
                ).immediate,
                max_unverified_days=None,
                instrument_id=instrument_id,
            )
            return run
    except Exception:
        if not savepoint:
            raise
        _log.exception("plan check sync failed for instrument %s", instrument_id)
        return None


def sync_after_note(session: Session, profile: Profile, note) -> PlanRun | None:
    """:func:`sync_instrument` for the instrument of a research note just stored, dismissed or
    restored (it moves the thesis health ``plan_vs_thesis`` reads); nothing for a theme note or a
    candidate (candidates never count in health)."""
    if note.instrument_id is None or note.kind == CANDIDATE_KIND:
        return None
    return sync_instrument(session, profile, note.instrument_id)
