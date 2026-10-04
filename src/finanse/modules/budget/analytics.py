"""Budget analytics over transactions: cashflow, spending, recurring payments.

Internal transfers (money moved between the user's own accounts) are excluded
from income/expense figures so they don't inflate spending or earnings.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import func
from sqlmodel import Session, select

from finanse.core import modules, profiles
from finanse.core.accounts import own_ibans as _own_ibans
from finanse.core.accounts import profile_accounts
from finanse.core.profiles import account_ids_query

from .models import Transaction
from .queries import transactions

ZERO = Decimal("0.00")

# Categories that are structural moves, never real income or expense: internal
# transfers, and cash withdrawals reclassified as a move into the cash pool.
NON_SPENDING_CATEGORIES = {"transfer", "cash_withdrawal"}


# --------------------------------------------------------------------------- #
# Monthly cashflow
# --------------------------------------------------------------------------- #

@dataclass
class MonthlyCashflow:
    year: int
    month: int
    income: Decimal
    expense: Decimal  # positive magnitude

    @property
    def net(self) -> Decimal:
        return self.income - self.expense

    @property
    def label(self) -> str:
        return f"{self.year}-{self.month:02d}"


def monthly_cashflow(
    session: Session,
    currency: str = "PLN",
    include_internal: bool = False,
    *,
    profile_id: int | None = None,
) -> list[MonthlyCashflow]:
    from .ingestion.normalize import iban_key

    pid = profiles.scope(session, profile_id)
    # Every account the profile owns — a transaction whose counterparty is one of
    # these is a move *within* the profile's money, not real income/expense.
    own_ibans = _own_ibans(session, pid)

    q = transactions(pid, Transaction.currency == currency)
    buckets: dict[tuple[int, int], MonthlyCashflow] = {}
    for t in session.exec(q).all():
        if t.category in NON_SPENDING_CATEGORIES:
            continue  # internal / capital / cash-pool moves are never income or expense
        if not include_internal:
            if t.is_internal_transfer:
                continue
            cp = iban_key(t.counterparty_iban)
            if cp and cp in own_ibans:
                continue
        key = (t.booking_date.year, t.booking_date.month)
        mc = buckets.get(key)
        if mc is None:
            mc = MonthlyCashflow(key[0], key[1], ZERO, ZERO)
            buckets[key] = mc
        if t.amount >= 0:
            mc.income += t.amount
        else:
            mc.expense += -t.amount
    return [buckets[k] for k in sorted(buckets)]


# --------------------------------------------------------------------------- #
# Spending by category
# --------------------------------------------------------------------------- #

@dataclass
class CategorySpend:
    category: str
    label: str
    amount: Decimal  # positive expense magnitude


def _in_period(d: date, year: int | None, month: int | None, quarter: int | None) -> bool:
    if year is not None and d.year != year:
        return False
    if month is not None and d.month != month:
        return False
    return quarter is None or (d.month - 1) // 3 + 1 == quarter


def spending_by_category(
    session: Session,
    currency: str = "PLN",
    year: int | None = None,
    month: int | None = None,
    quarter: int | None = None,
    *,
    profile_id: int | None = None,
) -> list[CategorySpend]:
    """Expense totals per category (transfers excluded), optionally for a month,
    quarter or year."""
    from .categorize import taxonomy
    from .ingestion.normalize import iban_key

    pid = profiles.scope(session, profile_id)
    own = _own_ibans(session, pid)
    buckets: dict[str, Decimal] = {}
    for t in session.exec(transactions(pid, Transaction.currency == currency)).all():
        if t.amount >= 0 or t.is_internal_transfer or t.category in NON_SPENDING_CATEGORIES:
            continue
        cp = iban_key(t.counterparty_iban) if t.counterparty_iban else ""
        if cp and cp in own:
            continue
        if not _in_period(t.booking_date, year, month, quarter):
            continue
        cat = t.category or "other"
        buckets[cat] = buckets.get(cat, ZERO) + (-t.amount)

    out = [CategorySpend(k, taxonomy.LABELS.get(k, k), v) for k, v in buckets.items()]
    out.sort(key=lambda c: c.amount, reverse=True)
    return out


def _txn_details(t: Transaction, primary: str | None) -> str | None:
    """A secondary 'so you can tell what it is' line: recipient + memo + bank ids,
    skipping whatever already appears as the primary title (avoids duplication)."""
    parts: list[str] = []
    if t.counterparty_name and t.counterparty_name != primary:
        parts.append(t.counterparty_name)
    if t.description and t.description != primary and t.description != t.counterparty_name:
        parts.append(t.description)
    if t.counterparty_iban:
        parts.append("…" + t.counterparty_iban[-4:])
    if t.bank_transaction_id:
        parts.append("nr " + t.bank_transaction_id)
    seen: set[str] = set()
    uniq = [p for p in parts if not (p in seen or seen.add(p))]
    return " · ".join(uniq) or None


def category_transactions(
    session: Session,
    category: str,
    currency: str = "PLN",
    sort: str = "date",
    order: str = "desc",
    year: int | None = None,
    month: int | None = None,
    quarter: int | None = None,
    *,
    profile_id: int | None = None,
) -> list[dict]:
    """Transactions in one category (for drill-down), sortable by date or amount."""
    from .ingestion.normalize import merchant_key

    pid = profiles.scope(session, profile_id)
    accounts = {a.id: a for a in profile_accounts(session, pid)}
    rows: list[dict] = []
    for t in session.exec(transactions(pid, Transaction.currency == currency)).all():
        if (t.category or "other") != category:
            continue
        if not _in_period(t.booking_date, year, month, quarter):
            continue
        acc = accounts.get(t.account_id)
        merchant = (
            t.reference or t.description or t.counterparty_name
            or merchant_key(t.counterparty_name, t.reference, t.description)
        )
        rows.append(
            {
                "id": t.id,
                "date": t.booking_date.isoformat(),
                "amount": t.amount,
                "currency": t.currency,
                "merchant": merchant,
                "merchant_key": merchant_key(t.counterparty_name, t.reference, t.description),
                "details": _txn_details(t, merchant),
                "counterparty": t.counterparty_name,
                "category": t.category,
                "category_source": t.category_source,
                "account": acc.name if acc else None,
            }
        )
    reverse = order != "asc"
    if sort == "amount":
        rows.sort(key=lambda r: abs(r["amount"]), reverse=reverse)
    else:
        rows.sort(key=lambda r: r["date"], reverse=reverse)
    return rows


# --------------------------------------------------------------------------- #
# Recurring-payment detection (basic; refined in a later phase)
# --------------------------------------------------------------------------- #

@dataclass
class RecurringCandidate:
    counterparty: str
    typical_amount: Decimal
    occurrences: int
    months_covered: int
    median_gap_days: int
    last_date: date
    currency: str = "PLN"


# Monthly, same-amount outflows that are NOT subscriptions: rent and housing fees,
# bank fees, cash withdrawals, taxes and own-account moves; modules add theirs
# (``ModuleSpec.not_subscription_categories``, e.g. loans: "loans").
NOT_SUBSCRIPTION_CATEGORIES = {
    "housing", "fees", "cash", "taxes", "transfer", "cash_withdrawal",
}


def not_subscription_categories() -> set[str]:
    from finanse.core import modules

    return NOT_SUBSCRIPTION_CATEGORIES | modules.not_subscription_categories()


# Per-transaction category decisions the deterministic engine cannot reproduce.
_TXN_DECIDED_SOURCES = {"manual_txn", "llm_full", "llm_fallback", "cash_leg"}


def detect_recurring(
    session: Session,
    min_occurrences: int = 3,
    *,
    min_gap: int = 24,
    max_gap: int = 37,
    profile_id: int | None = None,
) -> list[RecurringCandidate]:
    """Surface likely monthly subscriptions.

    Groups non-internal outflows by (cleaned merchant, exact amount) — a real
    subscription has the same payee AND the same amount each period, which
    naturally separates it from variable spend at the same merchant (groceries).
    A group qualifies when it recurs at a roughly monthly cadence (median gap in
    [min_gap, max_gap] days). Still a heuristic; a dedicated engine comes later.

    Outflows whose category (the user's per-transaction choice, else what the
    deterministic engine gives without the recurring signal) is rent, a loan
    installment, a fee, cash, tax or a transfer are not subscriptions and are
    skipped. Groups are per currency, so amounts are never mixed.
    """
    from .categorize import engine
    from .categorize.rules import load_rules
    from .ingestion.normalize import merchant_key

    pid = profiles.scope(session, profile_id)
    own = _own_ibans(session, pid)
    rules = load_rules(session, pid)
    patterns = modules.payment_patterns(session, pid)
    excluded = not_subscription_categories()

    def not_a_subscription(t: Transaction) -> bool:
        if t.category_source in _TXN_DECIDED_SOURCES and t.category:
            cat = t.category
        else:
            cat, _src = engine.categorize(
                t, own_ibans=own, rules=rules, subscription_keys=set(), patterns=patterns
            )
        return cat in excluded

    groups: dict[tuple[str, str, str], list[Transaction]] = defaultdict(list)
    q = transactions(pid, Transaction.is_internal_transfer == False)
    for t in session.exec(q).all():
        if t.amount >= 0:
            continue  # subscriptions are outflows
        payee = merchant_key(t.counterparty_name, t.reference, t.description)
        if not payee or not_a_subscription(t):
            continue
        groups[(payee, t.currency, f"{-t.amount:.2f}")].append(t)

    candidates: list[RecurringCandidate] = []
    for (payee, currency, amount_key), txns in groups.items():
        if len(txns) < min_occurrences:
            continue
        dates = sorted(t.booking_date for t in txns)
        gaps = [(dates[i + 1] - dates[i]).days for i in range(len(dates) - 1)]
        gaps = [g for g in gaps if g > 0]
        if not gaps:
            continue
        median_gap = sorted(gaps)[len(gaps) // 2]
        if not (min_gap <= median_gap <= max_gap):
            continue
        months = {(d.year, d.month) for d in dates}
        candidates.append(
            RecurringCandidate(
                counterparty=payee,
                typical_amount=Decimal(amount_key),
                occurrences=len(txns),
                months_covered=len(months),
                median_gap_days=median_gap,
                last_date=dates[-1],
                currency=currency,
            )
        )

    candidates.sort(key=lambda c: c.last_date, reverse=True)
    return candidates


def reference_date(session: Session, *, profile_id: int | None = None) -> date | None:
    """Most recent transaction date of the profile — a proxy for 'now'."""
    pid = profiles.scope(session, profile_id)
    return session.exec(
        select(func.max(Transaction.booking_date)).where(
            Transaction.account_id.in_(account_ids_query(pid))
        )
    ).one()


def active_recurring(
    session: Session,
    within_days: int = 45,
    min_occurrences: int = 3,
    *,
    profile_id: int | None = None,
) -> list[RecurringCandidate]:
    """Recurring payments still seen recently (likely current subscriptions)."""
    rec = detect_recurring(session, min_occurrences=min_occurrences, profile_id=profile_id)
    ref = reference_date(session, profile_id=profile_id)
    if ref is None:
        return rec
    cutoff = ref - timedelta(days=within_days)
    return [c for c in rec if c.last_date >= cutoff]
