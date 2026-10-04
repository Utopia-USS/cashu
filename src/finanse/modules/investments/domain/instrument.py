"""Instruments and their reference data: aliases, manual valuations, renames."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from .enums import AssetClass, InstrumentStatus, ValuationMode, default_valuation_mode
from .values import CalendarDate, Currency, InstrumentId


class AliasNamespace:
    """Well-known :attr:`InstrumentAlias.namespace` values. Broker symbols use the broker id
    (``xtb``, ``generic_csv``) as their namespace."""

    ISIN = "isin"
    STOOQ = "stooq"
    YAHOO = "yahoo"


@dataclass(frozen=True, slots=True)
class InstrumentAlias:
    """An external identifier of an instrument, unique per namespace across all instruments
    (``isin:IE00B4L5Y983``, ``stooq:pkn``, ``yahoo:PKN.WA``, ``xtb:PKN.PL``)."""

    namespace: str
    value: str
    guessed: bool = False
    """True when inferred (e.g. a yahoo symbol guessed from an exchange hint), not read or confirmed."""

    def __str__(self) -> str:
        return f"{self.namespace}:{self.value}{' (guessed)' if self.guessed else ''}"


@dataclass(frozen=True, slots=True)
class Instrument:
    """Shared market reference data: a security, fund, bond, claim or cash-like instrument.

    ``valuation_mode`` defaults to :func:`default_valuation_mode` of ``asset_class`` when not given.
    """

    id: InstrumentId
    name: str
    currency: Currency
    """Trading / pricing currency. Price sources reject quotes in another currency."""
    asset_class: AssetClass
    symbol: str | None = None
    """Display ticker (``PKN``, ``VWCE``), not unique."""
    isin: str | None = None
    mic: str | None = None
    """ISO 10383 market identifier of the main listing (``XWAR``, ``XETR``)."""
    region: str | None = None
    sector: str | None = None
    tags: tuple[str, ...] = ()
    """Free-form classification tags used by strategy buckets (``global_equity``)."""
    needs_classification: bool = False
    """True for instruments created during import that the owner has not reviewed yet."""
    aliases: tuple[InstrumentAlias, ...] = ()
    valuation_mode: ValuationMode | None = None
    status: InstrumentStatus = InstrumentStatus.ACTIVE

    def __post_init__(self) -> None:
        if self.valuation_mode is None:
            object.__setattr__(self, "valuation_mode", default_valuation_mode(self.asset_class))
        if not isinstance(self.tags, tuple):
            object.__setattr__(self, "tags", tuple(self.tags))
        if not isinstance(self.aliases, tuple):
            object.__setattr__(self, "aliases", tuple(self.aliases))

    def alias(self, namespace: str) -> str | None:
        """Value of the alias in ``namespace``; a confirmed alias wins over a guessed one."""
        guess: str | None = None
        for alias in self.aliases:
            if alias.namespace != namespace:
                continue
            if not alias.guessed:
                return alias.value
            if guess is None:
                guess = alias.value
        return guess

    @property
    def label(self) -> str:
        """Symbol, else name (for messages)."""
        return self.symbol or self.name

    @property
    def fetches_market_data(self) -> bool:
        """False for delisted and frozen instruments: market sources are not asked for them."""
        return self.status == InstrumentStatus.ACTIVE


@dataclass(frozen=True, slots=True)
class ManualValuation:
    """A value per unit of an instrument set by the owner as of a date (0 is valid, e.g. a frozen ADR).

    Used for ``ValuationMode.MANUAL`` and frozen instruments: the newest valuation on/before the
    valuation date applies.
    """

    instrument_id: InstrumentId
    as_of: CalendarDate
    unit_value: Decimal
    currency: Currency
    note: str | None = None


@dataclass(frozen=True, slots=True)
class InstrumentRename:
    """The instrument ``old_instrument_id`` continues as ``new_instrument_id`` from ``date`` (ticker change,
    merger into a successor). Open lots carry over with their cost and open date; this is not a sell plus
    a buy. Transactions dated on/after ``date`` that still name the old instrument count for the new one.
    """

    date: CalendarDate
    old_instrument_id: InstrumentId
    new_instrument_id: InstrumentId
    note: str | None = None


def placeholder_instrument(instrument_id: InstrumentId, currency: Currency) -> Instrument:
    """Stand-in for a held instrument without metadata (asset class ``other``, needs classification)."""
    return Instrument(
        id=instrument_id,
        name=instrument_id,
        currency=currency,
        asset_class=AssetClass.OTHER,
        needs_classification=True,
    )


__all__ = [
    "AliasNamespace",
    "Instrument",
    "InstrumentAlias",
    "InstrumentRename",
    "ManualValuation",
    "placeholder_instrument",
]
