"""Net worth: per-currency totals, assets vs liabilities, history by bucket.

Every account contributes its latest balance; loans (amortized outstanding),
vehicles (depreciated value) and the cash pool (running transaction sum) are
valued by their modules. Totals are per currency, never summed across currencies.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlmodel import Session, select

from finanse.modules.assets import depreciation as dep_mod
from finanse.modules.assets.service import depreciations as _depreciations
from finanse.modules.budget.cash import cash_balance_points as _cash_balance_points
from finanse.modules.loans import amortization as loan_mod
from finanse.modules.loans.service import loan_schedules as _loan_schedules

from .models import Account, AccountType, Balance

ZERO = Decimal("0.00")

# Types that are debts, and types that aren't liquid (excluded from "liquid" net worth).
LIABILITY_TYPES = {AccountType.CREDIT, AccountType.MORTGAGE, AccountType.LOAN}
ILLIQUID_TYPES = {
    AccountType.PROPERTY, AccountType.VEHICLE, AccountType.MORTGAGE, AccountType.LOAN,
}

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


