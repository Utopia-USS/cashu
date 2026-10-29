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
"""

from __future__ import annotations

import datetime as dt
import functools
import itertools
import re
from dataclasses import dataclass, replace

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

UNKNOWN_SUMMARY = "Za mało aktualnych notowań, by opisać ten rynek."


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
    ``4,1 %``."""
    decimals = _pct_decimals(value)
    text = rg._signed(value * 100, decimals) if signed else rg._number(value * 100, decimals)
    return f"{text} %"


def pp(value: float, decimals: int = 1) -> str:
    """Percentage points without a sign: ``0,6 pp``."""
    return f"{rg._number(value, decimals)} pp"


def month(day: dt.date) -> str:
    """``maja 2025`` (genitive, after ``od``)."""
    return f"{MONTHS_GENITIVE[day.month - 1]} {day.year}"


def since_phrase(regime: rg.Regime) -> str:
    """``od maja 2025``; ``co najmniej od października 2021`` for an open-ended state; empty when
    unknown."""
    if regime.since is not None:
        return f"od {month(regime.since)}"
    if regime.since_open and regime.since_min is not None:
        return f"co najmniej od {month(regime.since_min)}"
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


def _risk(regime: rg.Regime, since: str) -> str:
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


def _week(regime: rg.Regime, currency: CurrencyEffect | None) -> str:
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


def _dollar(regime: rg.Regime, since: str, currency: CurrencyEffect | None) -> str:
    head = _DOLLAR_HEAD[regime.state]
    six = _metric(regime, "6 mies.")
    detail = "" if six is None else f"indeks dolara {pct(six)} w pół roku"
    week = _week(regime, currency)
    full = " ".join(p for p in (_sentence(head, since, detail), week) if p)
    if len(full) <= SUMMARY_MAX or not week:
        return full
    return f"{_sentence(head, since)} {week}"


def _em(regime: rg.Regime, since: str) -> str:
    eem = _metric(regime, "EEM 6 mies.")
    diff = _metric(regime, "EEM wobec ACWI 6 mies.")
    detail = _join("" if eem is None else f"w pół roku {pct(eem)}", _versus(diff, "akcje globalne"))
    return _sentence(_EM_HEAD[regime.state], since, detail)


def _commodities(regime: rg.Regime, since: str) -> str:
    year = _metric(regime, "DBC 12 mies.")
    diff = _metric(regime, "wobec ACWI 12 mies.")
    detail = _join("" if year is None else f"{pct(year)} w rok", _versus(diff, "akcje na świecie"))
    return _sentence(_COMMODITIES_HEAD[regime.state], since, detail)


def _rates(regime: rg.Regime, since: str) -> str:
    level = _metric(regime, "USA 10 lat")
    change = _metric(regime, "3 mies. zmiana")
    level_text = "" if level is None else f"10-letnie {rg._number(level, 2)} %"
    change_text = "" if change is None else f"{rg._signed(change / 100, 2)} pp w 3 miesiące"
    head = _RATES_HEAD[regime.state]
    text = _sentence(head, since, _join(level_text, change_text))
    if rg.INVERTED in regime.flags:
        text = f"{text} {INVERTED_SENTENCE}"
        if len(text) > SUMMARY_MAX:  # the 3-month change gives way to the curve
            text = f"{_sentence(head, since, level_text)} {INVERTED_SENTENCE}"
    return text


def summary(regime: rg.Regime, currency: CurrencyEffect | None = None) -> str:
    """The card's short text (module doc). ``currency``: the portfolio's currency effect of the week,
    folded into the dollar card only."""
    if regime.missing or regime.state == rg.UNKNOWN:
        return UNKNOWN_SUMMARY
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


def plain(regime: rg.Regime) -> str:
    """The beginner sentence of the regime's state (:data:`PLAIN`), deterministic: the state only
    (plus the inverted-curve flag of the rates card), no numbers from the data."""
    if regime.missing:
        return PLAIN_UNKNOWN
    text = PLAIN.get(regime.key, {}).get(regime.state)
    if text is None:
        return PLAIN_UNKNOWN
    if rg.INVERTED in regime.flags:
        text = f"{text} {PLAIN_INVERTED}"
    return text


def explain(regime: rg.Regime) -> str:
    """The card's hover text: :data:`INTRO`, :data:`RULE`, then the current state and its
    ``meaning`` (module doc)."""
    now = f"Teraz: {regime.state_label}. {regime.meaning}"
    return f"{INTRO[regime.key]} {RULE[regime.key]} {now}"


# --------------------------------------------------------------------------- #
# Vocabulary check (MCP)
# --------------------------------------------------------------------------- #

_WORD = re.compile(r"[^\W\d_]+")
_ALLOWED = re.compile(r"^[\w\s%+\-,.:/]*$")
_LONG_NUMBER = re.compile(r"\d{5,}")


@functools.cache
def vocabulary() -> frozenset[str]:
    """Every word :func:`summary` can write: generated over every state, ``since`` kind, metric sign,
    flag and currency variant (numbers are not words)."""
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
