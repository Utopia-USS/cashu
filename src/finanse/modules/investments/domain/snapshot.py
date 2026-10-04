"""Portfolio data shapes shared by the portfolio math, the rules engine and the daily run.

Plain frozen data, no logic beyond getters. Money amounts are ``Decimal``, ratios ``float``. Sequences
are tuples, sets frozensets; mappings are plain dicts (treat them as read-only).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import Decimal

from .enums import ValuationMode
from .instrument import Instrument, ManualValuation
from .market_data import PriceBar
from .values import (
    EXACT_CONTEXT,
    AccountId,
    CalendarDate,
    Currency,
    InstrumentId,
    Money,
    ProfileId,
    TxnId,
    days_between,
    divided_by,
    ratio,
)
from .warnings import PortfolioWarning

_mul = EXACT_CONTEXT.multiply
_add = EXACT_CONTEXT.add
_sub = EXACT_CONTEXT.subtract


@dataclass(frozen=True, slots=True)
class OpenLot:
    """A still-open FIFO lot of one instrument in one account."""

    account_id: AccountId
    instrument_id: InstrumentId
    open_txn_id: TxnId
    """Transaction that opened the lot (buy, transfer in, adjustment)."""
    open_date: CalendarDate
    quantity: Decimal
    """Remaining units (after partial sells and splits), > 0."""
    currency: Currency
    unit_cost: Decimal | None = None
    """Cost per unit in ``currency`` including buy fees; None when unknown (transfer in without price)."""

    @property
    def cost_basis(self) -> Decimal | None:
        """``quantity * unit_cost``, or None when the cost is unknown."""
        return None if self.unit_cost is None else _mul(self.unit_cost, self.quantity)


@dataclass(frozen=True, slots=True)
class RealizedTrade:
    """A closed (part of a) lot: one FIFO match between an opening and a closing transaction.

    The cost is in ``cost_currency`` (the lot's), the proceeds in ``currency`` (the sell's). When they
    differ, ``pnl`` is None because two currencies are never subtracted; the base-currency result at
    trade-date FX is ``ValuedRealizedTrade.pnl_base``.
    """

    account_id: AccountId
    instrument_id: InstrumentId
    open_txn_id: TxnId
    close_txn_id: TxnId
    open_date: CalendarDate
    close_date: CalendarDate
    quantity: Decimal
    close_unit_price: Decimal
    """Proceeds per unit net of sell fees and taxes, in ``currency``."""
    currency: Currency
    cost_currency: Currency | None = None
    """Currency of the lot's cost; defaults to ``currency``."""
    open_unit_cost: Decimal | None = None
    """Cost per unit incl. buy fees in ``cost_currency``, None when unknown."""
    pnl: Decimal | None = None
    """Realized profit in ``currency``; None when the cost is unknown or the currencies differ."""

    def __post_init__(self) -> None:
        if self.cost_currency is None:
            object.__setattr__(self, "cost_currency", self.currency)

    @property
    def holding_days(self) -> int:
        return days_between(self.open_date, self.close_date)

    @property
    def proceeds(self) -> Decimal:
        """Net proceeds of the matched units in ``currency``."""
        return _mul(self.close_unit_price, self.quantity)

    @property
    def cost(self) -> Decimal | None:
        """Cost of the matched units in ``cost_currency``, None when unknown."""
        return None if self.open_unit_cost is None else _mul(self.open_unit_cost, self.quantity)


@dataclass(frozen=True, slots=True)
class Holding:
    """Position in one instrument in one account (sum of its open lots)."""

    account_id: AccountId
    instrument_id: InstrumentId
    currency: Currency
    """Currency of the lots' costs (the first lot's; normally the instrument's trading currency)."""
    quantity: Decimal
    lots: tuple[OpenLot, ...] = ()

    @property
    def has_unknown_cost(self) -> bool:
        return any(lot.unit_cost is None for lot in self.lots)

    @property
    def has_mixed_currencies(self) -> bool:
        return any(lot.currency != self.currency for lot in self.lots)

    @property
    def cost_basis(self) -> Decimal | None:
        """Sum of lot costs in ``currency``; None if any lot cost is unknown or the lots mix currencies."""
        if self.has_mixed_currencies:
            return None
        total = Decimal(0)
        for lot in self.lots:
            cost = lot.cost_basis
            if cost is None:
                return None
            total = _add(total, cost)
        return total

    @property
    def average_cost(self) -> Decimal | None:
        """``cost_basis / quantity`` (via ``divided_by``), or None when unknown or the quantity is 0."""
        cost = self.cost_basis
        if cost is None or self.quantity == 0:
            return None
        return divided_by(cost, self.quantity)


@dataclass(frozen=True, slots=True)
class CashBalance:
    """Cash of one account in one currency (sum of ``Transaction.cash_amount``)."""

    account_id: AccountId
    currency: Currency
    amount: Decimal


@dataclass(frozen=True, slots=True)
class DatedAmount:
    """A dated cash amount in its own currency, e.g. one deposit."""

    account_id: AccountId
    date: CalendarDate
    amount: Money


@dataclass(frozen=True, slots=True)
class DatedPrice:
    """A unit price observed on a date (e.g. the last trade price of an instrument)."""

    date: CalendarDate
    price: Decimal
    currency: Currency


@dataclass(frozen=True, slots=True)
class PortfolioSnapshot:
    """Derived state of a profile as of a date (only transactions on/before ``as_of``)."""

    profile_id: ProfileId
    as_of: CalendarDate
    holdings: tuple[Holding, ...] = ()
    """Non-zero positions, one per (account, instrument), in order of first appearance."""
    cash: tuple[CashBalance, ...] = ()
    deposits: tuple[DatedAmount, ...] = ()
    """Deposits, oldest first (input of ``contribution_gap``)."""
    realized: tuple[RealizedTrade, ...] = ()
    last_trade_prices: Mapping[InstrumentId, DatedPrice] = field(default_factory=dict)
    """Newest positive buy/sell price per instrument on/before ``as_of`` (split-adjusted, reconciliation
    rows ignored). Valuation falls back to it when an instrument has no market bar."""
    warnings: tuple[PortfolioWarning, ...] = ()

    @property
    def realized_pnl_by_currency(self) -> dict[Currency, Decimal]:
        """Realized results per currency (only trades with a known cost in the sale currency)."""
        result: dict[Currency, Decimal] = {}
        for trade in self.realized:
            if trade.pnl is None:
                continue
            result[trade.currency] = _add(result.get(trade.currency, Decimal(0)), trade.pnl)
        return result

    def holdings_of(self, instrument_id: InstrumentId) -> tuple[Holding, ...]:
        """Holdings of ``instrument_id`` across accounts."""
        return tuple(h for h in self.holdings if h.instrument_id == instrument_id)


@dataclass(frozen=True, slots=True)
class ValuedHolding:
    """A holding with price and base-currency values.

    Price-dependent fields are None when no price is known (the holding is then excluded from weights
    and a warning is recorded).
    """

    holding: Holding
    instrument: Instrument
    is_stale: bool
    """Price older than the allowed age, last trade price used, or no price at all."""
    price: Decimal | None = None
    """Unit price used, in ``price_currency`` (the average unit cost when valued at cost)."""
    price_date: CalendarDate | None = None
    """Bar date, last trade date or manual valuation date; None at cost (and for a frozen default 0)."""
    market_value_base: Decimal | None = None
    cost_basis_base: Decimal | None = None
    """Cost in the base currency at trade-date FX; None when any lot cost or rate is unknown."""
    unrealized_pct: float | None = None
    """(market_value_base - cost_basis_base) / cost_basis_base, e.g. -0.25 for a 25 % loss."""
    weight: float | None = None
    """market_value_base / ValuedPortfolio.total_base, 0..1."""
    valuation_mode: ValuationMode = ValuationMode.MARKET
    """Mode actually used (a frozen instrument is valued manually whatever its configured mode)."""
    price_currency: Currency | None = None
    """Instrument currency for bars, the last trade price's own currency, the manual valuation's
    currency, the lots' currency at cost (the base currency when the lots mix currencies)."""
    missing_fx_currency: Currency | None = None
    """Set when a price is known but no usable valuation-date rate converts ``price_currency``:
    ``market_value_base`` and ``weight`` are then None."""

    @property
    def account_id(self) -> AccountId:
        return self.holding.account_id

    @property
    def instrument_id(self) -> InstrumentId:
        return self.holding.instrument_id

    @property
    def valued_at_cost(self) -> bool:
        """Valued at its cost basis: never stale, no price date."""
        return self.valuation_mode == ValuationMode.COST

    @property
    def valued_manually(self) -> bool:
        """Valued from a manual valuation (or a frozen default 0): never stale, no market series."""
        return self.valuation_mode == ValuationMode.MANUAL


@dataclass(frozen=True, slots=True)
class ValuedCash:
    """One cash balance with its value in the base currency."""

    cash: CashBalance
    amount_base: Decimal | None = None
    """Converted at the valuation-date rate (negative when the balance is); None without a usable rate."""

    @property
    def account_id(self) -> AccountId:
        return self.cash.account_id

    @property
    def currency(self) -> Currency:
        return self.cash.currency

    @property
    def counted_base(self) -> Decimal:
        """What the balance contributes to totals and weights: ``amount_base`` floored at 0 (a negative
        balance means deposits are missing, ``CashHistoryGap``); 0 without a rate."""
        if self.amount_base is None or self.amount_base < 0:
            return Decimal(0)
        return self.amount_base


@dataclass(frozen=True, slots=True)
class ValuedRealizedTrade:
    """A realized trade with its base-currency result: proceeds at the close-date rate, cost at the
    open-date rate."""

    trade: RealizedTrade
    proceeds_base: Decimal | None = None
    cost_base: Decimal | None = None

    @property
    def pnl_base(self) -> Decimal | None:
        if self.proceeds_base is None or self.cost_base is None:
            return None
        return _sub(self.proceeds_base, self.cost_base)


@dataclass(frozen=True, slots=True)
class ValuedPortfolio:
    """A snapshot valued in the base currency."""

    snapshot: PortfolioSnapshot
    base_currency: Currency
    cash_base: Decimal
    """Cash counted in totals: balances with a usable rate, negative ones as 0 (sum of ``counted_base``)."""
    total_base: Decimal
    """Valued holdings' market values plus ``cash_base``."""
    stale_weight: float
    """Share of ``total_base`` valued with stale prices, 0..1."""
    valued: tuple[ValuedHolding, ...] = ()
    cash: tuple[ValuedCash, ...] = ()
    """Every cash balance in scope with its base value (allocation needs cash per account/currency)."""
    warnings: tuple[PortfolioWarning, ...] = ()
    """Valuation warnings (snapshot warnings stay on ``snapshot``)."""
    missing_fx_currencies: frozenset[Currency] = frozenset()
    """Currencies without a usable valuation-date rate that a holding or cash balance needed: those
    amounts are left out of ``total_base``, so weight rules skip."""
    realized: tuple[ValuedRealizedTrade, ...] = ()

    @property
    def profile_id(self) -> ProfileId:
        return self.snapshot.profile_id

    @property
    def as_of(self) -> CalendarDate:
        return self.snapshot.as_of

    @property
    def realized_pnl_base(self) -> Decimal | None:
        """Sum of realized results in the base currency, or None when any trade's result is unknown."""
        total = Decimal(0)
        for trade in self.realized:
            pnl = trade.pnl_base
            if pnl is None:
                return None
            total = _add(total, pnl)
        return total

    @property
    def all_warnings(self) -> tuple[PortfolioWarning, ...]:
        """Snapshot warnings followed by valuation warnings."""
        return self.snapshot.warnings + self.warnings


@dataclass(frozen=True, slots=True)
class BucketAllocation:
    """Allocation of one strategy bucket. Drift is ``weight - target``: positive means overweight."""

    bucket_id: str
    weight: float
    """Current share of the portfolio total, 0..1."""
    target: float
    drift_pp: float
    """(weight - target) * 100, in percentage points."""
    drift_rel: float
    """(weight - target) / target; ``inf`` when target is 0 and weight > 0, 0 when both are 0."""
    value_base: Decimal
    drift_value_base: Decimal
    """value_base - target * total: positive = above target (to sell), negative = to buy."""
    cash_history_gap: bool = False
    """A negative cash balance (counted as 0) falls into this bucket: its real value is unknown."""


@dataclass(frozen=True, slots=True)
class AllocationResult:
    """Output of ``portfolio.allocation.allocate``."""

    total_base: Decimal
    """Denominator of every bucket weight: valued holdings plus counted cash (classified or not)."""
    unclassified_value_base: Decimal
    unallocated_cash_base: Decimal
    """Cash that matches no bucket."""
    allocations: tuple[BucketAllocation, ...] = ()
    """One per bucket in declaration order, then one per target without a bucket (value 0)."""
    holdings_by_bucket: Mapping[str, tuple[ValuedHolding, ...]] = field(default_factory=dict)
    unclassified: tuple[ValuedHolding, ...] = ()
    """Holdings that match no bucket (including unpriced ones), in portfolio order."""

    @property
    def unclassified_weight(self) -> float:
        """Share of ``total_base`` held in unclassified holdings (0 when the total is 0)."""
        return ratio(self.unclassified_value_base, self.total_base) or 0.0

    def allocation(self, bucket_id: str) -> BucketAllocation | None:
        for allocation in self.allocations:
            if allocation.bucket_id == bucket_id:
                return allocation
        return None


@dataclass(frozen=True, slots=True)
class MarketView:
    """Market reference data as of ``as_of``: instrument metadata, daily bars and manual valuations."""

    as_of: CalendarDate
    instruments: Mapping[InstrumentId, Instrument] = field(default_factory=dict)
    bars: Mapping[InstrumentId, tuple[PriceBar, ...]] = field(default_factory=dict)
    """Daily bars per instrument, oldest first, dated on/before ``as_of``."""
    manual_valuations: Mapping[InstrumentId, tuple[ManualValuation, ...]] = field(
        default_factory=dict
    )
    """Manual valuations per instrument, oldest first."""

    def instrument(self, instrument_id: InstrumentId) -> Instrument | None:
        return self.instruments.get(instrument_id)

    def series(self, instrument_id: InstrumentId) -> tuple[PriceBar, ...]:
        """All bars of ``instrument_id``, oldest first (empty when none)."""
        return tuple(self.bars.get(instrument_id, ()))

    def last_bar(self, instrument_id: InstrumentId) -> PriceBar | None:
        series = self.bars.get(instrument_id)
        return series[-1] if series else None

    def last_bars(self, instrument_id: InstrumentId, count: int) -> tuple[PriceBar, ...]:
        """The newest ``count`` bars (fewer when the series is shorter), oldest first."""
        series = self.series(instrument_id)
        return series if len(series) <= count else series[len(series) - count :]

    def manual_valuation(
        self, instrument_id: InstrumentId, on: CalendarDate | None = None
    ) -> ManualValuation | None:
        """The newest manual valuation dated on/before ``on`` (default ``as_of``), or None."""
        limit = self.as_of if on is None else on
        best: ManualValuation | None = None
        for valuation in self.manual_valuations.get(instrument_id, ()):
            if valuation.as_of <= limit and (best is None or valuation.as_of >= best.as_of):
                best = valuation
        return best
