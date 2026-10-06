"""Investments' net-worth contributor: a brokerage account is worth its holdings plus its broker cash,
valued by the pure ``value_portfolio`` in the account's currency (NBP rates for other currencies,
stored prices, last trade price as the fallback). Net worth stays per currency: the account's value
is reported in the account currency like any other account.

History: the value is computed exactly at month ends (and today) and held flat in between, so the
net-worth series stays cheap with long histories. A brokerage account without investments
transactions is left to the core (its balance snapshots), so a manually set balance still counts.
"""

from __future__ import annotations

import calendar
import datetime as dt
from collections.abc import Mapping
from decimal import Decimal
from functools import cached_property

from sqlmodel import Session

from cashu.core.models import Account
from cashu.core.networth import Valuation

from .domain import Currency, Instrument, InstrumentId, MarketView
from .market import InMemoryMarketData
from .portfolio import build_snapshot, value_portfolio
from .rules import DataQualityPolicy
from .store import convert, instruments, market, transactions
from .store.transactions import BROKERAGE

_POLICY = DataQualityPolicy()
# Net worth uses the newest known NBP rate up to a year old (the rules' 10-day limit would drop
# foreign holdings from net worth whenever the daily check has not run for a while).
_NETWORTH_MAX_FX_AGE_DAYS = 366
_LATEST_WINDOW_DAYS = 400  # bars loaded for "now" (the newest one is used)


def _today() -> dt.date:
    return dt.date.today()  # noqa: DTZ011 - naive local date, like the booking dates


def month_ends(start: dt.date, end: dt.date) -> list[dt.date]:
    """Last day of every month from ``start``'s month up to ``end`` (inclusive, capped at ``end``)."""
    out: list[dt.date] = []
    year, month = start.year, start.month
    while True:
        last = dt.date(year, month, calendar.monthrange(year, month)[1])
        if last >= end:
            break
        out.append(last)
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return out


class _ProfileHistory:
    """One profile's investments history, loaded once per contributor call."""

    def __init__(self, session: Session, profile_id: int, account_currencies: set[str]) -> None:
        self.session = session
        self.profile_id = profile_id
        self.account_currencies = account_currencies
        self.txns = transactions.transactions(session, profile_id)
        self.renames = transactions.renames(session, profile_id)
        ids = {convert.pk(t.instrument_id) for t in self.txns if t.instrument_id is not None}
        for r in self.renames:
            ids |= {convert.pk(r.old_instrument_id), convert.pk(r.new_instrument_id)}
        self.instruments: dict[InstrumentId, Instrument] = {
            convert.sid(k): v
            for k, v in instruments.load(session, ids, profile_id=profile_id).items()
        }
        self.valuations = transactions.manual_valuations(session, profile_id, ids)

    @cached_property
    def currencies(self) -> set[str]:
        out = {str(t.currency) for t in self.txns} | {str(t.cash_currency) for t in self.txns}
        out |= {str(i.currency) for i in self.instruments.values()}
        out |= {str(v.currency) for v in self.valuations}
        return out

    @cached_property
    def full_market(self) -> InMemoryMarketData:
        """Every stored bar of the profile's instruments and every needed rate (for the series)."""
        today = _today()
        ids = [convert.pk(i) for i in self.instruments]
        bars = market.bars(self.session, ids, until=today)
        rates = market.rates(self.session, self.currencies | self.account_currencies, until=today)
        return InMemoryMarketData((b for series in bars.values() for b in series), rates)

    def value(self, account: Account, on: dt.date, *, recent_only: bool) -> Decimal | None:
        """Holdings + cash of ``account`` as of ``on`` in the account currency (None before its
        first transaction)."""
        aid = convert.sid(account.id)
        mine = [t for t in self.txns if t.account_id == aid and t.trade_date <= on]
        if not mine:
            return None
        snapshot = build_snapshot(convert.sid(self.profile_id), mine, on, renames=self.renames)
        held = {h.instrument_id for h in snapshot.holdings}
        listed = {k: v for k, v in self.instruments.items() if k in held}
        base = Currency(account.currency)
        if recent_only:
            series = market.bars(
                self.session,
                [convert.pk(i) for i in held],
                until=on,
                since=on - dt.timedelta(days=_LATEST_WINDOW_DAYS),
            )
            view = MarketView(
                as_of=on,
                instruments=listed,
                bars=series,
                manual_valuations=self._valuations_for(held),
            )
            fx = market.fx_lookup(self.session, snapshot, view, base)
        else:
            store = self.full_market
            view = store.market_view(
                on, listed.values(), (v for v in self.valuations if v.instrument_id in held)
            )
            fx = store.fx_lookup()
        valued = value_portfolio(
            snapshot,
            view,
            fx,
            base,
            _POLICY.max_price_age_days,
            max_fx_age_days=_NETWORTH_MAX_FX_AGE_DAYS,
        )
        return valued.total_base

    def _valuations_for(self, held: set[InstrumentId]) -> dict:
        grouped: dict[InstrumentId, list] = {}
        for v in self.valuations:
            if v.instrument_id in held:
                grouped.setdefault(v.instrument_id, []).append(v)
        return {k: tuple(sorted(v, key=lambda m: m.as_of)) for k, v in grouped.items()}


class BrokerageValuation:
    """``core.networth.Valuation`` of one brokerage account."""

    def __init__(self, history: _ProfileHistory, account: Account) -> None:
        self.history = history
        self.account = account
        aid = convert.sid(account.id)
        dates = [t.trade_date for t in history.txns if t.account_id == aid]
        self.first = min(dates) if dates else None
        self._memo: dict[dt.date, Decimal | None] = {}

    def latest(self, as_of: dt.date | None) -> tuple[dt.date, Decimal] | None:
        ref = as_of or _today()
        value = self.history.value(self.account, ref, recent_only=True)
        return None if value is None else (ref, value)

    def axis_dates(self) -> list[dt.date]:
        if self.first is None:
            return []
        today = _today()
        return [*month_ends(self.first, today), today] if self.first <= today else []

    def at(self, d: dt.date) -> Decimal | None:
        if self.first is None or d < self.first:
            return None
        points = [p for p in self.axis_dates() if p <= d]
        point = points[-1] if points else d
        if point not in self._memo:
            self._memo[point] = self.history.value(self.account, point, recent_only=False)
        return self._memo[point]


class InvestmentsContributor:
    def valuations(self, session: Session, accounts: Mapping[int, Account]) -> dict[int, Valuation]:
        brokerage = {aid: a for aid, a in accounts.items() if a.type == BROKERAGE}
        if not brokerage:
            return {}
        with_txns = transactions.has_transactions(session, brokerage)
        if not with_txns:
            return {}
        out: dict[int, Valuation] = {}
        histories: dict[int, _ProfileHistory] = {}
        for aid in sorted(with_txns):
            acc = brokerage[aid]
            history = histories.get(acc.profile_id)
            if history is None:
                history = histories[acc.profile_id] = _ProfileHistory(
                    session, acc.profile_id, {a.currency for a in brokerage.values()}
                )
            out[aid] = BrokerageValuation(history, acc)
        return out
