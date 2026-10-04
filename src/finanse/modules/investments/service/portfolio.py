"""A profile's portfolio as of a date: stored data -> the pure pipeline
(``build_snapshot`` -> ``value_portfolio`` -> ``allocate``). No math here, only loading."""

from __future__ import annotations

import datetime as dt
from collections.abc import Collection
from dataclasses import dataclass, field

from sqlmodel import Session

from finanse.core.models import Account, Profile

from ..domain import (
    AllocationResult,
    Currency,
    Instrument,
    InstrumentId,
    MarketView,
    PortfolioSnapshot,
    Transaction,
    ValuedPortfolio,
)
from ..portfolio import InMemoryFxLookup, allocate, build_snapshot, value_portfolio
from ..rules import DataQualityPolicy
from ..store import convert, instruments, market, transactions
from ..strategy import StrategyConfig


def today() -> dt.date:
    return dt.date.today()  # noqa: DTZ011 - naive local date, like trade dates


@dataclass
class PortfolioState:
    """Everything the views, the rules and net worth read for one profile as of one date."""

    profile_id: int
    as_of: dt.date
    base: Currency
    accounts: list[Account]
    """The profile's brokerage accounts (all, also when ``account_ids`` filters)."""
    account_ids: frozenset[str] | None
    """Domain ids of the accounts in scope (None = all)."""
    txns: list[Transaction]
    snapshot: PortfolioSnapshot
    """Snapshot of all accounts (``valued.snapshot`` is the restricted one)."""
    market: MarketView
    fx: InMemoryFxLookup
    valued: ValuedPortfolio
    instruments: dict[InstrumentId, Instrument] = field(default_factory=dict)
    allocation: AllocationResult | None = None
    data: DataQualityPolicy = field(default_factory=DataQualityPolicy)

    def account(self, account_id: str | int) -> Account | None:
        key = convert.maybe_pk(account_id)
        return next((a for a in self.accounts if a.id == key), None)


def base_currency(profile: Profile, strategy: StrategyConfig | None) -> Currency:
    return strategy.base_currency if strategy is not None else Currency(profile.base_currency)


def build(
    session: Session,
    profile: Profile,
    *,
    as_of: dt.date | None = None,
    strategy: StrategyConfig | None = None,
    account_ids: Collection[int] | None = None,
    base: Currency | None = None,
    history_days: int | None = 800,
) -> PortfolioState:
    """Load the profile's history and run the pipeline as of ``as_of`` (today by default),
    restricted to ``account_ids`` when given (weights relative to those accounts)."""
    as_of = as_of or today()
    pid = profile.id
    accounts = transactions.brokerage_accounts(session, pid)
    txns = transactions.transactions(session, pid)
    renames = transactions.renames(session, pid)
    snapshot = build_snapshot(convert.sid(pid), txns, as_of, renames=renames)

    referenced = {convert.pk(t.instrument_id) for t in txns if t.instrument_id is not None}
    for r in renames:
        referenced |= {convert.pk(r.old_instrument_id), convert.pk(r.new_instrument_id)}
    loaded = {convert.sid(k): v for k, v in instruments.load(session, referenced).items()}
    held = {h.instrument_id for h in snapshot.holdings}
    view = market.market_view(
        session,
        as_of,
        {k: v for k, v in loaded.items() if k in held},
        transactions.manual_valuations(session, pid, [convert.pk(i) for i in held]),
        history_days=history_days,
    )
    base = base or base_currency(profile, strategy)
    fx = market.fx_lookup(session, snapshot, view, base)
    data = strategy.data if strategy is not None else DataQualityPolicy()
    scope = None if account_ids is None else frozenset(convert.sid(a) for a in account_ids)
    valued = value_portfolio(
        snapshot,
        view,
        fx,
        base,
        data.max_price_age_days,
        account_ids=scope,
        max_fx_age_days=data.max_fx_age_days,
    )
    allocation = None
    if strategy is not None and strategy.allocation.buckets:
        allocation = allocate(valued, strategy.allocation, account_ids=scope)
    return PortfolioState(
        profile_id=pid,
        as_of=as_of,
        base=base,
        accounts=accounts,
        account_ids=scope,
        txns=txns,
        snapshot=snapshot,
        market=view,
        fx=fx,
        valued=valued,
        instruments=loaded,
        allocation=allocation,
        data=data,
    )
