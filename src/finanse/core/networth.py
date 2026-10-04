"""Net worth: per-currency totals, assets vs liabilities, history by bucket.

Core values every account from its balance snapshots. A module that knows better
how to value the accounts it owns registers a ``NetWorthContributor`` in its
``ModuleSpec``: loans value their accounts by the amortization schedule, assets
value vehicles by depreciation, budget values the cash pool by its running
transaction sum, investments (later) value brokerage accounts by their
positions. The sign, liquidity and chart bucket of each account come from the
account type registry (``core.account_types``). Totals are per currency, never
summed across currencies.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Protocol

from sqlmodel import Session, select

from . import account_types, modules
from .models import Account, Balance

ZERO = Decimal("0.00")


# --------------------------------------------------------------------------- #
# Contributor protocol
# --------------------------------------------------------------------------- #

class Valuation(Protocol):
    """How one account is valued over time (raw balance, before the sign)."""

    def latest(self, as_of: date | None) -> tuple[date, Decimal] | None:
        """(as-of date, value) for net worth now / at ``as_of``; None = no data."""

    def at(self, d: date) -> Decimal | None:
        """Value at ``d`` for the history series; None = no data yet."""

    def axis_dates(self) -> Iterable[date]:
        """Dates that create points on the history series (may be empty)."""


class NetWorthContributor(Protocol):
    def valuations(
        self, session: Session, accounts: Mapping[int, Account]
    ) -> dict[int, Valuation]:
        """Valuations for those of ``accounts`` this module values (others omitted)."""


class ComputedValuation:
    """A value computed for any date (loan outstanding, depreciated value)."""

    def __init__(self, value_at: Callable[[date], Decimal]):
        self._value_at = value_at

    def latest(self, as_of: date | None) -> tuple[date, Decimal]:
        ref = as_of or date.today()  # noqa: DTZ011 - naive local date, like the booking dates
        return ref, self._value_at(ref)

    def at(self, d: date) -> Decimal:
        return self._value_at(d)

    def axis_dates(self) -> list[date]:
        return []


class RunningValuation:
    """A value known at points (ascending (date, value)); 0 before the first one
    for net worth now, no value before it in the history (the cash pool)."""

    def __init__(self, points: list[tuple[date, Decimal]]):
        self._points = points

    def _last(self, d: date) -> Decimal | None:
        last = None
        for pd, v in self._points:
            if pd <= d:
                last = v
            else:
                break
        return last

    def latest(self, as_of: date | None) -> tuple[date, Decimal]:
        ref = as_of or date.today()  # noqa: DTZ011 - naive local date, like the booking dates
        last = self._last(ref)
        return ref, last if last is not None else ZERO

    def at(self, d: date) -> Decimal | None:
        return self._last(d)

    def axis_dates(self) -> list[date]:
        return [d for d, _ in self._points]


# Prefer Open Banking over CSV when two snapshots share the same date (OB is the
# more current/authoritative source).
_BALANCE_SOURCE_RANK = {"open_banking": 0, "csv": 1, "manual": 2}


class BalanceValuation:
    """Core default: the account's balance snapshots (step function)."""

    def __init__(self, balances: list[Balance]):
        self._rows = sorted(balances, key=lambda b: b.date)  # stable: insertion order per day
        by_date: dict[date, Decimal] = {}
        for b in self._rows:
            by_date[b.date] = b.amount  # last write per date wins
        self._points = sorted(by_date.items())

    def latest(self, as_of: date | None) -> tuple[date, Decimal] | None:
        best: tuple[date, int, Decimal] | None = None
        for b in self._rows:
            if as_of is not None and b.date > as_of:
                continue
            rank = _BALANCE_SOURCE_RANK.get(b.source.value, 9)
            if best is None or b.date > best[0] or (b.date == best[0] and rank < best[1]):
                best = (b.date, rank, b.amount)
        return (best[0], best[2]) if best else None

    def at(self, d: date) -> Decimal | None:
        last = None
        for pd, v in self._points:
            if pd <= d:
                last = v
            else:
                break
        return last

    def axis_dates(self) -> list[date]:
        return [d for d, _ in self._points]


def balance_valuations(
    session: Session, account_ids: Iterable[int]
) -> dict[int, BalanceValuation]:
    ids = set(account_ids)
    rows: dict[int, list[Balance]] = defaultdict(list)
    if ids:
        for b in session.exec(select(Balance).where(Balance.account_id.in_(ids))).all():
            rows[b.account_id].append(b)
    return {aid: BalanceValuation(bs) for aid, bs in rows.items()}


def valuations(session: Session, accounts: Mapping[int, Account]) -> dict[int, Valuation]:
    """Valuation per account: the owning module's contributor if any, else the
    balance snapshots. Accounts without any data are absent."""
    out: dict[int, Valuation] = {}
    for spec in modules.all_modules():
        if spec.networth is None:
            continue
        for acc_id, v in spec.networth.valuations(session, accounts).items():
            out.setdefault(acc_id, v)
    out.update(balance_valuations(session, (a for a in accounts if a not in out)))
    return out


# --------------------------------------------------------------------------- #
# Account semantics (from the account type registry)
# --------------------------------------------------------------------------- #

def contribution(account: Account, amount: Decimal | None) -> Decimal | None:
    """Signed contribution of an account balance to net worth.

    - credit (credit card): a positive balance is the limit/available credit
      (contributes 0); only a negative booked balance is real debt;
    - liability (mortgage, loan): stored as the outstanding principal, subtracts;
    - asset (cash, savings, investment, property, ...): adds at face value.
    """
    if amount is None:
        return None
    sign = account_types.get(account.type).sign
    if sign == "credit":
        return min(amount, ZERO)
    if sign == "liability":
        return -abs(amount)
    return amount


def _bucket(account: Account) -> str:
    """Which net-worth bucket an account contributes to (unknown types → money)."""
    return account_types.get(account.type).bucket


def component_labels() -> dict[str, str]:
    modules.registry()
    return {b.id: b.label for b in account_types.buckets()}


def component_order() -> list[str]:
    modules.registry()
    return [b.id for b in account_types.buckets()]


def liability_components() -> set[str]:
    modules.registry()
    return {b.id for b in account_types.buckets() if b.liability}


# --------------------------------------------------------------------------- #
# Net worth now
# --------------------------------------------------------------------------- #

def latest_balance_per_account(
    session: Session, as_of: date | None = None
) -> dict[int, tuple[date, Decimal]]:
    """Most recent value per account as of ``as_of`` (today when None). Accounts a
    module values (loans, vehicles, cash) get that module's value for the date."""
    accounts = {a.id: a for a in session.exec(select(Account)).all()}
    out: dict[int, tuple[date, Decimal]] = {}
    for acc_id, v in valuations(session, accounts).items():
        entry = v.latest(as_of)
        if entry is not None:
            out[acc_id] = entry
    return out


@dataclass
class NetWorthLine:
    account: Account
    as_of: date | None
    amount: Decimal | None  # raw reported balance; None = no balance data

    @property
    def is_liability(self) -> bool:
        return account_types.get(self.account.type).sign != "asset"

    @property
    def contribution(self) -> Decimal | None:
        return contribution(self.account, self.amount)


def net_worth(
    session: Session, as_of: date | None = None
) -> tuple[dict[str, Decimal], list[NetWorthLine]]:
    """Net worth totals **per currency** (mixing PLN/EUR/NOK/HUF into one number
    would be meaningless without FX conversion, which is a later phase)."""
    accounts = session.exec(select(Account).where(Account.active == True)).all()
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
        select(Account).where(Account.active == True, Account.currency == currency)
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
        tid = account_types.type_id(a.type)
        by_type[tid] = by_type.get(tid, ZERO) + c
        if c >= 0:
            assets += c
        else:
            liabilities += -c
        bucket = _bucket(a)
        if bucket == "property":
            prop += raw
        elif bucket == "mortgage":
            mort += abs(raw)
    return NetWorthBreakdown(currency, assets, liabilities, assets - liabilities, prop, mort, by_type)


# --------------------------------------------------------------------------- #
# History
# --------------------------------------------------------------------------- #

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
    """Net worth over time, broken into display buckets (see ``component_order``).

    Returns ``(date, {component: contribution})`` points; the buckets sum to the
    net-worth total at each date — the same money/auto/property/hipoteka/kredyt
    decomposition as the "assets vs liabilities" breakdown, tracked over time.
    Points sit on the dates where some account's value is known (balance
    snapshots, cash movements); computed values (loans, vehicles) are evaluated
    at those dates.

    granularity: 'daily' | 'weekly' | 'monthly' (period-end value). scope:
    'total' (all accounts) | 'liquid' (only liquid account types).
    """
    modules.registry()
    accounts = {
        a.id: a
        for a in session.exec(select(Account).where(Account.currency == currency)).all()
    }
    if scope == "liquid":
        accounts = {i: a for i, a in accounts.items() if account_types.get(a.type).liquid}
    if not accounts:
        return []

    vals = valuations(session, accounts)
    axis = sorted({d for v in vals.values() for d in v.axis_dates()})

    series: list[tuple[date, dict[str, Decimal]]] = []
    for d in axis:
        comps: dict[str, Decimal] = {}
        for acc_id, v in vals.items():
            acc = accounts[acc_id]
            c = contribution(acc, v.at(d))
            if c is not None:
                key = _bucket(acc)
                comps[key] = comps.get(key, ZERO) + c
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
