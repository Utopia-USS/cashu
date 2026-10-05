"""The daily check: strategy files -> one market refresh -> per profile valuation, allocation, rules
and the signal lifecycle, recorded as a rule run. Safe to run twice (the second run refreshes the
same signals and creates nothing new).

Phases (never a database transaction across network IO):

1. read (one short session): profiles to check, their strategy files (a changed file is stored as a
   new strategy version), what they hold, the FX currencies and history they need, split dates;
2. network: ``MarketDataRefresher`` over the DB ``StoredMarketData`` (one short read per question);
3. one write transaction: the fetched bars and rates (a split re-fetch replaces the stored window);
4. per profile, one transaction: snapshot -> valuation -> allocation -> rules ->
   ``reconcile_signals`` applied -> rule run (``ok`` / ``partial`` / ``failed``, stats, errors).

A missing strategy means valuation only (no rules, status ok); an invalid one leaves every open
signal untouched (status partial); a partial one runs the valid rules and leaves the signals of the
inactive rules untouched (status partial). Market errors make the run partial, never failed.
"""

from __future__ import annotations

import datetime as dt
import logging
from collections.abc import Callable, Collection
from contextlib import AbstractContextManager
from dataclasses import dataclass, field

from sqlmodel import Session, select

from finanse.core import locks, profiles
from finanse.core.db import get_session
from finanse.core.models import Profile, ProfileModule, utcnow

from ..domain import Currency, Instrument, InstrumentId, MarketView, TxnType
from ..market import FetchReport, FetchStatus, FxSource, MarketDataRefresher, PriceSource
from ..models import InvRuleRun, InvSignal
from ..portfolio import build_snapshot, fx_currencies_for
from ..rules import (
    Fired,
    NotFired,
    RuleContext,
    RulesEngine,
    RuleSpec,
    Skipped,
    reconcile_signals,
)
from ..store import convert, instruments, market, signals, transactions
from . import portfolio
from . import strategy as strategy_files

LOCK_NAME = "investments-daily"
MODULE_ID = "investments"
SessionFactory = Callable[[], AbstractContextManager[Session]]
_log = logging.getLogger("finanse.investments.daily")


class RunBusy(RuntimeError):
    """The daily check is already running (worker or another "run now")."""


@dataclass
class MarketSources:
    """Price and FX sources of one run (``close`` releases their HTTP client)."""

    prices: PriceSource
    fx: FxSource
    close: Callable[[], None] = lambda: None


def default_sources() -> MarketSources:
    """The production sources: Yahoo / stooq composite and NBP over one HTTP client."""
    import httpx

    from ..market import CompositePriceSource, MarketHttp, NbpFxSource

    client = httpx.Client(follow_redirects=True)
    http = MarketHttp(client)
    return MarketSources(CompositePriceSource.standard(http), NbpFxSource(http), client.close)


@dataclass
class ProfileRun:
    profile_id: int
    slug: str
    run_id: int | None
    status: str
    strategy: str
    stats: dict = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    new_signals: list[dict] = field(default_factory=list)
    escalated_signals: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "profile": self.slug,
            "run_id": self.run_id,
            "status": self.status,
            "strategy": self.strategy,
            "stats": self.stats,
            "errors": self.errors,
            "new_signals": self.new_signals,
            "escalated_signals": self.escalated_signals,
        }


@dataclass
class DailyCheckReport:
    trigger: str
    as_of: dt.date
    offline: bool
    started_at: dt.datetime
    finished_at: dt.datetime | None = None
    market: FetchReport | None = None
    market_error: str | None = None
    market_stats: dict = field(default_factory=dict)
    profiles: list[ProfileRun] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "trigger": self.trigger,
            "as_of": self.as_of.isoformat(),
            "offline": self.offline,
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "market": None if self.market is None else self.market.to_stats(),
            "market_errors": [] if self.market is None else self.market.error_messages,
            "market_error": self.market_error,
            "stored": self.market_stats,
            "profiles": [p.to_dict() for p in self.profiles],
        }


@dataclass
class _Needs:
    """What one profile needs from the market (phase 1)."""

    profile: Profile
    state: strategy_files.StrategyState
    instruments: dict[InstrumentId, Instrument] = field(default_factory=dict)
    currencies: set[Currency] = field(default_factory=set)
    fx_history_from: dict[Currency, dt.date] = field(default_factory=dict)
    split_dates: dict[InstrumentId, dt.date] = field(default_factory=dict)


def _profiles_to_check(session: Session, profile_ids: Collection[int] | None) -> list[Profile]:
    if profile_ids is not None:
        rows = [session.get(Profile, pid) for pid in sorted(set(profile_ids))]
        return [p for p in rows if p is not None]
    enabled = session.exec(
        select(ProfileModule.profile_id).where(
            ProfileModule.module_id == MODULE_ID, ProfileModule.enabled == True
        )
    ).all()
    return [p for p in profiles.list_profiles(session) if p.id in set(enabled)]


def _needs(session: Session, profile: Profile, as_of: dt.date) -> _Needs:
    state = strategy_files.load(session, profile, record=True)
    needs = _Needs(profile, state)
    txns = transactions.transactions(session, profile.id)
    snapshot = build_snapshot(
        convert.sid(profile.id), txns, as_of, renames=transactions.renames(session, profile.id)
    )
    held = {convert.pk(h.instrument_id) for h in snapshot.holdings}
    needs.instruments = {
        convert.sid(k): v for k, v in instruments.load(session, held, profile_id=profile.id).items()
    }
    grouped: dict[InstrumentId, list] = {}
    for valuation in transactions.manual_valuations(session, profile.id, held):
        grouped.setdefault(valuation.instrument_id, []).append(valuation)
    view = MarketView(
        as_of=as_of,
        instruments=needs.instruments,
        manual_valuations={k: tuple(v) for k, v in grouped.items()},
    )
    base = portfolio.base_currency(profile, state.config)
    currencies, _oldest = fx_currencies_for(snapshot, view, base)
    needs.currencies = set(currencies)
    for holding in snapshot.holdings:
        for lot in holding.lots:
            _earliest(needs.fx_history_from, lot.currency, lot.open_date)
    for trade in snapshot.realized:
        _earliest(needs.fx_history_from, trade.cost_currency or trade.currency, trade.open_date)
    for txn in txns:
        if txn.type == TxnType.SPLIT and txn.instrument_id in needs.instruments:
            current = needs.split_dates.get(txn.instrument_id)
            if current is None or txn.trade_date > current:
                needs.split_dates[txn.instrument_id] = txn.trade_date
    return needs


def _earliest(target: dict, key, value: dt.date) -> None:
    if key not in target or value < target[key]:
        target[key] = value


def run_daily_check(
    trigger: str,
    *,
    profile_ids: Collection[int] | None = None,
    as_of: dt.date | None = None,
    offline: bool = False,
    sources: MarketSources | Callable[[], MarketSources] | None = None,
    clock: Callable[[], dt.datetime] = utcnow,
    session_factory: SessionFactory = get_session,
    lock_wait: float = 0.0,
) -> DailyCheckReport:
    """Run the daily check for ``profile_ids`` (default: every profile with investments enabled).
    Raises :class:`RunBusy` when another run holds the lock."""
    try:
        with locks.run_lock(LOCK_NAME, wait=lock_wait):
            return _run(trigger, profile_ids, as_of, offline, sources, clock, session_factory)
    except locks.LockBusy as e:
        raise RunBusy(str(e)) from None


def _run(trigger, profile_ids, as_of, offline, sources, clock, session_factory) -> DailyCheckReport:
    as_of = as_of or portfolio.today()
    report = DailyCheckReport(trigger, as_of, offline, convert.aware(clock()))

    # 1. Read phase (strategy versions are recorded here, before any network call).
    with session_factory() as s:
        checked = [_needs(s, p, as_of) for p in _profiles_to_check(s, profile_ids)]

    # 2. Network phase: no transaction is open.
    if not offline and checked:
        held: dict[InstrumentId, Instrument] = {}
        currencies: set[Currency] = set()
        history: dict[Currency, dt.date] = {}
        splits: dict[InstrumentId, dt.date] = {}
        for needs in checked:
            # Profiles may see a shared instrument differently (one froze it): fetch it when any
            # profile still needs market prices for it.
            for iid, inst in needs.instruments.items():
                if iid not in held or (
                    inst.fetches_market_data and not held[iid].fetches_market_data
                ):
                    held[iid] = inst
            currencies |= needs.currencies
            for cur, day in needs.fx_history_from.items():
                _earliest(history, cur, day)
            for iid, day in needs.split_dates.items():
                if iid not in splits or day > splits[iid]:
                    splits[iid] = day
        active = MarketSources(*_unpack(sources))
        try:
            refresher = MarketDataRefresher(active.prices, active.fx)
            report.market = refresher.refresh(
                market.DbStoredMarketData(session_factory),
                held.values(),
                sorted(currencies),
                as_of,
                fx_history_from=history,
                split_dates=splits,
            )
        except Exception as e:  # noqa: BLE001 - the run goes on with the stored data
            _log.exception("market refresh failed")
            report.market_error = f"{type(e).__name__}: {e}"
        finally:
            active.close()

        # 3. One write transaction for the fetched data.
        if report.market is not None:
            with session_factory() as s:
                report.market_stats = market.apply_fetch_report(
                    s, report.market, now=convert.aware(clock())
                )

    # 4. Per profile: evaluate and persist (one transaction each).
    for needs in checked:
        report.profiles.append(
            _evaluate_profile(needs, report, as_of, trigger, clock, session_factory)
        )
    report.finished_at = convert.aware(clock())
    return report


def _unpack(sources) -> tuple[PriceSource, FxSource, Callable[[], None]]:
    if sources is None:
        sources = default_sources
    if callable(sources) and not isinstance(sources, MarketSources):
        sources = sources()
    return sources.prices, sources.fx, sources.close


def _market_errors_for(needs: _Needs, report: DailyCheckReport) -> list[str]:
    errors: list[str] = []
    if report.market_error:
        errors.append(f"market refresh failed: {report.market_error}")
    if report.market is None:
        return errors
    for item in report.market.instruments:
        if item.status == FetchStatus.ERROR and item.instrument_id in needs.instruments:
            errors.append(f"prices {item.label}: {item.message}")
    for fx in report.market.fx:
        if fx.status == FetchStatus.ERROR and fx.currency in needs.currencies:
            errors.append(f"fx {fx.currency}: {fx.message}")
    return errors


def _evaluate_profile(
    needs: _Needs,
    report: DailyCheckReport,
    as_of: dt.date,
    trigger: str,
    clock: Callable[[], dt.datetime],
    session_factory: SessionFactory,
) -> ProfileRun:
    profile, state = needs.profile, needs.state
    version_id = state.version.id if state.version is not None else None
    started = convert.aware(clock())
    errors = _market_errors_for(needs, report)
    try:
        with session_factory() as s:
            run = InvRuleRun(
                profile_id=profile.id,
                trigger=trigger,
                as_of=as_of,
                status="running",
                strategy_version_id=version_id,
                started_at=started,
            )
            s.add(run)
            s.flush()
            outcome = _evaluate(s, needs, run, as_of, clock, errors)
            run.status = outcome.status
            run.stats, run.errors = outcome.stats, outcome.errors
            run.report = {
                "new": [x["id"] for x in outcome.new_signals],
                "escalated": [x["id"] for x in outcome.escalated_signals],
            }
            run.finished_at = convert.aware(clock())
            s.add(run)
            s.flush()
            outcome.run_id = run.id
            return outcome
    except Exception as e:  # noqa: BLE001 - one broken profile never stops the others
        _log.exception("daily check failed for profile %s", profile.slug)
        message = f"{type(e).__name__}: {e}"
        with session_factory() as s:
            run = InvRuleRun(
                profile_id=profile.id,
                trigger=trigger,
                as_of=as_of,
                status="failed",
                strategy_version_id=version_id,
                started_at=started,
                errors=[*errors, message],
                finished_at=convert.aware(clock()),
            )
            s.add(run)
            s.flush()
            return ProfileRun(
                profile.id, profile.slug, run.id, "failed", state.state, errors=[*errors, message]
            )


def _evaluate(
    s: Session,
    needs: _Needs,
    run: InvRuleRun,
    as_of: dt.date,
    clock: Callable[[], dt.datetime],
    errors: list[str],
) -> ProfileRun:
    profile, state = needs.profile, needs.state
    config = state.config
    pstate = portfolio.build(s, profile, as_of=as_of, strategy=config)
    valued = pstate.valued
    stats: dict = {
        "strategy": state.state,
        "strategy_version": state.version.version if state.version is not None else None,
        "holdings": len(valued.valued),
        "accounts": len(pstate.accounts),
        "base_currency": str(pstate.base),
        "total_base": str(valued.total_base),
        "stale_weight": round(valued.stale_weight, 6),
        "warnings": len(valued.all_warnings),
        "missing_fx": sorted(str(c) for c in valued.missing_fx_currencies),
    }
    result = ProfileRun(profile.id, profile.slug, run.id, "ok", state.state, stats, list(errors))
    if config is None:
        stats["rules"] = 0
        if state.state == "invalid":
            first = state.read_error or next(
                (str(i) for i in state.issues if i.is_error), "invalid"
            )
            result.errors.append(f"strategy invalid, rules not run: {first}")
    else:
        ctx = RuleContext.build(
            profile_id=convert.sid(profile.id),
            as_of=as_of,
            portfolio=valued,
            market=pstate.market,
            allocation=pstate.allocation,
            data=config.data,
            contributions=config.contributions,
        )
        outcomes = RulesEngine(config.rules).evaluate(ctx)
        # Inactive rules are known to the lifecycle (so their open signals are not expired) but are
        # never evaluated (so those signals stay untouched).
        known = {rule.id for rule in config.rules}
        lifecycle_rules = list(config.rules) + [
            RuleSpec(id=r.rule_id, kind=r.kind or "inactive", params=None)
            for r in state.inactive_rules
            if r.rule_id and r.rule_id not in known
        ]
        now = convert.aware(clock())
        reconciliation = reconcile_signals(
            open_signals=signals.open_signals(s, profile.id),
            outcomes=outcomes,
            rules=lifecycle_rules,
            clock=lambda: now,
            closed_signals=signals.closed_signals(s, profile.id),
        )
        applied = signals.apply_reconciliation(
            s, profile.id, reconciliation, run_id=run.id, notify=config.notifications.immediate
        )
        stats.update(
            {
                "rules": len(config.rules),
                "inactive_rules": len(state.inactive_rules),
                "fired": sum(isinstance(o, Fired) for o in outcomes),
                "not_fired": sum(isinstance(o, NotFired) for o in outcomes),
                "skipped": sum(isinstance(o, Skipped) for o in outcomes),
                **reconciliation.stats,
                "notifications": len(applied.notified),
            }
        )
        result.new_signals = _signal_summaries(s, applied.created)
        result.escalated_signals = _signal_summaries(s, applied.escalated)
        for inactive in state.inactive_rules:
            reason = inactive.issues[0].message if inactive.issues else "invalid"
            result.errors.append(f"rule {inactive.rule_id or inactive.index} inactive: {reason}")
    if result.errors:
        result.status = "partial"
    return result


def _signal_summaries(s: Session, ids: list[int]) -> list[dict]:
    if not ids:
        return []
    rows = s.exec(select(InvSignal).where(InvSignal.id.in_(ids)).order_by(InvSignal.id)).all()
    return [
        {"id": r.id, "rule_id": r.rule_id, "severity": r.severity, "message": r.message}
        for r in rows
    ]
