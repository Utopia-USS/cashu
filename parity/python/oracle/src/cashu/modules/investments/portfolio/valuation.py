"""Values a snapshot in the base currency: prices from the market view, FX from an FxLookup. Pure."""

from __future__ import annotations

from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal

from ..domain import (
    DEFAULT_MAX_FX_AGE_DAYS,
    AccountId,
    CalendarDate,
    Currency,
    DatedPrice,
    FrozenValuedAtZero,
    FxLookup,
    Holding,
    Instrument,
    InstrumentId,
    InstrumentStatus,
    LastKnownPriceUsed,
    MarketView,
    MissingCostBasis,
    MissingFxRate,
    MissingInstrument,
    MissingManualValuation,
    MissingPrice,
    PortfolioSnapshot,
    PortfolioWarning,
    PriceBar,
    StaleFxRate,
    StalePrice,
    ValuationMode,
    ValuedCash,
    ValuedHolding,
    ValuedPortfolio,
    ValuedRealizedTrade,
    days_between,
    divided_by,
    exact,
    placeholder_instrument,
    ratio,
)
from .snapshot_builder import restrict_snapshot


def effective_valuation_mode(instrument: Instrument) -> ValuationMode:
    """The mode valuation uses: a frozen instrument is valued manually whatever its configured mode."""
    if instrument.status == InstrumentStatus.FROZEN:
        return ValuationMode.MANUAL
    return instrument.valuation_mode or ValuationMode.MARKET


@exact
def value_portfolio(
    snapshot: PortfolioSnapshot,
    market: MarketView,
    fx: FxLookup,
    base_currency: Currency,
    max_price_age_days: int,
    *,
    account_ids: Collection[AccountId] | None = None,
    last_known_prices: Mapping[InstrumentId, DatedPrice] | None = None,
    max_fx_age_days: int = DEFAULT_MAX_FX_AGE_DAYS,
) -> ValuedPortfolio:
    """Values ``snapshot`` in ``base_currency`` (port of the Kompas ``valuePortfolio`` incl. R2/R4/R12/
    R14/R15 fixes, plus manual valuation and frozen instruments).

    - Market mode: the newest bar of ``market`` dated on/before the snapshot date; stale when older than
      ``max_price_age_days`` calendar days (:class:`StalePrice`). Without a bar, the instrument's entry in
      ``last_known_prices`` (default ``snapshot.last_trade_prices``, buy/sell prices only) dated on/before
      the snapshot date is used and the holding counts as stale (:class:`LastKnownPriceUsed`); with
      neither, the holding is excluded from totals and weights (:class:`MissingPrice`).
    - Cost mode ignores bars: market value = cost basis in the base currency (lots at trade-date FX),
      ``price`` = average unit cost, no price date, never stale; with an unknown cost basis the holding is
      excluded (:class:`MissingCostBasis`).
    - Manual mode: the newest ``ManualValuation`` on/before the snapshot date (0 is valid), its date as
      ``price_date``, never stale; without one the holding is excluded (:class:`MissingManualValuation`).
      A frozen instrument is always valued manually and defaults to 0 (:class:`FrozenValuedAtZero`). A
      value of exactly 0 needs no FX rate.
    - Market value: quantity * price converted at the rate on/before the snapshot date. Bars are in the
      instrument currency (sources reject other quote currencies), a last trade price or manual valuation
      in its own currency; ``price_currency`` says which.
    - Cost basis: each lot's cost converted at the rate on/before its open date; None when any lot cost
      or rate is unknown.
    - Cash: converted at the snapshot-date rate; a negative balance (``CashHistoryGap``) counts as 0 in
      totals and weights (``ValuedCash.counted_base``).
    - FX: a rate older than ``max_fx_age_days`` relative to the date it is needed for is not used
      (:class:`StaleFxRate`); no rate adds :class:`MissingFxRate`. Either way the amount is left out and
      every such valuation-date currency is listed in ``missing_fx_currencies`` (weight rules skip).
    - Realized trades: proceeds at the close-date rate, cost at the open-date rate (no warnings).
    - Instruments missing from ``market`` get a placeholder (:class:`MissingInstrument`).

    ``total_base`` = valued market values + ``cash_base``; ``weight`` = market value / total (None when
    the total is 0); ``stale_weight`` = stale market values / total. Restricted to ``account_ids`` when
    given (the returned ``snapshot`` is then the restricted one).
    """
    scoped = snapshot if account_ids is None else restrict_snapshot(snapshot, account_ids)
    fallback_prices = scoped.last_trade_prices if last_known_prices is None else last_known_prices
    as_of = scoped.as_of
    warnings: dict[PortfolioWarning, None] = {}
    missing_fx: dict[Currency, None] = {}
    market_prices: dict[InstrumentId, _Price | None] = {}

    def warn(warning: PortfolioWarning) -> None:
        warnings.setdefault(warning, None)

    def market_price(instrument_id: InstrumentId) -> _Price | None:
        if instrument_id in market_prices:
            return market_prices[instrument_id]
        price: _Price | None
        bar = _last_bar_on_or_before(market.series(instrument_id), as_of)
        fallback = fallback_prices.get(instrument_id)
        if bar is not None:
            age = days_between(bar.date, as_of)
            stale = age > max_price_age_days
            if stale:
                warn(StalePrice(instrument_id=instrument_id, price_date=bar.date, age_days=age))
            price = _Price(bar.close, bar.date, None, stale)
        elif fallback is not None and fallback.date <= as_of:
            warn(
                LastKnownPriceUsed(
                    instrument_id=instrument_id, price_date=fallback.date, price=fallback.price
                )
            )
            price = _Price(fallback.price, fallback.date, fallback.currency, True)
        else:
            warn(MissingPrice(instrument_id=instrument_id, as_of=as_of))
            price = None
        market_prices[instrument_id] = price
        return price

    def convert(
        amount: Decimal, currency: Currency, on: CalendarDate, report: bool = True
    ) -> Decimal | None:
        """``amount`` at the usable rate for ``on``, or None (a warning when ``report``)."""
        quote = fx.quote_on_or_before(currency, on, base_currency)
        if quote is None:
            if report:
                warn(MissingFxRate(currency=currency, base=base_currency, date=on))
            return None
        age = quote.age_days(on)
        if age > max_fx_age_days:
            if report:
                warn(
                    StaleFxRate(
                        currency=currency,
                        base=base_currency,
                        date=on,
                        rate_date=quote.date,
                        age_days=age,
                    )
                )
            return None
        return amount * quote.rate

    drafts: list[_Draft] = []
    for holding in scoped.holdings:
        instrument = market.instrument(holding.instrument_id)
        if instrument is None:
            warn(MissingInstrument(instrument_id=holding.instrument_id))
            instrument = placeholder_instrument(holding.instrument_id, holding.currency)
        mode = effective_valuation_mode(instrument)

        if mode == ValuationMode.COST:
            cost_basis_base = _cost_basis_base(holding, convert)
            if cost_basis_base is None:
                warn(
                    MissingCostBasis(
                        account_id=holding.account_id, instrument_id=holding.instrument_id
                    )
                )
                price = None
            elif holding.average_cost is not None:
                price = _Price(holding.average_cost, None, holding.currency, False)
            else:
                # Lots in several currencies: the average cost exists only in the base currency.
                price = _Price(
                    divided_by(cost_basis_base, holding.quantity), None, base_currency, False
                )
            drafts.append(
                _Draft(holding, instrument, mode, price, cost_basis_base, cost_basis_base, None)
            )
            continue

        if mode == ValuationMode.MANUAL:
            valuation = market.manual_valuation(holding.instrument_id, as_of)
            if valuation is not None:
                price = _Price(valuation.unit_value, valuation.as_of, valuation.currency, False)
            elif instrument.status == InstrumentStatus.FROZEN:
                warn(FrozenValuedAtZero(instrument_id=holding.instrument_id))
                price = _Price(Decimal(0), None, instrument.currency, False)
            else:
                warn(MissingManualValuation(instrument_id=holding.instrument_id, as_of=as_of))
                price = None
        else:
            price = market_price(holding.instrument_id)

        price_currency = None if price is None else (price.currency or instrument.currency)
        market_value: Decimal | None = None
        missing_currency: Currency | None = None
        if price is not None and price_currency is not None:
            amount = holding.quantity * price.price
            if mode == ValuationMode.MANUAL and amount == 0:
                market_value = Decimal(0)
            else:
                market_value = convert(amount, price_currency, as_of)
            if market_value is None:
                missing_currency = price_currency
                missing_fx.setdefault(price_currency, None)
        cost_basis_base = _cost_basis_base(holding, convert)
        drafts.append(
            _Draft(
                holding, instrument, mode, price, market_value, cost_basis_base, missing_currency
            )
        )

    valued_cash: list[ValuedCash] = []
    for cash in scoped.cash:
        amount_base = convert(cash.amount, cash.currency, as_of)
        if amount_base is None:
            missing_fx.setdefault(cash.currency, None)
        valued_cash.append(ValuedCash(cash=cash, amount_base=amount_base))
    cash_base = sum((c.counted_base for c in valued_cash), Decimal(0))

    holdings_base = Decimal(0)
    stale_base = Decimal(0)
    for draft in drafts:
        if draft.market_value_base is None:
            continue
        holdings_base += draft.market_value_base
        if draft.is_stale:
            stale_base += draft.market_value_base
    total_base = holdings_base + cash_base

    valued = tuple(
        ValuedHolding(
            holding=d.holding,
            instrument=d.instrument,
            is_stale=d.is_stale,
            price=None if d.price is None else d.price.price,
            price_date=None if d.price is None else d.price.date,
            market_value_base=d.market_value_base,
            cost_basis_base=d.cost_basis_base,
            unrealized_pct=_unrealized_pct(d.market_value_base, d.cost_basis_base),
            weight=ratio(d.market_value_base, total_base),
            valuation_mode=d.mode,
            price_currency=d.price_currency,
            missing_fx_currency=d.missing_fx_currency,
        )
        for d in drafts
    )
    realized = tuple(
        ValuedRealizedTrade(
            trade=trade,
            proceeds_base=convert(trade.proceeds, trade.currency, trade.close_date, report=False),
            cost_base=None
            if trade.cost is None
            else convert(
                trade.cost, trade.cost_currency or trade.currency, trade.open_date, report=False
            ),
        )
        for trade in scoped.realized
    )
    return ValuedPortfolio(
        snapshot=scoped,
        base_currency=base_currency,
        cash_base=cash_base,
        total_base=total_base,
        stale_weight=ratio(stale_base, total_base) or 0.0,
        valued=valued,
        cash=tuple(valued_cash),
        warnings=tuple(warnings),
        missing_fx_currencies=frozenset(missing_fx),
        realized=realized,
    )


def _cost_basis_base(
    holding: Holding, convert: Callable[[Decimal, Currency, CalendarDate], Decimal | None]
) -> Decimal | None:
    total = Decimal(0)
    for lot in holding.lots:
        cost = lot.cost_basis
        if cost is None:
            return None
        converted = convert(cost, lot.currency, lot.open_date)
        if converted is None:
            return None
        total += converted
    return total


def _unrealized_pct(market_value: Decimal | None, cost_basis: Decimal | None) -> float | None:
    if market_value is None or cost_basis is None or cost_basis == 0:
        return None
    return ratio(market_value - cost_basis, cost_basis)


def _last_bar_on_or_before(series: Sequence[PriceBar], as_of: CalendarDate) -> PriceBar | None:
    for bar in reversed(series):
        if bar.date <= as_of:
            return bar
    return None


@dataclass(frozen=True, slots=True)
class _Price:
    """A price with its date; ``currency`` is None for market bars (instrument currency), ``date`` is
    None for a cost valuation or a frozen default."""

    price: Decimal
    date: CalendarDate | None
    currency: Currency | None
    is_stale: bool


@dataclass(frozen=True, slots=True)
class _Draft:
    holding: Holding
    instrument: Instrument
    mode: ValuationMode
    price: _Price | None
    market_value_base: Decimal | None
    cost_basis_base: Decimal | None
    missing_fx_currency: Currency | None

    @property
    def price_currency(self) -> Currency | None:
        if self.price is None:
            return None
        return self.price.currency or self.instrument.currency

    @property
    def is_stale(self) -> bool:
        """Stale price, last known price, or no price at all."""
        return True if self.price is None else self.price.is_stale
