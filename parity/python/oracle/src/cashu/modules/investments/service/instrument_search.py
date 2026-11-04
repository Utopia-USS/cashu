"""Instrument search for the add flow (F12): the profile's own instruments first (local, no network),
then listings from the free remote sources (Yahoo search; for an ISIN also OpenFIGI, whose listings
follow Yahoo's). A remote source that fails, times out or is rate limited never fails the search: the
result says ``remote_status`` instead.

Remote answers are cached in process per normalized query (:data:`CACHE_TTL`, a small LRU; only answers
where every source asked worked), so typing does not hammer Yahoo. The sources come from the module-level
:func:`default_sources` (tests and the e2e offline server swap it, like ``daily.default_sources``); the
same seam carries the chart lookup that verifies a pick before it is stored (``service.watchlist``).
"""

from __future__ import annotations

import logging
import threading
import time
import unicodedata
from collections import OrderedDict
from collections.abc import Callable
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from typing import Literal, Protocol

from sqlalchemy import func
from sqlmodel import Session, select

from cashu.core.models import Profile

from ..domain import AliasNamespace, CalendarDate, Instrument, InstrumentId
from ..market import ChartQuote
from ..market.search import MIC_LABELS, IsinLookup, SearchHit, SymbolSearch, is_isin
from ..models import InvInstrumentAlias
from ..store import instruments
from . import entries

MAX_QUERY = 60
REMOTE_MIN = 2
"""Shortest query sent to the remote sources (one letter matches half the market)."""
CACHE_TTL = 600.0
"""Seconds a successful remote answer is reused for the same normalized query."""
CACHE_SIZE = 64
_log = logging.getLogger("cashu.investments.search")
RemoteStatus = Literal["ok", "unavailable", "skipped"]


class SearchError(ValueError):
    """Invalid search input (message safe to show; the API answers 422)."""


class ChartLookup(Protocol):
    def chart(
        self,
        symbol: str,
        start: CalendarDate,
        end: CalendarDate,
        *,
        instrument_id: InstrumentId = "chart",
    ) -> ChartQuote: ...


@dataclass
class SearchSources:
    """The remote sources of one search or pick (``close`` releases their HTTP client)."""

    symbols: SymbolSearch | None
    isin: IsinLookup | None = None
    chart: ChartLookup | None = None
    close: Callable[[], None] = lambda: None


def default_sources() -> SearchSources:
    """The production sources over one short-timeout HTTP client: Yahoo search, OpenFIGI mapping and
    the Yahoo chart (pick verification)."""
    import httpx

    from ..market import MarketHttp, YahooPriceSource
    from ..market.search import SEARCH_TIMEOUT, OpenFigiIsinLookup, YahooSymbolSearch

    client = httpx.Client(follow_redirects=True)
    http = MarketHttp(client, timeout=SEARCH_TIMEOUT, max_retries=0)
    return SearchSources(
        YahooSymbolSearch(http), OpenFigiIsinLookup(http), YahooPriceSource(http), client.close
    )


def offline_sources() -> SearchSources:
    """No remote source at all: every search reports ``unavailable`` and no pick verifies."""
    return SearchSources(None)


@dataclass(frozen=True)
class Hit:
    """One search result row (the API / MCP shape, see :meth:`to_dict`)."""

    key: str
    instrument_id: int | None
    state: entries.EntryState
    symbol: str
    yahoo_symbol: str | None
    name: str
    exchange: str | None
    mic: str | None
    asset_class: str
    currency: str | None
    isin: str | None
    source: Literal["local", "yahoo", "openfigi"]

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "instrument_id": self.instrument_id,
            "state": self.state,
            "symbol": self.symbol,
            "yahoo_symbol": self.yahoo_symbol,
            "name": self.name,
            "exchange": self.exchange,
            "mic": self.mic,
            "asset_class": self.asset_class,
            "currency": self.currency,
            "isin": self.isin,
            "source": self.source,
        }


@dataclass
class SearchResult:
    query: str
    local: list[Hit] = field(default_factory=list)
    remote: list[Hit] = field(default_factory=list)
    remote_status: RemoteStatus = "skipped"

    def to_dict(self) -> dict:
        return {
            "query": self.query,
            "local": [h.to_dict() for h in self.local],
            "remote": [h.to_dict() for h in self.remote],
            "remote_status": self.remote_status,
        }


def clean_query(q: str | None) -> str:
    text = " ".join((q or "").split())
    if not text:
        raise SearchError("q is required (a name, symbol or ISIN)")
    if len(text) > MAX_QUERY:
        raise SearchError(f"q is too long (max {MAX_QUERY} characters)")
    return text


def fold(text: str) -> str:
    """Case- and diacritics-insensitive form (``Łódź`` -> ``lodz``) for matching."""
    folded = unicodedata.normalize("NFKD", text.casefold().replace("ł", "l"))
    return "".join(c for c in folded if not unicodedata.combining(c))


# --------------------------------------------------------------------------- #
# Remote (cached)
# --------------------------------------------------------------------------- #

_cache: OrderedDict[str, tuple[float, list[SearchHit]]] = OrderedDict()
_cache_lock = threading.Lock()
_clock: Callable[[], float] = time.monotonic


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _cached(key: str) -> list[SearchHit] | None:
    with _cache_lock:
        found = _cache.get(key)
        if found is None:
            return None
        if found[0] <= _clock():
            del _cache[key]
            return None
        _cache.move_to_end(key)
        return list(found[1])


def _remember(key: str, hits: list[SearchHit]) -> None:
    with _cache_lock:
        _cache[key] = (_clock() + CACHE_TTL, list(hits))
        _cache.move_to_end(key)
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)


def cache_key(text: str) -> str:
    """The cache key of a query: the text sent to the sources, whitespace-normalized and casefolded
    (the sources match case-insensitively)."""
    return " ".join(text.split()).casefold()


def remote_hits(
    q: str, *, sources: SearchSources | None = None
) -> tuple[list[SearchHit], RemoteStatus]:
    """Listings the remote sources find for ``q`` (no database access: call it with no session or
    transaction open). Yahoo first; for an ISIN also OpenFIGI, whose listings follow Yahoo's (deduped by
    Yahoo symbol). ``unavailable`` when every source asked failed; an answer is cached only when every
    source asked worked."""
    text = clean_query(q)
    if len(text) < REMOTE_MIN:
        return [], "skipped"
    key = cache_key(text)
    cached = _cached(key)
    if cached is not None:
        return cached, "ok"
    own = sources is None
    active = default_sources() if own else sources
    try:
        hits, worked, failed = _ask(text, active)
    finally:
        if own:
            active.close()
    if not worked:
        return [], "unavailable"
    if not failed:
        _remember(key, hits)
    return hits, "ok"


def _ask(text: str, sources: SearchSources) -> tuple[list[SearchHit], bool, bool]:
    """(hits, some source worked, some source failed)."""
    hits: list[SearchHit] = []
    worked = failed = False
    if sources.symbols is not None:
        try:
            hits = list(sources.symbols.search(text))
            worked = True
        except Exception as e:  # noqa: BLE001 - a failing source never fails the search
            _log.info("symbol search failed: %s", e)
            failed = True
    if is_isin(text) and sources.isin is not None:
        try:
            figi = sources.isin.lookup(text.upper())
            worked = True
        except Exception as e:  # noqa: BLE001 - a failing source never fails the search
            _log.info("ISIN lookup failed: %s", e)
            figi, failed = [], True
        seen = {(h.yahoo_symbol or "").upper() for h in hits}
        hits += [h for h in figi if (h.yahoo_symbol or "").upper() not in seen]
    return hits, worked, failed


# --------------------------------------------------------------------------- #
# Search
# --------------------------------------------------------------------------- #


def _local_rank(inst: Instrument, q: str, q_upper: str, *, by_name: bool = True) -> int | None:
    """0 exact ticker / ISIN / alias, 1 ticker or alias prefix, 2 name substring (only ``by_name``),
    None no match."""
    symbol = fold(inst.symbol or "")
    aliases = [fold(a.value) for a in inst.aliases if a.namespace != AliasNamespace.ISIN]
    if (symbol and symbol == q) or (inst.isin or "").upper() == q_upper or q in aliases:
        return 0
    if any(a.namespace == AliasNamespace.ISIN and a.value.upper() == q_upper for a in inst.aliases):
        return 0
    if (symbol and symbol.startswith(q)) or any(a.startswith(q) for a in aliases):
        return 1
    if by_name and q in fold(inst.name or ""):
        return 2
    return None


def _local_hit(inst: Instrument, state: entries.EntryState) -> Hit:
    iid = int(inst.id)
    return Hit(
        key=f"i:{iid}",
        instrument_id=iid,
        state=state,
        symbol=inst.label,
        yahoo_symbol=inst.alias(AliasNamespace.YAHOO),
        name=inst.name,
        exchange=MIC_LABELS.get(inst.mic or ""),
        mic=inst.mic,
        asset_class=inst.asset_class.value,
        currency=str(inst.currency),
        isin=inst.isin,
        source="local",
    )


def _remote_hit(hit: SearchHit) -> Hit:
    return Hit(
        key=f"y:{hit.yahoo_symbol}",
        instrument_id=None,
        state="new",
        symbol=hit.ticker,
        yahoo_symbol=hit.yahoo_symbol,
        name=hit.name,
        exchange=hit.exchange_label,
        mic=hit.mic,
        asset_class=hit.asset_class.value,
        currency=None if hit.currency_hint is None else str(hit.currency_hint),
        isin=hit.isin,
        source=hit.source,
    )


def stored_by_yahoo(session: Session, symbols: list[str]) -> dict[str, int]:
    """Stored instruments by upper-case Yahoo alias (guessed or confirmed) among ``symbols``."""
    wanted = sorted({s.upper() for s in symbols if s})
    if not wanted:
        return {}
    rows = session.exec(
        select(InvInstrumentAlias.value, InvInstrumentAlias.instrument_id).where(
            InvInstrumentAlias.namespace == AliasNamespace.YAHOO,
            func.upper(InvInstrumentAlias.value).in_(wanted),
        )
    ).all()
    return {value.upper(): iid for value, iid in rows}


NameFilter = Callable[[Instrument], bool]
"""Whether an instrument may be matched by its name (MCP strict privacy: not an owner-named one, whose
name the redaction hides; matching it would make the search an oracle for the hidden name)."""


def _local_part(
    session: Session,
    profile: Profile,
    text: str,
    limit: int,
    name_match: NameFilter | None,
) -> tuple[SearchResult, set[int]]:
    """The local rows of ``text`` and the profile's referenced instrument ids (no network)."""
    assert profile.id is not None
    folded, upper = fold(text), text.upper()
    referenced = instruments.profile_instrument_ids(session, profile.id)
    loaded = instruments.load(session, referenced, profile_id=profile.id)
    ranked: list[tuple[int, str, Instrument]] = []
    for inst in loaded.values():
        by_name = name_match is None or name_match(inst)
        rank = _local_rank(inst, folded, upper, by_name=by_name)
        if rank is not None:
            ranked.append((rank, fold(inst.label), inst))
    ranked.sort(key=lambda r: (r[0], r[1]))
    matched = [inst for _rank, _label, inst in ranked[:limit]]
    states = entries.entry_states(
        session, profile, [int(i.id) for i in matched], referenced=referenced
    )
    return SearchResult(text, [_local_hit(i, states[int(i.id)]) for i in matched]), referenced


def _merge(
    session: Session,
    profile: Profile,
    result: SearchResult,
    referenced: set[int],
    hits: list[SearchHit],
    limit: int,
) -> None:
    """Add the remote listings to ``result``: one the profile already references (same Yahoo alias)
    is shown once, as its local row; any other is a plain remote row (``instrument_id`` null, also for
    an instrument only another profile references: never exposed across profiles)."""
    stored = stored_by_yahoo(session, [h.yahoo_symbol for h in hits if h.yahoo_symbol])
    shown = {h.instrument_id for h in result.local}
    extra: list[int] = []
    seen: set[str] = set()
    for hit in hits:
        iid = stored.get((hit.yahoo_symbol or "").upper())
        if iid is not None and iid in referenced:
            if iid not in shown:  # the profile's own instrument the text did not match locally
                shown.add(iid)
                extra.append(iid)
            continue
        row = _remote_hit(hit)
        if row.key in seen or len(result.remote) >= limit:
            continue
        seen.add(row.key)
        result.remote.append(row)
    if extra:
        found = instruments.load(session, extra, profile_id=profile.id)
        more = entries.entry_states(session, profile, extra, referenced=referenced)
        result.local += [_local_hit(found[i], more[i]) for i in extra if i in found]


def search(
    session: Session,
    profile: Profile,
    q: str | None,
    *,
    remote: bool = True,
    limit: int = 8,
    sources: SearchSources | None = None,
    name_match: NameFilter | None = None,
) -> SearchResult:
    """The profile's instruments matching ``q`` (exact ticker / ISIN first, then prefix, then name)
    with their entry state, plus remote listings (``remote`` and ``q`` of at least two characters).
    Runs in the caller's ``session`` (reads only, no transaction is opened across the network); the
    API and the CLI use :func:`search_detached`, which holds no connection while waiting on the
    remote sources."""
    text = clean_query(q)
    result, referenced = _local_part(session, profile, text, limit, name_match)
    if not remote or len(text) < REMOTE_MIN:
        return result
    hits, result.remote_status = remote_hits(text, sources=sources)
    _merge(session, profile, result, referenced, hits, limit)
    return result


def search_detached(
    profile: Profile,
    q: str | None,
    *,
    remote: bool = True,
    limit: int = 8,
    sources: SearchSources | None = None,
    session_factory: Callable[[], AbstractContextManager[Session]] | None = None,
) -> SearchResult:
    """:func:`search` in two short sessions: the local part, then (after the remote IO, with no
    session open) the merge lookups."""
    if session_factory is None:
        from cashu.core.db import get_session as session_factory
    text = clean_query(q)
    with session_factory() as s:
        result, referenced = _local_part(s, profile, text, limit, None)
    if not remote or len(text) < REMOTE_MIN:
        return result
    hits, result.remote_status = remote_hits(text, sources=sources)
    with session_factory() as s:
        _merge(s, profile, result, referenced, hits, limit)
    return result
