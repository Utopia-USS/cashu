"""The watchlist: instruments a profile follows without holding them. Adding one resolves the instrument
(a search pick: a stored one by its Yahoo alias, else a new one verified against the Yahoo chart; free
text: a stored one by ISIN, Yahoo alias or symbol + market, else a new instrument with guessed Yahoo /
stooq aliases, and only where that cannot tell the market, the remote search); watched instruments join
the daily price refresh and can carry alerts.

One row per (profile, instrument) forever (F12): removing sets ``removed_at`` and adding the instrument
again restores the same row (same id; note and tags kept unless new ones are passed). Nothing about a
removed instrument is dropped: its research, theses, alerts and notes stay, and it stays referenced by the
profile. Network IO (search, chart verification) always happens before the first write."""

from __future__ import annotations

import datetime as dt
import logging
import re
from dataclasses import dataclass, field, replace
from typing import Self

from sqlmodel import Session, select

from cashu.core.models import Profile, utcnow

from ..alerts import AlertSource
from ..domain import AliasNamespace, AssetClass, Currency, Instrument, InstrumentAlias
from ..importing.exchanges import (
    exchange_for_hint,
    exchange_for_mic,
    split_broker_symbol,
)
from ..importing.resolver import guess_asset_class
from ..market import ChartQuote
from ..market.search import YAHOO_TYPES, SearchHit, crypto_currency, yahoo_market
from ..models import InvInstrumentAlias, InvWatchlistItem
from ..store import alerts as alert_store
from ..store import convert, instruments, market
from . import instrument_search, portfolio

MAX_ITEMS = 200
"""Most watchlist items per profile (each one costs a price fetch in every daily run)."""
MAX_TAGS = 10
MAX_TAG_LENGTH = 40
MAX_NOTE_LENGTH = 1000
MAX_NAME_LENGTH = 120
_ISIN = re.compile(r"^[A-Z]{2}[A-Z0-9]{9}[0-9]$")
_SYMBOL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.:\-_^=]{0,39}$")
PICK_HISTORY_DAYS = 366
"""Daily bars fetched with a verified pick (price, 30-day sparkline and 52-week high at once)."""
MAX_CANDIDATES = 5
_log = logging.getLogger("cashu.investments.watchlist")
"""Listings a free-text error names when several match."""
_CLASSIFIED = frozenset({AssetClass.EQUITY, AssetClass.ETF, AssetClass.FUND, AssetClass.CRYPTO})
"""Asset classes a pick is trusted with (``needs_classification`` False); anything else is reviewed."""


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


_PICK_SYMBOL = re.compile(r"^\^?[A-Za-z0-9][A-Za-z0-9.\-_^=&/]{0,39}$")
"""Yahoo symbols and tickers of a pick: ``VWCE.DE``, ``BRK-B``, ``M&M.NS``, ``BTC-USD``, ``^GSPC``,
an OpenFIGI class share ``BRK/B``."""


@dataclass(frozen=True)
class SearchPick:
    """A listing chosen from the search (``instrument_search``): the Yahoo symbol is required, the rest
    comes from the chosen hit and is only a hint (the chart meta wins for the currency)."""

    yahoo_symbol: str
    ticker: str | None = None
    name: str | None = None
    asset_class: str | None = None
    mic: str | None = None
    isin: str | None = None

    @classmethod
    def of_hit(cls, hit: SearchHit) -> SearchPick:
        assert hit.yahoo_symbol is not None
        return cls(
            yahoo_symbol=hit.yahoo_symbol,
            ticker=hit.ticker,
            name=hit.name,
            asset_class=hit.asset_class.value,
            mic=hit.mic,
            isin=hit.isin,
        )


def _clean_pick(pick: SearchPick) -> SearchPick:
    symbol = _clean(pick.yahoo_symbol)
    if symbol is None or not _PICK_SYMBOL.match(symbol):
        raise WatchlistError(
            "pick.yahoo_symbol must be a Yahoo symbol (e.g. VWCE.DE, NVDA, BTC-USD)"
        )
    ticker = _clean(pick.ticker)
    if ticker is not None and not _PICK_SYMBOL.match(ticker):
        raise WatchlistError(
            "pick.ticker must be a ticker (letters, digits and . - _ ^ = & /, up to 40)"
        )
    name = _clean(pick.name)
    if name is not None and len(name) > MAX_NAME_LENGTH:
        name = name[:MAX_NAME_LENGTH].rstrip()
    asset_class = _clean(pick.asset_class)
    if asset_class is not None:
        try:
            asset_class = AssetClass(asset_class.lower()).value
        except ValueError:
            raise WatchlistError(f'Unknown asset class "{asset_class}"') from None
    mic = _clean(pick.mic)
    if mic is not None:
        if exchange_for_mic(mic) is None:
            raise WatchlistError(f'Unknown market "{mic}"')
        mic = mic.upper()
    isin = _clean(pick.isin)
    if isin is not None:
        isin = isin.upper()
        if not _ISIN.match(isin):
            raise WatchlistError("pick.isin must be an ISIN (12 characters, e.g. IE00BK5BQT80)")
    return SearchPick(symbol.upper(), ticker and ticker.upper(), name, asset_class, mic, isin)


class _Remote:
    """The search sources of one add, created on first use (no client at all on the offline paths)
    and closed by the caller."""

    def __init__(self, given: instrument_search.SearchSources | None) -> None:
        self._given = given
        self._own: instrument_search.SearchSources | None = None

    def get(self) -> instrument_search.SearchSources:
        if self._given is not None:
            return self._given
        if self._own is None:
            self._own = instrument_search.default_sources()
        return self._own

    def close(self) -> None:
        if self._own is not None:
            self._own.close()
            self._own = None


def _verify(symbol: str, remote: _Remote) -> ChartQuote | None:
    """The Yahoo chart of ``symbol`` (about a year of daily bars), None when it cannot be verified
    (network error, unknown symbol, no bars). Network only: call it before any write."""
    chart = remote.get().chart
    if chart is None:
        return None
    end = portfolio.today()
    try:
        quote = chart.chart(symbol, end - dt.timedelta(days=PICK_HISTORY_DAYS), end)
    except Exception as e:  # noqa: BLE001 - unverified, never a failed add
        _log.info("price symbol %s not verified: %s", symbol, e)
        return None
    return quote if quote.bars else None


def resolve_pick(
    session: Session, pick: SearchPick, *, remote: _Remote | None = None
) -> Resolution:
    """The instrument of a search pick: a stored one with that Yahoo alias (no network; a guessed alias
    stays guessed), else a new one. A new one is verified first against the Yahoo chart (outside any
    write): verified, it takes the chart currency, a confirmed Yahoo alias and the fetched bars;
    unverified, the pick data with a guessed Yahoo alias, the market currency and a warning."""
    pick = _clean_pick(pick)
    found = instrument_search.stored_by_yahoo(session, [pick.yahoo_symbol]).get(pick.yahoo_symbol)
    if found is not None:
        return Resolution(found, False)
    own = remote is None
    remote = remote or _Remote(None)
    try:
        quote = _verify(pick.yahoo_symbol, remote)  # network: before the first write
    finally:
        if own:
            remote.close()
    return _create_pick(session, pick, quote)


def _unverified(symbol: str) -> WatchWarning:
    return WatchWarning(
        f"The price symbol {symbol} could not be verified (no prices yet); it is kept as a guess "
        "(check it in the instrument classification if no prices arrive)",
        "watchlist.unverified_price_symbol",
        symbol=symbol,
    )


def _insert_once(session: Session, planned: Instrument, yahoo_symbol: str) -> tuple[int, bool]:
    """Insert ``planned`` unless another instrument took ``yahoo_symbol`` meanwhile (two tabs, the app
    and an agent picking the same new listing): the INSERT opens the write transaction, so the check
    right after it is authoritative; on a clash the new row and its aliases are dropped again and the
    other instrument is used. (row id, created)."""
    row = instruments.insert(session, planned)
    owner = instrument_search.stored_by_yahoo(session, [yahoo_symbol]).get(yahoo_symbol.upper())
    if owner is None or owner == row.id:
        return row.id, True
    for alias in session.exec(
        select(InvInstrumentAlias).where(InvInstrumentAlias.instrument_id == row.id)
    ).all():
        session.delete(alias)
    session.flush()
    session.delete(row)
    session.flush()
    return owner, False


def _create_pick(session: Session, pick: SearchPick, quote: ChartQuote | None) -> Resolution:
    """A new instrument for a cleaned pick, with the chart ``quote`` when it verified (see
    :func:`resolve_pick`). No network here: the caller verified first."""
    meta_type = quote.instrument_type.upper() if quote and quote.instrument_type else ""
    crypto = pick.asset_class == AssetClass.CRYPTO.value or meta_type == "CRYPTOCURRENCY"
    ticker, market_info = yahoo_market(pick.yahoo_symbol, "CRYPTOCURRENCY" if crypto else meta_type)
    if pick.mic is not None:
        market_info = exchange_for_mic(pick.mic)
    ticker = pick.ticker or ticker
    if quote is not None:
        currency: Currency | None = quote.currency
    elif market_info is not None and market_info.crypto:
        currency = crypto_currency(pick.yahoo_symbol)
    else:
        currency = market_info.currency if market_info is not None else None
    if currency is None:
        raise WatchlistError(
            f"Cannot tell the currency of {pick.yahoo_symbol}: its price could not be checked; try "
            "again later or pick another listing"
        )
    name = pick.name or (quote.long_name if quote else None) or ticker
    if pick.asset_class is not None:
        asset_class = AssetClass(pick.asset_class)
    elif meta_type in YAHOO_TYPES:
        asset_class = YAHOO_TYPES[meta_type]
    else:
        asset_class = guess_asset_class(name, ticker, market_info)
    isin = pick.isin
    if isin is not None and instruments.DbInstrumentLookup(session).by_isin(isin) is not None:
        isin = None  # one ISIN, many listings (VWCE.DE and VWRA.L): the first stored keeps it
    aliases = [InstrumentAlias(AliasNamespace.YAHOO, pick.yahoo_symbol, guessed=quote is None)]
    stooq = market_info.stooq_symbol(ticker) if market_info is not None else None
    if stooq:
        aliases.append(InstrumentAlias(AliasNamespace.STOOQ, stooq, guessed=True))
    if isin is not None:
        aliases.append(InstrumentAlias(AliasNamespace.ISIN, isin))
    planned = Instrument(
        id="new-pick",
        name=name[:MAX_NAME_LENGTH],
        currency=currency,
        asset_class=asset_class,
        symbol=ticker,
        isin=isin,
        mic=market_info.mic if market_info is not None else None,
        needs_classification=asset_class not in _CLASSIFIED,
        aliases=tuple(aliases),
    )
    row_id, created = _insert_once(session, planned, pick.yahoo_symbol)
    if not created:
        return Resolution(row_id, False)
    if quote is not None:
        sid = convert.sid(row_id)
        market.upsert_bars(
            session, [replace(b, instrument_id=sid) for b in quote.bars], now=utcnow()
        )
        session.flush()
        return Resolution(row_id, True)
    return Resolution(row_id, True, [_unverified(pick.yahoo_symbol)])


def _candidates_text(text: str, hits: list[SearchHit]) -> str:
    shown = ", ".join(
        f"{h.yahoo_symbol} ({h.exchange_label or h.mic or '?'})" for h in hits[:MAX_CANDIDATES]
    )
    more = f" and {len(hits) - MAX_CANDIDATES} more" if len(hits) > MAX_CANDIDATES else ""
    return f'Several listings match "{text}": {shown}{more} - pass one of them'


def _search_fallback(
    session: Session, text: str, remote: _Remote, *, isin: bool
) -> Resolution | None:
    """The free-text fallback where the deterministic paths cannot tell the market (a bare ticker) or
    the currency (an unknown ISIN): one listing on a known market becomes a pick (an exact Yahoo
    symbol first: ``NVDA`` is the US listing); several raise naming them; none (or the search is
    unavailable) returns None and the caller raises its own error."""
    hits, _status = instrument_search.remote_hits(text, sources=remote.get())
    known = [h for h in hits if h.known_market and h.yahoo_symbol]
    if isin:  # Yahoo's listing(s) of the ISIN first; OpenFIGI's many listings only without one
        matching = [h for h in known if h.source == "yahoo"] or known
    else:
        exact = [h for h in known if (h.yahoo_symbol or "").upper() == text.upper()]
        matching = exact or [h for h in known if h.ticker.upper() == text.upper()]
    if len(matching) == 1:
        return resolve_pick(session, SearchPick.of_hit(matching[0]), remote=remote)
    if len(matching) > 1:
        raise WatchlistError(_candidates_text(text, matching))
    return None


def resolve_instrument(
    session: Session,
    profile: Profile,
    symbol_or_isin: str | None,
    *,
    name: str | None = None,
    currency: str | None = None,
    exchange: str | None = None,
    sources: instrument_search.SearchSources | None = None,
) -> Resolution:
    """The instrument ``symbol_or_isin`` means: a stored one (ISIN, Yahoo alias, symbol + market, or a
    symbol among the profile's instruments), else a new one (``needs_classification``) with guessed
    Yahoo / stooq aliases from the market suffix (``VWCE.DE``, ``PKN.WA``, ``NVDA:XNAS``) or
    ``exchange``; its currency comes from the market or ``currency``. Only where none of that works (a
    bare ticker, an unknown ISIN without currency) the remote search is asked (see
    :func:`_search_fallback`)."""
    remote = _Remote(sources)
    try:
        return _resolve_text(
            session, profile, symbol_or_isin, name, currency, exchange, remote=remote
        )
    finally:
        remote.close()


def _resolve_text(
    session: Session,
    profile: Profile,
    symbol_or_isin: str | None,
    name: str | None,
    currency: str | None,
    exchange: str | None,
    *,
    remote: _Remote,
) -> Resolution:
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
            searched = _search_fallback(session, upper, remote, isin=True)
            if searched is not None:
                return searched
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
        if _clean(exchange) is None and ":" not in text and "." not in text:
            searched = _search_fallback(session, text, remote, isin=False)
            if searched is not None:
                return searched
        raise WatchlistError(
            f'Cannot tell the market of "{text}": add the market suffix (e.g. {ticker}.US, '
            f"{ticker}.DE, {ticker}.WA) or give exchange / currency"
        )
    verify_failed = False
    if yahoo and market is not None and wanted_currency is None:
        # a new listing with its market (VWRA.L, VWCE.DE, NVDA:XNAS): verified like a search pick, so
        # it gets the real quote currency (VWRA.L trades in USD), a confirmed alias and bars
        quote = _verify(yahoo, remote)  # network: no write so far
        if quote is not None:
            pick = SearchPick(yahoo, ticker, display_name, None, market.mic)
            return _create_pick(session, _clean_pick(pick), quote)
        verify_failed = True
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
    if verify_failed and yahoo:
        warnings.append(_unverified(yahoo))
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
    restored: bool = False
    """True when the instrument's removed row came back (same id) instead of a new row."""
    previous_note: str | None = None
    """The restored row's note before this add (research undo puts it back)."""


def add(
    session: Session,
    profile: Profile,
    symbol_or_isin: str | None = None,
    *,
    instrument_id: int | None = None,
    pick: SearchPick | None = None,
    name: str | None = None,
    currency: str | None = None,
    exchange: str | None = None,
    note: str | None = None,
    tags: list[str] | None = None,
    source: AlertSource = AlertSource.USER,
    keep_existing_note: bool = False,
    sources: instrument_search.SearchSources | None = None,
) -> AddResult:
    """Put an instrument on the profile's watchlist: a search ``pick`` (:func:`resolve_pick`),
    ``instrument_id`` (one the profile references) or ``symbol_or_isin`` (resolved, see
    :func:`resolve_instrument`). An instrument whose row was removed gets that row back (same id, now
    at the end of the list, ``source`` = this adder); its note / tags are replaced only when given
    (``keep_existing_note``: a non-empty note stays even then)."""
    clean_note = _note(note)
    clean_tags = None if tags is None else _tags(tags)
    if len(alert_store.watchlist(session, profile.id)) >= MAX_ITEMS:
        raise WatchlistError(
            f"The watchlist holds at most {MAX_ITEMS} instruments; remove some first"
        )
    if pick is not None:
        resolution = resolve_pick(
            session, pick, remote=None if sources is None else _Remote(sources)
        )
    elif instrument_id is not None:
        if instrument_id not in instruments.profile_instrument_ids(session, profile.id):
            raise WatchlistNotFound(f"No instrument {instrument_id} in this profile")
        resolution = Resolution(instrument_id, False)
    else:
        resolution = resolve_instrument(
            session,
            profile,
            symbol_or_isin,
            name=name,
            currency=currency,
            exchange=exchange,
            sources=sources,
        )
    row = alert_store.watch_row_for(session, profile.id, resolution.instrument_id)
    if row is not None and row.removed_at is None:
        raise WatchlistConflict(f"That instrument is already on the watchlist (item {row.id})")
    now = utcnow()
    if row is not None:
        previous = row.note
        row.removed_at = None
        row.added_at = now
        row.source = source.value
        if note is not None and not (keep_existing_note and row.note):
            row.note = clean_note
        if clean_tags is not None:
            row.tags = clean_tags
        session.add(row)
        session.flush()
        return AddResult(row, resolution.created, resolution.warnings, True, previous)
    item = InvWatchlistItem(
        profile_id=profile.id,
        instrument_id=resolution.instrument_id,
        note=clean_note,
        tags=clean_tags or [],
        source=source.value,
        added_at=now,
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
    """Take an item off the watchlist: the row is kept with ``removed_at`` set (no daily fetch, not
    listed); its note, tags, the instrument's alerts, theses and research all stay, and adding the
    instrument again restores this row. A removed or unknown item is :class:`WatchlistNotFound`."""
    item = alert_store.watchlist_item(session, profile.id, item_id)
    if item is None:
        raise WatchlistNotFound(f"No watchlist item {item_id}")
    item.removed_at = utcnow()
    session.add(item)
    session.flush()
    return item
