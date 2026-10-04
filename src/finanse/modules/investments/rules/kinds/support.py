"""Shared helpers of the built-in rule kinds: data-quality checks, per-instrument aggregation across
accounts, instrument filters, deterministic formatting for messages. Pure functions, no IO."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

from finanse.modules.investments.domain import (
    AssetClass,
    CashHistoryGap,
    Currency,
    Instrument,
    InstrumentId,
    ValuedHolding,
    divided_by,
)

from ..kind import RuleContext
from ..params import ParamReader

RATIO_EPSILON = 1e-9
"""Tolerance for comparing derived float ratios with thresholds (a value exactly on the threshold must
not fire because of floating-point noise)."""


# --- data-quality problems ----------------------------------------------------------------------


def portfolio_data_problem(ctx: RuleContext) -> str | None:
    """Why portfolio-wide weights cannot be trusted right now, or None when they can.

    Weights are relative to ``total_base``, so anything left out of the total distorts every weight: a
    holding or cash balance without a usable FX rate, a holding without any price, or a stale share above
    ``max_stale_weight``. Rules that compare weights skip instead of firing on them.
    """
    problem = portfolio_value_problem(ctx)
    if problem is not None:
        return problem
    if ctx.portfolio.total_base <= 0:
        return "The portfolio has no value yet"
    return None


def portfolio_value_problem(ctx: RuleContext) -> str | None:
    """Like :func:`portfolio_data_problem` but an empty portfolio is fine (its total is a known 0)."""
    portfolio = ctx.portfolio
    fx_problem = missing_fx_problem(ctx)
    if fx_problem is not None:
        return fx_problem
    unpriced = sorted(
        {instrument_label(h.instrument) for h in portfolio.valued if h.market_value_base is None}
    )
    if unpriced:
        count = sum(1 for h in portfolio.valued if h.market_value_base is None)
        return (
            f"No price for {count} holding(s) ({', '.join(unpriced)}), "
            "so portfolio weights are incomplete"
        )
    if portfolio.stale_weight > ctx.data.max_stale_weight + RATIO_EPSILON:
        return (
            f"Stale prices cover {format_pct(portfolio.stale_weight)} of the portfolio "
            f"(max {format_pct(ctx.data.max_stale_weight)})"
        )
    return None


def missing_fx_problem(ctx: RuleContext) -> str | None:
    """Why amounts are missing from the total for lack of a usable FX rate, or None."""
    portfolio = ctx.portfolio
    currencies = portfolio.missing_fx_currencies
    if not currencies:
        return None
    holdings = sorted(
        {
            instrument_label(h.instrument)
            for h in portfolio.valued
            if h.missing_fx_currency is not None
        }
    )
    cash = sum(1 for c in portfolio.cash if c.amount_base is None)
    affected = []
    if holdings:
        affected.append(f"{len(holdings)} holding(s) ({', '.join(holdings)})")
    if cash:
        affected.append(f"{cash} cash balance(s)")
    names = ", ".join(sorted(str(c) for c in currencies))
    return (
        f"No usable {names}/{portfolio.base_currency} FX rate on {portfolio.as_of} (missing or older "
        f"than {ctx.data.max_fx_age_days} days): {' and '.join(affected) or 'some amounts'} cannot be "
        "valued, so portfolio weights are incomplete"
    )


def unclassified_problem(ctx: RuleContext) -> str | None:
    """Why bucket (or tag) weights are not comparable because too much of the portfolio matches no
    bucket (``RuleContext.unclassified``), or None. Names the unclassified instruments."""
    if not ctx.unclassified:
        return None
    share = sum(h.weight or 0.0 for h in ctx.unclassified)
    maximum = ctx.data.max_unclassified_weight
    if share <= maximum + RATIO_EPSILON:
        return None
    names = sorted({instrument_label(h.instrument) for h in ctx.unclassified})
    return (
        f"Holdings that match no bucket are {format_pct(share)} of the portfolio "
        f"(max {format_pct(maximum)}): {', '.join(names)}; classify or tag them so they fall into a bucket"
    )


def cash_history_problem(ctx: RuleContext) -> str | None:
    """Why the cash share is unknown because cash history is incomplete (negative cash), or None."""
    gaps = [w for w in ctx.portfolio.snapshot.warnings if isinstance(w, CashHistoryGap)]
    if not gaps:
        return None
    listed = ", ".join(f"{gap.amount} {gap.currency} in account {gap.account_id}" for gap in gaps)
    return (
        f"Cash history is incomplete (negative cash: {listed}; deposits missing from the imported "
        "history?), so the cash share is unknown"
    )


# --- instruments --------------------------------------------------------------------------------


def instrument_label(instrument: Instrument) -> str:
    """Display label of an instrument: its symbol, else its name."""
    return instrument.symbol or instrument.name


def has_all_tags(instrument: Instrument, tags: Iterable[str]) -> bool:
    """True when ``instrument`` carries every tag (case-insensitive, like bucket ``match.tags``)."""
    carried = {tag.strip().lower() for tag in instrument.tags}
    return all(tag.strip().lower() in carried for tag in tags)


@dataclass(frozen=True, slots=True)
class InstrumentFilter:
    """Per-instrument rule filters (``asset_class``, ``tags``, ``instrument_ids``), combined by AND.

    Same semantics as bucket ``match``: any listed asset class / instrument id matches, every listed tag
    must be present. Cash-like instruments (``asset_class: cash``) are left out unless ``asset_class``
    names ``cash`` explicitly: price and cost rules make no sense for them.
    """

    asset_classes: frozenset[AssetClass] = frozenset()
    tags: tuple[str, ...] = ()
    instrument_ids: frozenset[InstrumentId] = frozenset()

    KEYS = ("asset_class", "tags", "instrument_ids")

    @staticmethod
    def read(reader: ParamReader) -> InstrumentFilter:
        return InstrumentFilter(
            asset_classes=reader.asset_classes("asset_class"),
            tags=reader.strings("tags"),
            instrument_ids=frozenset(reader.strings("instrument_ids")),
        )

    def accepts(self, instrument: Instrument) -> bool:
        asset_class = instrument.asset_class
        if self.asset_classes:
            if asset_class not in self.asset_classes:
                return False
        elif asset_class == AssetClass.CASH:
            return False
        if self.tags and not has_all_tags(instrument, self.tags):
            return False
        return not self.instrument_ids or instrument.id in self.instrument_ids

    def payload(self) -> dict[str, object]:
        """The active filters for signal payloads (empty when none)."""
        result: dict[str, object] = {}
        if self.asset_classes:
            result["filter_asset_class"] = sorted(value.value for value in self.asset_classes)
        if self.tags:
            result["filter_tags"] = list(self.tags)
        if self.instrument_ids:
            result["filter_instrument_ids"] = sorted(self.instrument_ids)
        return result


@dataclass(frozen=True, slots=True)
class InstrumentPosition:
    """All holdings of one instrument across the profile's accounts."""

    instrument: Instrument
    holdings: tuple[ValuedHolding, ...]
    missing_fx_currencies: frozenset[Currency] = frozenset()

    @property
    def id(self) -> InstrumentId:
        return self.instrument.id

    @property
    def label(self) -> str:
        return instrument_label(self.instrument)

    @property
    def valued_manually(self) -> bool:
        """True when any holding is valued manually (a manual valuation, or a frozen default 0)."""
        return any(h.valued_manually for h in self.holdings)

    @property
    def valued_at_cost(self) -> bool:
        """True when any holding is valued at its cost basis (e.g. treasury bonds)."""
        return any(h.valued_at_cost for h in self.holdings)

    @property
    def series_problem(self) -> str | None:
        """Why price-history rules cannot judge this position (valued manually or at cost: no market
        price series by design), or None."""
        if self.valued_manually:
            return f"{self.label} is valued manually, so it has no market price series"
        if self.valued_at_cost:
            return f"{self.label} is valued at cost, so it has no market price series"
        return None

    @property
    def manual_problem(self) -> str | None:
        """Why the change from cost is not a market result (a manual valuation, e.g. a frozen holding at
        0 shows -100%), or None."""
        if self.valued_manually:
            return (
                f"{self.label} is valued manually, so its change from cost is not a market result"
            )
        return None

    @property
    def fx_problem(self) -> str | None:
        """Why this position cannot be valued in the base currency for lack of a usable FX rate, or None."""
        for holding in self.holdings:
            if holding.missing_fx_currency is not None:
                return f"No usable {holding.missing_fx_currency} FX rate, so {self.label} cannot be valued"
        if self.instrument.currency in self.missing_fx_currencies:
            return f"No usable {self.instrument.currency} FX rate, so {self.label} cannot be valued"
        return None

    @property
    def price_problem(self) -> str | None:
        """Why this position's price cannot be trusted, or None."""
        fx = self.fx_problem
        if fx is not None:
            return fx
        for holding in self.holdings:
            if holding.price is None or holding.market_value_base is None:
                return f"No price for {self.label}"
        for holding in self.holdings:
            if holding.is_stale:
                if holding.price_date is None:
                    return f"Price of {self.label} is stale"
                return f"Price of {self.label} is stale (last close {holding.price_date})"
        return None

    @property
    def weight(self) -> float | None:
        """Sum of weights, or None when any holding has none."""
        total = 0.0
        for holding in self.holdings:
            if holding.weight is None:
                return None
            total += holding.weight
        return total

    @property
    def market_value_base(self) -> Decimal | None:
        return _sum(h.market_value_base for h in self.holdings)

    @property
    def cost_basis_base(self) -> Decimal | None:
        return _sum(h.cost_basis_base for h in self.holdings)

    @property
    def cost_problem(self) -> str | None:
        """Why the unrealized result cannot be computed, or None."""
        cost = self.cost_basis_base
        if cost is None:
            return f"Cost basis of {self.label} is unknown (incomplete history or transfer without price)"
        if cost <= 0:
            return f"Cost basis of {self.label} is zero"
        return None

    @property
    def unrealized_pct(self) -> float | None:
        """(market value - cost) / cost across accounts, or None when either is unknown or cost is 0."""
        value = self.market_value_base
        cost = self.cost_basis_base
        if value is None or cost is None or cost <= 0:
            return None
        return float(divided_by(value - cost, cost))

    def payload(self) -> dict[str, object]:
        """Instrument context for signal payloads."""
        return {
            "instrument_id": self.instrument.id,
            "symbol": self.instrument.symbol,
            "name": self.instrument.name,
            "asset_class": self.instrument.asset_class.value,
            "accounts": len(self.holdings),
        }


def positions_by_instrument(
    ctx: RuleContext, instrument_filter: InstrumentFilter | None = None
) -> list[InstrumentPosition]:
    """Valued holdings grouped by instrument (first-seen order), filtered by ``instrument_filter``."""
    accepts = (instrument_filter or InstrumentFilter()).accepts
    grouped: dict[InstrumentId, list[ValuedHolding]] = {}
    instruments: dict[InstrumentId, Instrument] = {}
    for holding in ctx.portfolio.valued:
        if not accepts(holding.instrument):
            continue
        grouped.setdefault(holding.instrument_id, []).append(holding)
        instruments[holding.instrument_id] = holding.instrument
    missing = frozenset(ctx.portfolio.missing_fx_currencies)
    return [
        InstrumentPosition(instruments[key], tuple(holdings), missing)
        for key, holdings in grouped.items()
    ]


# --- formatting ---------------------------------------------------------------------------------


def format_pct(ratio: float, digits: int = 1) -> str:
    """``12.3%`` (rounded half away from zero)."""
    return f"{_round(ratio * 100, digits)}%"


def format_pp(pp: float) -> str:
    """``7.5 pp``."""
    return f"{_round(pp, 1)} pp"


def format_amount(amount: Decimal) -> str:
    """Whole currency units, e.g. ``3750`` (half away from zero)."""
    return str(amount.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def decimal_text(value: Decimal) -> str:
    """Canonical plain text of a Decimal for payloads: ``7000``, ``0.1`` (no exponent, no trailing 0)."""
    if value == 0:
        return "0"
    text = format(value.normalize(), "f")
    return text


def _round(value: float, digits: int) -> str:
    quantum = Decimal(1).scaleb(-digits)
    rounded = Decimal(repr(value)).quantize(quantum, rounding=ROUND_HALF_UP)
    if rounded == 0:
        rounded = abs(rounded)
    return str(rounded)


def _sum(values: Iterable[Decimal | None]) -> Decimal | None:
    total = Decimal(0)
    for value in values:
        if value is None:
            return None
        total += value
    return total
