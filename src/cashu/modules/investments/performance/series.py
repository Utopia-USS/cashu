"""Daily portfolio value and external-flow series per account in the base currency. Pure, no IO.

One incremental pass of the FIFO lot engine gives the snapshot at the end of every day with
transactions (the engine's private ``_events`` / ``_EngineState``: replaying the whole history for each
day would be O(days x transactions); ``tests/investments/performance`` checks the snapshots equal
``build_snapshot``). Each calendar day is then valued with the shared ``value_portfolio`` (the same rules
as the overview: bar on/before the day of any age, stale but valued; last trade price fallback; cost,
manual and frozen modes; cash floored at 0; FX older than ``max_fx_age_days`` left out) over a market
view holding one bar per held instrument.

Prices: stored closes are split-adjusted by the source, the lots are not before a split date. The close
used for day ``d`` is the stored close times the product of the portfolio's split ratios dated after
``d`` (same-ratio splits of one instrument within ``SPLIT_DEDUP_WINDOW_DAYS`` are one action), times a
residual scale inferred from trades for splits the portfolio never booked (see :class:`PriceAdjuster`).

External flows (``+`` = money put in): deposits and withdrawals, cash-only transfers, units moved in or
out (``transfer_in`` / ``adjustment`` / ``transfer_out``) at that day's unit value, and implied funding:
when a cash balance goes (more) negative, the valuation counts it as 0, so the shortfall is money that
came from outside the recorded history (and a later deposit that only fills the hole is not new money).
"""

from __future__ import annotations

import bisect
import math
from collections import defaultdict
from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal
from fractions import Fraction

from ..domain import (
    DEFAULT_MAX_FX_AGE_DAYS,
    AccountId,
    CalendarDate,
    CashBalance,
    Currency,
    FxLookup,
    Holding,
    Instrument,
    InstrumentId,
    InstrumentRename,
    ManualValuation,
    MarketView,
    OpenLot,
    PortfolioSnapshot,
    PriceBar,
    Transaction,
    TxnId,
    TxnType,
    ValuationMode,
    chronological_key,
    exact_decimals,
)
from ..portfolio import (
    SPLIT_DEDUP_WINDOW_DAYS,
    effective_valuation_mode,
    last_trade_prices,
    split_fraction,
    value_portfolio,
)
from ..portfolio.lot_engine import _EngineState, _events

ZERO = Decimal(0)
SCALE_TOLERANCE = 1.6
"""A trade price within this factor of the day's close needs no inferred scale."""
SCALE_SNAP = math.log(1.15)
"""An off-scale trade price snaps to n or 1/n when within 15 % of it (log distance)."""
SCALE_BAR_WINDOW_DAYS = 3
"""A trade is compared with the newest bar at most this many days before it."""


@dataclass(frozen=True, slots=True)
class ValuationPolicy:
    """The strategy's data limits the valuation applies (``data:``)."""

    max_price_age_days: int = 5
    max_fx_age_days: int = DEFAULT_MAX_FX_AGE_DAYS


@dataclass(frozen=True, slots=True)
class PriceScale:
    """A price scale inferred from a trade: closes on/before ``until`` are multiplied by ``factor``."""

    instrument_id: InstrumentId
    until: CalendarDate
    factor: Fraction


@dataclass(frozen=True, slots=True)
class PriceMismatch:
    """A trade price that is neither near the day's close nor a clean multiple of it."""

    instrument_id: InstrumentId
    date: CalendarDate
    ratio: float


@dataclass
class AccountSeries:
    """One account's daily series, aligned with :attr:`PortfolioSeries.dates`."""

    account_id: AccountId
    values: list[Decimal] = field(default_factory=list)
    """End-of-day value (holdings + counted cash); partial when the day is incomplete."""
    flows: list[Decimal] = field(default_factory=list)
    """External flows of the day, + = money put in."""
    fees: list[Decimal] = field(default_factory=list)
    """Account-level fees and taxes of the day (no instrument), + = paid."""
    complete: list[bool] = field(default_factory=list)
    implied: list[Decimal] = field(default_factory=list)
    """The implied-funding part of ``flows``."""


@dataclass(frozen=True, slots=True)
class Combined:
    """Accounts summed: floats ready for the return math."""

    values: list[float]
    flows: list[float]
    fees: list[float]
    complete: list[bool]
    implied: list[float]


@dataclass
class PortfolioSeries:
    """Output of :func:`build_series`."""

    base: Currency
    dates: list[CalendarDate]
    """Every calendar day from the day before the first transaction (value 0) to ``end``."""
    accounts: dict[AccountId, AccountSeries]
    captures: dict[CalendarDate, dict[tuple[AccountId, InstrumentId], Decimal | None]]
    """Holding values per (account, instrument) at the requested capture dates (None = not valued)."""
    txn_values: dict[TxnId, Decimal]
    """Base value of the units moved by transfers and adjustments (what the flow counted)."""
    unknown_flows: list[TxnId]
    """Transactions whose flow could not be valued (no rate, no price): counted as 0."""
    price_scales: tuple[PriceScale, ...] = ()
    price_mismatches: tuple[PriceMismatch, ...] = ()
    last_bar_dates: dict[InstrumentId, CalendarDate] = field(default_factory=dict)

    @property
    def first_date(self) -> CalendarDate | None:
        return self.dates[1] if len(self.dates) > 1 else None

    def index_of(self, day: CalendarDate) -> int:
        """Position of ``day`` (clamped to the series)."""
        if not self.dates:
            raise ValueError("empty series")
        offset = (day - self.dates[0]).days
        return max(0, min(len(self.dates) - 1, offset))

    def combined(self, account_ids: Collection[AccountId] | None = None) -> Combined:
        """Sum of the accounts in ``account_ids`` (all when None); a day is complete when every
        selected account is."""
        selected = [s for a, s in self.accounts.items() if account_ids is None or a in account_ids]
        n = len(self.dates)
        values, flows, fees, implied = [0.0] * n, [0.0] * n, [0.0] * n, [0.0] * n
        complete = [True] * n
        for series in selected:
            for i in range(n):
                values[i] += float(series.values[i])
                flows[i] += float(series.flows[i])
                fees[i] += float(series.fees[i])
                implied[i] += float(series.implied[i])
                complete[i] = complete[i] and series.complete[i]
        return Combined(values, flows, fees, complete, implied)


# --------------------------------------------------------------------------- #
# Renames and prices
# --------------------------------------------------------------------------- #


class Renames:
    """Which instrument an id stands for on a date (rename chains, effective at the start of their
    date, like the lot engine)."""

    def __init__(self, renames: Sequence[InstrumentRename]) -> None:
        self._renames = sorted(renames, key=lambda r: r.date)

    def resolve(self, instrument_id: InstrumentId | None, on: CalendarDate) -> InstrumentId | None:
        if instrument_id is None:
            return None
        redirect: dict[InstrumentId, InstrumentId] = {}
        for rename in self._renames:
            if rename.date > on:
                break
            old = self._follow(redirect, rename.old_instrument_id)
            new = self._follow(redirect, rename.new_instrument_id)
            if old != new:
                redirect[old] = new
        return self._follow(redirect, instrument_id)

    def final(self, instrument_id: InstrumentId | None) -> InstrumentId | None:
        """The id after every rename (what attribution groups by)."""
        if not self._renames:
            return instrument_id
        return self.resolve(instrument_id, self._renames[-1].date)

    @staticmethod
    def _follow(redirect: Mapping[InstrumentId, InstrumentId], instrument_id: InstrumentId):
        seen: set[InstrumentId] = set()
        while instrument_id in redirect and instrument_id not in seen:
            seen.add(instrument_id)
            instrument_id = redirect[instrument_id]
        return instrument_id


def _snap_scale(ratio: float) -> Fraction | None:
    """1 for a ratio near 1, n or 1/n for a clean split multiple, None otherwise."""
    if ratio <= 0:
        return None
    if 1 / SCALE_TOLERANCE <= ratio <= SCALE_TOLERANCE:
        return Fraction(1)
    n = round(ratio) if ratio > 1 else round(1 / ratio)
    if n < 2 or n > 1000:
        return None
    candidate = Fraction(n) if ratio > 1 else Fraction(1, n)
    if abs(math.log(ratio / float(candidate))) <= SCALE_SNAP:
        return candidate
    return None


class PriceAdjuster:
    """Stored (split-adjusted) closes brought to the units the lots hold on a given day.

    - Known splits: the portfolio's ``split`` transactions per instrument (renames resolved; a split of
      the same ratio within ``SPLIT_DEDUP_WINDOW_DAYS`` of an applied one is the same action). A close
      used for day ``d`` is multiplied by every ratio dated after ``d``.
    - Residual scale: each buy / sell with a price in the instrument currency is compared with the close
      of its day (the newest bar at most ``SCALE_BAR_WINDOW_DAYS`` before it, already adjusted for known
      splits). Off by more than ``SCALE_TOLERANCE`` and within 15 % of n or 1/n, that multiple is the
      scale of every day up to the trade (the next trade on/after a day decides); days after the last
      trade use 1, like today's valuation. Other off-scale trades are reported as mismatches.
    """

    def __init__(
        self,
        txns: Sequence[Transaction],
        renames: Renames,
        bars: Mapping[InstrumentId, Sequence[PriceBar]],
        instruments: Mapping[InstrumentId, Instrument],
    ) -> None:
        self._bars = {k: tuple(v) for k, v in bars.items() if v}
        self._dates = {k: [b.date for b in v] for k, v in self._bars.items()}
        self._cache: dict[tuple[InstrumentId, int, Fraction], PriceBar] = {}
        splits: dict[InstrumentId, list[tuple[CalendarDate, Fraction]]] = {}
        for t in sorted(txns, key=chronological_key):
            if t.type != TxnType.SPLIT or t.split_ratio is None or t.split_ratio <= 0:
                continue
            iid = renames.resolve(t.instrument_id, t.trade_date)
            if iid is None:
                continue
            ratio = split_fraction(t.split_ratio)
            applied = splits.setdefault(iid, [])
            if any(
                r == ratio and abs((d - t.trade_date).days) <= SPLIT_DEDUP_WINDOW_DAYS
                for d, r in applied
            ):
                continue
            applied.append((t.trade_date, ratio))
        self._splits = splits

        scales: list[PriceScale] = []
        mismatches: list[PriceMismatch] = []
        observations: dict[InstrumentId, list[tuple[CalendarDate, Fraction]]] = {}
        for t in sorted(txns, key=chronological_key):
            if t.type not in (TxnType.BUY, TxnType.SELL) or not t.price or t.price <= 0:
                continue
            iid = renames.resolve(t.instrument_id, t.trade_date)
            instrument = instruments.get(iid) if iid is not None else None
            if instrument is None or t.currency != instrument.currency:
                continue
            if effective_valuation_mode(instrument) != ValuationMode.MARKET:
                continue
            bar = self._raw_bar(iid, t.trade_date)
            if bar is None or (t.trade_date - bar.date).days > SCALE_BAR_WINDOW_DAYS:
                continue
            close = Fraction(bar.close) * self.known_factor(iid, t.trade_date)
            if close <= 0:
                continue
            ratio = float(Fraction(t.price) / close)
            scale = _snap_scale(ratio)
            if scale is None:
                mismatches.append(PriceMismatch(iid, t.trade_date, round(ratio, 4)))
                continue
            observations.setdefault(iid, []).append((t.trade_date, scale))
        for iid, obs in observations.items():
            obs.sort(key=lambda o: o[0])
            for day, scale in obs:
                if scale != 1:
                    scales.append(PriceScale(iid, day, scale))
        self._observations = observations
        self._obs_dates = {k: [d for d, _ in v] for k, v in observations.items()}
        self.scales = tuple(scales)
        self.mismatches = tuple(mismatches)

    def _raw_bar(self, instrument_id: InstrumentId, day: CalendarDate) -> PriceBar | None:
        dates = self._dates.get(instrument_id)
        if not dates:
            return None
        i = bisect.bisect_right(dates, day) - 1
        return None if i < 0 else self._bars[instrument_id][i]

    def known_factor(self, instrument_id: InstrumentId, day: CalendarDate) -> Fraction:
        factor = Fraction(1)
        for split_day, ratio in self._splits.get(instrument_id, ()):
            if split_day > day:
                factor *= ratio
        return factor

    def residual(self, instrument_id: InstrumentId, day: CalendarDate) -> Fraction:
        dates = self._obs_dates.get(instrument_id)
        if not dates:
            return Fraction(1)
        i = bisect.bisect_left(dates, day)
        return Fraction(1) if i >= len(dates) else self._observations[instrument_id][i][1]

    def bar_on(self, instrument_id: InstrumentId, day: CalendarDate) -> PriceBar | None:
        """The newest stored bar on/before ``day`` with its close in the units held on ``day``."""
        dates = self._dates.get(instrument_id)
        if not dates:
            return None
        i = bisect.bisect_right(dates, day) - 1
        if i < 0:
            return None
        factor = self.known_factor(instrument_id, day) * self.residual(instrument_id, day)
        bar = self._bars[instrument_id][i]
        if factor == 1:
            return bar
        key = (instrument_id, i, factor)
        cached = self._cache.get(key)
        if cached is None:
            with exact_decimals():
                close = bar.close * Decimal(factor.numerator) / Decimal(factor.denominator)
            cached = PriceBar(
                instrument_id=bar.instrument_id,
                date=bar.date,
                close=close,
                source=bar.source,
                currency=bar.currency,
            )
            self._cache[key] = cached
        return cached

    def last_bar_date(self, instrument_id: InstrumentId) -> CalendarDate | None:
        dates = self._dates.get(instrument_id)
        return dates[-1] if dates else None


# --------------------------------------------------------------------------- #
# The daily pass
# --------------------------------------------------------------------------- #


class SnapshotStream:
    """End-of-day snapshots (holdings and cash) from one pass of the FIFO lot engine.

    Uses the engine's private ``_events`` / ``_EngineState`` and reads its open lots and cash directly
    (``result()`` would rebuild every lot each day); the holdings are grouped exactly like
    ``build_snapshot`` (``tests/investments/performance`` compares them). ``keep_lots(instrument)``
    False drops the lots of a holding (quantity and currency stay): valuation only needs them for
    instruments valued at cost, and converting every lot's cost each day would dominate the run."""

    def __init__(
        self,
        ordered: Sequence[Transaction],
        renames: Sequence[InstrumentRename],
        *,
        keep_lots=None,
    ) -> None:
        self._by_date: dict[CalendarDate, list[Transaction | InstrumentRename]] = defaultdict(list)
        for event in _events(list(ordered), list(renames)):
            self._by_date[_event_date(event)].append(event)
        self._state = _EngineState()
        self._lots: dict[tuple[AccountId, TxnId], tuple[Fraction, Decimal | None, OpenLot]] = {}
        self._keep = keep_lots or (lambda _iid: True)
        self.snapshot = PortfolioSnapshot(profile_id="", as_of=date.min)

    def advance(self, day: CalendarDate) -> bool:
        """Apply ``day``'s events; True when the snapshot changed."""
        events = self._by_date.get(day)
        if not events:
            return False
        for event in events:
            if isinstance(event, InstrumentRename):
                self._state.rename(event)
            else:
                self._state.apply(event)
        self.snapshot = self._build(day)
        return True

    def _open_lot(self, lot) -> OpenLot:
        key = (lot.account_id, lot.open_txn_id)
        hit = self._lots.get(key)
        if (
            hit is not None
            and hit[0] == lot.quantity
            and hit[1] == lot.cost
            and hit[2].instrument_id == lot.instrument_id
        ):
            return hit[2]
        open_lot = lot.to_open_lot()
        self._lots[key] = (lot.quantity, lot.cost, open_lot)
        return open_lot

    def _build(self, day: CalendarDate) -> PortfolioSnapshot:
        holdings: list[Holding] = []
        for (account_id, instrument_id), queue in self._state._lots.items():
            if not queue:
                continue
            lots = [self._open_lot(lot) for lot in queue]
            holdings.append(
                Holding(
                    account_id=account_id,
                    instrument_id=instrument_id,
                    currency=lots[0].currency,
                    quantity=sum((lot.quantity for lot in lots), ZERO),
                    lots=tuple(lots) if self._keep(instrument_id) else (),
                )
            )
        cash = tuple(
            CashBalance(account_id=account_id, currency=currency, amount=amount)
            for (account_id, currency), amount in self._state._cash.items()
            if amount != 0
        )
        return PortfolioSnapshot(profile_id="", as_of=day, holdings=tuple(holdings), cash=cash)


def _event_date(event: Transaction | InstrumentRename) -> CalendarDate:
    return event.date if isinstance(event, InstrumentRename) else event.trade_date


def build_series(
    txns: Iterable[Transaction],
    *,
    instruments: Mapping[InstrumentId, Instrument],
    bars: Mapping[InstrumentId, Sequence[PriceBar]],
    fx: FxLookup,
    base: Currency,
    end: CalendarDate,
    renames: Sequence[InstrumentRename] = (),
    manual_valuations: Mapping[InstrumentId, Sequence[ManualValuation]] | None = None,
    policy: ValuationPolicy | None = None,
    capture_dates: Collection[CalendarDate] = (),
) -> PortfolioSeries:
    """Daily values and flows of every account from the day before the first transaction to ``end``.

    ``bars`` are the stored closes (any instruments; held ones are used), ``fx`` must know the rates of
    every currency involved (any base: cross rates through the stored pivot). ``capture_dates`` keep the
    per-holding values of those days (attribution)."""
    policy = policy or ValuationPolicy()
    ordered = sorted((t for t in txns if t.trade_date <= end), key=chronological_key)
    manual = {k: tuple(v) for k, v in (manual_valuations or {}).items()}
    if not ordered:
        return PortfolioSeries(base, [end], {}, {}, {}, [])
    renames_by = Renames(renames)
    active_renames = [r for r in renames if r.date <= end]
    adjuster = PriceAdjuster(ordered, renames_by, bars, instruments)
    first = ordered[0].trade_date
    anchor = first - timedelta(days=1)
    dates = [anchor + timedelta(days=i) for i in range((end - anchor).days + 1)]
    account_ids = sorted({t.account_id for t in ordered}, key=_natural)
    accounts = {a: AccountSeries(a) for a in account_ids}
    captures: dict[CalendarDate, dict[tuple[AccountId, InstrumentId], Decimal | None]] = {}
    wanted_captures = set(capture_dates)
    txn_values: dict[TxnId, Decimal] = {}
    unknown: list[TxnId] = []

    def keep_lots(instrument_id: InstrumentId) -> bool:
        inst = instruments.get(instrument_id)
        return inst is None or effective_valuation_mode(inst) == ValuationMode.COST

    stream = SnapshotStream(ordered, active_renames, keep_lots=keep_lots)
    txns_by_date: dict[CalendarDate, list[Transaction]] = defaultdict(list)
    for t in ordered:
        txns_by_date[t.trade_date].append(t)
    trade_dates = [t.trade_date for t in ordered]

    snapshot = PortfolioSnapshot(profile_id="", as_of=anchor)
    ltp: Mapping[InstrumentId, object] | None = None
    prev_cash: dict[tuple[AccountId, Currency], Decimal] = {}
    last_unit: dict[InstrumentId, Decimal] = {}

    def to_base(amount: Decimal, currency: Currency, on: CalendarDate) -> Decimal | None:
        if amount == 0:
            return ZERO
        quote = fx.quote_on_or_before(currency, on, base)
        return None if quote is None else amount * quote.rate

    with exact_decimals():
        for day in dates:
            if stream.advance(day):
                snapshot = stream.snapshot
                ltp = None

            bars_today: dict[InstrumentId, tuple[PriceBar, ...]] = {}
            needs_fallback = False
            for holding in snapshot.holdings:
                iid = holding.instrument_id
                if iid in bars_today:
                    continue
                bar = adjuster.bar_on(iid, day)
                if bar is not None:
                    bars_today[iid] = (bar,)
                else:
                    needs_fallback = True
            if needs_fallback and ltp is None:
                upto = bisect.bisect_right(trade_dates, day)
                ltp = last_trade_prices(
                    ordered[:upto], as_of=day, renames=[r for r in active_renames if r.date <= day]
                )
            view = MarketView(
                as_of=day, instruments=instruments, bars=bars_today, manual_valuations=manual
            )
            valued = value_portfolio(
                PortfolioSnapshot(
                    profile_id="",
                    as_of=day,
                    holdings=snapshot.holdings,
                    cash=snapshot.cash,
                    last_trade_prices=ltp or {},
                ),
                view,
                fx,
                base,
                policy.max_price_age_days,
                max_fx_age_days=policy.max_fx_age_days,
            )

            value = dict.fromkeys(account_ids, ZERO)
            flow = dict.fromkeys(account_ids, ZERO)
            fees = dict.fromkeys(account_ids, ZERO)
            implied = dict.fromkeys(account_ids, ZERO)
            whole = dict.fromkeys(account_ids, True)
            unit_today: dict[InstrumentId, Decimal] = {}
            capture = day in wanted_captures
            captured: dict[tuple[AccountId, InstrumentId], Decimal | None] = {}
            for vh in valued.valued:
                mv = vh.market_value_base
                if capture:
                    captured[(vh.account_id, vh.instrument_id)] = mv
                if mv is None:
                    whole[vh.account_id] = False
                    continue
                value[vh.account_id] += mv
                if vh.holding.quantity > 0:
                    unit_today[vh.instrument_id] = mv / vh.holding.quantity
            for vc in valued.cash:
                if vc.amount_base is None:
                    whole[vc.account_id] = False
                value[vc.account_id] += vc.counted_base
            if capture:
                captures[day] = captured

            def day_unit(iid: InstrumentId, day=day, unit_today=unit_today) -> Decimal | None:
                """Base value of one unit on ``day``: the day's valuation per unit, else (the units
                left the portfolio) the day's close, else the last valuation per unit."""
                if iid in unit_today:
                    return unit_today[iid]
                inst = instruments.get(iid)
                if inst is not None and effective_valuation_mode(inst) == ValuationMode.MARKET:
                    bar = adjuster.bar_on(iid, day)
                    if bar is not None:
                        quote = fx.quote_on_or_before(bar.currency or inst.currency, day, base)
                        if quote is not None:
                            return bar.close * quote.rate
                return last_unit.get(iid)

            for t in txns_by_date.get(day, ()):
                moved = _external(t, day, renames_by, day_unit, to_base)
                if moved is _NOT_EXTERNAL:
                    if t.type in (TxnType.FEE, TxnType.TAX) and t.instrument_id is None:
                        paid = to_base(-t.cash_amount, t.cash_currency, day)
                        if paid is not None:
                            fees[t.account_id] += paid
                    continue
                amount, unit_value = moved
                if amount is None:
                    unknown.append(t.id)
                    whole[t.account_id] = False
                    continue
                flow[t.account_id] += amount
                if unit_value is not None:
                    txn_values[t.id] = abs(amount)

            cash_now = {(c.account_id, c.currency): c.amount for c in snapshot.cash}
            for key in set(prev_cash) | set(cash_now):
                before = max(ZERO, -prev_cash.get(key, ZERO))
                after = max(ZERO, -cash_now.get(key, ZERO))
                if before == after:
                    continue
                gap = to_base(after - before, key[1], day)
                if gap is None:
                    whole[key[0]] = False
                    continue
                flow[key[0]] += gap
                implied[key[0]] += gap
            prev_cash = cash_now
            last_unit.update(unit_today)

            for a in account_ids:
                series = accounts[a]
                series.values.append(value[a])
                series.flows.append(flow[a])
                series.fees.append(fees[a])
                series.complete.append(whole[a])
                series.implied.append(implied[a])

    last_bars = {iid: d for iid in instruments if (d := adjuster.last_bar_date(iid)) is not None}
    return PortfolioSeries(
        base=base,
        dates=dates,
        accounts=accounts,
        captures=captures,
        txn_values=txn_values,
        unknown_flows=unknown,
        price_scales=adjuster.scales,
        price_mismatches=adjuster.mismatches,
        last_bar_dates=last_bars,
    )


_NOT_EXTERNAL = object()


def _external(t, day, renames, unit_value, to_base):
    """``(amount, unit_value)`` of an external flow (amount None = could not be valued), or
    ``_NOT_EXTERNAL``."""
    if t.type in (TxnType.DEPOSIT, TxnType.WITHDRAWAL):
        return to_base(t.cash_amount, t.cash_currency, day), None
    if t.type not in (TxnType.TRANSFER_IN, TxnType.TRANSFER_OUT, TxnType.ADJUSTMENT):
        return _NOT_EXTERNAL
    if t.instrument_id is None or not t.quantity:
        # A cash transfer between the account and the outside.
        return to_base(t.cash_amount, t.cash_currency, day), None
    unit = unit_value(renames.resolve(t.instrument_id, day))
    if unit is None and t.price and t.price > 0:
        unit = to_base(t.price, t.currency, day)
    if unit is None:
        return None, None
    sign = -1 if t.type == TxnType.TRANSFER_OUT else 1
    return sign * t.quantity * unit, unit


def _natural(account_id: str):
    return (0, int(account_id), "") if account_id.isdigit() else (1, 0, account_id)


def cash_flow_base(t: Transaction, fx: FxLookup, base: Currency) -> Decimal | None:
    """A transaction's cash amount in the base currency at the rate on/before its date (any age)."""
    if t.cash_amount == 0:
        return ZERO
    quote = fx.quote_on_or_before(t.cash_currency, t.trade_date, base)
    if quote is None:
        return None
    with exact_decimals():
        return t.cash_amount * quote.rate


__all__ = [
    "AccountSeries",
    "Combined",
    "PortfolioSeries",
    "PriceAdjuster",
    "PriceMismatch",
    "PriceScale",
    "Renames",
    "ValuationPolicy",
    "build_series",
    "cash_flow_base",
]
