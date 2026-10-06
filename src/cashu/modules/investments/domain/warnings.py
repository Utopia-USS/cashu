"""Warnings of the portfolio math: something it could not do exactly (never an exception).

Every warning is frozen data with value equality (duplicates collapse in a set), a stable ``kind``
(snake_case, for persistence and the UI) and a short English ``message``. ``account_id`` is the broker
account the warning belongs to, or None when it is not account-specific (e.g. a missing price of an
instrument that may be held in several accounts); ``restrict_snapshot`` drops warnings of other accounts.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import ClassVar

from .values import AccountId, CalendarDate, Currency, InstrumentId, TxnId


def _join(currencies: frozenset[Currency]) -> str:
    return ", ".join(sorted(currencies))


class PortfolioWarning:
    """Base of every portfolio warning."""

    __slots__ = ()
    kind: ClassVar[str] = "warning"
    account_id: AccountId | None
    """Set as a field by account-scoped warnings, a ``None`` class attribute on the others."""

    @property
    def message(self) -> str:
        raise NotImplementedError

    def __str__(self) -> str:
        return self.message


# --- lot engine / snapshot ----------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class HistoryGap(PortfolioWarning):
    """More units were sold / transferred out than the known history holds (expected with incomplete
    history). The shortfall was ignored, so positions may be understated."""

    kind: ClassVar[str] = "history_gap"
    account_id: AccountId
    instrument_id: InstrumentId
    date: CalendarDate
    shortfall: Decimal
    txn_id: TxnId

    @property
    def message(self) -> str:
        return (
            f"History gap: {self.txn_id} on {self.date} needs {self.shortfall} more units of "
            f"{self.instrument_id} than held"
        )


@dataclass(frozen=True, slots=True)
class UnknownCostBasis(PortfolioWarning):
    """A transfer in (or an adjustment) opened a lot without a usable price, so its cost is unknown."""

    kind: ClassVar[str] = "unknown_cost_basis"
    account_id: AccountId
    instrument_id: InstrumentId
    txn_id: TxnId
    date: CalendarDate

    @property
    def message(self) -> str:
        return (
            f"Unknown cost basis: {self.txn_id} on {self.date} opened a lot of {self.instrument_id} "
            "without a price"
        )


@dataclass(frozen=True, slots=True)
class InvalidTransaction(PortfolioWarning):
    """A transaction lacks a field its type needs (instrument, quantity, split ratio) and was ignored for
    lots. Its ``cash_amount`` still counts towards cash."""

    kind: ClassVar[str] = "invalid_transaction"
    account_id: AccountId
    txn_id: TxnId
    date: CalendarDate
    reason: str

    @property
    def message(self) -> str:
        return f"Ignored transaction {self.txn_id} on {self.date} for lots: {self.reason}"


@dataclass(frozen=True, slots=True)
class MixedLotCurrencies(PortfolioWarning):
    """Lots of one instrument in one account carry different currencies; ``Holding.cost_basis`` /
    ``average_cost`` are None (never summed across currencies). Valuation converts each lot on its own."""

    kind: ClassVar[str] = "mixed_lot_currencies"
    account_id: AccountId
    instrument_id: InstrumentId
    currencies: frozenset[Currency]

    @property
    def message(self) -> str:
        return (
            f"Lots of {self.instrument_id} in one account use several currencies: "
            f"{_join(self.currencies)}"
        )


@dataclass(frozen=True, slots=True)
class RealizedCurrencyMismatch(PortfolioWarning):
    """A sell was booked in another currency than the lots it closed: the realized trades keep proceeds
    and cost in their own currencies, their ``pnl`` is None, valuation reports the base-currency result."""

    kind: ClassVar[str] = "realized_currency_mismatch"
    account_id: AccountId
    instrument_id: InstrumentId
    txn_id: TxnId
    date: CalendarDate
    sale_currency: Currency
    lot_currencies: frozenset[Currency]

    @property
    def message(self) -> str:
        return (
            f"Sale {self.txn_id} of {self.instrument_id} on {self.date} is in {self.sale_currency} but "
            f"closed lots in {_join(self.lot_currencies)}: realized result only in the base currency"
        )


@dataclass(frozen=True, slots=True)
class CashHistoryGap(PortfolioWarning):
    """The cash of an account in one currency is negative as of the snapshot date: deposits (or sells,
    dividends) are missing from the imported history. Valuation counts the balance as 0 in totals and
    weights; cash rules skip while any such gap exists."""

    kind: ClassVar[str] = "cash_history_gap"
    account_id: AccountId
    currency: Currency
    amount: Decimal
    """The (negative) balance."""
    as_of: CalendarDate

    @property
    def message(self) -> str:
        return (
            f"Cash history gap: {self.currency} cash of {self.account_id} is {self.amount} on "
            f"{self.as_of} (deposits missing from the history?); counted as 0"
        )


# --- valuation ----------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class StaleFxRate(PortfolioWarning):
    """The newest rate converting ``currency`` to ``base`` for ``date`` is more than ``max_fx_age_days``
    old. It is not used: the amount is treated like one without any rate (see :class:`MissingFxRate`)."""

    kind: ClassVar[str] = "stale_fx_rate"
    account_id: ClassVar[None] = None
    currency: Currency
    base: Currency
    date: CalendarDate
    """The date the rate was needed for."""
    rate_date: CalendarDate
    age_days: int

    @property
    def message(self) -> str:
        return (
            f"Stale {self.currency}/{self.base} FX rate for {self.date}: newest rate {self.rate_date} "
            f"is {self.age_days} days old"
        )


@dataclass(frozen=True, slots=True)
class MissingFxRate(PortfolioWarning):
    """No usable FX rate on/before ``date`` converts ``currency`` to ``base``: the affected amount is left
    out and weight rules skip while a holding or cash balance lacks a valuation-date rate."""

    kind: ClassVar[str] = "missing_fx_rate"
    account_id: ClassVar[None] = None
    currency: Currency
    base: Currency
    date: CalendarDate

    @property
    def message(self) -> str:
        return f"No {self.currency}/{self.base} FX rate on or before {self.date}"


@dataclass(frozen=True, slots=True)
class MissingPrice(PortfolioWarning):
    """No price for a held instrument (no bar on/before the valuation date, no last trade price): the
    holding is excluded from totals and weights."""

    kind: ClassVar[str] = "missing_price"
    account_id: ClassVar[None] = None
    instrument_id: InstrumentId
    as_of: CalendarDate

    @property
    def message(self) -> str:
        return f"No price for {self.instrument_id} on or before {self.as_of}: excluded from weights"


@dataclass(frozen=True, slots=True)
class LastKnownPriceUsed(PortfolioWarning):
    """No market bar: the holding was valued at the last trade price and counts as stale."""

    kind: ClassVar[str] = "last_known_price_used"
    account_id: ClassVar[None] = None
    instrument_id: InstrumentId
    price_date: CalendarDate
    price: Decimal

    @property
    def message(self) -> str:
        return (
            f"No market price for {self.instrument_id}: valued at the last known price {self.price} "
            f"from {self.price_date}"
        )


@dataclass(frozen=True, slots=True)
class StalePrice(PortfolioWarning):
    """The newest bar of a held instrument is older than the allowed price age."""

    kind: ClassVar[str] = "stale_price"
    account_id: ClassVar[None] = None
    instrument_id: InstrumentId
    price_date: CalendarDate
    age_days: int

    @property
    def message(self) -> str:
        return (
            f"Stale price for {self.instrument_id}: last close {self.price_date} is "
            f"{self.age_days} days old"
        )


@dataclass(frozen=True, slots=True)
class MissingInstrument(PortfolioWarning):
    """A held instrument has no metadata in the ``MarketView``; a placeholder (asset class ``other``,
    needs classification) was used, so it matches no bucket that needs metadata."""

    kind: ClassVar[str] = "missing_instrument"
    account_id: ClassVar[None] = None
    instrument_id: InstrumentId

    @property
    def message(self) -> str:
        return f"No instrument metadata for {self.instrument_id}: valued with a placeholder"


@dataclass(frozen=True, slots=True)
class MissingCostBasis(PortfolioWarning):
    """A holding valued at cost has an unknown cost basis (or no FX rate for a lot): excluded from totals
    and weights like an unpriced holding."""

    kind: ClassVar[str] = "missing_cost_basis"
    account_id: AccountId
    instrument_id: InstrumentId

    @property
    def message(self) -> str:
        return (
            f"Cannot value {self.instrument_id} at cost: its cost basis is unknown, "
            "excluded from weights"
        )


@dataclass(frozen=True, slots=True)
class MissingManualValuation(PortfolioWarning):
    """An instrument valued manually has no manual valuation on/before the valuation date: excluded from
    totals and weights like an unpriced holding."""

    kind: ClassVar[str] = "missing_manual_valuation"
    account_id: ClassVar[None] = None
    instrument_id: InstrumentId
    as_of: CalendarDate

    @property
    def message(self) -> str:
        return (
            f"No manual valuation of {self.instrument_id} on or before {self.as_of}: "
            "excluded from weights"
        )


@dataclass(frozen=True, slots=True)
class FrozenValuedAtZero(PortfolioWarning):
    """A frozen instrument without a manual valuation is valued at 0 (until the owner sets one)."""

    kind: ClassVar[str] = "frozen_valued_at_zero"
    account_id: ClassVar[None] = None
    instrument_id: InstrumentId

    @property
    def message(self) -> str:
        return f"{self.instrument_id} is frozen and has no manual valuation: valued at 0"


ALL_WARNING_TYPES: tuple[type[PortfolioWarning], ...] = (
    HistoryGap,
    UnknownCostBasis,
    InvalidTransaction,
    MixedLotCurrencies,
    RealizedCurrencyMismatch,
    CashHistoryGap,
    StaleFxRate,
    MissingFxRate,
    MissingPrice,
    LastKnownPriceUsed,
    StalePrice,
    MissingInstrument,
    MissingCostBasis,
    MissingManualValuation,
    FrozenValuedAtZero,
)
"""Every concrete warning type (``kind`` values are unique)."""
