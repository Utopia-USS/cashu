"""Month close: what one calendar month earned, spent and left over, per currency, and how much of the
surplus to move to investments.

Definition (the same filters as the cashflow and spending views, so every number matches them):

- income = inflows of the month, spending = outflows by category; internal transfers, own-account
  counterparties (IBANs of the profile's accounts) and structural moves (``transfer``,
  ``cash_withdrawal``) are excluded; each currency on its own, never summed or converted;
- surplus = income - spending;
- cushion top-up (only in the cushion currency, only when the profile turned the rule on in the
  budget settings): ``min(target - cushion level, surplus, monthly_max)``, never below 0; the target
  is a fixed amount or N months of average spending (up to 6 months ending with the closed month);
- cushion level = the cushion accounts' balance as of the month start plus the month's transfers on
  them (internal / own-account / structural moves, in minus out), so the month's own income and
  spending booked on a cushion account (the income account kept as the cushion) are never counted
  twice: they are the surplus (F6 review V7). A transfer out to another own account that funded the
  month's spending there (a card repayment, a spending account, a cash withdrawal spent from the cash
  pool) is not a cushion outflow either: per destination account outside the cushion,
  ``min(transferred out to it, spending booked on it in the month)`` is added back (F7 review R5), so
  moving the suggested transfer out leaves the cushion at its target. An account without a balance
  before the month falls back to its month-end balance minus the month's income and spending booked
  on it;
- suggested transfer = surplus - cushion top-up, never below 0;
- planned contribution: the investments strategy's ``contributions.monthly_amount`` (in the
  strategy's base currency), read only when the investments module is enabled for the profile; the
  comparison uses the suggested transfer in that currency.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from sqlmodel import Session, select

from finanse.core import networth, profiles
from finanse.core.accounts import own_ibans
from finanse.core.models import Account, Profile

from . import analytics, investing_link
from .analytics import NON_SPENDING_CATEGORIES
from .models import Transaction
from .queries import transactions
from .settings import BudgetSettings, CushionSettings

ZERO = Decimal("0.00")
CUSHION_AVERAGE_MONTHS = 6
"""Months of spending averaged for a ``target_months`` cushion (ending with the closed month)."""


@dataclass
class CurrencyClose:
    currency: str
    income: Decimal = ZERO
    spending: Decimal = ZERO
    income_by_category: dict[str, Decimal] = field(default_factory=dict)
    spending_by_category: dict[str, Decimal] = field(default_factory=dict)
    transactions: int = 0
    cushion_top_up: Decimal = ZERO

    @property
    def surplus(self) -> Decimal:
        return self.income - self.spending

    @property
    def suggested_transfer(self) -> Decimal:
        return max(ZERO, self.surplus - self.cushion_top_up)


@dataclass
class CushionState:
    currency: str
    target: Decimal | None
    """None when the months target has no spending history to average."""
    target_source: str
    """amount | months"""
    target_months: int | None
    balance: Decimal
    missing: Decimal
    top_up: Decimal
    accounts: list[Account]
    average_spending: Decimal | None = None


@dataclass
class MonthClose:
    year: int
    month: int
    complete: bool
    base_currency: str
    currencies: list[CurrencyClose]
    first_month: str | None
    last_month: str | None
    cushion: CushionState | None = None
    planned: investing_link.PlannedContribution | None = None
    investments_enabled: bool = False

    @property
    def label(self) -> str:
        return f"{self.year}-{self.month:02d}"

    def currency(self, code: str) -> CurrencyClose | None:
        return next((c for c in self.currencies if c.currency == code), None)


def parse_month(value: str) -> tuple[int, int]:
    """``YYYY-MM`` -> (year, month); ValueError otherwise."""
    try:
        year_s, month_s = value.split("-")
        year, month = int(year_s), int(month_s)
    except (AttributeError, ValueError):
        raise ValueError("month must be YYYY-MM") from None
    if len(year_s) != 4 or not 1 <= month <= 12 or year < 1900:
        raise ValueError("month must be YYYY-MM")
    return year, month


def _shift(year: int, month: int, delta: int) -> tuple[int, int]:
    index = year * 12 + (month - 1) + delta
    return index // 12, index % 12 + 1


def default_month(session: Session, profile_id: int, today: date) -> tuple[int, int]:
    """The month to close when none is asked for: the newest month with data, unless that is the
    running calendar month (then the one before it)."""
    ref = analytics.reference_date(session, profile_id=profile_id)
    if ref is None or (ref.year, ref.month) >= (today.year, today.month):
        return _shift(today.year, today.month, -1)
    return ref.year, ref.month


def _month_bounds(session: Session, profile_id: int) -> tuple[str | None, str | None]:
    from sqlalchemy import func

    from finanse.core.profiles import account_ids_query

    first, last = session.exec(
        select(func.min(Transaction.booking_date), func.max(Transaction.booking_date)).where(
            Transaction.account_id.in_(account_ids_query(profile_id))
        )
    ).one()
    return _label(first), _label(last)


def _label(d: date | None) -> str | None:
    return None if d is None else f"{d.year}-{d.month:02d}"


def _is_flow(t: Transaction, own: set[str]) -> bool:
    """True when ``t`` is income or spending (the cashflow filters), False for a transfer."""
    from .ingestion.normalize import iban_key

    if t.category in NON_SPENDING_CATEGORIES or t.is_internal_transfer:
        return False
    cp = iban_key(t.counterparty_iban) if t.counterparty_iban else ""
    return not (cp and cp in own)


def month_flows(
    session: Session, profile_id: int, year: int, month: int
) -> dict[str, CurrencyClose]:
    """Income and spending of one month per currency (filters as ``monthly_cashflow``)."""
    start = date(year, month, 1)
    end = date(year, month, calendar.monthrange(year, month)[1])
    own = own_ibans(session, profile_id)
    out: dict[str, CurrencyClose] = {}
    q = transactions(profile_id, Transaction.booking_date >= start, Transaction.booking_date <= end)
    for t in session.exec(q).all():
        if not _is_flow(t, own):
            continue
        cc = out.get(t.currency)
        if cc is None:
            cc = out[t.currency] = CurrencyClose(t.currency)
        cc.transactions += 1
        if t.amount >= 0:
            cat = t.category or "income_other"
            cc.income += t.amount
            cc.income_by_category[cat] = cc.income_by_category.get(cat, ZERO) + t.amount
        else:
            cat = t.category or "other"
            cc.spending += -t.amount
            cc.spending_by_category[cat] = cc.spending_by_category.get(cat, ZERO) - t.amount
    return out


def _cushion_accounts(
    session: Session, profile_id: int, cushion: CushionSettings, currency: str
) -> list[Account]:
    query = select(Account).where(Account.profile_id == profile_id, Account.currency == currency)
    if cushion.account_ids:
        query = query.where(Account.id.in_(cushion.account_ids))
    else:
        query = query.where(Account.type == "savings", Account.active == True)
    return list(session.exec(query.order_by(Account.id)).all())


def _average_spending(
    session: Session, profile_id: int, currency: str, year: int, month: int
) -> Decimal | None:
    label = f"{year}-{month:02d}"
    rows = [
        r
        for r in analytics.monthly_cashflow(session, currency=currency, profile_id=profile_id)
        if r.label <= label
    ][-CUSHION_AVERAGE_MONTHS:]
    if not rows:
        return None
    return (sum((r.expense for r in rows), ZERO) / len(rows)).quantize(Decimal("0.01"))


def _destination(session: Session, t: Transaction, by_iban: dict[str, int]) -> int | None:
    """The profile's own account that received the money of an outgoing transfer ``t``: the other leg
    of a matched internal transfer, the cash pool for a withdrawal mirrored into it, or the own account
    named by the counterparty IBAN; None for money that left the profile's accounts."""
    from .ingestion.normalize import iban_key

    if t.transfer_group_id:
        other = session.exec(
            select(Transaction.account_id).where(
                Transaction.transfer_group_id == t.transfer_group_id,
                Transaction.account_id != t.account_id,
            )
        ).first()
        if other is not None:
            return other
    leg = session.exec(
        select(Transaction.account_id).where(Transaction.dedup_hash == f"cashleg:{t.id}")
    ).first()
    if leg is not None:
        return leg
    if t.counterparty_iban:
        return by_iban.get(iban_key(t.counterparty_iban))
    return None


def cushion_level(
    session: Session, profile_id: int, accounts: list[Account], year: int, month: int
) -> Decimal:
    """The cushion accounts' level for the close of ``year-month`` (see the module doc).

    level = balance as of the day before the month (the newest snapshot then plus the transactions
    booked after it) + the month's transfers on the account (in minus out); then, per own destination
    account outside the cushion, ``min(transferred out to it, spending booked on it in the month)`` is
    added back: that money funded the month's spending (a card repayment, a spending account, cash
    spent from the cash pool), which the surplus already counts (F7 review R5). Without an earlier
    balance the start is the month-end balance minus the month's income and spending on the account.
    Moving the suggested transfer out of the cushion then leaves it at its target."""
    from .ingestion.normalize import iban_key

    month_start = date(year, month, 1)
    before = date.fromordinal(month_start.toordinal() - 1)
    month_end = date(year, month, calendar.monthrange(year, month)[1])
    if not accounts:
        return ZERO
    own = own_ibans(session, profile_id)
    at_start = networth.latest_balance_per_account(session, before, profile_id=profile_id)
    at_end = networth.latest_balance_per_account(session, month_end, profile_id=profile_id)
    cushion_ids = {a.id for a in accounts}
    profile_accounts = session.exec(select(Account).where(Account.profile_id == profile_id)).all()
    by_iban = {iban_key(a.iban): a.id for a in profile_accounts if a.iban}
    sent: dict[int, Decimal] = {}
    level = ZERO
    for acc in accounts:
        rows = session.exec(
            select(Transaction).where(
                Transaction.account_id == acc.id, Transaction.booking_date <= month_end
            )
        ).all()
        in_month = [t for t in rows if t.booking_date >= month_start]
        moves = [t for t in in_month if not _is_flow(t, own)]
        start = at_start.get(acc.id)
        if start is not None:
            snapshot_day, amount = start
            amount += sum(
                (t.amount for t in rows if snapshot_day < t.booking_date <= before), ZERO
            )
            amount += sum((t.amount for t in moves), ZERO)
        else:
            end = at_end.get(acc.id)
            if end is None:
                continue
            amount = end[1] - sum((t.amount for t in in_month if _is_flow(t, own)), ZERO)
        value = networth.contribution(acc, amount)
        level += value if value is not None else ZERO
        for t in moves:
            if t.amount >= 0:
                continue
            dest = _destination(session, t, by_iban)
            if dest is not None and dest not in cushion_ids:
                sent[dest] = sent.get(dest, ZERO) - t.amount
    for dest, amount in sent.items():
        spent = ZERO
        for t in session.exec(
            select(Transaction).where(
                Transaction.account_id == dest,
                Transaction.booking_date >= month_start,
                Transaction.booking_date <= month_end,
            )
        ).all():
            if t.amount < 0 and _is_flow(t, own):
                spent -= t.amount
        level += min(amount, spent)
    return level


def cushion_state(
    session: Session,
    profile: Profile,
    cushion: CushionSettings,
    year: int,
    month: int,
    surplus: Decimal,
) -> CushionState:
    currency = cushion.currency or analytics.base_currency(session, profile.id)
    accounts = _cushion_accounts(session, profile.id, cushion, currency)
    balance = cushion_level(session, profile.id, accounts, year, month)
    average = None
    if cushion.target_amount is not None:
        target, source = cushion.target_amount, "amount"
    else:
        average = _average_spending(session, profile.id, currency, year, month)
        months = cushion.target_months or 0
        target = None if average is None else (average * months).quantize(Decimal("0.01"))
        source = "months"
    missing = ZERO if target is None else max(ZERO, target - balance)
    top_up = min(missing, max(ZERO, surplus))
    if cushion.monthly_max is not None:
        top_up = min(top_up, cushion.monthly_max)
    return CushionState(
        currency=currency,
        target=target,
        target_source=source,
        target_months=cushion.target_months if source == "months" else None,
        balance=balance,
        missing=missing,
        top_up=top_up,
        accounts=accounts,
        average_spending=average,
    )


def month_close(
    session: Session,
    profile: Profile,
    settings: BudgetSettings,
    *,
    year: int | None = None,
    month: int | None = None,
    today: date | None = None,
) -> MonthClose:
    """The close of one month for the profile (default month: see :func:`default_month`)."""
    today = today or date.today()  # noqa: DTZ011 - naive local date, like the booking dates
    pid = profiles.scope(session, profile.id)
    if year is None or month is None:
        year, month = default_month(session, pid, today)
    base = analytics.base_currency(session, pid)
    flows = month_flows(session, pid, year, month) if pid else {}
    first, last = _month_bounds(session, pid) if pid else (None, None)

    cushion = None
    if settings.cushion.enabled and pid:
        currency = settings.cushion.currency or base
        cc = flows.get(currency)
        cushion = cushion_state(
            session, profile, settings.cushion, year, month, cc.surplus if cc else ZERO
        )
        if cc is not None:
            cc.cushion_top_up = cushion.top_up

    order = {
        c.currency: i for i, c in enumerate(analytics.budget_currencies(session, profile_id=pid))
    }
    closes = sorted(flows.values(), key=lambda c: (order.get(c.currency, len(order)), c.currency))
    enabled = investing_link.investments_enabled(session, profile)
    return MonthClose(
        year=year,
        month=month,
        complete=date(year, month, calendar.monthrange(year, month)[1]) < today,
        base_currency=base,
        currencies=closes,
        first_month=first,
        last_month=last,
        cushion=cushion,
        planned=investing_link.planned_contribution(session, profile) if enabled else None,
        investments_enabled=enabled,
    )


def _f(value: Decimal | None) -> float | None:
    return None if value is None else float(value)


def _categories(values: dict[str, Decimal]) -> list[dict]:
    from .categorize import taxonomy

    rows = sorted(values.items(), key=lambda kv: kv[1], reverse=True)
    return [
        {"category": k, "label": taxonomy.LABELS.get(k, k), "amount": float(v)} for k, v in rows
    ]


def as_dict(close: MonthClose) -> dict:
    """The JSON shape of ``GET /budget/month-close`` (amounts as numbers, per currency)."""
    investing = None
    if close.investments_enabled:
        plan = close.planned
        investing = {"enabled": True, "strategy_state": None, "planned": None, "comparison": None}
        if plan is not None:
            investing["strategy_state"] = plan.strategy_state
            if plan.amount is not None and plan.currency:
                investing["planned"] = {
                    "amount": float(plan.amount),
                    "currency": plan.currency,
                    "day_of_month": plan.day_of_month,
                }
                cc = close.currency(plan.currency)
                surplus = cc.surplus if cc else ZERO
                suggested = cc.suggested_transfer if cc else ZERO
                investing["comparison"] = {
                    "currency": plan.currency,
                    "has_data": cc is not None,
                    "surplus": float(surplus),
                    "suggested_transfer": float(suggested),
                    "difference": float(suggested - plan.amount),
                    "status": "covered" if suggested >= plan.amount else "short",
                }
    cushion = None
    if close.cushion is not None:
        c = close.cushion
        cushion = {
            "enabled": True,
            "currency": c.currency,
            "target": _f(c.target),
            "target_source": c.target_source,
            "target_months": c.target_months,
            "average_spending": _f(c.average_spending),
            "balance": float(c.balance),
            "missing": float(c.missing),
            "top_up": float(c.top_up),
            "reached": c.target is not None and c.missing == 0,
            "accounts": [{"id": a.id, "name": a.name} for a in c.accounts],
        }
    return {
        "month": close.label,
        "complete": close.complete,
        "base_currency": close.base_currency,
        "first_month": close.first_month,
        "last_month": close.last_month,
        "currencies": [
            {
                "currency": c.currency,
                "income": float(c.income),
                "spending": float(c.spending),
                "surplus": float(c.surplus),
                "cushion_top_up": float(c.cushion_top_up),
                "suggested_transfer": float(c.suggested_transfer),
                "transactions": c.transactions,
                "income_by_category": _categories(c.income_by_category),
                "spending_by_category": _categories(c.spending_by_category),
            }
            for c in close.currencies
        ],
        "cushion": cushion,
        "investing": investing,
    }
