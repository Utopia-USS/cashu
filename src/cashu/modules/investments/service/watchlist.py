"""The watchlist: instruments a profile follows without holding them. Adding one resolves the instrument
(a stored one by ISIN, Yahoo alias or symbol + market, else a new instrument with guessed Yahoo / stooq
aliases); watched instruments join the daily price refresh and can carry alerts."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Self

from sqlmodel import Session

from cashu.core.models import Profile, utcnow

from ..alerts import AlertSource
from ..domain import AliasNamespace, Currency, Instrument, InstrumentAlias
from ..importing.exchanges import exchange_for_hint, split_broker_symbol
from ..importing.resolver import guess_asset_class
from ..models import InvWatchlistItem
from ..store import alerts as alert_store
from ..store import instruments

MAX_ITEMS = 200
"""Most watchlist items per profile (each one costs a price fetch in every daily run)."""
MAX_TAGS = 10
MAX_TAG_LENGTH = 40
MAX_NOTE_LENGTH = 1000
MAX_NAME_LENGTH = 120
_ISIN = re.compile(r"^[A-Z]{2}[A-Z0-9]{9}[0-9]$")
_SYMBOL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.:\-_^=]{0,39}$")


class WatchlistError(ValueError):
    """Invalid watchlist input (message safe to show; the API answers 422)."""


class WatchlistConflict(WatchlistError):
    """The instrument is already on the profile's watchlist (409)."""


class WatchlistNotFound(LookupError):
    """No such item / instrument in this profile (404)."""


class WatchWarning(str):
    """An English warning text (it stays a ``str`` for the CLI, MCP and the ``warnings`` list) with a
    stable ``code`` + ``params`` for a translated label (``watchlist.<name>``)."""

    code: str
    params: dict

    def __new__(cls, message: str, code: str, **params: object) -> Self:
        obj = super().__new__(cls, message)
        obj.code, obj.params = code, dict(params)
        return obj

    def to_dict(self) -> dict:
        return {"code": self.code, "params": dict(self.params), "message": str(self)}


@dataclass
class Resolution:
    instrument_id: int
    created: bool
    warnings: list[WatchWarning] = field(default_factory=list)


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _currency(value: str | None) -> Currency | None:
    text = _clean(value)
    if text is None:
        return None
    try:
        return Currency(text.upper())
    except ValueError:
        raise WatchlistError("currency must be a 3-letter currency code (e.g. EUR)") from None


def resolve_instrument(
    session: Session,
    profile: Profile,
    symbol_or_isin: str | None,
    *,
    name: str | None = None,
    currency: str | None = None,
    exchange: str | None = None,
) -> Resolution:
    """The instrument ``symbol_or_isin`` means: a stored one (ISIN, Yahoo alias, symbol + market, or a
    symbol among the profile's instruments), else a new one (``needs_classification``) with guessed
    Yahoo / stooq aliases from the market suffix (``VWCE.DE``, ``PKN.WA``, ``NVDA:XNAS``) or
    ``exchange``; its currency comes from the market or ``currency``."""
    text = _clean(symbol_or_isin)
    if text is None:
        raise WatchlistError(
            "symbol_or_isin is required: a ticker with its market (VWCE.DE, PKN.WA, AAPL.US) or an ISIN"
        )
    if not _SYMBOL.match(text):
        raise WatchlistError(
            "symbol_or_isin must be a ticker or an ISIN (letters, digits and . : - _ ^ =, up to 40)"
        )
    display_name = _clean(name)
    if display_name is not None and len(display_name) > MAX_NAME_LENGTH:
        raise WatchlistError(f"name is too long (max {MAX_NAME_LENGTH} characters)")
    wanted_currency = _currency(currency)
    lookup = instruments.DbInstrumentLookup(session)

    upper = text.upper()
    if _ISIN.match(upper):
        found = lookup.by_isin(upper)
        if found is not None:
            return Resolution(int(found.id), False)
        if wanted_currency is None:
            raise WatchlistError(
                f"ISIN {upper} is not known yet: give its currency (better: its ticker with the market, "
                "e.g. VWCE.DE, so prices can be fetched)"
            )
        planned = Instrument(
            id="new-watch",
            name=display_name or upper,
            currency=wanted_currency,
            asset_class=guess_asset_class(display_name, None, None),
            isin=upper,
            needs_classification=True,
            aliases=(InstrumentAlias(AliasNamespace.ISIN, upper),),
        )
        row = instruments.insert(session, planned)
        return Resolution(
            row.id,
            True,
            [
                WatchWarning(
                    f"No Yahoo symbol known for {upper}: prices are not fetched until one is set "
                    "(instrument classification, alias yahoo)",
                    "watchlist.no_price_symbol",
                    isin=upper,
                )
            ],
        )

    if _clean(exchange) is not None and exchange_for_hint(exchange) is None:
        raise WatchlistError(
            f'Unknown exchange "{_clean(exchange)}" (e.g. GPW, XETRA, NASDAQ, LSE, US)'
        )
    split = split_broker_symbol(text, exchange)
    market = split.exchange
    ticker = split.symbol.strip().upper()
    yahoo = market.yahoo_symbol(ticker) if market is not None else upper
    candidates = [upper, text] + ([yahoo] if yahoo else [])
    for value in dict.fromkeys(c for c in candidates if c):
        found = lookup.by_alias(AliasNamespace.YAHOO, value)
        if found is not None:
            return Resolution(int(found.id), False)
    if market is not None and market.mic:
        same = lookup.by_symbol(ticker, market.mic)
        if len(same) == 1:
            return Resolution(int(same[0].id), False)
    referenced = instruments.load(
        session, instruments.profile_instrument_ids(session, profile.id), profile_id=profile.id
    )
    mine = [
        inst
        for inst in referenced.values()
        if (inst.symbol or "").upper() == ticker
        and (market is None or market.mic is None or inst.mic == market.mic)
    ]
    if len(mine) == 1:
        return Resolution(int(mine[0].id), False)

    instrument_currency = wanted_currency or (market.currency if market is not None else None)
    if instrument_currency is None:
        raise WatchlistError(
            f'Cannot tell the market of "{text}": add the market suffix (e.g. {ticker}.US, '
            f"{ticker}.DE, {ticker}.WA) or give exchange / currency"
        )
    aliases: list[InstrumentAlias] = []
    if yahoo:
        aliases.append(InstrumentAlias(AliasNamespace.YAHOO, yahoo, guessed=True))
    stooq = market.stooq_symbol(ticker) if market is not None else None
    if stooq:
        aliases.append(InstrumentAlias(AliasNamespace.STOOQ, stooq, guessed=True))
    planned = Instrument(
        id="new-watch",
        name=display_name or ticker,
        currency=instrument_currency,
        asset_class=guess_asset_class(display_name or ticker, ticker, market),
        symbol=ticker,
        mic=market.mic if market is not None else None,
        needs_classification=True,
        aliases=tuple(aliases),
    )
    row = instruments.insert(session, planned)
    warnings = [
        WatchWarning(
            f"New instrument {ticker} ({instrument_currency}); price symbol guessed as {yahoo} "
            "(check it in the instrument classification if no prices arrive)",
            "watchlist.guessed_price_symbol",
            symbol=ticker,
            currency=str(instrument_currency),
            price_symbol=yahoo,
        )
    ]
    return Resolution(row.id, True, warnings)


def _tags(tags: list[str] | None) -> list[str]:
    if tags is None:
        return []
    if not isinstance(tags, list) or not all(isinstance(t, str) for t in tags):
        raise WatchlistError("tags must be a list of texts")
    cleaned = list(dict.fromkeys(t.strip() for t in tags if t and t.strip()))
    if len(cleaned) > MAX_TAGS:
        raise WatchlistError(f"at most {MAX_TAGS} tags")
    if any(len(t) > MAX_TAG_LENGTH for t in cleaned):
        raise WatchlistError(f"tags must be at most {MAX_TAG_LENGTH} characters")
    return cleaned


def _note(note: str | None) -> str | None:
    if note is None:
        return None
    if not isinstance(note, str):
        raise WatchlistError("note must be text")
    if len(note) > MAX_NOTE_LENGTH:
        raise WatchlistError(f"note is too long (max {MAX_NOTE_LENGTH} characters)")
    return note.strip() or None


@dataclass
class AddResult:
    item: InvWatchlistItem
    created_instrument: bool
    warnings: list[WatchWarning]


def add(
    session: Session,
    profile: Profile,
    symbol_or_isin: str | None = None,
    *,
    instrument_id: int | None = None,
    name: str | None = None,
    currency: str | None = None,
    exchange: str | None = None,
    note: str | None = None,
    tags: list[str] | None = None,
    source: AlertSource = AlertSource.USER,
) -> AddResult:
    """Put an instrument on the profile's watchlist: ``instrument_id`` (one the profile references)
    or ``symbol_or_isin`` (resolved, see :func:`resolve_instrument`)."""
    clean_note, clean_tags = _note(note), _tags(tags)
    if len(alert_store.watchlist(session, profile.id)) >= MAX_ITEMS:
        raise WatchlistError(
            f"The watchlist holds at most {MAX_ITEMS} instruments; remove some first"
        )
    if instrument_id is not None:
        if instrument_id not in instruments.profile_instrument_ids(session, profile.id):
            raise WatchlistNotFound(f"No instrument {instrument_id} in this profile")
        resolution = Resolution(instrument_id, False)
    else:
        resolution = resolve_instrument(
            session, profile, symbol_or_isin, name=name, currency=currency, exchange=exchange
        )
    existing = alert_store.watched_item_for(session, profile.id, resolution.instrument_id)
    if existing is not None:
        raise WatchlistConflict(f"That instrument is already on the watchlist (item {existing.id})")
    item = InvWatchlistItem(
        profile_id=profile.id,
        instrument_id=resolution.instrument_id,
        note=clean_note,
        tags=clean_tags,
        source=source.value,
        added_at=utcnow(),
    )
    session.add(item)
    session.flush()
    return AddResult(item, resolution.created, resolution.warnings)


def update(
    session: Session,
    profile: Profile,
    item_id: int,
    *,
    note: str | None = None,
    tags: list[str] | None = None,
) -> InvWatchlistItem:
    item = alert_store.watchlist_item(session, profile.id, item_id)
    if item is None:
        raise WatchlistNotFound(f"No watchlist item {item_id}")
    if note is not None:
        item.note = _note(note)
    if tags is not None:
        item.tags = _tags(tags)
    session.add(item)
    session.flush()
    return item


def remove(session: Session, profile: Profile, item_id: int) -> InvWatchlistItem:
    """Take an item off the watchlist (its instrument's alerts stay)."""
    item = alert_store.watchlist_item(session, profile.id, item_id)
    if item is None:
        raise WatchlistNotFound(f"No watchlist item {item_id}")
    session.delete(item)
    session.flush()
    return item
