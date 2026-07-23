"""Read-only analytics over the normalized data: net worth, cashflow, recurring.

These power the CLI `stats` output now and the dashboard later. Internal
transfers (money moved between the user's own accounts) are excluded from
income/expense figures so they don't inflate spending or earnings.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import func
from sqlmodel import Session, select

from . import depreciation as dep_mod
from . import loan as loan_mod
from .models import Account, AccountType, Balance, Depreciation, Loan, Transaction

ZERO = Decimal("0.00")

# Types that are debts, and types that aren't liquid (excluded from "liquid" net worth).
LIABILITY_TYPES = {AccountType.CREDIT, AccountType.MORTGAGE, AccountType.LOAN}
ILLIQUID_TYPES = {
    AccountType.PROPERTY, AccountType.VEHICLE, AccountType.MORTGAGE, AccountType.LOAN,
}

# Categories that are structural moves, never real income or expense: internal
# transfers, and cash withdrawals reclassified as a move into the cash pool.
NON_SPENDING_CATEGORIES = {"transfer", "cash_withdrawal"}

# Net-worth display buckets. Each account maps to exactly one, so the buckets sum
# to the net-worth total — the same decomposition as the "assets vs liabilities"
# breakdown, tracked over time. Assets sit above 0, liabilities below.
NW_COMPONENT_LABELS = {
    "money": "Pieniądze",
    "property": "Nieruchomości",
    "vehicle": "Auto",
    "mortgage": "Hipoteka",
    "loan": "Kredyt",
}
# Stacking order: assets first (bottom→top), then liabilities (below zero).
NW_COMPONENT_ORDER = ["money", "property", "vehicle", "mortgage", "loan"]
_NW_COMPONENT_OF_TYPE = {
    AccountType.VEHICLE: "vehicle",
    AccountType.PROPERTY: "property",
    AccountType.MORTGAGE: "mortgage",
    AccountType.LOAN: "loan",
}


def _nw_component(account: Account) -> str:
    """Which net-worth bucket an account contributes to (everything liquid → money)."""
    return _NW_COMPONENT_OF_TYPE.get(account.type, "money")


def contribution(account: Account, amount: Decimal | None) -> Decimal | None:
    """Signed contribution of an account balance to net worth.

    - Credit card: positive balance is the limit/available credit (contributes 0);
      only a negative booked balance is real debt.
    - Mortgage / loan: stored as the outstanding principal → subtracts.
    - Everything else (cash, savings, investment, property): adds at face value.
    """
    if amount is None:
        return None
    if account.type == AccountType.CREDIT:
        return min(amount, ZERO)
    if account.type in (AccountType.MORTGAGE, AccountType.LOAN):
        return -abs(amount)
    return amount


# --------------------------------------------------------------------------- #
# Net worth
# --------------------------------------------------------------------------- #

# Prefer Open Banking over CSV when two snapshots share the same date (OB is the
# more current/authoritative source).
_BALANCE_SOURCE_RANK = {"open_banking": 0, "csv": 1, "manual": 2}


def _cash_balance_points(session: Session) -> dict[int, list[tuple[date, Decimal]]]:
    """Running end-of-day balance per CASH account, derived from its transactions.

    A cash account has no bank/OB balance feed — its balance is purely the sum of
    withdrawals into the pool (positive) minus manually-logged cash spends
    (negative). Returns ascending (date, running_total) points, and an empty list
    for a cash account that has no transactions yet (so it still shows as 0)."""
    out: dict[int, list[tuple[date, Decimal]]] = {}
    cash_accounts = session.exec(
        select(Account).where(Account.type == AccountType.CASH)
    ).all()
    for acc in cash_accounts:
        txns = session.exec(
            select(Transaction).where(Transaction.account_id == acc.id)
        ).all()
        by_date: dict[date, Decimal] = {}
        run = ZERO
        for t in sorted(txns, key=lambda t: (t.booking_date, t.id or 0)):
            run += t.amount
            by_date[t.booking_date] = run
        out[acc.id] = sorted(by_date.items())
    return out


def _loan_schedules(session: Session) -> dict[int, tuple[Loan, list]]:
    """account_id -> (Loan, amortization schedule)."""
    out: dict[int, tuple[Loan, list]] = {}
    for loan in session.exec(select(Loan)).all():
        rows = loan_mod.schedule(loan.principal, loan.annual_rate, loan.term_months, loan.start_date)
        out[loan.account_id] = (loan, rows)
    return out


def _depreciations(session: Session) -> dict[int, Depreciation]:
    """account_id -> Depreciation terms (VEHICLE accounts)."""
    return {d.account_id: d for d in session.exec(select(Depreciation)).all()}


def latest_balance_per_account(
    session: Session, as_of: date | None = None
) -> dict[int, tuple[date, Decimal]]:
    """Most recent balance per account. For loan accounts the balance is the
    amortized outstanding as of `as_of` (interest accrues, payments reduce it)."""
    q = select(Balance)
    if as_of is not None:
        q = q.where(Balance.date <= as_of)
    latest: dict[int, tuple[date, Decimal]] = {}
    ranks: dict[int, int] = {}
    for b in session.exec(q).all():
        rank = _BALANCE_SOURCE_RANK.get(b.source.value, 9)
        cur = latest.get(b.account_id)
        if cur is None or b.date > cur[0] or (b.date == cur[0] and rank < ranks[b.account_id]):
            latest[b.account_id] = (b.date, b.amount)
            ranks[b.account_id] = rank

    ref = as_of or date.today()
    for acc_id, (loan, rows) in _loan_schedules(session).items():
        latest[acc_id] = (ref, loan_mod.outstanding(rows, ref, loan.origination_date))
    # Vehicles: value is the depreciated estimate as of `ref`.
    for acc_id, dep in _depreciations(session).items():
        latest[acc_id] = (ref, dep_mod.value_of(dep, ref))
    # Cash accounts: balance is the running transaction sum as of `ref`.
    for acc_id, pts in _cash_balance_points(session).items():
        bal = ZERO
        for d, v in pts:
            if d <= ref:
                bal = v
            else:
                break
        latest[acc_id] = (ref, bal)
    return latest


@dataclass
class NetWorthLine:
    account: Account
    as_of: date | None
    amount: Decimal | None  # raw reported balance; None = no balance data

    @property
    def is_liability(self) -> bool:
        return self.account.type in LIABILITY_TYPES

    @property
    def contribution(self) -> Decimal | None:
        return contribution(self.account, self.amount)


def net_worth(
    session: Session, as_of: date | None = None
) -> tuple[dict[str, Decimal], list[NetWorthLine]]:
    """Net worth totals **per currency** (mixing PLN/EUR/NOK/HUF into one number
    would be meaningless without FX conversion, which is a later phase)."""
    accounts = session.exec(select(Account).where(Account.active == True)).all()  # noqa: E712
    latest = latest_balance_per_account(session, as_of)
    lines: list[NetWorthLine] = []
    totals: dict[str, Decimal] = {}
    for acc in accounts:
        entry = latest.get(acc.id)
        amount = entry[1] if entry else None
        line = NetWorthLine(account=acc, as_of=entry[0] if entry else None, amount=amount)
        lines.append(line)
        if line.contribution is not None:
            totals[acc.currency] = totals.get(acc.currency, ZERO) + line.contribution
    return totals, lines


@dataclass
class NetWorthBreakdown:
    currency: str
    assets: Decimal
    liabilities: Decimal  # positive magnitude of debts
    net: Decimal
    property_value: Decimal
    mortgage: Decimal
    by_type: dict[str, Decimal]

    @property
    def home_equity(self) -> Decimal:
        return self.property_value - self.mortgage


def net_worth_breakdown(session: Session, currency: str = "PLN") -> NetWorthBreakdown:
    """Split net worth into assets vs liabilities (+ property / mortgage / equity)."""
    accounts = session.exec(
        select(Account).where(Account.active == True, Account.currency == currency)  # noqa: E712
    ).all()
    latest = latest_balance_per_account(session)
    assets = liabilities = prop = mort = ZERO
    by_type: dict[str, Decimal] = {}
    for a in accounts:
        entry = latest.get(a.id)
        if entry is None:
            continue
        raw = entry[1]
        c = contribution(a, raw)
        by_type[a.type.value] = by_type.get(a.type.value, ZERO) + c
        if c >= 0:
            assets += c
        else:
            liabilities += -c
        if a.type == AccountType.PROPERTY:
            prop += raw
        elif a.type == AccountType.MORTGAGE:
            mort += abs(raw)
    return NetWorthBreakdown(currency, assets, liabilities, assets - liabilities, prop, mort, by_type)


def _resample_period_end(series: list[tuple[date, object]], granularity: str) -> list:
    """Keep the last value in each week/month (period-end net worth). Works for any
    value type (a scalar total or a per-component dict)."""
    buckets: dict[tuple, tuple[date, object]] = {}
    for d, v in series:  # series is ascending, so last write per period wins
        if granularity == "monthly":
            key = (d.year, d.month)
        else:  # weekly
            iso = d.isocalendar()
            key = (iso[0], iso[1])
        buckets[key] = (d, v)
    return [buckets[k] for k in sorted(buckets)]


def net_worth_component_series(
    session: Session,
    currency: str = "PLN",
    granularity: str = "daily",
    scope: str = "total",
) -> list[tuple[date, dict[str, Decimal]]]:
    """Net worth over time, broken into display buckets (see ``NW_COMPONENT_ORDER``).

    Returns ``(date, {component: contribution})`` points; the buckets sum to the
    net-worth total at each date — the same money/auto/property/hipoteka/kredyt
    decomposition as the "assets vs liabilities" breakdown, tracked over time.

    granularity: 'daily' | 'weekly' | 'monthly' (period-end value). scope:
    'total' (all accounts) | 'liquid' (only the money bucket).
    """
    accounts = {
        a.id: a
        for a in session.exec(select(Account).where(Account.currency == currency)).all()
    }
    if scope == "liquid":
        accounts = {i: a for i, a in accounts.items() if a.type not in ILLIQUID_TYPES}
    if not accounts:
        return []

    loans = {aid: lr for aid, lr in _loan_schedules(session).items() if aid in accounts}
    vehicles = {aid: d for aid, d in _depreciations(session).items() if aid in accounts}
    cash_ids = {aid for aid, a in accounts.items() if a.type == AccountType.CASH}
    computed = set(loans) | set(vehicles)

    # (date, balance) points per account. Balance-driven accounts come from their
    # Balance snapshots; cash accounts from their running transaction sum; loan and
    # vehicle accounts are computed per-date from their schedule/depreciation.
    points: dict[int, list[tuple[date, Decimal]]] = {}
    bal_by_date: dict[int, dict[date, Decimal]] = defaultdict(dict)
    for b in sorted(session.exec(select(Balance)).all(), key=lambda b: b.date):
        if b.account_id in accounts and b.account_id not in computed and b.account_id not in cash_ids:
            bal_by_date[b.account_id][b.date] = b.amount  # last write per date wins
    for acc_id, d2a in bal_by_date.items():
        points[acc_id] = sorted(d2a.items())
    for acc_id, pts in _cash_balance_points(session).items():
        if acc_id in accounts:
            points[acc_id] = pts

    if not points and not loans and not vehicles:
        return []

    series: list[tuple[date, dict[str, Decimal]]] = []
    for d in sorted({pd for pts in points.values() for pd, _ in pts}):
        comps: dict[str, Decimal] = {}

        def add(acc: Account, amount: Decimal | None) -> None:
            c = contribution(acc, amount)
            if c is not None:
                key = _nw_component(acc)
                comps[key] = comps.get(key, ZERO) + c

        for acc_id, pts in points.items():
            last = None
            for pd, amt in pts:
                if pd <= d:
                    last = amt
                else:
                    break
            if last is not None:
                add(accounts[acc_id], last)
        for acc_id, (loan, rows) in loans.items():
            add(accounts[acc_id], loan_mod.outstanding(rows, d, loan.origination_date))
        for acc_id, dep in vehicles.items():
            add(accounts[acc_id], dep_mod.value_of(dep, d))
        series.append((d, comps))

    if granularity in ("weekly", "monthly"):
        series = _resample_period_end(series, granularity)
    return series


def net_worth_series(
    session: Session,
    currency: str = "PLN",
    granularity: str = "daily",
    scope: str = "total",
) -> list[tuple[date, Decimal]]:
    """Net worth total over time (sum of the component buckets)."""
    return [
        (d, sum(comps.values(), ZERO))
        for d, comps in net_worth_component_series(session, currency, granularity, scope)
    ]


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
    session: Session, currency: str = "PLN", include_internal: bool = False
) -> list[MonthlyCashflow]:
    from .ingestion.normalize import iban_key

    # Every account we own — a transaction whose counterparty is one of these is
    # a move *within* the estate, not real income/expense.
    own_ibans = {iban_key(a.iban) for a in session.exec(select(Account)).all() if a.iban}

    q = select(Transaction).where(Transaction.currency == currency)
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
    if quarter is not None and (d.month - 1) // 3 + 1 != quarter:
        return False
    return True


def spending_by_category(
    session: Session,
    currency: str = "PLN",
    year: int | None = None,
    month: int | None = None,
    quarter: int | None = None,
) -> list[CategorySpend]:
    """Expense totals per category (transfers excluded), optionally for a month,
    quarter or year."""
    from .categorize import taxonomy
    from .ingestion.normalize import iban_key

    own = {iban_key(a.iban) for a in session.exec(select(Account)).all() if a.iban}
    buckets: dict[str, Decimal] = {}
    for t in session.exec(select(Transaction).where(Transaction.currency == currency)).all():
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
) -> list[dict]:
    """Transactions in one category (for drill-down), sortable by date or amount."""
    from .ingestion.normalize import merchant_key

    accounts = {a.id: a for a in session.exec(select(Account)).all()}
    rows: list[dict] = []
    for t in session.exec(select(Transaction).where(Transaction.currency == currency)).all():
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


def detect_recurring(
    session: Session,
    min_occurrences: int = 3,
    *,
    min_gap: int = 24,
    max_gap: int = 37,
) -> list[RecurringCandidate]:
    """Surface likely monthly subscriptions.

    Groups non-internal outflows by (cleaned merchant, exact amount) — a real
    subscription has the same payee AND the same amount each period, which
    naturally separates it from variable spend at the same merchant (groceries).
    A group qualifies when it recurs at a roughly monthly cadence (median gap in
    [min_gap, max_gap] days). Still a heuristic; a dedicated engine comes later.
    """
    from .ingestion.normalize import merchant_key

    groups: dict[tuple[str, str], list[Transaction]] = defaultdict(list)
    q = select(Transaction).where(
        Transaction.is_internal_transfer == False,  # noqa: E712
    )
    for t in session.exec(q).all():
        if t.amount >= 0:
            continue  # subscriptions are outflows
        payee = merchant_key(t.counterparty_name, t.reference, t.description)
        if not payee:
            continue
        groups[(payee, f"{-t.amount:.2f}")].append(t)

    candidates: list[RecurringCandidate] = []
    for (payee, amount_key), txns in groups.items():
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
            )
        )

    candidates.sort(key=lambda c: c.last_date, reverse=True)
    return candidates


def reference_date(session: Session) -> date | None:
    """Most recent transaction date in the DB — a proxy for 'now'."""
    return session.exec(select(func.max(Transaction.booking_date))).one()


def active_recurring(
    session: Session, within_days: int = 45, min_occurrences: int = 3
) -> list[RecurringCandidate]:
    """Recurring payments still seen recently (likely current subscriptions)."""
    rec = detect_recurring(session, min_occurrences=min_occurrences)
    ref = reference_date(session)
    if ref is None:
        return rec
    cutoff = ref - timedelta(days=within_days)
    return [c for c in rec if c.last_date >= cutoff]
