"""Planned deposits of a profile ("Zaplanuj wpłatę"): list / create / cancel, booking by a matching
deposit, and the month's contribution-plan progress.

A planned deposit counts against the strategy's contribution plan (``contributions.monthly_amount``)
and is never cash, value or a performance flow: only a real deposit transaction is. When a deposit is
imported (or booked by hand) that matches a planned one, the plan becomes ``booked`` and points at
that transaction. Match: same currency, the plan's account (or any of the profile's brokerage
accounts when the plan names none), dated from ``MATCH_BEFORE_DAYS`` before to ``MATCH_AFTER_DAYS``
after the planned date, amount within ``AMOUNT_TOLERANCE`` of the planned one, not booking another
plan; the closest date wins (then the closest amount, then the older transaction). Plans are matched
oldest planned date first.
"""

from __future__ import annotations

import calendar
import datetime as dt
from collections.abc import Collection
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

from sqlmodel import Session, select

from finanse.core.models import Account, Profile, utcnow

from ..domain import Currency, TxnType
from ..models import PLANNED_DEPOSIT_STATUSES, InvPlannedDeposit, InvTransaction
from ..portfolio import InMemoryFxLookup
from ..portfolio.fx_lookup import convert as fx_convert
from ..store import convert, market, transactions
from . import portfolio as portfolio_service

MATCH_BEFORE_DAYS = 7
MATCH_AFTER_DAYS = 31
AMOUNT_TOLERANCE = Decimal("0.10")
"""A deposit within 10 % of the planned amount books the plan."""
PAST_DAYS = 31
"""A plan may be dated up to a month back (a deposit already made is booked at once)."""
FUTURE_DAYS = 366
MAX_AMOUNT = Decimal(1000000000)
MAX_NOTE = 500
DEFAULT_STATUSES = ("planned", "booked")


class PlannedError(ValueError):
    """Invalid input (422 ``planned_invalid``)."""


class PlannedNotFound(LookupError):
    """No such plan or account in this profile (404 ``not_found``)."""


class PlannedBooked(ValueError):
    """A booked plan cannot be cancelled (409 ``planned_booked``)."""


@dataclass(frozen=True)
class PlannedInput:
    amount: object
    planned_date: dt.date
    currency: str | None = None
    account_id: int | None = None
    note: str | None = None


def parse_statuses(value: str | None) -> tuple[str, ...]:
    """``planned,booked`` (default), ``all`` or a comma list of statuses."""
    if value is None or not value.strip():
        return DEFAULT_STATUSES
    if value.strip() == "all":
        return PLANNED_DEPOSIT_STATUSES
    wanted = tuple(dict.fromkeys(v.strip() for v in value.split(",") if v.strip()))
    unknown = [v for v in wanted if v not in PLANNED_DEPOSIT_STATUSES]
    if unknown:
        raise PlannedError(
            f"Unknown status {', '.join(unknown)}; use all or {', '.join(PLANNED_DEPOSIT_STATUSES)}"
        )
    return wanted


def planned_deposits(
    session: Session, profile_id: int, statuses: Collection[str] = DEFAULT_STATUSES
) -> list[InvPlannedDeposit]:
    """The profile's plans with these statuses, newest planned date first."""
    return list(
        session.exec(
            select(InvPlannedDeposit)
            .where(
                InvPlannedDeposit.profile_id == profile_id,
                InvPlannedDeposit.status.in_(sorted(statuses)),
            )
            .order_by(InvPlannedDeposit.planned_date.desc(), InvPlannedDeposit.id.desc())
        ).all()
    )


def planned_deposit(session: Session, profile_id: int, planned_id: int) -> InvPlannedDeposit | None:
    row = session.get(InvPlannedDeposit, planned_id)
    return row if row is not None and row.profile_id == profile_id else None


def _account(session: Session, profile_id: int, account_id: int | None) -> Account | None:
    if account_id is None:
        return None
    account = next(
        (a for a in transactions.brokerage_accounts(session, profile_id) if a.id == account_id),
        None,
    )
    if account is None:
        raise PlannedNotFound(f"No brokerage account {account_id} in this profile")
    return account


def _amount(value: object) -> Decimal:
    try:
        amount = Decimal(str(value).strip().replace(",", "."))
    except (InvalidOperation, ValueError):
        raise PlannedError("amount must be a number") from None
    if not amount.is_finite() or amount <= 0:
        raise PlannedError("amount must be greater than 0")
    if amount > MAX_AMOUNT:
        raise PlannedError("amount is too large")
    return amount


def create(
    session: Session,
    profile: Profile,
    data: PlannedInput,
    *,
    today: dt.date | None = None,
    now: dt.datetime | None = None,
) -> InvPlannedDeposit:
    """Store a planned deposit (status ``planned``), then book it at once when a matching deposit
    already exists. Currency defaults to the account's, else the profile's base currency."""
    today = today or portfolio_service.today()
    now = convert.aware(now or utcnow())
    amount = _amount(data.amount)
    if not isinstance(data.planned_date, dt.date):
        raise PlannedError("planned_date must be a date (YYYY-MM-DD)")
    if data.planned_date < today - dt.timedelta(days=PAST_DAYS):
        raise PlannedError(f"planned_date can be at most {PAST_DAYS} days in the past")
    if data.planned_date > today + dt.timedelta(days=FUTURE_DAYS):
        raise PlannedError(f"planned_date can be at most {FUTURE_DAYS} days ahead")
    account = _account(session, profile.id, data.account_id)
    raw_currency = data.currency or (account.currency if account is not None else None)
    try:
        currency = (
            Currency(raw_currency)
            if raw_currency
            else portfolio_service.base_currency(profile, None)
        )
    except ValueError:
        raise PlannedError(f"currency must be a 3-letter ISO code, got {raw_currency!r}") from None
    note = (data.note or "").strip() or None
    if note is not None and len(note) > MAX_NOTE:
        raise PlannedError(f"note is too long (max {MAX_NOTE} characters)")
    row = InvPlannedDeposit(
        profile_id=profile.id,
        account_id=None if account is None else account.id,
        amount=amount,
        currency=str(currency),
        planned_date=data.planned_date,
        note=note,
        status="planned",
        created_at=now,
        updated_at=now,
    )
    session.add(row)
    session.flush()
    book_matching(session, profile.id, now=now)
    return row


def cancel(
    session: Session, profile: Profile, planned_id: int, *, now: dt.datetime | None = None
) -> InvPlannedDeposit:
    """Cancel a planned deposit (kept as history, status ``cancelled``); cancelling twice is a no-op.
    A booked plan raises :class:`PlannedBooked` (its deposit is real)."""
    row = planned_deposit(session, profile.id, planned_id)
    if row is None:
        raise PlannedNotFound(f"No planned deposit {planned_id}")
    if row.status == "booked":
        raise PlannedBooked("This planned deposit is already booked by an imported deposit")
    if row.status != "cancelled":
        row.status, row.updated_at = "cancelled", convert.aware(now or utcnow())
        session.add(row)
        session.flush()
    return row


def book_matching(
    session: Session, profile_id: int, *, now: dt.datetime | None = None
) -> list[int]:
    """Book every open plan of the profile that a stored deposit matches (see the module doc).
    Returns the ids of the plans booked now."""
    open_plans = sorted(
        planned_deposits(session, profile_id, ("planned",)),
        key=lambda p: (p.planned_date, p.id),
    )
    if not open_plans:
        return []
    accounts = [a.id for a in transactions.brokerage_accounts(session, profile_id)]
    if not accounts:
        return []
    earliest = min(p.planned_date for p in open_plans) - dt.timedelta(days=MATCH_BEFORE_DAYS)
    deposits = session.exec(
        select(InvTransaction).where(
            InvTransaction.account_id.in_(accounts),
            InvTransaction.type == TxnType.DEPOSIT.value,
            InvTransaction.trade_date >= earliest,
        )
    ).all()
    used = set(
        session.exec(
            select(InvPlannedDeposit.booked_txn_id).where(
                InvPlannedDeposit.profile_id == profile_id,
                InvPlannedDeposit.booked_txn_id.is_not(None),
            )
        ).all()
    )
    stamp = convert.aware(now or utcnow())
    booked: list[int] = []
    for plan in open_plans:
        low = plan.planned_date - dt.timedelta(days=MATCH_BEFORE_DAYS)
        high = plan.planned_date + dt.timedelta(days=MATCH_AFTER_DAYS)
        tolerance = plan.amount * AMOUNT_TOLERANCE
        candidates = [
            t
            for t in deposits
            if t.id not in used
            and (plan.account_id is None or t.account_id == plan.account_id)
            and t.cash_currency == plan.currency
            and low <= t.trade_date <= high
            and t.cash_amount > 0
            and abs(t.cash_amount - plan.amount) <= tolerance
        ]
        if not candidates:
            continue
        best = min(
            candidates,
            key=lambda t: (
                abs((t.trade_date - plan.planned_date).days),
                abs(t.cash_amount - plan.amount),
                t.id,
            ),
        )
        used.add(best.id)
        plan.status, plan.booked_txn_id = "booked", best.id
        plan.booked_at = stamp
        plan.updated_at = stamp
        session.add(plan)
        booked.append(plan.id)
    if booked:
        session.flush()
    return booked


def _month_bounds(month: str | None, today: dt.date) -> tuple[dt.date, dt.date]:
    if month is None:
        year, number = today.year, today.month
    else:
        try:
            year, number = (int(x) for x in month.split("-", 1))
            if not 1 <= number <= 12 or not 1900 <= year <= 9999:
                raise ValueError
        except ValueError:
            raise PlannedError("month must be YYYY-MM") from None
    return dt.date(year, number, 1), dt.date(year, number, calendar.monthrange(year, number)[1])


def month_plan(
    session: Session, profile: Profile, month: str | None = None, *, today: dt.date | None = None
) -> dict:
    """The month's contribution-plan progress in the base currency: the strategy's
    ``monthly_amount``, deposits dated in the month (trade-date FX), open plans dated in the month
    (FX of the planned date or the newest known), what remains and whether the plan is covered.
    Amounts are None when an FX rate is missing; ``monthly_amount`` None without a plan."""
    from . import strategy as strategy_files

    today = today or portfolio_service.today()
    start, end = _month_bounds(month, today)
    config = strategy_files.load(session, profile, record=False).config
    base = portfolio_service.base_currency(profile, config)
    plan = config.contributions if config is not None else None
    accounts = [a.id for a in transactions.brokerage_accounts(session, profile.id)]
    deposits = (
        session.exec(
            select(InvTransaction).where(
                InvTransaction.account_id.in_(accounts),
                InvTransaction.type == TxnType.DEPOSIT.value,
                InvTransaction.trade_date >= start,
                InvTransaction.trade_date <= end,
            )
        ).all()
        if accounts
        else []
    )
    plans = [
        p
        for p in planned_deposits(session, profile.id, ("planned",))
        if start <= p.planned_date <= end
    ]
    currencies = {str(base)} | {t.cash_currency for t in deposits} | {p.currency for p in plans}
    until = max(end, today)
    fx = InMemoryFxLookup(
        market.rates(session, currencies, until=until, since=start - dt.timedelta(days=10))
    )

    def total(items: list[tuple[Decimal, str, dt.date]]) -> Decimal | None:
        out = Decimal(0)
        for amount, currency, on in items:
            converted = fx_convert(fx, amount, Currency(currency), base, on)
            if converted is None:
                return None
            out += converted
        return out

    deposited = total([(t.cash_amount, t.cash_currency, t.trade_date) for t in deposits])
    planned = total([(p.amount, p.currency, min(p.planned_date, today)) for p in plans])
    monthly = plan.monthly_amount if plan is not None else None
    remaining = covered = None
    if monthly is not None and deposited is not None and planned is not None:
        remaining = max(Decimal(0), monthly - deposited - planned)
        covered = remaining == 0
    return {
        "month": f"{start.year:04d}-{start.month:02d}",
        "currency": str(base),
        "monthly_amount": _money(monthly),
        "day_of_month": plan.day_of_month if plan is not None else None,
        "deposited": _money(deposited),
        "planned": _money(planned),
        "remaining": _money(remaining),
        "covered": covered,
        "planned_count": len(plans),
    }


def _money(value: Decimal | None) -> float | None:
    return None if value is None else float(round(value, 2))


def planned_dict(row: InvPlannedDeposit) -> dict:
    return {
        "id": row.id,
        "account_id": row.account_id,
        "amount": float(row.amount),
        "currency": row.currency,
        "planned_date": row.planned_date.isoformat(),
        "note": row.note,
        "status": row.status,
        "booked_txn_id": row.booked_txn_id,
        "booked_at": None if row.booked_at is None else convert.aware(row.booked_at).isoformat(),
        "created_at": convert.aware(row.created_at).isoformat(),
        "updated_at": convert.aware(row.updated_at).isoformat(),
    }
