#!/usr/bin/env python3
"""Differential vectors for the TS macro port (scope S20): Python is the oracle.

    .venv/bin/python packages/domain/test/macro_vectors.py           # rewrite the vectors
    .venv/bin/python packages/domain/test/macro_vectors.py --check   # fail when they would change

Writes ``packages/domain/test/vectors/macro-*.jsonl`` from ``modules/investments/macro``
(``regimes``, ``texts``, ``series``, ``service.regime_dict`` / ``changes``, ``refresh`` constants).
Everything is synthetic: piecewise geometric series described by a small spec (the TS test rebuilds
the same closes from it with the same float operations), hand-picked and seeded random numbers, and
synthetic regimes; no data dir or database is opened.

Format (as ``research_vectors.py``): JSON Lines, line 1 ``{"meta": {...}}`` with the count and the
row layout, then one JSON array per vector, ASCII (``ensure_ascii``).
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import random
import sys
import unicodedata
from collections.abc import Callable, Iterable
from pathlib import Path

from cashu.core.i18n import use_language
from cashu.modules.investments.macro import refresh, series, service
from cashu.modules.investments.macro import regimes as rg
from cashu.modules.investments.macro import texts as tx

SEED = 2020
ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "packages" / "domain" / "test" / "vectors"
LANGS = ("pl", "en")


def canon(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def pairs(mapping: dict) -> list:
    """A dict as [key, value] pairs (key order is part of the contract)."""
    return [[k, v] for k, v in mapping.items()]


def iso(day: dt.date | None) -> str | None:
    return None if day is None else day.isoformat()


# --------------------------------------------------------------------------------------- tables


def gen_tables(_rng: random.Random) -> list:
    tables: dict[str, object] = {
        "ORDER": list(rg.ORDER),
        "LABELS": pairs(rg.LABELS),
        "LABELS_EN": pairs(rg.LABELS_EN),
        "STATES": [
            [k, [[s, lbl, tone] for s, (lbl, tone) in v.items()]] for k, v in rg.STATES.items()
        ],
        "STATES_EN": [[k, pairs(v)] for k, v in rg.STATES_EN.items()],
        "MEANINGS": [[k, pairs(v)] for k, v in rg.MEANINGS.items()],
        "MEANINGS_EN": [[k, pairs(v)] for k, v in rg.MEANINGS_EN.items()],
        "FIXED": [
            rg.UNKNOWN,
            rg.UNKNOWN_LABEL,
            rg.UNKNOWN_LABEL_EN,
            rg.INVERTED,
            rg.INVERTED_SUFFIX,
            rg.INVERTED_SUFFIX_EN,
            rg.UNKNOWN_MEANING,
            rg.UNKNOWN_MEANING_EN,
            rg.INVERTED_MEANING,
            rg.INVERTED_MEANING_EN,
        ],
        "METRIC_LABELS": sorted(rg.METRIC_LABELS),
        "METRIC_LABELS_EN": pairs(rg.METRIC_LABELS_EN),
        "CONSTANTS": [
            rg.MIN_BARS,
            rg.MA_WINDOW,
            rg.SLOPE_LAG,
            rg.PEAK_WINDOW,
            rg.SIX_MONTHS,
            rg.TWELVE_MONTHS,
            rg.THREE_MONTHS,
            rg.HOLD_SESSIONS,
            rg.STALE_DAYS,
            rg.HISTORY_MAX,
            rg.TOLERANCE,
            rg.WEEK_DAYS,
            rg.BEAR_DRAWDOWN,
            rg.CORRECTION_DRAWDOWN,
            rg.DOLLAR_MOVE,
            rg.EM_RELATIVE,
            rg.COMMODITY_MOVE,
            rg.RATES_MOVE,
            tx.SUMMARY_MAX,
            service.DIGITS,
            series.BACKFILL_DAYS,
            refresh.TIMEOUT_SECONDS,
            refresh.MAX_RETRIES,
        ],
        "SERIES": [[s.key, s.symbol, s.meaning, s.unit, s.adjusted] for s in series.SERIES],
        "USDPLN": series.USDPLN,
        "SKIPPED_MESSAGE": refresh.SKIPPED_MESSAGE,
        "MONTHS_GENITIVE": list(tx.MONTHS_GENITIVE),
        "MONTHS_EN": list(tx.MONTHS_EN),
        "SUMMARY_FIXED": [
            tx.UNKNOWN_SUMMARY,
            tx.UNKNOWN_SUMMARY_EN,
            tx.INVERTED_SENTENCE,
            tx.INVERTED_SENTENCE_EN,
            tx.PLAIN_INVERTED,
            tx.PLAIN_INVERTED_EN,
            tx.PLAIN_UNKNOWN,
            tx.PLAIN_UNKNOWN_EN,
        ],
        "HEADS": [
            ["risk", pairs(tx._RISK_HEAD)],
            ["dollar", pairs(tx._DOLLAR_HEAD)],
            ["em", pairs(tx._EM_HEAD)],
            ["commodities", pairs(tx._COMMODITIES_HEAD)],
            ["rates", pairs(tx._RATES_HEAD)],
        ],
        "HEADS_EN": [[k, pairs(v)] for k, v in tx._HEAD_EN.items()],
        "INTRO": pairs(tx.INTRO),
        "INTRO_EN": pairs(tx.INTRO_EN),
        "RULE": pairs(tx.RULE),
        "RULE_EN": pairs(tx.RULE_EN),
        "PLAIN": [[k, pairs(v)] for k, v in tx.PLAIN.items()],
        "PLAIN_EN": [[k, pairs(v)] for k, v in tx.PLAIN_EN.items()],
        "VOCABULARY": sorted(tx.vocabulary()),
    }
    return [
        [name, hashlib.sha256(canon(value).encode()).hexdigest(), value]
        for name, value in tables.items()
    ]


# --------------------------------------------------------------------------------------- formats

EDGE = [
    0.0,
    -0.0,
    0.0412,
    -0.0412,
    -0.0004,
    0.0005,
    0.00049,
    0.00051,
    0.0995,
    0.1,
    -0.0999,
    0.125,
    0.135,
    6.25,
    6.35,
    -0.04,
    -0.05,
    0.05,
    45.4,
    -12.6,
    -0.4,
    0.5,
    1.5,
    2.5,
    1234.5,
    98.44,
    5.231,
    -0.051,
    4.231,
    123456.789,
    -98765.4321,
    1e-7,
    -1e-7,
    0.0049999999,
]


def gen_formats(rng: random.Random) -> list:
    values = list(EDGE)
    for _ in range(300):
        magnitude = 10 ** rng.uniform(-5, 5)
        value = magnitude if rng.random() < 0.5 else -magnitude
        if rng.random() < 0.3:
            value = round(value, rng.randint(0, 4)) + rng.choice((0.0, 0.005, -0.005, 0.05))
        values.append(value)
    rows = []
    for value in values:
        for lang in LANGS:
            with use_language(lang):
                for unit, decimals, suffix in (
                    ("pct", 1, ""),
                    ("pp", 1, ""),
                    ("bp", 0, ""),
                    ("level", 1, ""),
                    ("level", 2, " %"),
                    ("level", 0, " pkt"),
                ):
                    metric = rg.Metric("x", value, unit, decimals=decimals, suffix=suffix)
                    rows.append(
                        ["metric", lang, value, [unit, decimals, suffix], rg.format_metric(metric)]
                    )
                rows.append(["pct", lang, value, [True], tx.pct(value)])
                rows.append(["pct", lang, value, [False], tx.pct(value, signed=False)])
                rows.append(["pp", lang, value, [1], tx.pp(value)])
                rows.append(["bond", lang, value, [], rg.bond_equivalent(value)])
    return rows


# --------------------------------------------------------------------------------------- series cases

START = dt.date(2021, 1, 4)
GROWTHS = (0.996, 0.998, 0.999, 0.9995, 1.0, 1.0005, 1.001, 1.002, 1.004)


def weekdays(start: dt.date, n: int) -> list[dt.date]:
    out, day = [], start
    while len(out) < n:
        if day.weekday() < 5:
            out.append(day)
        day += dt.timedelta(days=1)
    return out


def build(spec: dict) -> list[tuple[dt.date, float]]:
    """The closes of one series spec (mirrored by ``buildCloses`` in the TS test)."""
    days = weekdays(dt.date.fromisoformat(spec["start"]), spec["n"])
    values: list[float] = []
    value = spec["p0"]
    for length, growth in spec["segments"]:
        for _ in range(length):
            values.append(value)
            value *= growth
    points = []
    drop = spec.get("drop")
    for i, (day, v) in enumerate(zip(days, values, strict=True)):
        if drop is not None and i % drop[0] == drop[1]:
            continue
        points.append((day, v))
    for i in spec.get("zero", []):
        if i < len(points):
            points[i] = (points[i][0], 0.0)
    return points


def segments(rng: random.Random, n: int, flips: bool) -> list:
    out, total = [], 0
    while total < n:
        if flips and rng.random() < 0.25:
            length = rng.randint(2, 7)
        else:
            length = rng.randint(15, 160)
        length = min(length, n - total)
        out.append([length, rng.choice(GROWTHS)])
        total += length
    return out


def series_spec(rng: random.Random, n: int, p0: float, *, flips: bool) -> dict:
    spec: dict = {"start": START.isoformat(), "n": n, "p0": p0, "segments": segments(rng, n, flips)}
    if rng.random() < 0.2:
        m = rng.randint(5, 13)
        spec["drop"] = [m, rng.randrange(m)]
    if rng.random() < 0.05:
        spec["zero"] = [rng.randrange(n // 2)]
    return spec


def case_spec(rng: random.Random) -> dict:
    n = rng.choice((240, 300, 420, 600, 800))
    flips = rng.random() < 0.6
    specs: dict[str, dict] = {}
    bases = {
        "acwi": 100.0,
        "spx": 5000.0,
        "dxy": 100.0,
        "eem": 40.0,
        "dbc": 20.0,
        "us10y": rng.uniform(1.0, 5.0),
        series.USDPLN: 4.0,
    }
    for key, p0 in bases.items():
        if rng.random() < 0.1:
            continue  # a missing series
        length = n if rng.random() < 0.8 else rng.randint(120, n)
        specs[key] = series_spec(rng, length, p0, flips=flips)
    if "us10y" in specs and rng.random() < 0.9:
        us3m = series_spec(
            rng, specs["us10y"]["n"], specs["us10y"]["p0"] + rng.uniform(-0.8, 0.4), flips=flips
        )
        specs["us3m"] = us3m
    return specs


def regimes_dicts(regimes, lang: str, currency) -> list:
    with use_language(lang):
        cards = [service.regime_dict(r, currency if r.key == "dollar" else None) for r in regimes]
    for card in cards:
        del card["explain"]  # static intro + rule + state: covered by macro-texts
    return cards


def changes_of(closes: dict, start: dt.date, end: dt.date, lang: str) -> list:
    original = service.regimes
    service.regimes = lambda _session, as_of=None: rg.evaluate(closes, as_of)
    try:
        with use_language(lang):
            return service.changes(None, start, end)
    finally:
        service.regimes = original


def gen_cases(rng: random.Random) -> list:
    rows = []
    for _ in range(70):
        specs = case_spec(rng)
        closes = {key: build(spec) for key, spec in specs.items()}
        last = max((d for points in closes.values() for d, _ in points), default=START)
        as_ofs = [last + dt.timedelta(days=rng.choice((0, 0, 1, 3, 6, 9)))]
        as_ofs.append(last - dt.timedelta(days=rng.randint(1, 120)))
        for as_of in as_ofs:
            currency = None
            if rng.random() < 0.6:
                currency = tx.CurrencyEffect(
                    rng.choice((0.0, 0.0004, -0.0042, 0.006, rng.uniform(-0.03, 0.03))),
                    rng.random() < 0.8,
                )
            found = rg.evaluate(closes, as_of)
            cards = {lang: regimes_dicts(found, lang, currency) for lang in LANGS}
            full = [
                [
                    r.key,
                    [[iso(h.date), h.state, iso(h.confirmed), h.open] for h in r.history],
                    r.usdpln_1w,
                ]
                for r in found
            ]
            starts = sorted({as_of - dt.timedelta(days=rng.randint(1, 400)) for _ in range(4)})
            changes = [
                [iso(s), changes_of(closes, s, as_of, "pl"), changes_of(closes, s, as_of, "en")]
                for s in starts
            ]
            rows.append(
                [
                    specs,
                    iso(as_of),
                    None if currency is None else [currency.contribution, currency.foreign],
                    cards["pl"],
                    cards["en"],
                    full,
                    changes,
                ]
            )
    return rows


# --------------------------------------------------------------------------------------- texts

METRIC_UNITS = {
    "ACWI wobec 200 sesji": "pct",
    "od szczytu": "pct",
    "S&P 500 od szczytu": "pct",
    "DXY": "level",
    "6 mies.": "pct",
    "USD/PLN 6 mies.": "pct",
    "EEM wobec ACWI 6 mies.": "pp",
    "EEM 6 mies.": "pct",
    "DBC 12 mies.": "pct",
    "wobec ACWI 12 mies.": "pp",
    "USA 10 lat": "level",
    "3 mies. zmiana": "bp",
    "krzywa 10l-3m": "bp",
}


def random_value(rng: random.Random, unit: str) -> float:
    if unit == "pct":
        return rng.choice(
            (0.0, -0.0004, 0.0995, -0.0999, rng.uniform(-0.6, 0.8), rng.uniform(-0.12, 0.12))
        )
    if unit == "pp":
        return rng.choice((0.0, -0.04, 0.05, rng.uniform(-40, 40)))
    if unit == "bp":
        return rng.choice((0.0, -0.4, 45.0, rng.uniform(-200, 200)))
    return rng.choice((rng.uniform(0.1, 15.0), rng.uniform(80, 120), 4.62, 14.62))


def random_day(rng: random.Random) -> dt.date:
    return dt.date(2019, 1, 1) + dt.timedelta(days=rng.randint(0, 2900))


def random_regime(rng: random.Random) -> rg.Regime:
    key = rng.choice(rg.ORDER)
    state = rng.choice(
        [*rg.STATES[key], rg.UNKNOWN] if rng.random() < 0.05 else list(rg.STATES[key])
    )
    label, tone = rg.STATES[key].get(state, (rg.UNKNOWN_LABEL, ""))
    labels = sorted(rg.METRIC_LABELS)
    chosen = [lbl for lbl in labels if rng.random() < 0.6]
    rng.shuffle(chosen)
    metrics = tuple(
        rg.Metric(lbl, random_value(rng, METRIC_UNITS[lbl]), METRIC_UNITS[lbl]) for lbl in chosen
    )
    since_kind = rng.randrange(3)
    day = random_day(rng)
    return rg.Regime(
        key=key,
        label=rg.LABELS[key],
        state=state,
        state_label=label,
        tone=tone,
        since=day if since_kind == 0 else None,
        metrics=metrics,
        as_of=dt.date(2026, 10, 9),
        stale=False,
        missing=rng.random() < 0.04,
        meaning=rg.MEANINGS[key].get(state, rg.UNKNOWN_MEANING),
        flags=(rg.INVERTED,) if rng.random() < 0.3 else (),
        since_open=since_kind == 1,
        since_min=day if since_kind == 1 else None,
        usdpln_1w=rng.choice((None, 0.006, -0.0123, 0.0, rng.uniform(-0.05, 0.05))),
    )


def regime_json(r: rg.Regime) -> list:
    return [
        r.key,
        r.state,
        iso(r.since),
        r.since_open,
        iso(r.since_min),
        [[m.label, m.value, m.unit] for m in r.metrics],
        list(r.flags),
        r.usdpln_1w,
        r.missing,
    ]


def gen_texts(rng: random.Random) -> list:
    rows = []
    for i in range(900):
        r = random_regime(rng)
        currency = None
        if rng.random() < 0.6:
            currency = tx.CurrencyEffect(
                rng.choice((0.0, 0.0001, -0.0042, 0.006, rng.uniform(-0.03, 0.03))),
                rng.random() < 0.8,
            )
        out = {}
        for lang in LANGS:
            with use_language(lang):
                out[lang] = [
                    tx.summary(r, currency),
                    tx.plain(r),
                    tx.explain(r) if i % 10 == 0 else None,
                ]
        rows.append(
            [
                regime_json(r),
                None if currency is None else [currency.contribution, currency.foreign],
                out["pl"],
                out["en"],
                [tx.summary_ok(out["pl"][0]), tx.summary_ok(out["en"][0])],
            ]
        )
    return rows


# --------------------------------------------------------------------------------------- summary_ok

NOISE = [
    "Jan",
    "Kowalski",
    "zł",
    "123456",
    "12 400",
    "kupuj",
    "\n",
    "  ",
    "\u2014",
    "?",
    "!",
    "_",
    "x",
    "ę",
    "²",
    "٣",
]


def gen_summary_ok(rng: random.Random) -> list:
    base = []
    for _ in range(300):
        r = random_regime(rng)
        with use_language("pl"):
            base.append(tx.summary(r, None))
    texts = [
        tx.UNKNOWN_SUMMARY,
        "1234567",
        "Jan Kowalski rosną.",
        "Dolar słabnie: 12 400 zł.",
        "",
        ".",
        "a b c.",
    ]
    for text in base:
        texts.append(text)
        words = text.split(" ")
        pos = rng.randrange(len(words) + 1)
        texts.append(" ".join(words[:pos] + [rng.choice(NOISE)] + words[pos:]))
        texts.append(text[:-1])
        texts.append(text + "\n")
        texts.append(text * 3)
        texts.append(text.replace(",", ";", 1))
    return [[text, tx.summary_ok(text)] for text in texts]


# --------------------------------------------------------------------------------------- main

GENERATORS: dict[str, tuple[Callable[[random.Random], list], str]] = {
    "macro-tables": (gen_tables, "[name, sha256 of the canonical JSON, value]"),
    "macro-formats": (gen_formats, "[metric|pct|pp|bond, lang, value, args, text]"),
    "macro-cases": (
        gen_cases,
        (
            "[series specs, as_of, currency, regime_dict pl (no explain), regime_dict en, [key, full history, usdpln_1w],"
            " [[start, changes pl, changes en]]]"
        ),
    ),
    "macro-texts": (
        gen_texts,
        "[regime, currency, [summary, plain, explain] pl, ... en, [summary_ok pl, en]]",
    ),
    "macro-summary-ok": (gen_summary_ok, "[text, summary_ok]"),
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
            "generator": "packages/domain/test/macro_vectors.py",
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
