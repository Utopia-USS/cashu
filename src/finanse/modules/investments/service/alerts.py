"""Alerts of one profile: create / update / snooze / mute / delete with catalog validation, and their
evaluation in the daily check (after the market refresh): each evaluated alert is one outcome; the open
alert signals are reconciled with the rule-signal lifecycle (dedup by alert id, the alert's cooldown)
and written with the profile's notification policy; alert statuses follow their signals."""

from __future__ import annotations

import datetime as dt
from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from sqlmodel import Session

from finanse.core.models import Profile, utcnow

from ..alerts import (
    EVALUATED_STATUSES,
    LIVE_STATUSES,
    AlertCheck,
    AlertData,
    AlertDefinition,
    AlertKind,
    AlertScope,
    AlertSource,
    AlertStatus,
    AlertValidationError,
    alert_signal_kind,
    evaluate_alert,
    is_alert_key,
    validate,
    validate_text,
)
from ..alerts.catalog import MAX_COOLDOWN_DAYS, MAX_EXPIRY_DAYS
from ..domain import SignalSeverity
from ..models import InvAlert
from ..rules import (
    UNVERIFIED,
    CreateSignal,
    DataQualityPolicy,
    EscalateSignal,
    ExpireSignal,
    Fired,
    NotFired,
    RefreshSignal,
    ResolveSignal,
    RuleContext,
    RuleSpec,
    SignalPolarity,
    Skipped,
    SuppressCandidate,
    did_you_mean,
    reconcile_signals,
)
from ..rules.kinds.support import decimal_text
from ..store import alerts as alert_store
from ..store import convert, instruments, market, signals
from ..strategy import NotificationPolicy, StrategyConfig

AGENT_ALERT_LIMIT = 50
"""Most agent-created alerts that can still fire (active, triggered, snoozed) per profile."""
BAR_HISTORY_DAYS = 420
"""Calendar days of stored bars loaded for evaluation (windows are capped at 260 sessions)."""
RESTORE_WINDOW = dt.timedelta(minutes=15)
"""How long a deleted alert can be restored with its id (the UI's undo), like decisions."""


class AlertError(ValueError):
    """Invalid alert input (message safe to show; the API answers 422). ``issues``: (field, message)."""

    def __init__(self, message: str, issues: list[tuple[str, str]] | None = None) -> None:
        super().__init__(message)
        self.issues = issues or [("", message)]


class AlertLimit(AlertError):
    """The agent already has ``AGENT_ALERT_LIMIT`` live alerts in this profile."""


class AlertNotFound(LookupError):
    """No such alert (or instrument) in this profile (404)."""


class AlertRestoreExpired(ValueError):
    """The alert was deleted more than ``RESTORE_WINDOW`` ago (409 ``undo_expired``)."""


def _invalid(error: AlertValidationError) -> AlertError:
    return AlertError(str(error), error.issues)


def _aware(value: dt.datetime | None) -> dt.datetime | None:
    return None if value is None else convert.aware(value)


def _polarity(value: object, default: str = SignalPolarity.NEUTRAL.value) -> str:
    if value is None or value == "":
        return default
    names = [p.value for p in SignalPolarity]
    if not isinstance(value, str) or value not in names:
        raise AlertError(
            f'Unknown polarity "{value}"{did_you_mean(str(value), names)}; allowed: {", ".join(names)}',
            [("polarity", "unknown polarity")],
        )
    return value


def _severity(value: object, default: str = SignalSeverity.INFO.value) -> str:
    if value is None or value == "":
        return default
    names = [s.value for s in SignalSeverity]
    if not isinstance(value, str) or value not in names:
        raise AlertError(
            f'Unknown severity "{value}"{did_you_mean(str(value), names)}; allowed: {", ".join(names)}',
            [("severity", "unknown severity")],
        )
    return value


def _cooldown(value: object) -> int | None:
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= MAX_COOLDOWN_DAYS:
        raise AlertError(
            f"cooldown_days must be a whole number from 0 to {MAX_COOLDOWN_DAYS}",
            [("cooldown_days", "out of range")],
        )
    return value


def _expiry(
    expires_at: dt.datetime | None, expires_in_days: object, now: dt.datetime
) -> dt.datetime | None:
    if expires_in_days is not None:
        if (
            not isinstance(expires_in_days, int)
            or isinstance(expires_in_days, bool)
            or not 1 <= expires_in_days <= MAX_EXPIRY_DAYS
        ):
            raise AlertError(
                f"expires_in_days must be a whole number from 1 to {MAX_EXPIRY_DAYS}",
                [("expires_in_days", "out of range")],
            )
        return now + dt.timedelta(days=expires_in_days)
    if expires_at is None:
        return None
    expires = convert.aware(expires_at)
    if expires <= now:
        raise AlertError("expires_at must be in the future", [("expires_at", "in the past")])
    return expires


def _check_buckets(session: Session, profile: Profile, refs: tuple[str, ...]) -> None:
    if not refs:
        return
    from . import strategy as strategy_files

    config = strategy_files.load(session, profile).config
    buckets = [b.id for b in config.allocation.buckets] if config is not None else []
    if not buckets:
        raise AlertError(
            "bucket alerts need a strategy with buckets (strategy.yaml)",
            [("params.bucket", "no strategy buckets")],
        )
    for ref in refs:
        if ref not in buckets:
            raise AlertError(
                f'Unknown bucket "{ref}"{did_you_mean(ref, buckets)}; strategy buckets: '
                f"{', '.join(buckets)}",
                [("params.bucket", "unknown bucket")],
            )


def _check_instrument(session: Session, profile: Profile, instrument_id: int | None) -> None:
    if instrument_id is None:
        return
    if instrument_id not in instruments.profile_instrument_ids(session, profile.id):
        raise AlertNotFound(
            f"No instrument {instrument_id} in this profile (add it to the watchlist first)"
        )


@dataclass
class AlertInput:
    kind: str
    title: str
    params: Mapping[str, object] = field(default_factory=dict)
    instrument_id: int | None = None
    scope: str | None = None
    polarity: str | None = None
    severity: str | None = None
    note: str | None = None
    cooldown_days: int | None = None
    expires_at: dt.datetime | None = None
    expires_in_days: int | None = None


def create(
    session: Session,
    profile: Profile,
    data: AlertInput,
    *,
    source: AlertSource = AlertSource.USER,
    created_by: str = "app",
    now: dt.datetime | None = None,
) -> InvAlert:
    """Store a new ACTIVE alert after validating it against the catalog, the profile's instruments
    and strategy buckets; agent alerts are capped at ``AGENT_ALERT_LIMIT`` live ones."""
    now = convert.aware(now or utcnow())
    try:
        valid = validate(
            data.kind, data.params, scope=data.scope, has_instrument=data.instrument_id is not None
        )
        title, note = validate_text(data.title, data.note)
    except AlertValidationError as e:
        raise _invalid(e) from None
    _check_instrument(session, profile, data.instrument_id)
    _check_buckets(session, profile, valid.bucket_refs)
    polarity = _polarity(data.polarity)
    severity = _severity(data.severity)
    cooldown = _cooldown(data.cooldown_days)
    expires = _expiry(data.expires_at, data.expires_in_days, now)
    if (
        source == AlertSource.AGENT
        and alert_store.live_agent_alerts(session, profile.id) >= AGENT_ALERT_LIMIT
    ):
        raise AlertLimit(
            f"At most {AGENT_ALERT_LIMIT} active agent alerts per profile; mute or let some expire "
            "first",
            [("", "agent alert limit")],
        )
    row = InvAlert(
        profile_id=profile.id,
        instrument_id=data.instrument_id,
        scope=valid.scope.value,
        kind=valid.kind.value,
        params=valid.params,
        polarity=polarity,
        severity=severity,
        title=title,
        note=note,
        source=source.value,
        created_by=created_by,
        status=AlertStatus.ACTIVE.value,
        cooldown_days=cooldown,
        expires_at=expires,
        created_at=now,
        updated_at=now,
    )
    session.add(row)
    session.flush()
    return row


UPDATABLE = (
    "title",
    "note",
    "params",
    "polarity",
    "severity",
    "cooldown_days",
    "expires_at",
    "expires_in_days",
    "status",
    "snooze_days",
    "snoozed_until",
)


def update(
    session: Session,
    profile: Profile,
    alert_id: int,
    changes: Mapping[str, Any],
    *,
    now: dt.datetime | None = None,
) -> InvAlert:
    """Change an alert: texts, params (same kind, re-validated), polarity, severity, cooldown, expiry
    (``expires_at`` null clears it), or its status: ``muted`` / ``snoozed`` (``snooze_days`` or
    ``snoozed_until``) close its open signal at once; ``active`` re-arms a muted, snoozed or expired
    one. The kind and the instrument never change (create a new alert instead)."""
    now = convert.aware(now or utcnow())
    row = alert_store.alert(session, profile.id, alert_id)
    if row is None:
        raise AlertNotFound(f"No alert {alert_id}")
    unknown = sorted(set(changes) - set(UPDATABLE))
    if unknown:
        raise AlertError(
            f"Unknown field(s): {', '.join(unknown)}; allowed: {', '.join(UPDATABLE)}",
            [(k, "unknown field") for k in unknown],
        )
    if "title" in changes or "note" in changes:
        try:
            title, note = validate_text(
                changes.get("title", row.title), changes.get("note", row.note)
            )
        except AlertValidationError as e:
            raise _invalid(e) from None
        row.title, row.note = title, note
    if "params" in changes:
        try:
            valid = validate(
                row.kind,
                changes["params"],
                scope=row.scope,
                has_instrument=row.instrument_id is not None,
            )
        except AlertValidationError as e:
            raise _invalid(e) from None
        _check_buckets(session, profile, valid.bucket_refs)
        row.params = valid.params
    if "polarity" in changes:
        row.polarity = _polarity(changes["polarity"], row.polarity)
    if "severity" in changes:
        row.severity = _severity(changes["severity"], row.severity)
    if "cooldown_days" in changes:
        row.cooldown_days = _cooldown(changes["cooldown_days"])
    if "expires_in_days" in changes and changes["expires_in_days"] is not None:
        row.expires_at = _expiry(None, changes["expires_in_days"], now)
    elif "expires_at" in changes:
        row.expires_at = _expiry(changes["expires_at"], None, now)
    if "status" in changes or "snooze_days" in changes or "snoozed_until" in changes:
        _set_status(session, profile, row, changes, now)
    elif row.status == AlertStatus.EXPIRED.value and "expires_at" in changes:
        pass  # a new expiry alone does not re-arm; status "active" does
    row.updated_at = now
    session.add(row)
    session.flush()
    return row


def _set_status(
    session: Session, profile: Profile, row: InvAlert, changes: Mapping[str, Any], now: dt.datetime
) -> None:
    status = changes.get("status")
    if status is None and ("snooze_days" in changes or "snoozed_until" in changes):
        status = AlertStatus.SNOOZED.value
    allowed = (AlertStatus.ACTIVE.value, AlertStatus.MUTED.value, AlertStatus.SNOOZED.value)
    if status not in allowed:
        raise AlertError(
            f"status can be set to {', '.join(allowed)} (triggered and expired come from the daily "
            "check)",
            [("status", "not settable")],
        )
    if status == AlertStatus.SNOOZED.value:
        until = _snooze_until(changes, now)
        row.status, row.snoozed_until = status, until
        alert_store.close_open_signal(session, profile.id, row.id, now=now, reason="snooze")
    elif status == AlertStatus.MUTED.value:
        row.status, row.snoozed_until = status, None
        alert_store.close_open_signal(session, profile.id, row.id, now=now, reason="mute")
    else:
        if row.expires_at is not None and convert.aware(row.expires_at) <= now:
            raise AlertError(
                "the alert has expired: set a new expires_at (or null) together with status active",
                [("expires_at", "expired")],
            )
        if row.status != AlertStatus.TRIGGERED.value:
            row.status = AlertStatus.ACTIVE.value
        row.snoozed_until = None


def _snooze_until(changes: Mapping[str, Any], now: dt.datetime) -> dt.datetime:
    days = changes.get("snooze_days")
    if days is not None:
        if not isinstance(days, int) or isinstance(days, bool) or not 1 <= days <= 365:
            raise AlertError(
                "snooze_days must be a whole number from 1 to 365",
                [("snooze_days", "out of range")],
            )
        return now + dt.timedelta(days=days)
    until = changes.get("snoozed_until")
    if until is None:
        raise AlertError(
            "snoozing needs snooze_days or snoozed_until", [("snooze_days", "missing")]
        )
    until = convert.aware(until)
    if until <= now:
        raise AlertError("snoozed_until must be in the future", [("snoozed_until", "in the past")])
    return until


def mute(session: Session, profile: Profile, alert_id: int, *, now=None) -> InvAlert:
    return update(session, profile, alert_id, {"status": AlertStatus.MUTED.value}, now=now)


def delete(session: Session, profile: Profile, alert_id: int, *, now=None) -> InvAlert:
    """Delete an alert (soft: ``deleted_at``, restorable for ``RESTORE_WINDOW``); its open signal
    expires at once (closed signals stay as history). The row stays as a tombstone, never purged:
    SQLite would hand its id (``max(rowid) + 1``) to the next alert, which would then inherit the old
    ``alert:<id>`` signals and cooldown (F6 review V8)."""
    now = convert.aware(now or utcnow())
    row = alert_store.alert(session, profile.id, alert_id)
    if row is None:
        raise AlertNotFound(f"No alert {alert_id}")
    alert_store.close_open_signal(session, profile.id, alert_id, now=now, reason="delete")
    row.deleted_at = now
    session.add(row)
    session.flush()
    return row


def restore_until(row: InvAlert) -> dt.datetime | None:
    """Until when a deleted alert can be restored (None: not deleted)."""
    return None if row.deleted_at is None else convert.aware(row.deleted_at) + RESTORE_WINDOW


def restore(session: Session, profile: Profile, alert_id: int, *, now=None) -> InvAlert:
    """Undo a deletion within ``RESTORE_WINDOW``: the same alert (same id) is back with its status,
    and the open signal the deletion expired is open again (``AlertRestoreExpired`` after the window,
    ``AlertNotFound`` for an unknown or another profile's alert). Restoring a live alert returns it
    unchanged. An agent alert still counts against ``AGENT_ALERT_LIMIT``."""
    now = convert.aware(now or utcnow())
    live = alert_store.alert(session, profile.id, alert_id)
    if live is not None:
        return live
    row = alert_store.deleted_alert(session, profile.id, alert_id)
    if row is None:
        raise AlertNotFound(f"No alert {alert_id}")
    deleted_at = convert.aware(row.deleted_at)
    if now - deleted_at > RESTORE_WINDOW:
        raise AlertRestoreExpired(
            f"Deleted alerts can be restored for {int(RESTORE_WINDOW.total_seconds() // 60)} minutes"
        )
    if (
        row.source == AlertSource.AGENT.value
        and row.status in {s.value for s in LIVE_STATUSES}
        and alert_store.live_agent_alerts(session, profile.id) >= AGENT_ALERT_LIMIT
    ):
        raise AlertLimit(
            f"At most {AGENT_ALERT_LIMIT} active agent alerts per profile; mute or let some expire "
            "first",
            [("", "agent alert limit")],
        )
    reopened = alert_store.reopen_signal_closed_at(session, profile.id, alert_id, deleted_at)
    if row.status == AlertStatus.TRIGGERED.value and reopened is None:
        row.status = AlertStatus.ACTIVE.value  # its signal is gone: the next check re-arms it
    row.deleted_at = None
    row.updated_at = now
    session.add(row)
    session.flush()
    return row


# --------------------------------------------------------------------------- #
# Daily evaluation
# --------------------------------------------------------------------------- #


@dataclass
class AlertRun:
    stats: dict = field(default_factory=dict)
    created: list[int] = field(default_factory=list)
    escalated: list[int] = field(default_factory=list)
    notified: list[int] = field(default_factory=list)
    checks: dict[int, AlertCheck] = field(default_factory=dict)


def definition(row: InvAlert, instrument=None) -> AlertDefinition:
    return AlertDefinition(
        id=row.id,
        kind=AlertKind(row.kind),
        scope=AlertScope(row.scope),
        params=dict(row.params or {}),
        title=row.title,
        polarity=SignalPolarity(row.polarity),
        severity=SignalSeverity(row.severity),
        instrument=instrument,
    )


def housekeeping(session: Session, profile_id: int, now: dt.datetime) -> dict[str, int]:
    """Expire alerts past ``expires_at`` (their open signal expires with them) and wake snoozed ones
    whose ``snoozed_until`` passed."""
    expired = woken = 0
    for row in alert_store.alerts(
        session,
        profile_id,
        [AlertStatus.ACTIVE.value, AlertStatus.TRIGGERED.value, AlertStatus.SNOOZED.value],
    ):
        if row.expires_at is not None and convert.aware(row.expires_at) <= now:
            row.status, row.snoozed_until, row.updated_at = AlertStatus.EXPIRED.value, None, now
            alert_store.close_open_signal(
                session, profile_id, row.id, now=now, reason="alert_expired"
            )
            expired += 1
        elif (
            row.status == AlertStatus.SNOOZED.value
            and row.snoozed_until is not None
            and convert.aware(row.snoozed_until) <= now
        ):
            row.status, row.snoozed_until, row.updated_at = AlertStatus.ACTIVE.value, None, now
            woken += 1
        else:
            continue
        session.add(row)
    session.flush()
    return {"alerts_expired": expired, "alerts_woken": woken}


def evaluate_profile(
    session: Session,
    profile: Profile,
    *,
    as_of: dt.date,
    now: dt.datetime,
    ctx: RuleContext | None,
    config: StrategyConfig | None,
    run_id: int | None,
) -> AlertRun:
    """Evaluate the profile's active / triggered alerts and apply the lifecycle of their signals in the
    caller's transaction. Works with or without a strategy (``ctx`` = the valued portfolio)."""
    now = convert.aware(now)
    result = AlertRun(stats=housekeeping(session, profile.id, now))
    rows = alert_store.alerts(session, profile.id, [s.value for s in EVALUATED_STATUSES])
    ids = {row.instrument_id for row in rows if row.instrument_id is not None}
    loaded = instruments.load(session, ids, profile_id=profile.id)
    bars = market.bars(session, ids, until=as_of, since=as_of - dt.timedelta(days=BAR_HISTORY_DAYS))
    data = AlertData(
        as_of=as_of,
        bars=bars,
        max_price_age_days=(config.data.max_price_age_days if config is not None else 5),
        ctx=ctx,
    )
    specs: list[RuleSpec[object]] = []
    outcomes = []
    for row in rows:
        check = evaluate_alert(
            definition(row, loaded.get(row.instrument_id) if row.instrument_id else None), data
        )
        result.checks[row.id] = check
        outcomes.append(check.outcome)
        specs.append(
            RuleSpec(
                id=f"alert:{row.id}",
                kind=alert_signal_kind(row.kind),
                params=None,
                severity=SignalSeverity(row.severity),
                cooldown_days=row.cooldown_days,
            )
        )
    open_alert = [o for o in signals.open_signals(session, profile.id) if is_alert_key(o.dedup_key)]
    # Cooldowns count from a resolution of the condition only: a signal closed by a snooze, mute,
    # delete or the alert's expiry does not start one (F6 review V5).
    closed_alert = [
        c
        for c in signals.closed_signals(session, profile.id, skip_closed_by=True)
        if is_alert_key(c.dedup_key)
    ]
    reconciliation = reconcile_signals(
        open_signals=open_alert,
        outcomes=outcomes,
        rules=specs,
        clock=lambda: now,
        closed_signals=closed_alert,
        max_unverified_days=(
            config.data.max_unverified_days
            if config is not None
            else DataQualityPolicy().max_unverified_days
        ),
    )
    notify = (config.notifications if config is not None else NotificationPolicy()).immediate
    applied = signals.apply_reconciliation(
        session, profile.id, reconciliation, run_id=run_id, notify=notify
    )
    result.created, result.escalated = applied.created, applied.escalated
    result.notified = applied.notified

    fired_now: set[str] = set()
    created_now: set[str] = set()
    resolved_now: set[str] = set()
    for action in reconciliation.actions:
        match action:
            case ExpireSignal(rule_id=rule_id, reason=reason) if reason == UNVERIFIED:
                resolved_now.add(rule_id)  # no check confirmed it for too long: armed again
            case CreateSignal(candidate=candidate):
                fired_now.add(candidate.rule_id)
                created_now.add(candidate.rule_id)
            case RefreshSignal(candidate=candidate) | EscalateSignal(candidate=candidate):
                fired_now.add(candidate.rule_id)
            case ResolveSignal(rule_id=rule_id):
                resolved_now.add(rule_id)
            case SuppressCandidate():
                pass
    for row in rows:
        rule_id = f"alert:{row.id}"
        check = result.checks[row.id]
        if not isinstance(check.outcome, Skipped):
            # Only a real check counts as one: a skip (stale price, short series) leaves the last
            # check's time and value, so "sprawdzone d.m" stays true (F8, lifecycle facts 5(a3)).
            row.last_checked_at = now
            if check.value is not None:
                row.last_value = decimal_text(Decimal(check.value))
        if rule_id in fired_now:
            row.status = AlertStatus.TRIGGERED.value
            if rule_id in created_now:
                row.last_triggered_at = now
        elif rule_id in resolved_now or isinstance(check.outcome, NotFired | Fired):
            # resolved, not firing, or fired but held back by the cooldown: armed again
            row.status = AlertStatus.ACTIVE.value
        session.add(row)
    session.flush()
    result.stats.update(
        {
            "alerts": len(rows),
            "alerts_fired": sum(isinstance(o, Fired) for o in outcomes),
            "alerts_skipped": sum(isinstance(o, Skipped) for o in outcomes),
            "alert_signals_new": len(reconciliation.created),
            "alert_signals_resolved": len(reconciliation.resolved),
            "alert_signals_expired": len(reconciliation.expired),
            "alert_signals_suppressed": len(reconciliation.suppressed),
            "alert_notifications": len(applied.notified),
        }
    )
    return result


def find_instrument(session: Session, profile: Profile, text: str) -> int:
    """An instrument of the profile (held, watched or otherwise referenced) by id, symbol, ISIN or
    Yahoo alias (case-insensitive). Raises :class:`AlertNotFound` / :class:`AlertError` (ambiguous)."""
    ids = instruments.profile_instrument_ids(session, profile.id)
    wanted = (text or "").strip()
    if wanted.isdigit() and int(wanted) in ids:
        return int(wanted)
    upper = wanted.upper()
    matches = [
        int(inst.id)
        for inst in instruments.load(session, ids, profile_id=profile.id).values()
        if upper
        and upper
        in {
            (inst.symbol or "").upper(),
            (inst.isin or "").upper(),
            (inst.alias("yahoo") or "").upper(),
        }
    ]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise AlertError(
            "several instruments match; use the instrument id", [("instrument", "ambiguous")]
        )
    raise AlertNotFound(
        "no such instrument in this profile (held or watched; add it to the watchlist first)"
    )


STATUS_FILTERS = tuple(s.value for s in AlertStatus)


def parse_status_filter(raw: str | None) -> list[str] | None:
    """``all`` (None = every status), ``live`` (active, triggered, snoozed) or a comma list."""
    text = (raw or "all").strip().lower()
    if text == "all":
        return None
    if text == "live":
        return ["active", "triggered", "snoozed"]
    parts = [p.strip() for p in text.split(",") if p.strip()]
    if not parts or any(p not in STATUS_FILTERS for p in parts):
        raise AlertError(
            f"status must be all, live or a comma list of: {', '.join(STATUS_FILTERS)}",
            [("status", "unknown status")],
        )
    return parts
