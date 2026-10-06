"""The strategy's benchmark proxy as a shared reference instrument (market data only).

A strategy names its benchmark by a market symbol (``IUSQ.DE``) the owner often neither holds nor
watches, so no instrument row exists and the comparison never starts. :func:`ensure_proxy` registers
it offline when the symbol names a known market (the same Yahoo / stooq symbol conventions as broker
imports and the watchlist, ``importing.exchanges``): a shared ``InvInstrument`` with guessed yahoo and
stooq aliases and the market's usual currency. It is no position, no watchlist item and has no
signals: nothing of a profile references it, only the performance view (benchmark) and the price
backfill, which fetches its bars and settles its quote currency at the source.

An ISIN that is no stored instrument, or a symbol without a known market suffix, is not registered
here: the online backfill probe resolves a Yahoo symbol; otherwise the benchmark stays
``proxy_not_found``.
"""

from __future__ import annotations

import logging

from sqlmodel import Session, func, select

from ..domain import AliasNamespace, Instrument, InstrumentAlias
from ..importing.exchanges import split_broker_symbol
from ..importing.resolver import guess_asset_class
from ..models import (
    InvAlert,
    InvPositionSnapshot,
    InvPriceBar,
    InvProfileInstrument,
    InvTransaction,
    InvWatchlistItem,
)
from ..store import convert
from ..store import instruments as instrument_store

log = logging.getLogger(__name__)

FOUND, ADDED, UNRESOLVED = "found", "added", "unresolved"


def reference_instrument(proxy: str) -> Instrument | None:
    """The planned reference instrument of a market symbol with a known market suffix
    (``IUSQ.DE`` -> IUSQ on Xetra, EUR, yahoo ``IUSQ.DE``, stooq ``iusq.de``), else None."""
    from .service import is_isin

    text = (proxy or "").strip()
    if not text or is_isin(text):
        return None
    split = split_broker_symbol(text, None)
    market = split.exchange
    if market is None or market.currency is None or market.crypto:
        return None
    ticker = split.symbol.strip().upper()
    yahoo = market.yahoo_symbol(ticker)
    if not ticker or not yahoo:
        return None
    aliases = [InstrumentAlias(AliasNamespace.YAHOO, yahoo, guessed=True)]
    stooq = market.stooq_symbol(ticker)
    if stooq:
        aliases.append(InstrumentAlias(AliasNamespace.STOOQ, stooq, guessed=True))
    return Instrument(
        id="benchmark-proxy",
        name=yahoo,
        currency=market.currency,
        asset_class=guess_asset_class(ticker, ticker, market),
        symbol=ticker,
        mic=market.mic,
        aliases=tuple(aliases),
    )


def ensure_proxy(session: Session, proxy: str) -> tuple[Instrument | None, str]:
    """The stored instrument of a strategy's ``benchmark.proxy``, registering it as a reference
    instrument when the symbol names a known market. ``(instrument, "found" | "added")`` or
    ``(None, "unresolved")``. No network."""
    from .service import find_proxy

    found = find_proxy(session, proxy)
    if found is not None:
        return found, FOUND
    planned = reference_instrument(proxy)
    if planned is None:
        return None, UNRESOLVED
    row = instrument_store.insert(session, planned)
    stored = instrument_store.load_one(session, row.id)
    log.info("benchmark proxy %s registered as a reference instrument", proxy.strip())
    return stored, ADDED


def ensure_quietly(session: Session, proxy: str | None) -> None:
    """:func:`ensure_proxy` for the strategy loader: never raises (the strategy itself is fine)."""
    if not proxy:
        return
    try:
        ensure_proxy(session, proxy)
    except Exception:  # logged; the benchmark then stays proxy_not_found
        log.warning("could not register the benchmark proxy", exc_info=True)


def is_reference_only(session: Session, instrument_id) -> bool:
    """True when no profile references the instrument (no transaction, broker snapshot, watchlist
    item, alert or override) and it has no stored bars: a freshly registered reference proxy whose
    currency the backfill may still settle at the source."""
    pk = convert.pk(instrument_id)
    for model in (
        InvTransaction,
        InvPositionSnapshot,
        InvWatchlistItem,
        InvAlert,
        InvProfileInstrument,
        InvPriceBar,
    ):
        count = session.exec(
            select(func.count()).select_from(model).where(model.instrument_id == pk)
        ).one()
        if count:
            return False
    return True
