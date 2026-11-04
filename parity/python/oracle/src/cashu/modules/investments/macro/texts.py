"""Human texts of the macro regime cards (P7). Pure (no IO).

- :func:`summary`: one or two short Polish sentences built deterministically from the state, ``since``
  and the metrics, in plain words (at most :data:`SUMMARY_MAX` characters: a card's secondary detail
  gives way first, then the ``since`` phrase, which the card also shows next to its title); the dollar
  card may fold in the portfolio's currency effect of the week (:class:`CurrencyEffect`).
- :func:`explain`: the full hover text: what the cycle / indicator is (static), how the app measures it
  (the rule in plain words), then the current state and its ``meaning``.

Register: present facts, past facts and "zwykle" (what usually went together); never a statement about
a future price. :func:`summary_ok` tells whether a text could have come from :func:`summary` (only its
vocabulary plus numbers): the MCP layer lets nothing else through as public market text.

Language: every text is rendered in the current UI language (``core.i18n``); the English variants sit
next to the Polish ones (``*_EN``). The MCP renders Polish, and :func:`vocabulary` is always the Polish
one, so :func:`summary_ok` accepts Polish summaries only (an English text fails closed).
"""

from __future__ import annotations

import datetime as dt
import functools
import itertools
import re
from dataclasses import dataclass, replace

from cashu.core.i18n import lang, tr, use_language

from . import regimes as rg

SUMMARY_MAX = 140
"""Maximum length of a summary (the dollar card drops its half-year detail, the rates card its
3-month change, then any card its ``since`` phrase to stay within it)."""

MONTHS_GENITIVE: tuple[str, ...] = (
    "stycznia",
    "lutego",
    "marca",
    "kwietnia",
    "maja",
    "czerwca",
    "lipca",
    "sierpnia",
    "września",
    "października",
    "listopada",
    "grudnia",
)

MONTHS_EN: tuple[str, ...] = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)

UNKNOWN_SUMMARY = "Za mało aktualnych notowań, by opisać ten rynek."
UNKNOWN_SUMMARY_EN = "Too few current prices to describe this market."


@dataclass(frozen=True)
class CurrencyEffect:
    """The portfolio's currency effect over the last week (the 1w segment attribution)."""

    contribution: float
    """Fraction of the portfolio's value (0.006 = 0,6 pp)."""
    foreign: bool
    """The portfolio held foreign-currency assets at the start of the week."""


# --------------------------------------------------------------------------- #
# Formatting
# --------------------------------------------------------------------------- #


def _pct_decimals(value: float) -> int:
    return 0 if abs(value) * 100 >= 10 else 1


def pct(value: float, *, signed: bool = True) -> str:
    """A fraction as Polish percent: ``+4,1 %`` / ``-12 %`` (no decimals from 10 % up); unsigned:
    ``4,1 %``. English: ``+4.1%``."""
    decimals = _pct_decimals(value)
    text = rg._signed(value * 100, decimals) if signed else rg._number(value * 100, decimals)
    return f"{text}{tr(pl=' %', en='%')}"


def pp(value: float, decimals: int = 1) -> str:
    """Percentage points without a sign: ``0,6 pp`` (``0.6 pp``)."""
    return f"{rg._number(value, decimals)} pp"


def month(day: dt.date) -> str:
    """``maja 2025`` (genitive, after ``od``); ``May 2025`` in English."""
    return f"{tr(pl=MONTHS_GENITIVE, en=MONTHS_EN)[day.month - 1]} {day.year}"


def since_phrase(regime: rg.Regime) -> str:
    """``od maja 2025``; ``co najmniej od października 2021`` for an open-ended state; empty when
    unknown. English: ``since May 2025``, ``since at least October 2021``."""
    if regime.since is not None:
        return tr(pl=f"od {month(regime.since)}", en=f"since {month(regime.since)}")
    if regime.since_open and regime.since_min is not None:
        return tr(
            pl=f"co najmniej od {month(regime.since_min)}",
            en=f"since at least {month(regime.since_min)}",
        )
    return ""


def _metric(regime: rg.Regime, label: str) -> float | None:
    found = next((m for m in regime.metrics if m.label == label), None)
    return None if found is None else found.value


def _sentence(head: str, since: str, detail: str = "") -> str:
    text = head + (f" {since}" if since else "")
    return text + (f": {detail}" if detail else "") + "."


def _versus(diff_pp: float | None, other: str) -> str:
    """``o 6,2 pp więcej niż akcje globalne`` (``tyle samo co`` when it rounds to 0)."""
    if diff_pp is None:
        return ""
    if lang() == "en":
        if round(diff_pp, 1) == 0:
            return f"the same as {other}"
        return f"{pp(abs(diff_pp))} {'more' if diff_pp > 0 else 'less'} than {other}"
    if round(diff_pp, 1) == 0:
        return f"tyle samo co {other}"
    word = "więcej" if diff_pp > 0 else "mniej"
    return f"o {pp(abs(diff_pp))} {word} niż {other}"


def _join(*parts: str) -> str:
    return ", ".join(p for p in parts if p)


# --------------------------------------------------------------------------- #
# Summaries
# --------------------------------------------------------------------------- #

_RISK_HEAD = {
    "bull": "Akcje na świecie rosną",
    "flat": "Akcje na świecie bez wyraźnego trendu",
    "weak": "Akcje na świecie słabną",
    "correction": "Akcje na świecie w korekcie",
    "bear": "Akcje na świecie w bessie",
}
_DOLLAR_HEAD = {
    "strong": "Dolar umacnia się",
    "weak": "Dolar słabnie",
    "flat": "Dolar bez wyraźnego trendu",
}
_EM_HEAD = {
    "leading": "Rynki wschodzące radzą sobie lepiej niż świat",
    "lagging": "Rynki wschodzące radzą sobie gorzej niż świat",
    "inline": "Rynki wschodzące idą podobnie jak świat",
}
_COMMODITIES_HEAD = {
    "bull": "Surowce drożeją",
    "bear": "Surowce tanieją",
    "flat": "Surowce bez wyraźnego trendu",
}
_RATES_HEAD = {
    "rising": "Rentowności obligacji USA rosną",
    "falling": "Rentowności obligacji USA spadają",
    "stable": "Rentowności obligacji USA stabilne",
}
INVERTED_SENTENCE = "Krzywa odwrócona: bony 3-miesięczne dają więcej niż 10-letnie."

_HEAD_EN = {
    "risk": {
        "bull": "Global stocks rising",
        "flat": "Global stocks without a clear trend",
        "weak": "Global stocks weakening",
        "correction": "Global stocks in a correction",
        "bear": "Global stocks in a bear market",
    },
    "dollar": {
        "strong": "Dollar strengthening",
        "weak": "Dollar weakening",
        "flat": "Dollar without a clear trend",
    },
    "em": {
        "leading": "Emerging markets doing better than the world",
        "lagging": "Emerging markets doing worse than the world",
        "inline": "Emerging markets moving in line with the world",
    },
    "commodities": {
        "bull": "Commodity prices rising",
        "bear": "Commodity prices falling",
        "flat": "Commodities without a clear trend",
    },
    "rates": {
        "rising": "US bond yields rising",
        "falling": "US bond yields falling",
        "stable": "US bond yields stable",
    },
}
"""English summary heads per regime and state."""
INVERTED_SENTENCE_EN = "Inverted curve: 3-month bills yield more than 10-year bonds."


def _risk(regime: rg.Regime, since: str) -> str:
    if lang() == "en":
        return _risk_en(regime, since)
    dd = _metric(regime, "od szczytu")
    if dd is None:
        peak = ""
    elif round(dd * 100, _pct_decimals(dd)) == 0:
        peak = "na rocznym szczycie"
    else:
        peak = f"{pct(dd, signed=False)} pod rocznym szczytem"
    if regime.state == "weak":
        detail = "są pod średnią z 200 sesji" + (f" i {peak}" if peak else "")
    else:
        detail = f"są {peak}" if peak else ""
    return _sentence(_RISK_HEAD[regime.state], since, detail)


def _risk_en(regime: rg.Regime, since: str) -> str:
    dd = _metric(regime, "od szczytu")
    if dd is None:
        peak = ""
    elif round(dd * 100, _pct_decimals(dd)) == 0:
        peak = "at the yearly peak"
    else:
        peak = f"{pct(dd, signed=False)} below the yearly peak"
    if regime.state == "weak":
        detail = "below the 200-session average" + (f" and {peak}" if peak else "")
    else:
        detail = peak
    return _sentence(_HEAD_EN["risk"][regime.state], since, detail)


def _week(regime: rg.Regime, currency: CurrencyEffect | None) -> str:
    if lang() == "en":
        return _week_en(regime, currency)
    move = regime.usdpln_1w
    effect = ""
    if currency is not None and currency.foreign:
        value = currency.contribution * 100
        if round(value, 1) == 0:
            effect = "kursy walut prawie nie zmieniły wyniku portfela"
        elif value > 0:
            effect = f"kursy walut dodały portfelowi {pp(value)}"
        else:
            effect = f"kursy walut odjęły portfelowi {pp(abs(value))}"
    if move is None and not effect:
        return ""
    if move is None:
        return f"W tym tygodniu {effect}."
    if not effect:
        return f"W tym tygodniu USD/PLN {pct(move)}."
    return f"W tym tygodniu USD/PLN {pct(move)}, a {effect}."


def _week_en(regime: rg.Regime, currency: CurrencyEffect | None) -> str:
    move = regime.usdpln_1w
    effect = ""
    if currency is not None and currency.foreign:
        value = currency.contribution * 100
        if round(value, 1) == 0:
            effect = "currency moves barely changed the portfolio's result"
        elif value > 0:
            effect = f"currency moves added {pp(value)} to the portfolio"
        else:
            effect = f"currency moves took {pp(abs(value))} off the portfolio"
    if move is None and not effect:
        return ""
    if move is None:
        return f"This week {effect}."
    if not effect:
        return f"This week USD/PLN {pct(move)}."
    return f"This week USD/PLN {pct(move)}, and {effect}."


def _dollar(regime: rg.Regime, since: str, currency: CurrencyEffect | None) -> str:
    head = tr(pl=_DOLLAR_HEAD, en=_HEAD_EN["dollar"])[regime.state]
    six = _metric(regime, "6 mies.")
    detail = (
        ""
        if six is None
        else tr(pl=f"indeks dolara {pct(six)} w pół roku", en=f"dollar index {pct(six)} in six months")
    )
    week = _week(regime, currency)
    full = " ".join(p for p in (_sentence(head, since, detail), week) if p)
    if len(full) <= SUMMARY_MAX or not week:
        return full
    return f"{_sentence(head, since)} {week}"


def _em(regime: rg.Regime, since: str) -> str:
    eem = _metric(regime, "EEM 6 mies.")
    diff = _metric(regime, "EEM wobec ACWI 6 mies.")
    if lang() == "en":
        detail = _join(
            "" if eem is None else f"{pct(eem)} in six months", _versus(diff, "global stocks")
        )
        return _sentence(_HEAD_EN["em"][regime.state], since, detail)
    detail = _join("" if eem is None else f"w pół roku {pct(eem)}", _versus(diff, "akcje globalne"))
    return _sentence(_EM_HEAD[regime.state], since, detail)


def _commodities(regime: rg.Regime, since: str) -> str:
    year = _metric(regime, "DBC 12 mies.")
    diff = _metric(regime, "wobec ACWI 12 mies.")
    if lang() == "en":
        detail = _join("" if year is None else f"{pct(year)} in a year", _versus(diff, "global stocks"))
        return _sentence(_HEAD_EN["commodities"][regime.state], since, detail)
    detail = _join("" if year is None else f"{pct(year)} w rok", _versus(diff, "akcje na świecie"))
    return _sentence(_COMMODITIES_HEAD[regime.state], since, detail)


def _rates(regime: rg.Regime, since: str) -> str:
    level = _metric(regime, "USA 10 lat")
    change = _metric(regime, "3 mies. zmiana")
    if lang() == "en":
        level_text = "" if level is None else f"10-year {rg._number(level, 2)}%"
        change_text = "" if change is None else f"{rg._signed(change / 100, 2)} pp in 3 months"
        head = _HEAD_EN["rates"][regime.state]
        inverted = INVERTED_SENTENCE_EN
    else:
        level_text = "" if level is None else f"10-letnie {rg._number(level, 2)} %"
        change_text = "" if change is None else f"{rg._signed(change / 100, 2)} pp w 3 miesiące"
        head = _RATES_HEAD[regime.state]
        inverted = INVERTED_SENTENCE
    text = _sentence(head, since, _join(level_text, change_text))
    if rg.INVERTED in regime.flags:
        text = f"{text} {inverted}"
        if len(text) > SUMMARY_MAX:  # the 3-month change gives way to the curve
            text = f"{_sentence(head, since, level_text)} {inverted}"
    return text


def summary(regime: rg.Regime, currency: CurrencyEffect | None = None) -> str:
    """The card's short text (module doc). ``currency``: the portfolio's currency effect of the week,
    folded into the dollar card only."""
    if regime.missing or regime.state == rg.UNKNOWN:
        return tr(pl=UNKNOWN_SUMMARY, en=UNKNOWN_SUMMARY_EN)
    since = since_phrase(regime)
    text = _summary(regime, since, currency)
    if len(text) > SUMMARY_MAX and since:
        # a long ``since`` (``co najmniej od października 2025``) gives way first: the card shows the
        # state's start next to its title anyway, and an open-ended state never reads as a known start
        text = _summary(regime, "", currency)
    return text


def _summary(regime: rg.Regime, since: str, currency: CurrencyEffect | None) -> str:
    if regime.key == "risk":
        return _risk(regime, since)
    if regime.key == "dollar":
        return _dollar(regime, since, currency)
    if regime.key == "em":
        return _em(regime, since)
    if regime.key == "commodities":
        return _commodities(regime, since)
    return _rates(regime, since)


# --------------------------------------------------------------------------- #
# Explanations
# --------------------------------------------------------------------------- #

INTRO: dict[str, str] = {
    "risk": "Rynek akcji przechodzi cykle: hossę (długie okresy wzrostów), korekty (spadki o 10-20 %) "
    "i bessy (spadki o co najmniej 20 % od szczytu). Hossy trwały zwykle kilka lat, bessy zwykle "
    "od kilku miesięcy do około półtora roku.",
    "dollar": "Dolar przez lata na przemian umacniał się i słabł wobec innych walut, a jedna taka faza "
    "trwała zwykle kilka lat. To główna waluta handlu i surowców, więc jego kurs zwykle szedł w parze "
    "z cenami surowców, wynikami rynków wschodzących i wartością zagranicznych aktywów w złotych.",
    "em": "Rynki wschodzące to akcje krajów rozwijających się, m.in. Chin, Indii, Tajwanu i Brazylii. "
    "Na przemian wyprzedzały rynki rozwinięte i zostawały za nimi, a takie okresy trwały zwykle kilka "
    "lat.",
    "commodities": "Surowce (ropa, gaz, metale, płody rolne) mają własne, wieloletnie cykle drożenia i "
    "tanienia. Długą falę wzrostów nazywa się supercyklem: ostatni przypadł na pierwszą dekadę XXI "
    "wieku, gdy szybko rósł popyt z Chin.",
    "rates": "Rentowność obligacji to roczny zysk z pożyczenia pieniędzy państwu; rentowność "
    "10-letnich obligacji USA jest punktem odniesienia dla kosztu pieniądza na świecie. Krzywa "
    "rentowności porównuje obligacje długie z krótkimi: zwykle długie dają więcej, a gdy krótkie "
    "dawały więcej (krzywa odwrócona), w przeszłości często wyprzedzało to recesję w USA, choć nie "
    "zawsze.",
}
"""What the cycle / indicator is (static, educational)."""

RULE: dict[str, str] = {
    "risk": "Aplikacja patrzy na globalny ETF akcji ACWI: hossa, gdy kurs jest nad rosnącą średnią z "
    "200 sesji; korekta przy spadku o 10-20 % od szczytu z ostatniego roku, bessa przy spadku o 20 % "
    "lub więcej.",
    "dollar": "Aplikacja patrzy na indeks dolara DXY (dolar wobec koszyka głównych walut): umacnia się, "
    "gdy indeks jest nad średnią z 200 sesji i zyskał w pół roku ponad 3 %; słabnie przy odwrotnym "
    "układzie.",
    "em": "Aplikacja porównuje ETF rynków wschodzących EEM z globalnym ETF akcji ACWI: gdy EEM wypadł w "
    "pół roku o ponad 5 % lepiej, rynki wschodzące są silniejsze od świata, gdy o ponad 5 % gorzej, "
    "słabsze.",
    "commodities": "Aplikacja patrzy na szeroki koszyk surowców, ETF DBC: hossa surowcowa, gdy kurs jest "
    "nad średnią z 200 sesji i ponad 10 % wyżej niż przed rokiem; bessa surowcowa przy odwrotnym "
    "układzie.",
    "rates": "Aplikacja patrzy na zmianę rentowności 10-letnich obligacji USA w 3 miesiące: zmiana o co "
    "najmniej 0,40 pp w górę to rosnące rentowności, w dół spadające; krzywą liczy jako różnicę "
    "między obligacjami 10-letnimi a bonami 3-miesięcznymi.",
}
"""How the app measures it (the rule in plain words)."""

INTRO_EN: dict[str, str] = {
    "risk": "The stock market goes through cycles: bull markets (long periods of gains), corrections "
    "(drops of 10-20%) and bear markets (drops of at least 20% from the peak). Bull markets usually "
    "lasted several years, bear markets usually from a few months to about a year and a half.",
    "dollar": "Over the years the dollar has alternately strengthened and weakened against other "
    "currencies, and one such phase usually lasted several years. It is the main currency of trade and "
    "commodities, so its exchange rate usually went together with commodity prices, emerging market "
    "results and the value of foreign assets in zloty.",
    "em": "Emerging markets are stocks of developing countries, including China, India, Taiwan and "
    "Brazil. They have alternately led and lagged developed markets, and such periods usually lasted "
    "several years.",
    "commodities": "Commodities (oil, gas, metals, crops) have their own multi-year cycles of rising "
    "and falling prices. A long wave of gains is called a supercycle: the last one came in the first "
    "decade of the 21st century, when demand from China grew fast.",
    "rates": "A bond yield is the yearly return on lending money to a government; the 10-year US "
    "Treasury yield is the benchmark for the cost of money worldwide. The yield curve compares long "
    "bonds with short ones: long ones usually yield more, and when short ones yielded more (an "
    "inverted curve), it often came before a US recession in the past, though not always.",
}
"""English :data:`INTRO`."""

RULE_EN: dict[str, str] = {
    "risk": "The app looks at the global stock ETF ACWI: a bull market when the price is above a "
    "rising 200-session average; a correction on a drop of 10-20% from the peak of the last year, a "
    "bear market on a drop of 20% or more.",
    "dollar": "The app looks at the dollar index DXY (the dollar against a basket of major "
    "currencies): strengthening when the index is above its 200-session average and gained over 3% "
    "in six months; weakening in the opposite case.",
    "em": "The app compares the emerging markets ETF EEM with the global stock ETF ACWI: when EEM did "
    "over 5% better in six months, emerging markets are stronger than the world, when over 5% worse, "
    "weaker.",
    "commodities": "The app looks at a broad commodity basket, the ETF DBC: a commodity bull market "
    "when the price is above its 200-session average and over 10% higher than a year ago; a commodity "
    "bear market in the opposite case.",
    "rates": "The app looks at the 3-month change of the 10-year US Treasury yield: a move of at "
    "least 0.40 pp up means rising yields, down falling ones; it measures the curve as the difference "
    "between 10-year bonds and 3-month bills.",
}
"""English :data:`RULE`."""


# --------------------------------------------------------------------------- #
# Plain sentences (P9)
# --------------------------------------------------------------------------- #

PLAIN: dict[str, dict[str, str]] = {
    "risk": {
        "bull": "Trwa hossa: akcje na świecie od dłuższego czasu drożeją.",
        "flat": "Akcje na świecie stoją w miejscu, bez wyraźnego kierunku.",
        "weak": "Akcje na świecie tracą siłę: ceny są niżej niż przez ostatnie miesiące.",
        "correction": "Akcje są w korekcie: spadły o 10-20 % od szczytu.",
        "bear": "Trwa bessa: akcje spadły o ponad 20 % od szczytu.",
    },
    "dollar": {
        "strong": "Dolar się umacnia.",
        "weak": "Dolar słabnie.",
        "flat": "Kurs dolara stoi w miejscu.",
    },
    "em": {
        "leading": "Akcje krajów rozwijających się radzą sobie lepiej niż reszta świata.",
        "lagging": "Akcje krajów rozwijających się radzą sobie gorzej niż reszta świata.",
        "inline": "Akcje krajów rozwijających się idą podobnie jak reszta świata.",
    },
    "commodities": {
        "bull": "Surowce drożeją: koszyk ropy, metali i płodów rolnych jest wyraźnie droższy.",
        "bear": "Surowce tanieją: koszyk ropy, metali i płodów rolnych jest wyraźnie tańszy.",
        "flat": "Ceny surowców stoją w miejscu.",
    },
    "rates": {
        "rising": "Oprocentowanie obligacji w USA rośnie, więc pożyczanie pieniędzy drożeje.",
        "falling": "Oprocentowanie obligacji w USA spada, więc pożyczanie pieniędzy tanieje.",
        "stable": "Oprocentowanie obligacji w USA stoi w miejscu.",
    },
}
"""One beginner sentence per regime state (P9): the card shows it until a research brief exists."""
PLAIN_INVERTED = "Krótkie obligacje płacą więcej niż długie, co w przeszłości często było sygnałem ostrzegawczym."
PLAIN_UNKNOWN = "Za mało danych, by opisać ten rynek."

PLAIN_EN: dict[str, dict[str, str]] = {
    "risk": {
        "bull": "A bull market: stocks around the world have been rising for a while.",
        "flat": "Stocks around the world are standing still, with no clear direction.",
        "weak": "Stocks around the world are losing strength: prices are lower than in recent months.",
        "correction": "Stocks are in a correction: down 10-20% from the peak.",
        "bear": "A bear market: stocks are down more than 20% from the peak.",
    },
    "dollar": {
        "strong": "The dollar is strengthening.",
        "weak": "The dollar is weakening.",
        "flat": "The dollar exchange rate is standing still.",
    },
    "em": {
        "leading": "Stocks of developing countries are doing better than the rest of the world.",
        "lagging": "Stocks of developing countries are doing worse than the rest of the world.",
        "inline": "Stocks of developing countries are moving like the rest of the world.",
    },
    "commodities": {
        "bull": "Commodities are getting pricier: a basket of oil, metals and crops costs clearly more.",
        "bear": "Commodities are getting cheaper: a basket of oil, metals and crops costs clearly less.",
        "flat": "Commodity prices are standing still.",
    },
    "rates": {
        "rising": "US bond yields are rising, so borrowing money is getting more expensive.",
        "falling": "US bond yields are falling, so borrowing money is getting cheaper.",
        "stable": "US bond yields are standing still.",
    },
}
"""English :data:`PLAIN`."""
PLAIN_INVERTED_EN = "Short bonds pay more than long ones, which in the past was often a warning sign."
PLAIN_UNKNOWN_EN = "Too little data to describe this market."


def plain(regime: rg.Regime) -> str:
    """The beginner sentence of the regime's state (:data:`PLAIN`), deterministic: the state only
    (plus the inverted-curve flag of the rates card), no numbers from the data."""
    unknown = tr(pl=PLAIN_UNKNOWN, en=PLAIN_UNKNOWN_EN)
    if regime.missing:
        return unknown
    text = tr(pl=PLAIN, en=PLAIN_EN).get(regime.key, {}).get(regime.state)
    if text is None:
        return unknown
    if rg.INVERTED in regime.flags:
        text = f"{text} {tr(pl=PLAIN_INVERTED, en=PLAIN_INVERTED_EN)}"
    return text


def explain(regime: rg.Regime) -> str:
    """The card's hover text: :data:`INTRO`, :data:`RULE`, then the current state and its
    ``meaning`` (module doc)."""
    state, meaning = rg.display_state_label(regime), rg.display_meaning(regime)
    now = tr(pl=f"Teraz: {state}. {meaning}", en=f"Now: {state}. {meaning}")
    return f"{tr(pl=INTRO, en=INTRO_EN)[regime.key]} {tr(pl=RULE, en=RULE_EN)[regime.key]} {now}"


# --------------------------------------------------------------------------- #
# Vocabulary check (MCP)
# --------------------------------------------------------------------------- #

_WORD = re.compile(r"[^\W\d_]+")
_ALLOWED = re.compile(r"^[\w\s%+\-,.:/]*$")
_LONG_NUMBER = re.compile(r"\d{5,}")


@functools.cache
def vocabulary() -> frozenset[str]:
    """Every word :func:`summary` can write in Polish: generated over every state, ``since`` kind,
    metric sign, flag and currency variant (numbers are not words). Always Polish, whatever the
    current language (the MCP output is Polish)."""
    with use_language("pl"):
        return _vocabulary()


def _vocabulary() -> frozenset[str]:
    words: set[str] = set(MONTHS_GENITIVE)
    day = dt.date(2025, 5, 2)
    currencies = (
        None,
        CurrencyEffect(0.006, True),
        CurrencyEffect(-0.004, True),
        CurrencyEffect(0.0, True),
        CurrencyEffect(0.006, False),
    )
    for key, states in rg.STATES.items():
        for state, (label, tone) in states.items():
            for value, since, flags, currency, usd in itertools.product(
                (0.05, -0.05, 0.0, 0.5),
                ((day, False, None), (None, True, day), (None, False, None)),
                ((), (rg.INVERTED,)),
                currencies,
                (None, 0.006),
            ):
                metrics = tuple(rg.Metric(lbl, value, "pct") for lbl in sorted(rg.METRIC_LABELS))
                regime = rg.Regime(
                    key=key,
                    label=rg.LABELS[key],
                    state=state,
                    state_label=label,
                    tone=tone,
                    since=since[0],
                    metrics=metrics,
                    as_of=day,
                    stale=False,
                    missing=False,
                    meaning="",
                    flags=flags,
                    since_open=since[1],
                    since_min=since[2],
                    usdpln_1w=usd,
                )
                words.update(_WORD.findall(summary(regime, currency)))
                words.update(_WORD.findall(summary(_without_metrics(regime), currency)))
    words.update(_WORD.findall(UNKNOWN_SUMMARY))
    return frozenset(words)


def _without_metrics(regime: rg.Regime) -> rg.Regime:
    return replace(regime, metrics=())


def summary_ok(text: object) -> bool:
    """True when ``text`` uses only :func:`summary`'s vocabulary, numbers and its punctuation (the
    MCP lets a macro summary through as public market text only then)."""
    if not isinstance(text, str) or len(text) > 2 * SUMMARY_MAX or not _ALLOWED.match(text):
        return False
    if not text.endswith(".") or _LONG_NUMBER.search(text):
        return False
    words = _WORD.findall(text)
    return len(words) >= 3 and set(words) <= vocabulary()
