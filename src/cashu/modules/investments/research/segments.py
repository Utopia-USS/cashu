"""Market segments (P5): a small fixed catalog of asset classes and sectors behind the portfolio, the
segment of each instrument and the automatic assignment of well-known funds. Pure (no IO).

An instrument's segment is per profile (``inv_profile_instruments.segment``, set by the owner or the
research agent, ``segment_by``; the agent never changes the owner's choice); without one, :func:`auto_segment` guesses from the asset class and a table of
well-known fund symbols; otherwise it has none (the attribution shows it as ``unassigned``). Order of
:data:`SEGMENTS` is the UI tie-break. Labels are Polish (UI data).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from ..domain import AliasNamespace, AssetClass, Instrument

SegmentSource = Literal["owner", "agent", "auto"]
SEGMENT_SETTERS = ("owner", "agent")
"""Who set an instrument's segment: the owner in the app or the research agent over MCP."""


@dataclass(frozen=True)
class Segment:
    key: str
    """Stable id, ``[a-z_]+`` (API, MCP, DB)."""
    label: str
    """Polish, UI."""
    group: str
    """``asset`` | ``sector``."""


SEGMENTS: tuple[Segment, ...] = (
    Segment("equity_global", "Akcje globalne", "asset"),
    Segment("equity_pl", "Akcje polskie", "asset"),
    Segment("equity_em", "Rynki wschodzące", "asset"),
    Segment("bonds", "Obligacje i stopy", "asset"),
    Segment("gold", "Złoto i górnicy", "asset"),
    Segment("energy", "Ropa i gaz", "asset"),
    Segment("uranium", "Uran i atom", "asset"),
    Segment("metals", "Metale przemysłowe", "asset"),
    Segment("crypto", "Krypto", "asset"),
    Segment("real_estate", "Nieruchomości", "asset"),
    Segment("semis_ai", "Półprzewodniki i AI", "sector"),
    Segment("software", "Oprogramowanie i internet", "sector"),
    Segment("healthcare", "Ochrona zdrowia", "sector"),
    Segment("financials", "Finanse i płatności", "sector"),
    Segment("consumer", "Konsumpcja", "sector"),
    Segment("games_media", "Gry i media", "sector"),
    Segment("industrials", "Przemysł i obronność", "sector"),
    Segment("quantum", "Komputery kwantowe", "sector"),
)
SEGMENT_KEYS: tuple[str, ...] = tuple(s.key for s in SEGMENTS)
SEGMENT_GROUPS = ("asset", "sector")
UNASSIGNED = "unassigned"
UNASSIGNED_LABEL = "Bez segmentu"
"""Pseudo row of the attribution for holdings without a segment (never a catalog key)."""

_BY_KEY = {s.key: s for s in SEGMENTS}
_ORDER = {s.key: i for i, s in enumerate(SEGMENTS)}

STABLECOINS = frozenset({"USDC", "USDT", "DAI", "EURC", "FDUSD", "PYUSD"})
"""Crypto symbols pegged to a currency: no market segment (they behave like cash)."""

_FUNDS: dict[str, tuple[str, ...]] = {
    "gold": ("GLD", "IAU", "SGLD", "PHAU", "GDX", "GDXJ", "RING", "SIL"),
    "uranium": ("URA", "URNM", "URNU", "NUKZ"),
    "metals": ("REMX", "COPX", "PICK", "XME", "LIT"),
    "energy": ("OIH", "XLE", "XOP", "VDE", "IXC"),
    "equity_global": (
        "VOO",
        "SPY",
        "IVV",
        "CSPX",
        "SXR8",
        "IUSQ",
        "VWCE",
        "VWRA",
        "VWRP",
        "ACWI",
        "SSAC",
        "EUNL",
        "IWDA",
        "SWDA",
    ),
    "equity_em": ("EEM", "EIMI", "IEMG", "VFEM", "MCHI", "FXI", "KWEB"),
    "semis_ai": ("SMH", "SOXX", "SEMI"),
    "healthcare": ("XLV",),
    "financials": ("XLF",),
    "real_estate": ("VNQ", "IPRP"),
    "bonds": ("TLT", "IEF", "AGG", "BND", "IBTM", "IGLT"),
}
FUND_SEGMENTS: dict[str, str] = {
    symbol: segment for segment, symbols in _FUNDS.items() for symbol in symbols
}
"""Well-known fund symbols (without exchange suffix) -> segment."""

_BOND_CLASSES = (AssetClass.BOND, AssetClass.TREASURY_BOND)
_SUFFIX = re.compile(r"[.:].*$")


def is_segment(key: object) -> bool:
    return isinstance(key, str) and key in _BY_KEY


def segment(key: str) -> Segment | None:
    return _BY_KEY.get(key)


def segment_label(key: str) -> str:
    """The Polish label of ``key`` (``Bez segmentu`` for the unassigned row, the key itself when
    unknown, e.g. a key dropped from the catalog later)."""
    if key == UNASSIGNED:
        return UNASSIGNED_LABEL
    found = _BY_KEY.get(key)
    return found.label if found is not None else key


def segment_group(key: str) -> str | None:
    found = _BY_KEY.get(key)
    return found.group if found is not None else None


def catalog_order(key: str | None) -> int:
    """Position in :data:`SEGMENTS` (unknown keys and the unassigned row last)."""
    return _ORDER.get(key or "", len(SEGMENTS))


def bare_symbol(symbol: str | None) -> str:
    """``GDXJ.L`` / ``gdxj.us`` / ``XETR:SXR8`` -> ``GDXJ`` / ``SXR8`` (upper case, no exchange)."""
    text = (symbol or "").strip().upper()
    if ":" in text:
        text = text.rsplit(":", 1)[1]  # an exchange prefix (XETR:SXR8)
    return _SUFFIX.sub("", text)


def _symbols(instrument: Instrument) -> list[str]:
    """The instrument's ticker, then its price-source aliases (an instrument without a display
    symbol still matches by its Yahoo / stooq symbol)."""
    out = [instrument.symbol] if instrument.symbol else []
    for alias in instrument.aliases:
        if alias.namespace in (AliasNamespace.YAHOO, AliasNamespace.STOOQ) and alias.value:
            out.append(alias.value)
    return out


def auto_segment(instrument: Instrument) -> str | None:
    """The segment guessed when nothing was set: bonds and treasury bonds -> ``bonds``; crypto ->
    ``crypto`` except stablecoins; a well-known fund symbol (exchange suffix ignored) -> its segment;
    else None (Claude or the owner assigns)."""
    if instrument.asset_class in _BOND_CLASSES:
        return "bonds"
    symbols = _symbols(instrument)
    if instrument.asset_class == AssetClass.CRYPTO:
        for value in symbols:
            # crypto pairs are written BTC-USD / USDT-USD: the base asset decides
            if bare_symbol(value).split("-", 1)[0] in STABLECOINS:
                return None
        return "crypto"
    for value in symbols:
        found = FUND_SEGMENTS.get(bare_symbol(value))
        if found is not None:
            return found
    return None


def segment_of(
    instrument: Instrument, explicit: str | None, set_by: str | None = None
) -> tuple[str | None, SegmentSource | None]:
    """``(segment, source)``: the profile's own value (source = who set it, ``owner`` or ``agent``;
    ``owner`` when unknown) wins over :func:`auto_segment` (``auto``); ``(None, None)`` when neither
    gives one. An explicit value no longer in the catalog is ignored."""
    if is_segment(explicit):
        return explicit, set_by if set_by in SEGMENT_SETTERS else "owner"
    guessed = auto_segment(instrument)
    if guessed is not None:
        return guessed, "auto"
    return None, None


def catalog() -> list[dict]:
    """The catalog as JSON rows (API / MCP)."""
    return [{"segment": s.key, "label": s.label, "group": s.group} for s in SEGMENTS]
