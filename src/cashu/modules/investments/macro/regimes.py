"""Macro regimes (P6): five deterministic states computed from public reference series. Pure (no IO).

Input: daily closes per series key (``series.SERIES_KEYS`` plus ``series.USDPLN``), any order, and
``as_of`` (bars dated later are ignored). Output: one :class:`Regime` per card in :data:`ORDER`.

Terms: a session is a bar of the series a regime reads; ``ma200`` = the simple mean of the last 200
closes; ``chg(n)`` = close / close ``n`` sessions ago - 1. A regime needs :data:`MIN_BARS` sessions,
else it is ``unknown`` / ``missing``. Ratios (EM vs the world, commodities vs the world) and the yield
curve use the dates both series have (mismatched calendars are aligned, never forward-filled).

Hysteresis: the raw state is evaluated for every session from the first one with :data:`MIN_BARS`
sessions of history (over every stored bar, never a sliding window); that first raw state is reported
at once, after that the reported state switches only when a new raw state held :data:`HOLD_SESSIONS`
consecutive sessions: ``since`` is the first session of that run, ``confirmed`` the session the switch
became visible (the 5th). The first run's real start is unknown (it began before the data): it is
open-ended (``since`` None, ``since_open``, ``since_min`` = the first evaluated session). The
yield-curve inversion flag follows the same rule on its own (common) dates.

Staleness: a regime is stale when its last bar is more than :data:`STALE_DAYS` calendar days older than
``as_of``; every metric carries its own ``stale`` (its underlying series), and the inversion flag is
dropped when the common us10y / us3m date is stale.

The 13-week bill yield (``^IRX``) is quoted on a discount basis; before the curve it is converted to a
bond-equivalent yield (:func:`bond_equivalent`), comparable with the 10-year yield (``^TNX``).

Comparisons with a threshold treat values within a relative :data:`TOLERANCE` as equal to it (so a
drawdown of exactly -20 % computed in floating point is still ``<= -20 %``).

States describe the present, never the future. ``meaning`` is one factual Polish sentence about the
usual mechanism (UI tooltip), never a statement about a future price.

Language: a :class:`Regime` keeps the Polish labels (``label``, ``state_label``, ``meaning``, metric
``label``): they are its identity (the MCP allow-list, ``texts``' metric lookups) and the evaluation is
cached across requests. The UI texts are rendered per request by :func:`display_label`,
:func:`state_label`, :func:`display_state_label`, :func:`display_meaning`, :func:`metric_label` and
:func:`format_metric` in the current language (``core.i18n``).
"""

from __future__ import annotations

import datetime as dt
import math
from bisect import bisect_right
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Literal

from cashu.core.i18n import lang, tr

from .series import USDPLN

MetricUnit = Literal["pct", "pp", "bp", "level"]
Tone = Literal["pos", "neg", "warn", ""]

ORDER: tuple[str, ...] = ("risk", "dollar", "em", "commodities", "rates")

MIN_BARS = 260
"""Sessions a regime needs (200 for the mean + 20 for its slope, 252 for the yearly peak / change)."""
MA_WINDOW = 200
"""Sessions in the long moving average."""
SLOPE_LAG = 20
"""The mean's slope compares today's ma200 with the one this many sessions ago."""
PEAK_WINDOW = 252
"""Sessions (about a year) of the peak the equity drawdown is measured from."""
SIX_MONTHS = 126
"""Sessions in about six months."""
TWELVE_MONTHS = 252
"""Sessions in about twelve months."""
THREE_MONTHS = 63
"""Sessions in about three months."""
HOLD_SESSIONS = 5
"""Consecutive sessions a new raw state must hold before the reported state switches."""
STALE_DAYS = 5
"""A regime is stale when its last bar is more than this many calendar days older than ``as_of``."""
HISTORY_MAX = 12
"""State runs kept in ``Regime.history`` (newest last)."""
TOLERANCE = 1e-9
"""Relative tolerance of threshold comparisons (floating point noise)."""

BEAR_DRAWDOWN = -0.20
"""Equity bear market: ACWI at least 20 % below its 252-session peak."""
CORRECTION_DRAWDOWN = -0.10
"""Equity correction: ACWI 10-20 % below its peak."""
DOLLAR_MOVE = 0.03
"""Dollar trend: DXY 6-month change beyond +/- 3 % (and on the same side of its ma200)."""
EM_RELATIVE = 0.05
"""EM vs the world: the EEM / ACWI ratio's 6-month change beyond +/- 5 %."""
COMMODITY_MOVE = 0.10
"""Commodity cycle: DBC 12-month change beyond +/- 10 % (and on the same side of its ma200)."""
RATES_MOVE = 0.40
"""Rates: the US 10-year yield moved at least 0.40 percentage points in 3 months."""

UNKNOWN = "unknown"
UNKNOWN_LABEL = "brak danych"
UNKNOWN_LABEL_EN = "no data"
INVERTED = "inverted"
INVERTED_SUFFIX = " · krzywa odwrócona"
INVERTED_SUFFIX_EN = " · inverted curve"
"""The inversion modifier (the frontend splits ``state_label`` on `` · `` and compares it)."""

LABELS: dict[str, str] = {
    "risk": "Rynek akcji",
    "dollar": "Dolar",
    "em": "Rynki wschodzące",
    "commodities": "Surowce",
    "rates": "Obligacje i stopy",
}
LABELS_EN: dict[str, str] = {
    "risk": "Stock market",
    "dollar": "Dollar",
    "em": "Emerging markets",
    "commodities": "Commodities",
    "rates": "Bonds and rates",
}

STATES: dict[str, dict[str, tuple[str, Tone]]] = {
    "risk": {
        "bear": ("bessa", "neg"),
        "correction": ("korekta", "warn"),
        "bull": ("hossa", "pos"),
        "weak": ("słabość", "warn"),
        "flat": ("bez trendu", ""),
    },
    "dollar": {
        "strong": ("umacnia się", ""),
        "weak": ("słabnie", ""),
        "flat": ("bez trendu", ""),
    },
    "em": {
        "leading": ("silniejsze od świata", "pos"),
        "lagging": ("słabsze od świata", "neg"),
        "inline": ("w linii", ""),
    },
    "commodities": {
        "bull": ("hossa surowcowa", "pos"),
        "bear": ("bessa surowcowa", "neg"),
        "flat": ("bez trendu", ""),
    },
    "rates": {
        "rising": ("rentowności rosną", "warn"),
        "falling": ("rentowności spadają", "pos"),
        "stable": ("rentowności stabilne", ""),
    },
}
"""Machine state -> (Polish label, tone) per regime. Tone colours the card; it describes, never
advises (the dollar has none: its direction is not good or bad per se)."""

STATES_EN: dict[str, dict[str, str]] = {
    "risk": {
        "bear": "bear market",
        "correction": "correction",
        "bull": "bull market",
        "weak": "weakness",
        "flat": "no trend",
    },
    "dollar": {"strong": "strengthening", "weak": "weakening", "flat": "no trend"},
    "em": {
        "leading": "stronger than the world",
        "lagging": "weaker than the world",
        "inline": "in line",
    },
    "commodities": {
        "bull": "commodity bull market",
        "bear": "commodity bear market",
        "flat": "no trend",
    },
    "rates": {"rising": "yields rising", "falling": "yields falling", "stable": "yields stable"},
}
"""English state labels (the frontend's ``macro.strings.ts`` uses the same words)."""

MEANINGS: dict[str, dict[str, str]] = {
    "risk": {
        "bull": "Globalne akcje są powyżej rosnącej średniej z 200 sesji: trwały trend wzrostowy "
        "zwykle sprzyja spółkom wzrostowym i rynkom ryzykowniejszym.",
        "weak": "Globalne akcje są poniżej średniej z 200 sesji: słabszy trend zwykle ciąży "
        "spółkom wzrostowym i rynkom ryzykowniejszym.",
        "correction": "Globalne akcje są 10-20 % poniżej szczytu z ostatniego roku: spadek wycen "
        "zwykle ciąży nastrojom inwestorów i rynkom ryzykowniejszym.",
        "bear": "Globalne akcje są co najmniej 20 % poniżej szczytu z ostatniego roku: bessa zwykle "
        "ciąży wszystkim aktywom ryzykownym i sprzyja bezpiecznym obligacjom.",
        "flat": "Globalne akcje są powyżej średniej z 200 sesji, ale ta średnia nie rośnie: rynek "
        "nie ma wyraźnego trendu.",
    },
    "dollar": {
        "strong": "Umacniający się dolar podnosi wartość aktywów w USD liczoną w złotych i zwykle "
        "ciąży rynkom wschodzącym oraz surowcom wycenianym w dolarach.",
        "weak": "Słabnący dolar obniża wartość aktywów w USD liczoną w złotych i zwykle sprzyja "
        "rynkom wschodzącym oraz surowcom wycenianym w dolarach.",
        "flat": "Indeks dolara nie ma wyraźnego trendu: ani półroczna zmiana, ani średnia z 200 "
        "sesji nie wskazują jednego kierunku.",
    },
    "em": {
        "leading": "Akcje rynków wschodzących radzą sobie od pół roku lepiej niż akcje globalne: "
        "taka przewaga zwykle idzie w parze ze słabszym dolarem i drożejącymi surowcami.",
        "lagging": "Akcje rynków wschodzących radzą sobie od pół roku gorzej niż akcje globalne: "
        "taka słabość zwykle idzie w parze z silnym dolarem i taniejącymi surowcami.",
        "inline": "Akcje rynków wschodzących radzą sobie od pół roku podobnie jak akcje globalne.",
    },
    "commodities": {
        "bull": "Szeroki koszyk surowców jest powyżej średniej z 200 sesji i ponad 10 % wyżej niż "
        "przed rokiem: drożejące surowce zwykle sprzyjają spółkom surowcowym i ciążą obligacjom "
        "przez presję inflacyjną.",
        "bear": "Szeroki koszyk surowców jest poniżej średniej z 200 sesji i ponad 10 % niżej niż "
        "przed rokiem: taniejące surowce zwykle ciążą spółkom surowcowym i górniczym.",
        "flat": "Szeroki koszyk surowców nie ma wyraźnego trendu: to ani hossa, ani bessa "
        "surowcowa.",
    },
    "rates": {
        "rising": "Wyższe rentowności podnoszą koszt pieniądza: zwykle ciążą wycenom spółek "
        "wzrostowych i cenom obligacji długoterminowych.",
        "falling": "Niższe rentowności obniżają koszt pieniądza: zwykle sprzyjają wycenom spółek "
        "wzrostowych i cenom obligacji długoterminowych.",
        "stable": "Rentowność 10-letnich obligacji USA zmieniła się w 3 miesiące o mniej niż "
        "0,40 pp: koszt pieniądza stoi w miejscu.",
    },
}
UNKNOWN_MEANING = "Za mało aktualnych notowań, by ustalić stan."
INVERTED_MEANING = (
    "Krzywa jest odwrócona: bony 3-miesięczne dają więcej niż obligacje 10-letnie, co zwykle ciąży "
    "marżom banków i akcji kredytowej."
)

MEANINGS_EN: dict[str, dict[str, str]] = {
    "risk": {
        "bull": "Global stocks are above a rising 200-session average: a lasting uptrend usually "
        "favors growth stocks and riskier markets.",
        "weak": "Global stocks are below their 200-session average: a weaker trend usually weighs on "
        "growth stocks and riskier markets.",
        "correction": "Global stocks are 10-20% below their peak of the last year: falling prices "
        "usually weigh on investor sentiment and riskier markets.",
        "bear": "Global stocks are at least 20% below their peak of the last year: a bear market "
        "usually weighs on all risky assets and favors safe bonds.",
        "flat": "Global stocks are above their 200-session average, but the average is not rising: "
        "the market has no clear trend.",
    },
    "dollar": {
        "strong": "A strengthening dollar raises the value of USD assets in zloty and usually weighs "
        "on emerging markets and dollar-priced commodities.",
        "weak": "A weakening dollar lowers the value of USD assets in zloty and usually favors "
        "emerging markets and dollar-priced commodities.",
        "flat": "The dollar index has no clear trend: neither the six-month change nor the "
        "200-session average points one way.",
    },
    "em": {
        "leading": "Emerging market stocks have done better than global stocks for half a year: "
        "such a lead usually goes with a weaker dollar and rising commodity prices.",
        "lagging": "Emerging market stocks have done worse than global stocks for half a year: such "
        "weakness usually goes with a strong dollar and falling commodity prices.",
        "inline": "Emerging market stocks have done about as well as global stocks for half a year.",
    },
    "commodities": {
        "bull": "A broad commodity basket is above its 200-session average and over 10% higher than "
        "a year ago: rising commodity prices usually favor commodity companies and weigh on bonds "
        "through inflation pressure.",
        "bear": "A broad commodity basket is below its 200-session average and over 10% lower than "
        "a year ago: falling commodity prices usually weigh on commodity and mining companies.",
        "flat": "A broad commodity basket has no clear trend: neither a commodity bull nor a bear "
        "market.",
    },
    "rates": {
        "rising": "Higher yields raise the cost of money: they usually weigh on growth stock "
        "valuations and long-term bond prices.",
        "falling": "Lower yields lower the cost of money: they usually favor growth stock valuations "
        "and long-term bond prices.",
        "stable": "The 10-year US Treasury yield moved less than 0.40 pp in 3 months: the cost of "
        "money is standing still.",
    },
}
UNKNOWN_MEANING_EN = "Too few current prices to determine the state."
INVERTED_MEANING_EN = (
    "The curve is inverted: 3-month bills yield more than 10-year bonds, which usually weighs on "
    "bank margins and lending."
)


# --------------------------------------------------------------------------- #
# Result types
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Metric:
    label: str
    value: float
    unit: MetricUnit
    """``pct``: a fraction (0.041 = 4,1 %); ``pp`` / ``bp``: percentage / basis points; ``level``: a
    quote as is (index points, a yield in percent)."""
    decimals: int = 1
    suffix: str = ""
    """Appended to a ``level`` (``" %"`` for a yield)."""
    stale: bool = False
    """The metric's own series ended more than :data:`STALE_DAYS` days before ``as_of``."""

    @property
    def text(self) -> str:
        return format_metric(self)


@dataclass(frozen=True)
class StateRun:
    date: dt.date
    """First session of the run (after hysteresis)."""
    state: str
    confirmed: dt.date | None = None
    """The session the switch became visible (the :data:`HOLD_SESSIONS`-th of the run); the first
    evaluated session for the first run."""
    open: bool = False
    """The first run: it began before the data, ``date`` is only the first evaluated session."""


@dataclass(frozen=True)
class Regime:
    key: str
    label: str
    state: str
    state_label: str
    tone: Tone
    since: dt.date | None
    """First session of the current state (after hysteresis); None when unknown or open-ended."""
    metrics: tuple[Metric, ...]
    as_of: dt.date | None
    """Last bar used; None without data."""
    stale: bool
    missing: bool
    meaning: str
    history: tuple[StateRun, ...] = ()
    """Every reported state run over the stored bars, oldest first (the API shows the last
    :data:`HISTORY_MAX`)."""
    flags: tuple[str, ...] = field(default=())
    """``inverted`` for an inverted yield curve (rates)."""
    since_open: bool = False
    """The current state held since the first evaluated session: its start is before the data."""
    since_min: dt.date | None = None
    """With ``since_open``: the first evaluated session (the state held at least since then)."""
    usdpln_1w: float | None = None
    """Dollar only: USD/PLN over the last 7 calendar days (rate on/before ``as_of - 7`` -> the newest
    on/before ``as_of``, a fraction); None without both rates or when the newest is stale."""


# --------------------------------------------------------------------------- #
# Formatting (pl-PL, en)
# --------------------------------------------------------------------------- #


def _number(value: float, decimals: int) -> str:
    text = f"{abs(value):,.{decimals}f}"
    if lang() == "en":
        return text
    return text.replace(",", " ").replace(".", ",")


def _signed(value: float, decimals: int) -> str:
    rounded = round(value, decimals)
    if rounded == 0:
        return _number(0.0, decimals)
    return ("+" if rounded > 0 else "-") + _number(rounded, decimals)


def format_metric(metric: Metric) -> str:
    """The text of a metric in the current language: ``+4,1 %``, ``-6,2 pp``, ``+45 bp``, ``98,4``,
    ``4,23 %`` (Polish: decimal comma) / ``+4.1%``, ``-6.2 pp``, ``4.23%`` (English); a sign on
    changes, never ``-0``."""
    percent = tr(pl=" %", en="%")
    if metric.unit == "pct":
        return f"{_signed(metric.value * 100, metric.decimals)}{percent}"
    if metric.unit == "pp":
        return f"{_signed(metric.value, metric.decimals)} pp"
    if metric.unit == "bp":
        return f"{_signed(metric.value, 0)} bp"
    value = round(metric.value, metric.decimals)
    sign = "-" if value < 0 else ""
    suffix = percent if metric.suffix == " %" else metric.suffix
    return f"{sign}{_number(value, metric.decimals)}{suffix}"


# --------------------------------------------------------------------------- #
# Series helpers
# --------------------------------------------------------------------------- #


def _cmp(a: float, b: float) -> int:
    """1 / 0 / -1 for a > b / a == b / a < b, within the relative :data:`TOLERANCE`."""
    tol = TOLERANCE * max(1.0, abs(a), abs(b))
    if a > b + tol:
        return 1
    if a < b - tol:
        return -1
    return 0


class _Line:
    """One date-sorted series of closes with O(1) moving means."""

    def __init__(self, dates: Sequence[dt.date], closes: Sequence[float]) -> None:
        self.dates = tuple(dates)
        self.closes = tuple(closes)
        sums = [0.0]
        for c in self.closes:
            sums.append(sums[-1] + c)
        self._sums = sums

    def __len__(self) -> int:
        return len(self.closes)

    @property
    def last(self) -> int:
        return len(self.closes) - 1

    def ma(self, i: int, n: int = MA_WINDOW) -> float:
        return (self._sums[i + 1] - self._sums[i + 1 - n]) / n

    def chg(self, i: int, n: int) -> float:
        return self.closes[i] / self.closes[i - n] - 1

    def diff(self, i: int, n: int) -> float:
        return self.closes[i] - self.closes[i - n]

    def peak(self, i: int, n: int = PEAK_WINDOW) -> float:
        return max(self.closes[i + 1 - n : i + 1])

    def drawdown(self, i: int) -> float:
        return self.closes[i] / self.peak(i) - 1


def _clean(
    points: Sequence[tuple[dt.date, float]] | None, as_of: dt.date, *, positive: bool
) -> dict[dt.date, float]:
    out: dict[dt.date, float] = {}
    for day, value in points or ():
        if day > as_of:
            continue
        v = float(value)
        if not math.isfinite(v) or (positive and v <= 0):
            continue
        out[day] = v
    return out


def _line(points: dict[dt.date, float]) -> _Line:
    days = sorted(points)
    return _Line(days, [points[d] for d in days])


def _joined(a: dict[dt.date, float], b: dict[dt.date, float]) -> tuple[list[dt.date], list, list]:
    days = sorted(set(a) & set(b))
    return days, [a[d] for d in days], [b[d] for d in days]


def _runs(raw: Sequence[str], dates: Sequence[dt.date]) -> list[StateRun]:
    """Hysteresis over raw states (see the module doc): the reported runs, oldest first."""
    if not raw:
        return []
    reported = raw[0]
    runs = [StateRun(dates[0], reported, confirmed=dates[0], open=True)]
    candidate: str | None = None
    start = 0
    held = 0
    for j in range(1, len(raw)):
        r = raw[j]
        if r == reported:
            candidate, held = None, 0
            continue
        if r == candidate:
            held += 1
        else:
            candidate, start, held = r, j, 1
        if held >= HOLD_SESSIONS:
            reported = r
            runs.append(StateRun(dates[start], r, confirmed=dates[j]))
            candidate, held = None, 0
    return runs


def _stale(last: dt.date | None, as_of: dt.date) -> bool:
    return last is None or (as_of - last).days > STALE_DAYS


def _missing(key: str, last: dt.date | None, as_of: dt.date) -> Regime:
    return Regime(
        key=key,
        label=LABELS[key],
        state=UNKNOWN,
        state_label=UNKNOWN_LABEL,
        tone="",
        since=None,
        metrics=(),
        as_of=last,
        stale=_stale(last, as_of),
        missing=True,
        meaning=UNKNOWN_MEANING,
    )


def _regime(
    key: str,
    line: _Line,
    as_of: dt.date,
    raw: Callable[[int], str],
    metrics: Callable[[int, bool], list[Metric]],
) -> Regime:
    last = line.dates[-1] if len(line) else None
    if len(line) < MIN_BARS:
        return _missing(key, last, as_of)
    first = MIN_BARS - 1
    states = [raw(i) for i in range(first, len(line))]
    runs = _runs(states, line.dates[first:])
    current = runs[-1]
    label, tone = STATES[key][current.state]
    stale = _stale(last, as_of)
    return Regime(
        key=key,
        label=LABELS[key],
        state=current.state,
        state_label=label,
        tone=tone,
        since=None if current.open else current.date,
        metrics=tuple(metrics(line.last, stale)),
        as_of=last,
        stale=stale,
        missing=False,
        meaning=MEANINGS[key][current.state],
        history=tuple(runs),
        since_open=current.open,
        since_min=current.date if current.open else None,
    )


# --------------------------------------------------------------------------- #
# The five regimes
# --------------------------------------------------------------------------- #


def _risk(acwi: dict, spx: dict, as_of: dt.date) -> Regime:
    line = _line(acwi)
    spx_line = _line(spx)

    def raw(i: int) -> str:
        c, ma = line.closes[i], line.ma(i)
        dd = line.drawdown(i)
        if _cmp(dd, BEAR_DRAWDOWN) <= 0:
            return "bear"
        if _cmp(dd, CORRECTION_DRAWDOWN) <= 0:
            return "correction"
        if _cmp(c, ma) > 0 and _cmp(ma, line.ma(i - SLOPE_LAG)) > 0:
            return "bull"
        if _cmp(c, ma) < 0:
            return "weak"
        return "flat"

    def metrics(i: int, stale: bool) -> list[Metric]:
        out = [
            Metric("ACWI wobec 200 sesji", line.closes[i] / line.ma(i) - 1, "pct", stale=stale),
            Metric("od szczytu", line.drawdown(i), "pct", stale=stale),
        ]
        if len(spx_line) >= PEAK_WINDOW:
            out.append(
                Metric(
                    "S&P 500 od szczytu",
                    spx_line.drawdown(spx_line.last),
                    "pct",
                    stale=_stale(spx_line.dates[-1], as_of),
                )
            )
        return out

    return _regime("risk", line, as_of, raw, metrics)


def _dollar(dxy: dict, usdpln: dict, as_of: dt.date) -> Regime:
    line = _line(dxy)
    pln = _line(usdpln)

    def raw(i: int) -> str:
        c, ma, c6 = line.closes[i], line.ma(i), line.chg(i, SIX_MONTHS)
        if _cmp(c, ma) > 0 and _cmp(c6, DOLLAR_MOVE) > 0:
            return "strong"
        if _cmp(c, ma) < 0 and _cmp(c6, -DOLLAR_MOVE) < 0:
            return "weak"
        return "flat"

    def metrics(i: int, stale: bool) -> list[Metric]:
        out = [
            Metric("DXY", line.closes[i], "level", stale=stale),
            Metric("6 mies.", line.chg(i, SIX_MONTHS), "pct", stale=stale),
        ]
        if len(pln) > SIX_MONTHS:
            out.append(
                Metric(
                    "USD/PLN 6 mies.",
                    pln.chg(pln.last, SIX_MONTHS),
                    "pct",
                    stale=_stale(pln.dates[-1], as_of),
                )
            )
        return out

    return replace(_regime("dollar", line, as_of, raw, metrics), usdpln_1w=week_change(pln, as_of))


WEEK_DAYS = 7


def week_change(line: _Line, as_of: dt.date) -> float | None:
    """Close on/before ``as_of - 7`` -> the newest close on/before ``as_of``; None when either is
    missing, the newest is stale or both are the same day."""
    if not len(line) or _stale(line.dates[-1], as_of):
        return None
    start = as_of - dt.timedelta(days=WEEK_DAYS)
    j = bisect_right(line.dates, start) - 1
    if j < 0 or line.dates[j] >= line.dates[-1] or line.closes[j] <= 0:
        return None
    return line.closes[-1] / line.closes[j] - 1


def _em(eem: dict, acwi: dict, as_of: dt.date) -> Regime:
    days, e, a = _joined(eem, acwi)
    ratio = _Line(days, [x / y for x, y in zip(e, a, strict=True)])
    eem_line = _Line(days, e)

    def raw(i: int) -> str:
        r6 = ratio.chg(i, SIX_MONTHS)
        if _cmp(r6, EM_RELATIVE) > 0:
            return "leading"
        if _cmp(r6, -EM_RELATIVE) < 0:
            return "lagging"
        return "inline"

    def metrics(i: int, stale: bool) -> list[Metric]:
        return [
            Metric("EEM wobec ACWI 6 mies.", ratio.chg(i, SIX_MONTHS) * 100, "pp", stale=stale),
            Metric("EEM 6 mies.", eem_line.chg(i, SIX_MONTHS), "pct", stale=stale),
        ]

    return _regime("em", ratio, as_of, raw, metrics)


def _commodities(dbc: dict, acwi: dict, as_of: dt.date) -> Regime:
    line = _line(dbc)
    days, d, a = _joined(dbc, acwi)
    ratio = _Line(days, [x / y for x, y in zip(d, a, strict=True)])

    def raw(i: int) -> str:
        c, ma, c12 = line.closes[i], line.ma(i), line.chg(i, TWELVE_MONTHS)
        if _cmp(c, ma) > 0 and _cmp(c12, COMMODITY_MOVE) > 0:
            return "bull"
        if _cmp(c, ma) < 0 and _cmp(c12, -COMMODITY_MOVE) < 0:
            return "bear"
        return "flat"

    def metrics(i: int, stale: bool) -> list[Metric]:
        out = [Metric("DBC 12 mies.", line.chg(i, TWELVE_MONTHS), "pct", stale=stale)]
        if len(ratio) > TWELVE_MONTHS:
            out.append(
                Metric(
                    "wobec ACWI 12 mies.",
                    ratio.chg(ratio.last, TWELVE_MONTHS) * 100,
                    "pp",
                    stale=_stale(ratio.dates[-1], as_of),
                )
            )
        return out

    return _regime("commodities", line, as_of, raw, metrics)


def bond_equivalent(discount: float) -> float:
    """A 13-week bill's discount yield (``^IRX``, percent) as a bond-equivalent yield (percent):
    ``BEY = 365 * d / (360 - 91 * d)`` with ``d`` as a decimal (91-day bill), so it compares with the
    10-year Treasury yield (``^TNX``, bond-equivalent)."""
    d = discount / 100
    return 100 * 365 * d / (360 - 91 * d)


def _rates(us10y: dict, us3m: dict, as_of: dt.date) -> Regime:
    line = _line(us10y)
    days, long_, short = _joined(us10y, us3m)
    curve = [x - bond_equivalent(y) for x, y in zip(long_, short, strict=True)]
    curve_stale = not days or _stale(days[-1], as_of)

    def raw(i: int) -> str:
        d3 = line.diff(i, THREE_MONTHS)
        if _cmp(d3, RATES_MOVE) >= 0:
            return "rising"
        if _cmp(d3, -RATES_MOVE) <= 0:
            return "falling"
        return "stable"

    def metrics(i: int, stale: bool) -> list[Metric]:
        out = [
            Metric("USA 10 lat", line.closes[i], "level", decimals=2, suffix=" %", stale=stale),
            Metric(
                "3 mies. zmiana", line.diff(i, THREE_MONTHS) * 100, "bp", decimals=0, stale=stale
            ),
        ]
        if curve:
            out.append(
                Metric("krzywa 10l-3m", curve[-1] * 100, "bp", decimals=0, stale=curve_stale)
            )
        return out

    regime = _regime("rates", line, as_of, raw, metrics)
    if regime.missing or not curve or curve_stale:
        return regime
    flag_runs = _runs(["1" if _cmp(c, 0.0) < 0 else "0" for c in curve], days)
    if flag_runs[-1].state != "1":
        return regime
    return replace(
        regime,
        state_label=regime.state_label + INVERTED_SUFFIX,
        tone="warn",
        meaning=f"{regime.meaning} {INVERTED_MEANING}",
        flags=(INVERTED,),
    )


def evaluate(
    closes: Mapping[str, Sequence[tuple[dt.date, float]]], as_of: dt.date
) -> tuple[Regime, ...]:
    """The five regimes as of ``as_of`` from the closes per series key (see the module doc), in
    :data:`ORDER`."""

    def get(key: str, *, positive: bool = True) -> dict[dt.date, float]:
        return _clean(closes.get(key), as_of, positive=positive)

    acwi = get("acwi")
    return (
        _risk(acwi, get("spx"), as_of),
        _dollar(get("dxy"), get(USDPLN), as_of),
        _em(get("eem"), acwi, as_of),
        _commodities(get("dbc"), acwi, as_of),
        _rates(get("us10y", positive=False), get("us3m", positive=False), as_of),
    )


METRIC_LABELS: frozenset[str] = frozenset(
    {
        "ACWI wobec 200 sesji",
        "od szczytu",
        "S&P 500 od szczytu",
        "DXY",
        "6 mies.",
        "USD/PLN 6 mies.",
        "EEM wobec ACWI 6 mies.",
        "EEM 6 mies.",
        "DBC 12 mies.",
        "wobec ACWI 12 mies.",
        "USA 10 lat",
        "3 mies. zmiana",
        "krzywa 10l-3m",
    }
)
"""Every metric label the regimes produce (the MCP ``market`` label allows exactly these)."""

METRIC_LABELS_EN: dict[str, str] = {
    "ACWI wobec 200 sesji": "ACWI vs 200 sessions",
    "od szczytu": "from the peak",
    "S&P 500 od szczytu": "S&P 500 from the peak",
    "DXY": "DXY",
    "6 mies.": "6 mo.",
    "USD/PLN 6 mies.": "USD/PLN 6 mo.",
    "EEM wobec ACWI 6 mies.": "EEM vs ACWI 6 mo.",
    "EEM 6 mies.": "EEM 6 mo.",
    "DBC 12 mies.": "DBC 12 mo.",
    "wobec ACWI 12 mies.": "vs ACWI 12 mo.",
    "USA 10 lat": "US 10-year",
    "3 mies. zmiana": "3 mo. change",
    "krzywa 10l-3m": "curve 10y-3m",
}
"""English display labels of :data:`METRIC_LABELS` (the Polish label stays the metric's identity)."""


def state_label(key: str, state: str) -> str:
    """The label of a machine state in the current language (``brak danych`` / ``no data`` for
    unknown)."""
    if lang() == "en":
        return STATES_EN.get(key, {}).get(state, UNKNOWN_LABEL_EN)
    found = STATES.get(key, {}).get(state)
    return found[0] if found is not None else UNKNOWN_LABEL


def display_label(key: str) -> str:
    """The regime card's label in the current language."""
    return tr(pl=LABELS, en=LABELS_EN)[key]


def display_state_label(regime: Regime) -> str:
    """The regime's ``state_label`` in the current language (with the inversion suffix)."""
    text = state_label(regime.key, regime.state)
    if INVERTED in regime.flags:
        text += tr(pl=INVERTED_SUFFIX, en=INVERTED_SUFFIX_EN)
    return text


def display_meaning(regime: Regime) -> str:
    """The regime's ``meaning`` in the current language (with the inverted-curve note)."""
    if lang() != "en":
        return regime.meaning
    if regime.missing or regime.state == UNKNOWN:
        return UNKNOWN_MEANING_EN
    text = MEANINGS_EN[regime.key][regime.state]
    return f"{text} {INVERTED_MEANING_EN}" if INVERTED in regime.flags else text


def metric_label(metric: Metric) -> str:
    """A metric's label in the current language."""
    if lang() == "en":
        return METRIC_LABELS_EN.get(metric.label, metric.label)
    return metric.label
