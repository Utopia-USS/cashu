"""Instrument resolution for one import (one broker), without writing anything.

Order: ISIN -> broker alias (namespace = broker id; the symbol as exported, or the name when the row
has no symbol) -> symbol + market (instrument symbol and MIC, then guessed stooq / Yahoo aliases) ->
plan a new instrument with ``needs_classification=True``, a guessed asset class (``ETF`` / ``UCITS`` in
the name -> etf, a well-known crypto symbol -> crypto, a known market -> equity, else other) and guessed
stooq / Yahoo aliases flagged ``guessed``.

R10: a planned instrument's currency comes from the strongest :class:`CurrencyEvidence` among the rows
naming it (a priced trade row beats a position line or unpriced trade, which beat a dividend / tax / fee
row booked in the account currency), whatever their order in the file; trade rows that disagree are
noted. Planned instruments and aliases are visible to later rows of the same import, so one new
instrument is planned once. Matching an existing instrument also plans the aliases it lacks (its ISIN,
the broker symbol) when no other instrument owns them.

The persistence layer implements :class:`InstrumentLookup` (read-only) and writes
:attr:`InstrumentResolver.new_instruments` and :attr:`InstrumentResolver.new_aliases` on commit.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, replace
from decimal import Decimal
from enum import IntEnum, StrEnum
from typing import Protocol

from ..domain import (
    AliasNamespace,
    AssetClass,
    Currency,
    Instrument,
    InstrumentAlias,
    InstrumentId,
    TxnType,
)
from .contract import ParsedPosition, ParsedTxn
from .exchanges import CRYPTO, ExchangeInfo, crypto_base, exchange_for_hint, split_broker_symbol


class InstrumentLookup(Protocol):
    """Read-only access to the stored instruments (implemented by the persistence layer)."""

    def by_isin(self, isin: str) -> Instrument | None:
        """The instrument whose ISIN (display field or ``isin`` alias) is ``isin`` (upper-case)."""
        ...

    def by_alias(self, namespace: str, value: str) -> Instrument | None:
        """The instrument owning alias (``namespace``, ``value``), guessed or confirmed."""
        ...

    def by_symbol(self, symbol: str, mic: str) -> Sequence[Instrument]:
        """Instruments with ``symbol`` (case-insensitive) listed on ``mic``, oldest first."""
        ...


class InMemoryInstrumentLookup:
    """:class:`InstrumentLookup` over a list of instruments (tests, previews over loaded data)."""

    def __init__(self, instruments: Iterable[Instrument] = ()) -> None:
        self._instruments: list[Instrument] = list(instruments)

    def add(self, instrument: Instrument) -> None:
        self._instruments.append(instrument)

    def by_isin(self, isin: str) -> Instrument | None:
        wanted = isin.strip().upper()
        for instrument in self._instruments:
            if (instrument.isin or "").upper() == wanted:
                return instrument
            for alias in instrument.aliases:
                if alias.namespace == AliasNamespace.ISIN and alias.value.upper() == wanted:
                    return instrument
        return None

    def by_alias(self, namespace: str, value: str) -> Instrument | None:
        if namespace == AliasNamespace.ISIN:
            return self.by_isin(value)
        for instrument in self._instruments:
            for alias in instrument.aliases:
                if alias.namespace == namespace and alias.value == value:
                    return instrument
        return None

    def by_symbol(self, symbol: str, mic: str) -> Sequence[Instrument]:
        upper = symbol.upper()
        return [
            instrument
            for instrument in self._instruments
            if (instrument.symbol or "").upper() == upper and instrument.mic == mic
        ]


class InstrumentMatch(StrEnum):
    """How an import row was matched to an instrument, in resolution order."""

    ISIN = "isin"
    BROKER_ALIAS = "broker_alias"
    SYMBOL_EXCHANGE = "symbol_exchange"
    CREATED = "created"
    """Not found: a new instrument with ``needs_classification=True`` is planned."""


class CurrencyEvidence(IntEnum):
    """How much a row's currency says about the instrument's trading currency (weakest first)."""

    CASH_FLOW = 0
    """Dividend, withholding tax, fee, interest...: often booked in the account currency."""
    WEAK = 1
    """A position line, a trade row without a price, or a split."""
    TRADE = 2
    """A trade row with a price (buy, sell, transfer, adjustment): quoted in the trading currency."""


TRADE_TYPES: frozenset[TxnType] = frozenset(
    {TxnType.BUY, TxnType.SELL, TxnType.TRANSFER_IN, TxnType.TRANSFER_OUT, TxnType.ADJUSTMENT}
)


def evidence_of(txn: ParsedTxn) -> CurrencyEvidence:
    """The :class:`CurrencyEvidence` of a transaction row's currency."""
    if txn.type in TRADE_TYPES:
        price = txn.price
        return (
            CurrencyEvidence.TRADE
            if price is not None and price > Decimal(0)
            else CurrencyEvidence.WEAK
        )
    return CurrencyEvidence.WEAK if txn.type == TxnType.SPLIT else CurrencyEvidence.CASH_FLOW


@dataclass(frozen=True, slots=True, kw_only=True)
class InstrumentHint:
    """What an import row says about its instrument (hashable: resolutions are cached per hint)."""

    currency: Currency
    """Trading currency used when a new instrument is planned (weighed by ``evidence``)."""
    symbol: str | None = None
    """Symbol as written in the export (may carry a market suffix such as ``PKN.PL``)."""
    isin: str | None = None
    name: str | None = None
    exchange_hint: str | None = None
    evidence: CurrencyEvidence = CurrencyEvidence.WEAK

    @staticmethod
    def from_txn(txn: ParsedTxn) -> InstrumentHint:
        return InstrumentHint(
            currency=txn.currency,
            symbol=txn.symbol,
            isin=txn.isin,
            name=txn.name,
            exchange_hint=txn.exchange_hint,
            evidence=evidence_of(txn),
        )

    @staticmethod
    def from_position(position: ParsedPosition) -> InstrumentHint:
        return InstrumentHint(
            currency=position.currency,
            symbol=position.symbol,
            isin=position.isin,
            name=position.name,
            exchange_hint=position.exchange_hint,
        )

    @property
    def is_empty(self) -> bool:
        """True when the hint names no instrument at all (cash rows)."""
        return (
            _clean(self.symbol) is None and _clean(self.isin) is None and _clean(self.name) is None
        )


@dataclass(frozen=True, slots=True)
class ResolvedInstrument:
    """Result of :meth:`InstrumentResolver.resolve`. Look the instrument itself up with
    :meth:`InstrumentResolver.instrument` (a planned one can still gain an ISIN, aliases or a better
    currency from later rows)."""

    instrument_id: InstrumentId
    match: InstrumentMatch
    notes: tuple[str, ...] = ()
    """Conflicts and ambiguities worth showing in the preview (English, one sentence each)."""

    @property
    def is_new(self) -> bool:
        return self.match == InstrumentMatch.CREATED


_ETF_NAME = re.compile(r"\b(ETF|UCITS)\b", re.IGNORECASE)


def guess_asset_class(
    name: str | None, symbol: str | None, exchange: ExchangeInfo | None
) -> AssetClass:
    """Asset class guess for a planned instrument: ETF / UCITS in the name -> etf, crypto (pseudo-market
    or a well-known crypto symbol without a real market) -> crypto, a known market -> equity, else
    other."""
    if name and _ETF_NAME.search(name):
        return AssetClass.ETF
    if (exchange is not None and exchange.crypto) or (
        exchange is None and crypto_base(symbol) is not None
    ):
        return AssetClass.CRYPTO
    if exchange is not None:
        return AssetClass.EQUITY
    return AssetClass.OTHER


@dataclass(frozen=True, slots=True)
class _HintKey:
    """The normalized identifiers of a hint used for matching."""

    isin: str | None
    broker_symbol: str | None
    """The symbol as exported (or the name when the row has no symbol): the broker alias value."""
    ticker: str | None
    """Bare ticker (market suffix split off; crypto pairs reduced to the base coin)."""
    exchange: ExchangeInfo | None

    @staticmethod
    def of(hint: InstrumentHint) -> _HintKey:
        isin = _upper(_clean(hint.isin))
        symbol_text = _clean(hint.symbol)
        broker_symbol = symbol_text or _clean(hint.name)
        if symbol_text is None:
            return _HintKey(isin, broker_symbol, None, exchange_for_hint(hint.exchange_hint))
        split = split_broker_symbol(symbol_text, hint.exchange_hint)
        ticker, exchange = split.symbol, split.exchange
        if exchange is None and not _ETF_NAME.search(hint.name or ""):
            base = crypto_base(ticker)
            if base is not None:
                ticker, exchange = base, CRYPTO
        elif exchange is not None and exchange.crypto:
            ticker = crypto_base(ticker) or ticker
        return _HintKey(isin, broker_symbol, ticker, exchange)


def _new_id() -> InstrumentId:
    return str(uuid.uuid4())


class InstrumentResolver:
    """Maps import rows to instruments for one import (one broker) without writing anything.

    ``id_factory`` makes the ids of planned instruments (default: random UUID strings); the commit may
    keep them or remap them to stored ids.
    """

    def __init__(
        self,
        lookup: InstrumentLookup,
        *,
        broker_id: str,
        id_factory: Callable[[], InstrumentId] = _new_id,
    ) -> None:
        self._lookup = lookup
        self.broker_id = broker_id
        self._id_factory = id_factory
        self._planned: dict[InstrumentId, Instrument] = {}
        self._planned_evidence: dict[InstrumentId, CurrencyEvidence] = {}
        self._currency_conflicts: set[InstrumentId] = set()
        self._existing: dict[InstrumentId, Instrument] = {}
        self._new_aliases: dict[InstrumentId, list[InstrumentAlias]] = {}
        self._cache: dict[InstrumentHint, ResolvedInstrument] = {}

    @property
    def new_instruments(self) -> tuple[Instrument, ...]:
        """Instruments to create, in the order they were first needed."""
        return tuple(self._planned.values())

    @property
    def new_aliases(self) -> dict[InstrumentId, tuple[InstrumentAlias, ...]]:
        """Aliases to add to existing instruments."""
        return {key: tuple(value) for key, value in self._new_aliases.items()}

    def instrument(self, instrument_id: InstrumentId) -> Instrument | None:
        """Current state of a resolved instrument (planned or existing), None if never resolved."""
        return self._planned.get(instrument_id) or self._existing.get(instrument_id)

    def is_planned(self, instrument_id: InstrumentId) -> bool:
        return instrument_id in self._planned

    def resolve(self, hint: InstrumentHint) -> ResolvedInstrument:
        """Resolve ``hint``, planning a new instrument when nothing matches; raises ``ValueError``
        when it names no instrument (:attr:`InstrumentHint.is_empty`)."""
        if hint.is_empty:
            raise ValueError("The hint names no instrument (no symbol, ISIN or name)")
        cached = self._cache.get(hint)
        if cached is not None:
            return cached
        key = _HintKey.of(hint)
        notes: list[str] = []
        found = self._match(key, notes)
        if found is None:
            planned = self._plan(hint, key.isin, key.broker_symbol, key.ticker, key.exchange)
            result = ResolvedInstrument(planned.id, InstrumentMatch.CREATED)
        else:
            instrument_id, match = found
            self._learn(instrument_id, key.isin, key.broker_symbol, notes)
            self._weigh_currency(instrument_id, hint, notes)
            result = ResolvedInstrument(instrument_id, match, tuple(notes))
        self._cache[hint] = result
        return result

    def find(
        self,
        *,
        symbol: str | None = None,
        isin: str | None = None,
        name: str | None = None,
        exchange_hint: str | None = None,
    ) -> ResolvedInstrument | None:
        """Match without planning or learning anything (corporate actions naming an instrument that
        must already exist in the store or among this import's rows); None when nothing matches."""
        key = _HintKey.of(
            InstrumentHint(
                currency=Currency.USD,  # unused: matching never reads the currency
                symbol=symbol,
                isin=isin,
                name=name,
                exchange_hint=exchange_hint,
            )
        )
        if key.isin is None and key.broker_symbol is None:
            return None
        notes: list[str] = []
        found = self._match(key, notes)
        if found is None:
            return None
        return ResolvedInstrument(found[0], found[1], tuple(notes))

    def _match(
        self, key: _HintKey, notes: list[str]
    ) -> tuple[InstrumentId, InstrumentMatch] | None:
        if key.isin is not None:
            owner = self._owner(AliasNamespace.ISIN, key.isin)
            if owner is not None:
                return owner, InstrumentMatch.ISIN
        if key.broker_symbol is not None:
            owner = self._owner(self.broker_id, key.broker_symbol)
            if owner is not None:
                return owner, InstrumentMatch.BROKER_ALIAS
        if key.ticker is not None and key.exchange is not None:
            owner = self._by_symbol_and_exchange(key.ticker, key.exchange, notes)
            if owner is not None:
                return owner, InstrumentMatch.SYMBOL_EXCHANGE
        return None

    # --- matching --------------------------------------------------------------------------------

    def _by_symbol_and_exchange(
        self, symbol: str, exchange: ExchangeInfo, notes: list[str]
    ) -> InstrumentId | None:
        mic = exchange.mic
        if mic is not None:
            upper = symbol.upper()
            for instrument in self._planned.values():
                if (instrument.symbol or "").upper() == upper and instrument.mic == mic:
                    return instrument.id
            stored = list(self._lookup.by_symbol(symbol, mic))
            if stored:
                if len(stored) > 1:
                    notes.append(
                        f"Symbol {symbol} on {mic} matches {len(stored)} instruments; "
                        f"used the oldest ({stored[0].name})"
                    )
                return self._remember(stored[0]).id
        for namespace, value in (
            (AliasNamespace.STOOQ, exchange.stooq_symbol(symbol)),
            (AliasNamespace.YAHOO, exchange.yahoo_symbol(symbol)),
        ):
            if value is None:
                continue
            owner = self._owner(namespace, value)
            if owner is not None:
                return owner
        return None

    def _owner(self, namespace: str, value: str) -> InstrumentId | None:
        """The instrument owning alias (``namespace``, ``value``): planned instruments and planned
        aliases first, then the lookup."""
        normalized = _normalize_alias(namespace, value)
        for instrument in self._planned.values():
            if namespace == AliasNamespace.ISIN and instrument.isin == normalized:
                return instrument.id
            if any(a.namespace == namespace and a.value == normalized for a in instrument.aliases):
                return instrument.id
        for instrument_id, aliases in self._new_aliases.items():
            if any(a.namespace == namespace and a.value == normalized for a in aliases):
                return instrument_id
        if namespace == AliasNamespace.ISIN:
            stored = self._lookup.by_isin(normalized)
        else:
            stored = self._lookup.by_alias(namespace, normalized)
        return None if stored is None else self._remember(stored).id

    def _remember(self, instrument: Instrument) -> Instrument:
        return self._existing.setdefault(instrument.id, instrument)

    # --- planning --------------------------------------------------------------------------------

    def _plan(
        self,
        hint: InstrumentHint,
        isin: str | None,
        broker_symbol: str | None,
        symbol: str | None,
        exchange: ExchangeInfo | None,
    ) -> Instrument:
        aliases: list[InstrumentAlias] = []
        if broker_symbol is not None:
            aliases.append(InstrumentAlias(self.broker_id, broker_symbol))
        if symbol is not None and exchange is not None:
            for namespace, value in (
                (AliasNamespace.STOOQ, exchange.stooq_symbol(symbol)),
                (AliasNamespace.YAHOO, exchange.yahoo_symbol(symbol)),
            ):
                if value is not None and self._owner(namespace, value) is None:
                    aliases.append(InstrumentAlias(namespace, value, guessed=True))
        name = _clean(hint.name) or symbol or isin or broker_symbol or "?"
        instrument = Instrument(
            id=self._id_factory(),
            name=name,
            currency=hint.currency,
            asset_class=guess_asset_class(name, symbol, exchange),
            symbol=symbol,
            isin=isin,
            mic=None if exchange is None else exchange.mic,
            needs_classification=True,
            aliases=tuple(aliases),
        )
        self._planned[instrument.id] = instrument
        self._planned_evidence[instrument.id] = hint.evidence
        return instrument

    def _weigh_currency(
        self, instrument_id: InstrumentId, hint: InstrumentHint, notes: list[str]
    ) -> None:
        """Let a later row of a planned instrument correct its currency when it is stronger evidence
        (R10); note trade rows that disagree."""
        planned = self._planned.get(instrument_id)
        evidence = self._planned_evidence.get(instrument_id)
        if planned is None or evidence is None:
            return
        if planned.currency == hint.currency:
            if hint.evidence > evidence:
                self._planned_evidence[instrument_id] = hint.evidence
            return
        if hint.evidence > evidence:
            self._planned[instrument_id] = replace(planned, currency=hint.currency)
            self._planned_evidence[instrument_id] = hint.evidence
        elif (
            hint.evidence == CurrencyEvidence.TRADE
            and evidence == CurrencyEvidence.TRADE
            and instrument_id not in self._currency_conflicts
        ):
            self._currency_conflicts.add(instrument_id)
            notes.append(
                f"Trade rows of {planned.name} use several currencies ({planned.currency}, "
                f"{hint.currency}); created it in {planned.currency}"
            )

    def _learn(
        self,
        instrument_id: InstrumentId,
        isin: str | None,
        broker_symbol: str | None,
        notes: list[str],
    ) -> None:
        """Plan the ISIN and broker symbol aliases ``instrument_id`` lacks, unless another instrument
        owns them."""
        current = self.instrument(instrument_id)
        if current is None:  # pragma: no cover - every match path remembers the instrument
            return
        if isin is not None:
            owner = self._owner(AliasNamespace.ISIN, isin)
            known = current.alias(AliasNamespace.ISIN) or current.isin
            if owner is None and known is None:
                self._add_alias(instrument_id, AliasNamespace.ISIN, isin)
            elif owner != instrument_id and (owner is not None or known != isin):
                notes.append(
                    f"ISIN {isin} of the row differs from {current.name} "
                    f"({known or 'owned by another instrument'})"
                )
        if broker_symbol is not None:
            owner = self._owner(self.broker_id, broker_symbol)
            if owner is None:
                self._add_alias(instrument_id, self.broker_id, broker_symbol)
            elif owner != instrument_id:
                other = self.instrument(owner)
                notes.append(
                    f"Broker symbol {broker_symbol} belongs to "
                    f"{other.name if other else 'another instrument'}, but the row was matched to "
                    f"{current.name}"
                )

    def _add_alias(self, instrument_id: InstrumentId, namespace: str, value: str) -> None:
        planned = self._planned.get(instrument_id)
        if planned is not None:
            if namespace == AliasNamespace.ISIN:
                self._planned[instrument_id] = replace(planned, isin=value)
            else:
                self._planned[instrument_id] = replace(
                    planned, aliases=(*planned.aliases, InstrumentAlias(namespace, value))
                )
            return
        self._new_aliases.setdefault(instrument_id, []).append(InstrumentAlias(namespace, value))


def _normalize_alias(namespace: str, value: str) -> str:
    trimmed = value.strip()
    return trimmed.upper() if namespace == AliasNamespace.ISIN else trimmed


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    trimmed = value.strip()
    return trimmed or None


def _upper(value: str | None) -> str | None:
    return None if value is None else value.upper()


__all__ = [
    "TRADE_TYPES",
    "CurrencyEvidence",
    "InMemoryInstrumentLookup",
    "InstrumentHint",
    "InstrumentLookup",
    "InstrumentMatch",
    "InstrumentResolver",
    "ResolvedInstrument",
    "evidence_of",
    "guess_asset_class",
]
