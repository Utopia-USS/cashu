#!/usr/bin/env python3
"""Differential vectors for the TS research port (scope S21a): Python is the oracle.

    .venv/bin/python parity/python/generators/domain/research_vectors.py           # rewrite the vectors
    .venv/bin/python parity/python/generators/domain/research_vectors.py --check   # fail when they would change

Writes ``packages/domain/test/vectors/research-*.jsonl`` from ``modules/investments/research``
(``validation``, ``scoring``, ``similarity``, ``segments``, ``strategy_text``, ``signals``, ``keys``)
and the standard library behaviour they rely on (``re`` with Unicode ``\\w \\b \\s \\d`` and
IGNORECASE, ``str.casefold``, ``urllib.parse.urlsplit``, ``ipaddress``, ``datetime.fromisoformat``).
Everything is synthetic: hand-written phrases, URLs and dates plus seeded random mutations; no data
dir or database is opened.

Inputs are what JSON can carry to the TS side: an integral float (``2.0``) is left out because
``JSON.parse`` decodes it as the integer 2 (Python refuses it where an int is required; a known
JSON-boundary difference, see S37 / the S21a checkpoint).

Format (as ``parity/python/vectors.py``): JSON Lines, line 1 ``{"meta": {...}}`` with the count and
the row layout, then one JSON array per vector. Files are ASCII (``ensure_ascii``) so lone
surrogates and every code point survive the round trip.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import random
import re
import sys
import unicodedata
from collections.abc import Callable, Iterable
from pathlib import Path

from cashu.core import i18n
from cashu.modules.investments import models
from cashu.modules.investments.models import InvResearchNote
from cashu.modules.investments.research import keys, scoring, segments, signals, similarity
from cashu.modules.investments.research import strategy_text as st
from cashu.modules.investments.research import validation as V

SEED = 2110
ROOT = Path(__file__).resolve().parents[4]  # parity/python/generators/domain -> the repo
OUT = ROOT / "packages" / "domain" / "test" / "vectors"
NOW = dt.datetime(2026, 10, 9, 12, tzinfo=dt.UTC)

# --------------------------------------------------------------------------------------- helpers


def canon(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def pairs(mapping: dict) -> list:
    """A dict as [key, value] pairs (key order is part of the contract, JSON objects lose it)."""
    return [[k, v] for k, v in mapping.items()]


def iso(value: dt.datetime | None) -> str | None:
    return None if value is None else value.isoformat()


# --------------------------------------------------------------------------------------- word lists


def gen_wordlists(rng: random.Random) -> list:
    tables: dict[str, object] = {
        "FORECAST": V._FORECAST.pattern,
        "ADVICE_CORE": V._ADVICE_CORE,
        "ADVICE": V._ADVICE.pattern,
        "MARKET_ADVICE": V._MARKET_ADVICE.pattern,
        "PRICE_CALL": V._PRICE_CALL.pattern,
        "SENTENCE": V._SENTENCE.pattern,
        "INSTITUTION": V._INSTITUTION.pattern,
        "ATTRIBUTION": V._ATTRIBUTION.pattern,
        "NOT_INSTITUTIONAL": V._NOT_INSTITUTIONAL.pattern,
        "YEAR": V._YEAR.pattern,
        "SPAN": V._SPAN.pattern,
        "PERIOD": V._PERIOD.pattern,
        "CANDIDATE_SYMBOL": V._CANDIDATE_SYMBOL.pattern,
        "EXCHANGE": V._EXCHANGE.pattern,
        "CURRENCY": V._CURRENCY.pattern,
        "CONTROL": V._CONTROL.pattern,
        "BYPASS_HOSTS": list(V.BYPASS_HOSTS),
        "DETAILS_KEYS": list(V.DETAILS_KEYS),
        "VALUATION_KEYS": list(V.VALUATION_KEYS),
        "BRIEF_KEYS": list(V.BRIEF_KEYS),
        "RUN_COUNT_KEYS": list(V.RUN_COUNT_KEYS),
        "COMMUNITY_SCALES": list(V.COMMUNITY_SCALES),
        "SEGMENT_NOTE_KINDS": list(V.SEGMENT_NOTE_KINDS),
        "TOPIC_THESIS_RELATIONS": list(V.TOPIC_THESIS_RELATIONS),
        "HEADING": st._HEADING.pattern,
        "FENCE": st._FENCE.pattern,
        "SECTION_KEYWORDS": pairs({k: list(v) for k, v in st._KEYWORDS.items()}),
        "STOPWORDS_TEXT": similarity._STOPWORDS_TEXT,
        "UP_WORDS": [list(similarity.UP_WORDS[0]), sorted(similarity.UP_WORDS[1])],
        "DOWN_WORDS": [list(similarity.DOWN_WORDS[0]), sorted(similarity.DOWN_WORDS[1])],
        "SEGMENTS": [[s.key, s.label, s.group, s.label_en] for s in segments.SEGMENTS],
        "MACRO_SEGMENTS": [[s.key, s.label, s.group, s.label_en] for s in segments.MACRO_SEGMENTS],
        "UNASSIGNED": [segments.UNASSIGNED, segments.UNASSIGNED_LABEL, segments.UNASSIGNED_LABEL_EN],
        "LEGACY_KEYS": pairs(segments.LEGACY_KEYS),
        "STABLECOINS": sorted(segments.STABLECOINS),
        "FUNDS": pairs({k: list(v) for k, v in segments._FUNDS.items()}),
        "SUFFIX": segments._SUFFIX.pattern,
        "KIND_LABEL": pairs(signals.KIND_LABEL),
        "KIND_LABEL_EN": pairs(signals.KIND_LABEL_EN),
        "RELATION_LABEL": pairs(signals.RELATION_LABEL),
        "RELATION_LABEL_EN": pairs(signals.RELATION_LABEL_EN),
        "RESEARCH_NOTE_KINDS": list(models.RESEARCH_NOTE_KINDS),
        "RESEARCH_POLARITIES": list(models.RESEARCH_POLARITIES),
        "RESEARCH_THESIS_RELATIONS": list(models.RESEARCH_THESIS_RELATIONS),
        "RESEARCH_THESIS_FIELDS": list(models.RESEARCH_THESIS_FIELDS),
        "FULFILLS_THESIS_FIELDS": list(models.FULFILLS_THESIS_FIELDS),
        "THESIS_ENTRY_TYPES": list(models.THESIS_ENTRY_TYPES),
        "RESEARCH_RUN_STATUSES": list(models.RESEARCH_RUN_STATUSES),
        "RESEARCH_CREATORS": list(models.RESEARCH_CREATORS),
        "RESEARCH_BOUNDS": [
            models.RESEARCH_TITLE_MAX,
            models.RESEARCH_SUMMARY_MAX,
            models.RESEARCH_NOTE_TTL_DAYS,
            models.RESEARCH_RESTORE_MINUTES,
            models.RESEARCH_CANDIDATE_COOLDOWN_DAYS,
        ],
        "RESEARCH_PREFIX": keys.RESEARCH_PREFIX,
    }
    return [
        [name, hashlib.sha256(canon(value).encode()).hexdigest(), value]
        for name, value in tables.items()
    ]


# --------------------------------------------------------------------------------------- classes


def blocks(fn: Callable[[str], str]) -> list[str]:
    out = []
    for block in range(0x110000 // 4096):
        h = hashlib.sha256()
        for c in range(block * 4096, (block + 1) * 4096):
            if 0xD800 <= c <= 0xDFFF:
                continue
            h.update(fn(chr(c)).encode("utf-8", "surrogatepass"))
            h.update(b"\0")
        out.append(h.hexdigest()[:16])
    return out


IGNORECASE_UNITS = sorted(
    set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZąćęłńóśźżĄĆĘŁŃÓŚŹŻ")
) + ["[sś]", "[aą]", "[oó]", "[zż]", "[eę]", "[cć]", "[QH]", "[1-4]", "[\\s-]", "[a-z]", "[iI]"]


def gen_classes(rng: random.Random) -> list:
    word = re.compile(r"\w")
    digit = re.compile(r"\d")
    space = re.compile(r"\s")
    rows: list = [
        ["w", blocks(lambda c: "1" if word.fullmatch(c) else "0")],
        ["d", blocks(lambda c: "1" if digit.fullmatch(c) else "0")],
        ["s", blocks(lambda c: "1" if space.fullmatch(c) else "0")],
        ["dot", blocks(lambda c: "1" if re.fullmatch(".", c) else "0")],
        ["casefold", blocks(lambda c: c.casefold())],
        ["nfkd", blocks(lambda c: unicodedata.normalize("NFKD", c))],
        ["nfkc", blocks(lambda c: unicodedata.normalize("NFKC", c))],
    ]
    for unit in IGNORECASE_UNITS:
        pattern = re.compile("(?i)" + unit)
        matches = [c for c in range(0x10000) if not 0xD800 <= c <= 0xDFFF and pattern.fullmatch(chr(c))]
        rows.append(["ignorecase", unit, matches])
    return rows


# --------------------------------------------------------------------------------------- phrases

SEED_PHRASES = [
    "Analitycy podnosza cene docelowa do 120 zl",
    "Bank X: rekomendacja kupuj dla spolki",
    "Upgrade to buy after earnings",
    "Strong buy rating reiterated",
    "Kurs wzrosnie do 50 zl w tym roku",
    "The stock will reach 300 by spring",
    "Warto kupic przed dywidenda",
    "Price target raised",
    "Inwestorzy sprzedaja akcje po wynikach",
    "Kurs spadl o 8% po publikacji raportu",
    "Sprzedaz wzrosla r/r o 12%",
    "Akcje wzrosną jeszcze w tym roku",
    "Kurs spadnie po wynikach spółek",
    "Rynek będzie rósł dalej przez lata",
    "Prognozy analityków są optymistyczne",
    "Kupuj spółki chipowe teraz",
    "Sprzedaj akcje ubezpieczycieli",
    "Analitycy podnieśli cel cenowy spółki",
    "Ceny spadna po wynikach",
    "Rynek urośnie w kolejnym roku",
    "Ropa podrożeje zimą",
    "Miedź stanieje po decyzji Chin",
    "Kurs odbije po korekcie",
    "Niskie stopy sprzyjają spółkom wzrostowym",
    "Wyceny są wysoko, więc rynek jest wrażliwy na złe wiadomości",
    "Coraz więcej kupujących wraca na rynek gier",
    "Spadły wydatki na reklamę w grach",
    "MFW prognozuje wzrost PKB USA o 2,1 % w 2027",
    "Fed w projekcji (dot plot) zakłada stopy 3,4 % na koniec 2026",
    "Według projekcji NBP inflacja spadnie do 2,5 % w 2027",
    "EBC prognozuje inflację w strefie euro na 2,0 % w 2026",
    "IEA szacuje, że popyt na prąd wzrośnie o 4 % rocznie do 2027",
    "OECD przewiduje, że handel światowy urośnie o 2,8 % w 2026",
    "Prognozujemy, że PKB USA wzrośnie o 2 % w 2027",
    "Analitycy prognozują wzrost zysków spółek o 10 %",
    "Konsensus analityków według MFW prognozuje wzrost PKB o 2 %",
    "S&P 500 wzrośnie do 7000 punktów w 2027",
    "MFW prognozuje, że S&P 500 wzrośnie do 7000 punktów",
    "Fed prognozuje, że wyceny spółek spadną w 2027",
    "Według OECD kurs dolara spadnie do 3,5 zł",
    "MFW prognozuje wzrost PKB. Rynek będzie rósł dalej",
    "Rynek będzie rósł, bo tak prognozuje rynek",
    "Według MFW warto kupić akcje banków",
    "Według projekcji NBP inflacja spadnie do 2,5 % w 2027; RPP utrzymała stopy.",
    "Fed prognozuje, że kurs akcji banków wzrośnie do 50 USD.",
    "popyt wzrośnie do 945 TWh",
    "installations will reach 575,000",
    "cena złota wzrośnie do 3000",
    "Cena miedzi może w tym roku wzrosnąć o 10",
    "kurs akcji spółki wzrośnie",
    "akcje spółki spadną",
    "notowania odbiją",
    "wyceny spadną",
    "sprzedaż robotów rośnie",
    "prices will rise sharply",
    "valuations could double",
    "upside of 20%",
    "kup teraz",
    "zrealizuj zyski",
    "Międzynarodowa Agencja Energetyczna szacuje wzrost popytu o 4 %",
    "Bank Światowy prognozuje spowolnienie",
    "Rezerwa Federalna według projekcji obniży stopy",
    "Komisja Europejska przewiduje wzrost PKB",
    "Gartner estimates IT spending growth of 9.8% in 2026",
    "IDC forecasts 575 tys. instalacji do 2030",
    "+4% rocznie przez 2-4 lat",
    "627 mld USD w 2030",
    "Q3 2026 i H1 2027",
    "12 mies. horyzont, 3 kwartały, 2 tygodnie, 10 dni",
    "W 2030 roku rynek osiągnie 1,2 bln",
    "we expect growth; I forecast decline",
    "naszym zdaniem rynek urośnie",
    "dom maklerski podnosi rekomendację do kupuj",
    "rekomendacja neutralnie dla banku",
    "downgraded to sell",
    "you should buy this",
    "we recommend selling",
    "i recommend buying now",
    "nalezy kupic akcje",
    "należy sprzedać",
    "share target lifted",
    "target price 50",
    "will hit 100 soon",
    "will climb to 7000",
    "kurs dojdzie do 100",
    "Cena osiągnie poziom do 5",
    "ceny ropy spadną o 5",
    "cenie złota wzrośnie do 3000",
]
WORD_EDGES = ["", "x", "ł", "_", "1", "é", "-", ".", "İ", "́", "٣"]
SPACES = [" ", "  ", " ", " ", "\x1c", "　", "\x85", "\t", "​", "﻿"]
DIGITS = {"0123456789": "٠١٢٣٤٥٦٧٨٩", "0123456789 ": "０１２３４５６７８９ "}


def mutate(rng: random.Random, text: str) -> str:
    op = rng.randrange(12)
    if op == 0:
        return text.upper()
    if op == 1:
        return text.swapcase()
    if op == 2:
        return text.replace("i", rng.choice(["İ", "ı", "I"])).replace("I", rng.choice(["İ", "ı", "i"]))
    if op == 3:
        return "".join(rng.choice(SPACES) if c == " " else c for c in text)
    if op == 4:
        table = str.maketrans("0123456789", rng.choice(["٠١٢٣٤٥٦٧٨٩", "０１２３４５６７８９", "०१२३४५६७८९"]))
        return text.translate(table)
    if op == 5:
        words = text.split(" ")
        i = rng.randrange(len(words))
        words[i] = rng.choice(WORD_EDGES) + words[i] + rng.choice(WORD_EDGES)
        return " ".join(words)
    if op == 6:
        return text + rng.choice([". ", "; ", "! ", "? ", ".\n", ". ąę "]) + rng.choice(SEED_PHRASES)
    if op == 7:
        return unicodedata.normalize("NFD", text)
    if op == 8:
        return text.translate(str.maketrans("ąćęłńóśźżĄĆĘŁŃÓŚŹŻ", "acelnoszzACELNOSZZ"))
    if op == 9:
        return text.replace("s", "ſ")
    if op == 10:
        return text.replace("k", "K").replace("-", "–")
    return rng.choice(SEED_PHRASES) + " " + text.lower()


def phrase_corpus(rng: random.Random, n: int) -> list[str]:
    out = list(SEED_PHRASES)
    while len(out) < n:
        text = rng.choice(out)
        for _ in range(rng.randrange(1, 3)):
            text = mutate(rng, text)
        out.append(text[:600])
    return out


PATTERNS = {
    "FORECAST": V._FORECAST,
    "ADVICE": V._ADVICE,
    "MARKET_ADVICE": V._MARKET_ADVICE,
    "PRICE_CALL": V._PRICE_CALL,
    "INSTITUTION": V._INSTITUTION,
    "ATTRIBUTION": V._ATTRIBUTION,
    "NOT_INSTITUTIONAL": V._NOT_INSTITUTIONAL,
    "YEAR": V._YEAR,
    "SPAN": V._SPAN,
    "PERIOD": V._PERIOD,
}


def gen_phrases(rng: random.Random) -> list:
    rows = []
    for text in phrase_corpus(rng, 1600):
        rows.append(
            [
                text,
                V.advice_problem(text),
                V.claim_problem(text),
                V.forecast_problem(text),
                V.market_view_problem(text),
                V.attributed_trend_forecast(text),
                V.has_quantitative_estimate(text),
                V._SENTENCE.split(text),
                {name: [m.group(0) for m in p.finditer(text)] for name, p in PATTERNS.items()},
            ]
        )
    return rows


# --------------------------------------------------------------------------------------- URLs

URLS = [
    "https://www.example.pl/rynki/artykul,123.html?x=1",
    "https://example.com/news/2026/10/07/spolka-x-wyniki",
    "ftp://example.com/a",
    "https://localhost/a",
    "http://127.0.0.1/a",
    "https://user:pw@example.com/a",
    "https://intranet/a",
    "https://archive.ph/abc",
    "https://www.12ft.io/proxy?q=https://example.com",
    "https://example.com/a b",
    "https://" + "a" * 600 + ".com",
    "HTTPS://Example.COM/x",
    "https://example.com.",
    "https://example.com:443/x",
    "https://example.com:0/x",
    "https://example.com:65535/x",
    "https://example.com:65536/x",
    "https://example.com:/x",
    "https://example.com:abc/x",
    "https://example.com:٣/x",
    "https://example.com:-1/x",
    "https://@example.com/x",
    "https://user@example.com/x",
    "https://:pw@example.com/x",
    "https://[::1]/x",
    "https://[::1]:8080/x",
    "https://[v1.fe]/x",
    "https://[v1.]/x",
    "https://[V1.fe]/x",
    "https://[fe80::1%25eth0]/x",
    "https://[fe80::1%eth0]/x",
    "https://[::ffff:1.2.3.4]/x",
    "https://[1.2.3.4]/x",
    "https://[::1]x/x",
    "https://x[::1]/x",
    "https://[::1/x",
    "https://::1]/x",
    "https://[1:2:3:4:5:6:7:8]/x",
    "https://[1:2:3:4:5:6:7:8:9]/x",
    "https://[1::2::3]/x",
    "https://[12345::1]/x",
    "https://[::g]/x",
    "https://[:1:2:3:4:5:6:7]/x",
    "https://[1:2:3:4:5:6:7:]/x",
    "https://[::]/x",
    "https://[1::]/x",
    "https://[::1.2.3]/x",
    "https://[::01.2.3.4]/x",
    "https://256.1.1.1/x",
    "https://01.2.3.4/x",
    "https://1.2.3.4./x",
    "https://1.2.3/x",
    "https://0.0.0.0/x",
    "https://255.255.255.255/x",
    "https://1.2.3.4.5/x",
    "https://a.local/x",
    "https://a.localhost/x",
    "https://a.internal/x",
    "https://local/x",
    "https://www.archive.ph/x",
    "https://notarchive.ph/x",
    "https://archive.ph.example.com/x",
    "https://freedium.cfd/x",
    "https://przykład.pl/x",
    "https://ＡＢＣ.com/x",
    "https://a℀b.com/x",
    "https://exa／mple.com/x",
    "https://exa⁇mple.com/x",
    "https://bücher.de@evil.com/x",
    "https://evil.com#@good.com/x",
    "https://example.com?x=@y",
    "https:example.com/x",
    "https:/example.com/x",
    "//example.com/x",
    "example.com/x",
    "javascript:alert(1)",
    "h ttp://example.com",
    "1http://example.com/x",
    "ht+tp://example.com/x",
    "http://exa_mple.com/x",
    "http://ex\x00ample.com/x",
    "http://ex\x7fample.com/x",
    "http://example.com/\x1cx",
    "http://example.com/ x",
    "http://example.com/​x",
    "http://example.com/﻿x",
    "  https://example.com/x  ",
    "",
    "   ",
    "https://",
    "https:///x",
    "https://.com/x",
    "https://..com/x",
    "https://İSTANBUL.com/x",
    "https://EXAMPLE.ΣΑΣ/x",
    "https://[::1]%41/x",
    "https://a:b:c@example.com/x",
    "https://a@b@example.com/x",
    "https://example.com:8080:90/x",
]
URL_PARTS = {
    "scheme": ["http://", "https://", "HTTP://", "Https://", "ftp://", "", "https:", "https:///"],
    "user": ["", "", "", "u@", "u:p@", "@", ":@"],
    "host": [
        "example.com",
        "sub.example.co.uk",
        "localhost",
        "a.local",
        "127.0.0.1",
        "[::1]",
        "[v7.ab]",
        "archive.today",
        "x.12ft.io",
        "żółw.pl",
        "EXAMPLE.COM",
        "example.com.",
        "example",
        "1.2.3.04",
        "[::ffff:10.0.0.1]",
        "smry.ai.",
        "foo.internal.",
    ],
    "port": ["", "", "", ":80", ":99999", ":x", ":", ":008"],
    "path": ["", "/", "/a/b?c=d#e", "?q=1", "#frag", "/ścieżka", "/a@b"],
}


def gen_urls(rng: random.Random) -> list:
    corpus = list(URLS)
    for _ in range(1200):
        corpus.append("".join(rng.choice(URL_PARTS[k]) for k in ("scheme", "user", "host", "port", "path")))
    return [[url, V.check_url(url)] for url in corpus] + [[5, V.check_url(5)], [None, V.check_url(None)]]


# --------------------------------------------------------------------------------------- moments

MOMENTS = [
    "2026-10-03",
    "2026-10-03T08:00:00Z",
    "yesterday",
    "2026-10-03T08:30:00.",
    "2026-10-03T08:30:00,5",
    "2026-10-03T08",
    "2026-10-03T0830",
    "2026-10-03T08:30:00.1234567",
    "2026-10-03T24:00",
    "2026-10-03T24:00:01",
    "2026-12-31T24:00",
    "2026-02-29T24:00",
    "2026-00-31T24:00",
    "2026-13-01T24:00",
    "2026-10-03T08:30+01",
    "2026-10-03T08:30+0130",
    "2026-10-03T08:30+01:30:15.5",
    "2026-10-03T08:30+00:99",
    "2026-10-03T08:30+24:00",
    "2026-10-03T08:30+23:59:59.999999",
    "2026-10-03T08:30Zx",
    "2026-10-03x08:30",
    "2026-W40-1T08",
    "2026W401T08",
    "2026-W40T08",
    "2026W40T08",
    "2026-W53-1",
    "2020-W53-1T00:00",
    "20261003T083000Z",
    "20261003",
    "2026-W40",
    "2026W40",
    "2026W405",
    "2026-10-03T08:30:00+00:00:00.000001",
    "2026-10-03Ä08:30",
    "2026-10-03😀08:30",
    "2026-10-03€08:30",
    "2026-10-03T08:30-00",
    "2026-10-03T08:3",
    "2026-10-03 08:30:00.000000-23:59",
    "2026-10-03T08:30+",
    "2026-10-03T08:30+1",
    "2026-10-03Z",
    "2026-10-03T08:30:00ZZ",
    "  2026-10-03  ",
    "　2026-10-03T08:00　",
    "\x1c2026-10-03\x1c",
    "﻿2026-10-03",
    "0001-01-01T00:00:00+00:01",
    "9999-12-31T23:59:59-00:01",
    "9999-12-31T24:00",
    "0001-01-01",
    "2026-1003T08",
    "202610-03",
    "2026-10-3",
    "２０２６-10-03",
    "2026-10-03T٠٨:00",
    "2026-10-03T08:00:00.1",
    "2026-10-03T08:00:00.12",
    "2026-10-03T08:00:00.123456789+05:00",
    "2026-10-03T08:00:00.12x",
    "2026-10-03T08:00:00:00",
    "2026-10-03T08:00x00",
    "2026-10-03T08.5",
    "2026-10-03T0800.5",
    "2026-10-03T080000.5",
    "2026-10-03T08:00:60",
    "2026-10-03T25:00",
    "2026-10-03T08:61",
    "2026-02-30",
    "2026-10-03T",
    "2026-10-03TZ",
    "2026-10-03T-01:00",
    "2026-10-03T08-01:00",
    "2026-10-03T08:00-0100",
    "2026-10-03T08:00-01:00:30",
    "2026-10-03T08:00+01:00:30.123",
    "2026-W00-1",
    "2026-W40-8",
    "2026-W40-",
    "2026-W4",
    "2026-W40-1-",
    "2026",
    "",
    "2026-10-03T08:00:00+05:00junk",
    "2026-10-03T08:00:00\ud800",
    "2026-10\ud80003T08:00",
    "2026-10-03\ud80008:00",
]


def gen_moments(rng: random.Random) -> list:
    corpus = list(MOMENTS)
    dates = ["2026-10-03", "20261003", "2026-W40", "2026-W40-3", "2026W40", "2026W403", "1999-12-31",
             "2024-02-29", "2023-02-29", "0001-01-01", "9999-12-31", "2026-13-01"]
    seps = ["T", " ", "t", "x", "1", "-", "Ł", "€", "😀", "_"]
    times = ["08", "0830", "08:30", "08:30:15", "083015", "08:30:15.5", "08:30:15,123456", "083015.1234567",
             "24:00", "24:00:00.000000", "23:59:59.999999", "00:00", "8:30", "08:3", "08::30", "08:30:"]
    zones = ["", "", "Z", "+01", "-0130", "+01:30", "+01:30:15", "+01:30:15.25", "-00:00", "+23:59", "+24:00",
             "Z0", "+", "-1", "+01:3", "+0130.5", "+01:30:15.1234567"]
    for _ in range(1500):
        text = rng.choice(dates)
        if rng.random() < 0.85:
            text += rng.choice(seps) + rng.choice(times) + rng.choice(zones)
        if rng.random() < 0.1:
            text = rng.choice([" ", "\t", " ", "\x85"]) + text + rng.choice(["", " ", "\n"])
        corpus.append(text)
    rows = []
    for text in corpus:
        try:
            value = V.parse_moment(text)
            out = None if value is None else value.isoformat()
        except Exception as e:  # noqa: BLE001 - the error class is the vector
            out = {"error": type(e).__name__}
        rows.append([text, out])
    return rows


# --------------------------------------------------------------------------------------- text

TEXTS = [
    "Półprzewodniki",
    "  polprzewodniki ",
    "Stopy procentowe (NBP)",
    "!!!",
    "Złoto, ŁÓDŹ i 2025 r.",
    "Złoto 2025",
    "prognozę prognozy",
    "Straße STRASSE ẞ",
    "ﬁnanse ﬀ ﬆ",
    "Σίσυφος ΣΑΣ ς",
    "İstanbul ıi",
    "ǅemal ǈ",
    "x² ① ⅷ ٣",
    "Ćma ćma Ćma",
    "été",
    "Ångström Øresund đ Đ",
    " Handel detaliczny\x1c ",
    "Rośnie popyt na chipy do centrów danych",
    "Popyt na chipy do centrów danych dalej rośnie",
    "Nvidia podnosi prognozę przychodów na kwartał",
    "Fed obniżył stopy procentowe",
    "Dolar się umacnia wobec euro",
    "Dolar słabnie wobec euro",
    "Nvidia raises revenue guidance",
    "Nvidia cuts revenue guidance",
    "Rynek chipów wychodzi z konsolidacji",
    "Popyt rośnie, ceny spadły",
    "a" * 70,
    "-a-b-",
    "",
    "   ",
    "GDXJ.L",
    "gdxj.us",
    "XETR:SXR8",
    " vwce.de ",
    "BTC-USD",
    "usdt-usd",
    "a.b:c.d",
    "A:B:C",
    "ß.de",
    "ﬁ:x",
    "ab.c\nd",
    "ab\n",
]


def gen_text(rng: random.Random) -> list:
    corpus = list(TEXTS)
    alphabet = "aąbcćdeęfghijklłmnńoóprsśtuwyzźżAĄĆĘŁŃÓŚŹŻßẞİıﬁ²①٣ .,:-_!0123456789́ \x1c　ΣσςЖж"
    for _ in range(600):
        corpus.append("".join(rng.choice(alphabet) for _ in range(rng.randrange(0, 40))))
    rows = []
    for text in corpus:
        rows.append(
            [
                text,
                scoring.clean_theme(text),
                scoring.theme_key(text),
                sorted(similarity.tokens(text)),
                sorted(similarity.tokens(text, numbers=True)),
                sorted(similarity.directions(text)),
                sorted(similarity.numbers(text)),
                similarity.body(text, text[:10] or None),
                segments.bare_symbol(text),
                st._fold(text),
                st._kind(text),
                text.casefold(),
            ]
        )
    return rows


def gen_sections(rng: random.Random) -> list:
    heads = ["# Strategia", "## Cel", "## Moje przekonania", "### Szczegóły", "## Entry and exit rules",
             "## Czego unikam", "## Wykluczenia", "## Notatki", "#Brak spacji", "####### Za dużo",
             "## Zasady wejścia i wyjścia ##", "##   Filozofia   #", "## W co WIERZĘ", "## Beliefs\r",
             "  ## Wcięty", "## Approach x", "## Teza inwestycyjna", "## czego NIE kupuję"]
    bodies = ["Emerytura.", "Rynek rośnie długoterminowo.", "", "```", "~~~", "  ```python", "# w kodzie",
              "Kupuję na spadkach.", "x" * 900, "y\n" * 40, "Koniec.", "\t", " "]
    rows = []
    for _ in range(300):
        lines = []
        for _ in range(rng.randrange(1, 14)):
            lines.append(rng.choice(heads) if rng.random() < 0.4 else rng.choice(bodies))
        md = rng.choice(["\n", "\r\n"]).join(lines)
        rows.append([md, [[s.kind, s.heading, s.text] for s in st.strategy_sections(md)]])
    rows.append([None, []])
    return rows


# --------------------------------------------------------------------------------------- notes

SOURCE = {
    "url": "https://example.com/news/2026/10/07/spolka-x-wyniki",
    "publisher": "Example News",
    "published_at": "2026-10-07",
    "title": "Spolka X po wynikach",
}
BASE_NOTES = [
    {
        "kind": "news",
        "polarity": "negative",
        "strength": 2,
        "title": "Spolka X obniza prognoze sprzedazy",
        "summary": "Zarzad obnizyl prognoze sprzedazy na rok 2026; raport kwartalny z 7.10.",
        "sources": [SOURCE],
    },
    {
        "kind": "trend",
        "polarity": "positive",
        "strength": 2,
        "segment": "semis_ai",
        "title": "Popyt na chipy AI",
        "summary": "Producenci chipów raportują rekordowe zamówienia od operatorów centrów danych.",
        "sources": [{"url": "https://example.com/p9/1", "publisher": "Example News", "published_at": "2026-10-07"}],
        "details": {"brief": {"headline": "Rośnie popyt na chipy do centrów danych",
                              "why": "Najwięksi klienci zwiększyli wydatki na serwery z AI."}},
    },
    {
        "kind": "macro",
        "polarity": "negative",
        "strength": 3,
        "segment": "macro_risk",
        "title": "Trwa hossa na giełdach",
        "summary": "Spółki zarabiają coraz więcej.",
        "sources": [SOURCE],
        "details": {"brief": {"headline": "Trwa hossa na giełdach",
                              "why": "Spółki zarabiają coraz więcej, a firmy dużo wydają na AI.",
                              "supports": ["Banki centralne obniżają stopy"], "risks": ["Wyceny są wysoko"]}},
    },
    {
        "kind": "candidate",
        "polarity": "positive",
        "strength": 1,
        "title": "Kandydat Newco",
        "summary": "Spółka spełnia kryteria strategii (C/Z, dywidenda).",
        "sources": [SOURCE],
        "candidate": {"symbol_or_isin": "NEWCO.WA", "name": "Newco SA", "exchange": "GPW", "currency": "pln"},
        "details": {"entry_type": "sentiment_correction", "criteria_version": 3, "bucket": "core",
                    "criteria": [{"text": "C/Z 9,8", "met": True, "threshold": "max 15"},
                                 {"text": "dywidenda 1,2%", "met": False}]},
    },
    {
        "kind": "community",
        "polarity": "neutral",
        "strength": 1,
        "title": "Watek na forum",
        "summary": "Uzytkownicy forum dyskutuja o wynikach spolki.",
        "sources": [SOURCE],
        "details": {"scale": "small", "context": "watek na forum", "event": "wyniki Q3",
                    "event_date": "2026-10-22", "headline": "Forum dyskutuje o wynikach",
                    "valuation": {"pe": 12.345678, "forward_pe": 10, "eps_growth": 0.35, "basis": "LTM"}},
    },
]
FIELD_VALUES: dict[str, list] = {
    "kind": ["news", "earnings", "community", "trend", "macro", "candidate", "rumour", None, 5, ""],
    "polarity": ["positive", "negative", "neutral", "bullish", None],
    "strength": [1, 2, 3, 0, 4, True, "2", None, 2.5],
    "thesis_relation": ["supports", "weakens", "invalidates", "fulfills", "neutral", "none", "kills", None, "", 0, []],
    "thesis_field": ["thesis", "exit_plan", "invalidation", "size_plan", "entry_type", "entry", None],
    "title": ["ab", "x" * 121, "two\n lines", "bell\x07char", "  Spokojny tytul  ", "Kurs wzrosnie do 50 zl",
              " Tytuł\x1cz spacjami", 5, None, "Warto kupic. Fakt.", "Fed: inflacja spadnie do 2 % w 2027"],
    "summary": ["z" * 1201, "z" * 401, "krotko", "Linia 1\r\n\r\n\r\n\r\nLinia 2 jest dluzsza", "Bell\x07 w tekscie",
                "Kurs wzrośnie do 50 zł w tym roku po wynikach.", "Według projekcji NBP inflacja spadnie do 2,5 % w 2027.",
                None, ["x"]],
    "theme": [None, "  Handel   detaliczny ", "x" * 61, "x", 5, True, 1.5, ["a", "b"], {"k": "v"}, ""],
    "segment": [None, "gold", "Gold", "macro_risk", "macro_rates", "semis_ai", "", "uranium"],
    "observed_at": [None, "2026-11-01", "2026-08-01", "2026-09-20", "2026-10-09T13:00:00Z", "", "bad", 5],
    "expires_in_days": [None, 1, 45, 90, 91, 0, True, "30", 2.5],
    "sources": [[], [SOURCE] * 11, [SOURCE, SOURCE], [{**SOURCE, "amount": 5}], [{**SOURCE, "url": None}],
                [{**SOURCE, "publisher": ""}], [{**SOURCE, "published_at": "2026-12-01"}],
                [{**SOURCE, "published_at": "2016-10-01"}], [{**SOURCE, "url": "https://archive.ph/x"}],
                [{**SOURCE, "published_at": "2026-10-07T08:30:00+02:00"}], ["x"], "x", None,
                [{**SOURCE, "title": "t" * 201}], [{**SOURCE, "url": "  https://example.com/a  "},
                                                   {**SOURCE, "url": "https://example.com/a"}]],
    "candidate": [None, {"symbol_or_isin": "a b"}, {"symbol_or_isin": "NEWCO.WA", "exchange": "GPW\n"},
                  {"symbol_or_isin": "NEWCO.WA", "currency": "usd\n"}, {"symbol_or_isin": " NVDA.US "},
                  {"symbol_or_isin": "X", "extra": 1}, "NVDA", {"symbol_or_isin": "N" * 41}],
    "details": [None, {"price_target": 120}, {"criteria": []}, {"scale": "large"}, {"event": "wyniki Q3"},
                {"event": "wyniki", "event_date": "2028-01-01"}, {"event_date": "bad"}, {"event_date": 20261022},
                {"headline": "Akcje wzrosną jeszcze w tym roku"}, {"headline": "Krótki"},
                {"valuation": {"pe": 0}}, {"valuation": {"eps_growth": 35}}, {"valuation": {"basis": "x"}},
                {"valuation": {"pe": 15, "eps_growth": -0.00001}}, {"valuation": {"pe": True}},
                {"valuation": {"pe": 1000.00004, "pe_avg_5y": 0.10004}}, {"valuation": "x"},
                {"brief": {"headline": "Hossa"}}, {"brief": {"headline": "Rynek będzie rósł dalej", "why": "y" * 20}},
                {"brief": {"headline": "Trwa hossa na giełdach", "why": "Spółki zarabiają.", "risks": ["a", "b", "c", "d"]}},
                {"brief": {"headline": "Trwa hossa na giełdach", "why": "Spółki zarabiają coraz więcej.",
                           "supports": ["Kurs wzrośnie do 50 zł"]}},
                {"brief": {"headline": "Trwa hossa", "why": "Spółki zarabiają coraz więcej.", "target": "x"}},
                {"entry_type": "trend"}, {"criteria_version": 0}, {"context": "c" * 201}, "x",
                {"brief": "x"}, {"brief": {"headline": "Trwa hossa na giełdach", "why": "Spółki zarabiają coraz.",
                                           "supports": "x"}}],
}


def note_json(note: V.NoteInput) -> dict:
    return {
        "kind": note.kind,
        "polarity": note.polarity,
        "strength": note.strength,
        "thesis_relation": note.thesis_relation,
        "title": note.title,
        "summary": note.summary,
        "sources": note.sources_json(),
        "theme": note.theme,
        "thesis_field": note.thesis_field,
        "observed_at": iso(note.observed_at),
        "expires_in_days": note.expires_in_days,
        "expires_at": note.expires_at(NOW).isoformat(),
        "details": floats_as_repr(note.details),
        "candidate": None if note.candidate is None else {**note.candidate.as_json(), "key": note.candidate.key},
        "segment": note.segment,
    }


def floats_as_repr(value: object) -> object:
    """Floats as ``{"float": repr}`` (JSON cannot tell 15.0 from 15; Python can)."""
    if isinstance(value, float):
        return {"float": repr(value)}
    if isinstance(value, dict):
        return {k: floats_as_repr(v) for k, v in value.items()}
    if isinstance(value, list):
        return [floats_as_repr(v) for v in value]
    return value


def outcome(fn: Callable[[], object]) -> object:
    try:
        return {"ok": fn()}
    except V.ResearchInputError as e:
        return {"issues": [list(i) for i in e.issues], "message": str(e)}


def gen_notes(rng: random.Random) -> list:
    rows = []
    for base in BASE_NOTES:
        rows.append([base, outcome(lambda b=base: note_json(V.validate_note(b, now=NOW)))])
    for _ in range(1400):
        raw = json.loads(json.dumps(rng.choice(BASE_NOTES)))
        for _ in range(rng.randrange(1, 4)):
            key = rng.choice(list(FIELD_VALUES))
            value = rng.choice(FIELD_VALUES[key])
            if value is None and rng.random() < 0.5:
                raw.pop(key, None)
            else:
                raw[key] = json.loads(json.dumps(value))
        rows.append([raw, outcome(lambda r=raw: note_json(V.validate_note(r, now=NOW)))])
    return rows


SCOPES: list = [
    None, {}, {"themes": ["Banki", "banki", "Energia"], "scheduled": True}, {"everything": True},
    {"held": "yes"}, {"held": False, "segments": ["gold", "gold", "crypto"]}, {"segments": ["Złoto"]},
    {"segments": "gold"}, {"full_refresh": True, "scheduled": True}, {"full_refresh": True},
    {"full_refresh": "yes"}, {"instruments": ["NVDA", 12, True, 1.5, "", "x" * 41, " PKN ", "NVDA"]},
    {"instruments": "NVDA"}, {"instruments": ["a"] * 101}, {"themes": ["ΣΑΣ", "σας", "Straße", "STRASSE", "x"]},
    {"themes": "x"}, {"themes": [5, None, True, ["a"]]}, {"segments": [], "instruments": []},
    {"held": None}, {"scheduled": 1}, {"segments": ["macro_risk", "gold", "uranium"]},
    {"segments": list(segments.NOTE_SEGMENT_KEYS) + ["gold"]}, {"watchlist": False, "candidates": True},
    {"zeta": 1, "alpha": 2},
]
COUNTS: list = [
    None, {}, {"sources_checked": 12}, {"notes": 5}, {"skipped": -1}, {"skipped": 100001},
    {"skipped": True}, {"skipped": 1.5}, {"segments_covered": 4, "themes_covered": 1},
    {"skipped": "1", "sources_checked": 2}, {"sources_checked": 1, "zzz": 1, "skipped": "x"},
]
VIEW_TEXTS = [
    "Popyt na chipy do AI rośnie; IDC szacuje 627 mld USD w 2030.",
    "Rynek robotów w 2-4 lat, Q3 2026, bez liczb poza horyzontem.",
    "kurs akcji spółki wzrośnie w tym roku po wynikach kwartalnych",
    "krótko",
    "x" * 401,
    None,
    "Instalacje robotów will reach 575,000 według IFR w 2026 roku.",
    "Sprzedaż robotów rośnie, a kup teraz jest zakazane w tym tekście.",
    "Line one\r\n\r\n\r\n\r\nline two of a market view text",
    "Rynek ładowarek rośnie o +4% rocznie do 2030 według BNEF.",
]


def gen_runs(rng: random.Random) -> list:
    rows = []
    for scope in SCOPES:
        rows.append(["scope", scope, outcome(lambda s=scope: vars_of(V.validate_scope(s)))])
    for counts in COUNTS:
        rows.append(["counts", counts, outcome(lambda c=counts: V.validate_counts(c))])
    for text in VIEW_TEXTS:
        rows.append(["assessment", text, outcome(lambda t=text: V.validate_assessment(t))])
        rows.append(["outlook", text, outcome(lambda t=text: V.validate_outlook(t))])
        rows.append(["outlook_q", text, outcome(lambda t=text: V.validate_outlook(t, quantitative=True))])
    for sources in FIELD_VALUES["sources"] + [[SOURCE] * 7, [SOURCE]]:
        rows.append(["view_sources", sources, outcome(lambda s=sources: V.validate_view_sources(s, now=NOW))])
    return rows


def vars_of(scope: V.RunScope) -> dict:
    return {
        "held": scope.held,
        "watchlist": scope.watchlist,
        "candidates": scope.candidates,
        "themes": list(scope.themes),
        "segments": list(scope.segments),
        "instruments": list(scope.instruments),
        "scheduled": scope.scheduled,
        "full_refresh": scope.full_refresh,
    }


# --------------------------------------------------------------------------------------- scoring


def gen_scoring(rng: random.Random) -> list:
    kinds = ["news", "earnings", "community", "trend", "macro", "candidate"]
    relations = list(scoring.RELATIONS) + ["community", "bogus"]
    rows = []
    for _ in range(400):
        at = NOW - dt.timedelta(days=rng.randrange(0, 20), hours=rng.randrange(24))
        notes = []
        for i in range(rng.randrange(0, 12)):
            observed = at - dt.timedelta(days=rng.uniform(-3, 70))
            observed = observed.replace(microsecond=0)
            created = observed + dt.timedelta(hours=rng.randrange(-5, 300))
            dismissed = None if rng.random() < 0.7 else created + dt.timedelta(hours=rng.randrange(1, 400))
            notes.append(
                scoring.ScoredNote(
                    id=rng.randrange(1, 30),
                    kind=rng.choice(kinds),
                    polarity=rng.choice(["positive", "negative", "neutral", "other"]),
                    strength=rng.randrange(-1, 6),
                    thesis_relation=rng.choice(relations),
                    observed_at=observed,
                    created_at=created,
                    expires_at=observed + dt.timedelta(days=rng.randrange(1, 90)),
                    dismissed_at=dismissed,
                )
            )
        changed = None if rng.random() < 0.5 else at - dt.timedelta(days=rng.randrange(0, 40))
        has_thesis = rng.random() < 0.85
        researched = rng.random() < 0.3
        weeks = scoring.sentiment_weeks(notes, at)
        health = scoring.thesis_health(
            notes, at, has_thesis=has_thesis, thesis_changed_at=changed, researched=researched
        )
        rows.append(
            [
                at.isoformat(),
                [[n.id, n.kind, n.polarity, n.strength, n.thesis_relation, iso(n.observed_at),
                  iso(n.created_at), iso(n.expires_at), iso(n.dismissed_at)] for n in notes],
                iso(changed),
                [has_thesis, researched],
                health_args(health),
                weeks,
                scoring.direction(weeks).value,
                [scoring.iso_week(at.date()), scoring.week_start(at.date()).isoformat()],
            ]
        )
    return rows


def health_args(h: scoring.HealthResult) -> list:
    return [h.state.value, h.counts, h.relation, list(h.note_ids), h.predates_thesis]


# --------------------------------------------------------------------------------------- signals


def gen_signals(rng: random.Random) -> list:
    rows: list = []
    for lang in ("pl", "en"):
        with i18n.use_language(lang):
            for count in list(range(0, 30)) + [101, 102, 104, 111, 112, 114, 122, 1000, -1, -2]:
                rows.append(["sources", lang, count, signals.sources_phrase(count)])
            for kind in list(signals.KIND_LABEL) + ["other"]:
                for relation in list(scoring.RELATIONS) + [None, "x"]:
                    rows.append(["message", lang, [kind, relation, "Tytuł", 3, 2],
                                 signals.research_message(kind, relation, "Tytuł", 3, 2)])
    for _ in range(150):
        week_start = NOW - dt.timedelta(days=rng.randrange(0, 10))
        notes = []
        for i in range(rng.randrange(1, 6)):
            created = week_start + dt.timedelta(hours=rng.randrange(-30, 30))
            details = rng.choice([None, {}, {"headline": "  Krótko o tym  "}, {"headline": ""},
                                  {"brief": {"headline": "Z briefu"}}, {"headline": [], "brief": {"headline": "B"}},
                                  {"headline": "   ", "brief": {"headline": "C"}}, {"brief": "x"}, "x"])
            notes.append(
                InvResearchNote(
                    id=rng.choice([None, rng.randrange(1, 50)]),
                    profile_id=1,
                    kind=rng.choice(["news", "earnings", "community", "trend", "macro", "candidate"]),
                    polarity=rng.choice(["positive", "negative", "neutral"]),
                    strength=rng.randrange(1, 4),
                    thesis_relation=rng.choice(["invalidates", "weakens", "supports", "none", "fulfills"]),
                    thesis_field=rng.choice([None, "thesis"]),
                    title=rng.choice(["Premiera przesunięta", "Słabszy kwartał", "Forum"]),
                    summary="s",
                    sources=[{"url": "u"}] * rng.randrange(0, 4),
                    details=details,
                    instrument_id=rng.choice([None, 3, 12]),
                    segment=rng.choice([None, "gold", "macro_rates", "unknown_key"]),
                    theme=rng.choice([None, "Półprzewodniki", "Energia"]),
                    created_at=created,
                    observed_at=created,
                    expires_at=created + dt.timedelta(days=rng.randrange(-2, 30)),
                    dismissed_at=None if rng.random() < 0.8 else created,
                )
            )
        at = week_start + dt.timedelta(days=1)
        lang = rng.choice(["pl", "en"])
        key = signals.note_key(notes[0]) or "research:2026-W41|t:x"
        with i18n.use_language(lang):
            candidate = signals.candidate_for(key, notes, at)
        rows.append(
            [
                "candidate",
                lang,
                at.isoformat(),
                key,
                [note_row(n) for n in notes],
                [[None if (s := signals.severity_of(n, at)) is None else s.value, signals.note_key(n)] for n in notes],
                None if candidate is None else candidate_row(candidate),
            ]
        )
    for week, kwargs in [("2026-W41", {"segment": "gold"}), ("2026-W41", {"instrument_id": 3, "segment": "gold"}),
                         ("2026-W41", {"theme": "energia"}), ("2026-W41", {})]:
        rows.append(["key", week, {k: (str(v) if k == "instrument_id" else v) for k, v in kwargs.items()},
                     keys.research_dedup_key(week, **kwargs)])
    for value in ["research:news", "research:", "researc", "", None, "x:research:"]:
        rows.append(["is_key", value, keys.is_research_key(value)])
    return rows


def note_row(n: InvResearchNote) -> dict:
    return {
        "id": n.id,
        "kind": n.kind,
        "polarity": n.polarity,
        "strength": n.strength,
        "thesis_relation": n.thesis_relation,
        "thesis_field": n.thesis_field,
        "title": n.title,
        "sources": n.sources,
        "details": n.details,
        "instrument_id": None if n.instrument_id is None else str(n.instrument_id),
        "segment": n.segment,
        "theme": n.theme,
        "created_at": iso(n.created_at),
        "expires_at": iso(n.expires_at),
        "dismissed_at": iso(n.dismissed_at),
    }


def candidate_row(c) -> dict:
    return {
        "rule_id": c.rule_id,
        "kind": c.kind,
        "dedup_key": c.dedup_key,
        "severity": c.severity.value,
        "message": c.message,
        "instrument_id": c.instrument_id,
        "payload": pairs(dict(c.payload)),
        "polarity": c.polarity.value,
    }


# --------------------------------------------------------------------------------------- segments


def gen_segments(rng: random.Random) -> list:
    from cashu.modules.investments.domain import AssetClass, Instrument, InstrumentAlias

    rows: list = []
    symbols = ["GDXJ", "GDXJ.L", "gdxj.us", "XETR:SXR8", " vwce.de ", "CDR", "BTC", "BTC-USD", "USDT-USD",
               "usdc", "DAI.X", "ETH-USD", None, "", "SIL", "TLT", "XLE", "IPRP.L", "ß", "ﬁ"]
    aliases = [[], [("yahoo", "SIL")], [("xtb", "GDX.US")], [("stooq", "tlt.us")], [("yahoo", "")],
               [("yahoo", "USDT-USD")], [("isin", "GLD")]]
    for asset_class in AssetClass:
        for symbol in symbols:
            alias = rng.choice(aliases)
            inst = Instrument(id="1", name="Example fund", currency="USD", asset_class=asset_class,
                              symbol=symbol, aliases=tuple(InstrumentAlias(ns, v) for ns, v in alias))
            explicit = rng.choice([None, "metals", "uranium", "old_key", "macro_risk", "Gold"])
            set_by = rng.choice([None, "owner", "agent", "bot"])
            rows.append(["auto", asset_class.value, symbol, alias, segments.auto_segment(inst), explicit, set_by,
                         list(segments.segment_of(inst, explicit, set_by))])
    for lang in ("pl", "en"):
        with i18n.use_language(lang):
            for key in list(segments.NOTE_SEGMENT_KEYS) + [segments.UNASSIGNED, "nope", "uranium"]:
                rows.append(["label", lang, key, segments.segment_label(key), segments.segment_group(key),
                             segments.catalog_order(key), segments.is_segment(key), segments.is_macro_key(key),
                             segments.is_note_segment(key), segments.regime_of(key)])
            rows.append(["catalog", lang, segments.catalog(), segments.macro_catalog()])
    return rows


GENERATORS: dict[str, tuple[Callable[[random.Random], list], str]] = {
    "research-wordlists": (gen_wordlists, "[name, sha256 of the canonical JSON, value]"),
    "research-classes": (
        gen_classes,
        "[w|d|s|dot|casefold|nfkd|nfkc, block hashes] or [ignorecase, unit, code points < 0x10000]",
    ),
    "research-phrases": (
        gen_phrases,
        "[text, advice, claim, forecast, market_view, attributed, quantitative, sentences, {pattern: matches}]",
    ),
    "research-urls": (gen_urls, "[url, check_url]"),
    "research-moments": (gen_moments, "[text, parse_moment isoformat | null | {error}]"),
    "research-text": (
        gen_text,
        "[text, clean_theme, theme_key, tokens, tokens(numbers), directions, numbers, body(text, text[:10]),"
        " bare_symbol, strategy fold, strategy kind, casefold]",
    ),
    "research-sections": (gen_sections, "[markdown, [[kind, heading, text]]]"),
    "research-notes": (gen_notes, "[raw, {ok: note} | {issues, message}]"),
    "research-runs": (gen_runs, "[kind, raw, {ok} | {issues, message}]"),
    "research-scoring": (
        gen_scoring,
        "[at, notes, thesis_changed_at, [has_thesis, researched], health [state, counts, relation, ids, predates], weeks, direction,"
        " [iso_week, week_start]]",
    ),
    "research-signals": (gen_signals, "[sources|message|candidate|key|is_key, ...]"),
    "research-segments": (gen_segments, "[auto|label|catalog, ...]"),
}


def render(name: str) -> str:
    fn, layout = GENERATORS[name]
    rng = random.Random(f"{SEED}:{name}")
    rows = fn(rng)
    meta = {
        "meta": {
            "name": name,
            "count": len(rows),
            "layout": layout,
            "seed": SEED,
            "generator": "parity/python/generators/domain/research_vectors.py",
            "python": sys.version.split()[0],
            "unicode": unicodedata.unidata_version,
        }
    }
    lines = [json.dumps(meta, ensure_ascii=True)]
    lines += [json.dumps(row, ensure_ascii=True, separators=(",", ":")) for row in rows]
    return "\n".join(lines) + "\n"


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail when a committed file differs")
    parser.add_argument("--only", action="append", help="generate only these files")
    args = parser.parse_args(list(argv) if argv is not None else None)
    OUT.mkdir(parents=True, exist_ok=True)
    stale = []
    for name in args.only or GENERATORS:
        text = render(name)
        path = OUT / f"{name}.jsonl"
        if args.check:
            if not path.exists() or path.read_text(encoding="utf-8") != text:
                stale.append(name)
            continue
        path.write_text(text, encoding="utf-8")
        print(f"{name}: {text.count(chr(10)) - 1} vectors, {len(text.encode()) // 1024} KiB")
    if stale:
        print("stale vector files: " + ", ".join(stale))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
