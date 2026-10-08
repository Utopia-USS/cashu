"""The fixed list of macro reference series (P6): public Yahoo symbols behind the regime cards. Pure.

Values are daily closes as Yahoo quotes them: distribution-adjusted closes (``adjclose``) for the ETFs
(``adjusted``: a yearly payout would otherwise bias their 6 / 12-month changes), index points for
``^GSPC`` and ``DX-Y.NYB``, and yields in percent for ``^TNX`` / ``^IRX`` (4.231 = 4,231 %; ``^IRX`` is a
discount yield, converted in ``regimes``). USD/PLN comes from the
NBP table in ``inv_fx_rates`` (quote USD), not from this list.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

SeriesUnit = Literal["price", "index", "percent"]


@dataclass(frozen=True)
class MacroSeries:
    key: str
    """Stable id (``inv_macro_bars.series``)."""
    symbol: str
    """Yahoo chart symbol."""
    meaning: str
    unit: SeriesUnit
    adjusted: bool = False
    """Store Yahoo's distribution-adjusted close (ETFs) instead of the raw close."""


SERIES: tuple[MacroSeries, ...] = (
    MacroSeries("acwi", "ACWI", "global equity (MSCI ACWI ETF, USD)", "price", adjusted=True),
    MacroSeries("spx", "^GSPC", "S&P 500", "index"),
    MacroSeries("dxy", "DX-Y.NYB", "US dollar index", "index"),
    MacroSeries("eem", "EEM", "emerging-markets equity ETF", "price", adjusted=True),
    MacroSeries("dbc", "DBC", "broad commodity ETF", "price", adjusted=True),
    MacroSeries("us10y", "^TNX", "US 10-year yield", "percent"),
    MacroSeries("us3m", "^IRX", "US 13-week bill yield", "percent"),
)
SERIES_KEYS: tuple[str, ...] = tuple(s.key for s in SERIES)
USDPLN = "usdpln"
"""Pseudo series key of the NBP USD/PLN rate in the regime input (read from ``inv_fx_rates``)."""

BACKFILL_DAYS = 1830
"""Calendar days every refresh fetches (about 5 years: 260 sessions for the regimes plus years of
state history). The whole window is fetched again each run (7 requests), so restated adjusted closes
and late corrections replace the stored ones; bars older than the window stay stored."""

_BY_KEY = {s.key: s for s in SERIES}


def series(key: str) -> MacroSeries | None:
    return _BY_KEY.get(key)
