#!/usr/bin/env python3
"""Synthetic parity vectors for the TypeScript loans and assets port (scope S11).

    .venv/bin/python parity/python/vectors_loans_assets.py            # writes the vectors
    .venv/bin/python parity/python/vectors_loans_assets.py --check    # regenerates in memory, fails on any diff

Writes into ``packages/domain/test/vectors/``:

- ``loans-assets-matching-data.jsonl``: the Polish installment phrases and the module literals read from
  the LIVE Python objects, with the sha256 of their canonical serialisation;
- ``loans-amortization.jsonl``: ``amortization.summarize`` over random and edge terms (the schedule as a
  sha256 digest of its rows plus its first and last row);
- ``loans-valuation.jsonl``: ``loan_valuation`` (balances recorded before / after the terms, several per
  day) probed at many dates (``at``, ``scheduled``, ``source``);
- ``assets-depreciation.jsonl`` (default tier) and ``assets-depreciation-sweep.jsonl`` (exhaustive tier):
  ``depreciation.value`` over random curves and ages, Python's float ``**`` against V8's.

Every input is synthetic (random with a fixed seed plus hand-picked edge cases); nothing reads a data dir
(``loan_valuation`` runs on an in-memory SQLite engine). File format as ``vectors.py``: JSON Lines, line 1
``{"meta": {...}}``, then one JSON array per vector (layout in ``meta.layout``). Errors are
``{"error": "<class>"}``.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import random
import sys
import unicodedata
from collections.abc import Iterable
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

from sqlmodel import Session, SQLModel, create_engine

import cashu.models  # noqa: F401  (registers every table for create_all)
from cashu.core.models import Balance, Source
from cashu.modules.assets import depreciation
from cashu.modules.assets import service as assets_service
from cashu.modules.assets.models import NOTE_MAX
from cashu.modules.loans import amortization, patterns
from cashu.modules.loans import service as loans_service
from cashu.modules.loans.models import Loan
from cashu.modules.loans.valuation import loan_valuation

SEED = 20261103
SOURCES = (Source.MANUAL, Source.CSV, Source.OPEN_BANKING, Source.CONNECTOR)
OUT = ROOT / "packages" / "domain" / "test" / "vectors"

if sys.version_info < (3, 14):
    raise SystemExit("vectors_loans_assets.py needs Python 3.14+ (decimal behaviour is pinned)")


# --------------------------------------------------------------------------- matching data


def matching_data() -> dict:
    """The literals from the live Python objects (never retyped)."""
    return {
        "installment_phrases": [list(p) for p in patterns.INSTALLMENT_PHRASES],
        "loans_category": patterns.LOANS_CATEGORY,
        "loan_types": [str(t) for t in loans_service.LOAN_TYPES],
        "manual_prefixes": list(assets_service.MANUAL_PREFIXES),
        "note_max": NOTE_MAX,
        "days_per_year": depreciation.DAYS_PER_YEAR,
    }


def gen_matching_data(_rng: random.Random) -> list:
    obj = matching_data()
    text = json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return [["matching", obj, hashlib.sha256(text.encode("utf-8")).hexdigest()]]


# --------------------------------------------------------------------------- amortization


def _row(r) -> list:
    return [r.n, r.date.isoformat(), str(r.payment), str(r.interest), str(r.principal), str(r.balance)]


def schedule_digest(rows) -> str:
    text = "".join("|".join(str(x) for x in _row(r)) + "\n" for r in rows)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _rand_day(rng: random.Random, start: dt.date, span_days: int) -> dt.date:
    return start + dt.timedelta(days=rng.randrange(span_days))


def _rand_terms(rng: random.Random) -> tuple[str, str, int, dt.date]:
    principal = str(Decimal(rng.randrange(1_000, 2_000_000_00)) / 100 if rng.random() < 0.5
                    else Decimal(rng.randrange(1, 900) * 1000))
    rate = rng.choice(["0", "0.0", "1", "2.5", "4.99", "6.27", "7.5", "8.9", "12", "18.99", "24", "0.01"])
    if rng.random() < 0.3:
        rate = str(Decimal(rng.randrange(0, 3000)) / 100)
    months = rng.choice([1, 2, 3, 6, 12, 24, 36, 48, 60, 72, 84, 120, 180, 240, 300, 360])
    start = _rand_day(rng, dt.date(2015, 1, 1), 5000)
    if rng.random() < 0.2:  # a month-end start: the schedule clamps the day in shorter months
        start = rng.choice([dt.date(2016, 1, 31), dt.date(2020, 2, 29), dt.date(2019, 3, 30), dt.date(2023, 8, 31)])
    return principal, rate, months, start


def amortization_case(principal: str, rate: str, months: int, start: dt.date, as_of: dt.date,
                      origination: dt.date | None) -> list:
    s = amortization.summarize(Decimal(principal), Decimal(rate), months, start, as_of,
                               origination_date=origination)
    first = _row(s.schedule[0]) if s.schedule else None
    last = _row(s.schedule[-1]) if s.schedule else None
    return [
        principal, rate, months, start.isoformat(), as_of.isoformat(),
        origination.isoformat() if origination else None,
        {
            "monthly_payment": str(s.monthly_payment), "outstanding": str(s.outstanding),
            "months_elapsed": s.months_elapsed, "paid_principal": str(s.paid_principal),
            "paid_interest": str(s.paid_interest), "total_interest": str(s.total_interest),
            "remaining_interest": str(s.remaining_interest), "payoff_date": s.payoff_date.isoformat(),
            "rows": len(s.schedule), "first": first, "last": last, "digest": schedule_digest(s.schedule),
        },
    ]


def gen_amortization(rng: random.Random) -> list:
    out = [
        amortization_case("60000", "8.9", 60, dt.date(2024, 11, 10), dt.date(2026, 10, 1), None),
        amortization_case("420000", "6.2", 300, dt.date(2022, 4, 5), dt.date(2026, 10, 1), dt.date(2022, 3, 14)),
        amortization_case("1000", "0", 3, dt.date(2025, 1, 31), dt.date(2025, 3, 1), None),
        amortization_case("1", "1", 1, dt.date(2025, 1, 1), dt.date(2025, 1, 1), None),
        amortization_case("0.01", "99", 12, dt.date(2024, 2, 29), dt.date(2025, 2, 28), None),
        amortization_case("400000", "6.0", 300, dt.date(2025, 1, 5), dt.date(2024, 12, 9), dt.date(2024, 12, 10)),
        amortization_case("400000", "6.0", 300, dt.date(2025, 1, 5), dt.date(2024, 12, 10), dt.date(2024, 12, 10)),
    ]
    for _ in range(193):
        principal, rate, months, start = _rand_terms(rng)
        origination = start - dt.timedelta(days=rng.randrange(1, 60)) if rng.random() < 0.4 else None
        as_of = _rand_day(rng, start - dt.timedelta(days=90), months * 31 + 200)
        out.append(amortization_case(principal, rate, months, start, as_of, origination))
    return out


# --------------------------------------------------------------------------- loan valuation


def _probes(start: dt.date, months: int, anchors: list[dt.date], rng: random.Random) -> list[dt.date]:
    ds = {start - dt.timedelta(days=40), start - dt.timedelta(days=1), start}
    for a in anchors:
        ds |= {a - dt.timedelta(days=1), a, a + dt.timedelta(days=1)}
    for _ in range(12):
        ds.add(_rand_day(rng, start - dt.timedelta(days=60), months * 31 + 120))
    return sorted(ds)


def valuation_case(engine, rng: random.Random, case: int) -> list:
    principal, rate, months, start = _rand_terms(rng)
    months = max(months, 6)
    origination = start - dt.timedelta(days=rng.randrange(1, 45)) if rng.random() < 0.4 else None
    terms_set = dt.datetime(2026, 1, 1, 12, 0, 0, tzinfo=dt.UTC) + dt.timedelta(
        seconds=rng.randrange(0, 86400 * 30))
    balances = []
    for i in range(rng.randrange(0, 7)):
        when = terms_set + dt.timedelta(seconds=rng.choice([-3600, -1, 0, 1, 60, 3600 * 24 * rng.randrange(1, 50)]))
        if rng.random() < 0.3:
            when = when.replace(microsecond=rng.randrange(0, 1_000_000))
        if rng.random() < 0.2:  # an aware value in another zone: compared as the same instant
            when = when.astimezone(dt.timezone(dt.timedelta(hours=rng.choice([-5, 1, 2]))))
        day = _rand_day(rng, start, months * 31)
        if balances and rng.random() < 0.3:
            day = dt.date.fromisoformat(balances[-1][0])  # several balances on one day
        amount = Decimal(rng.randrange(-5_000_000_00, 5_000_000_00)) / 100
        used = {b[3] for b in balances if b[0] == day.isoformat()}
        free = [src.value for src in SOURCES if src.value not in used]  # one row per (day, source)
        if not free:
            continue
        balances.append([day.isoformat(), str(amount), when.isoformat(sep=" "), rng.choice(free)])
    with Session(engine) as s:
        loan = Loan(id=case, account_id=case, principal=Decimal(principal), annual_rate=Decimal(rate),
                    term_months=months, start_date=start, origination_date=origination,
                    created_at=terms_set, updated_at=terms_set)
        s.add(loan)
        for day, amount, when, source in balances:
            s.add(Balance(account_id=case, date=dt.date.fromisoformat(day), amount=Decimal(amount),
                          currency="PLN", source=Source(source), created_at=dt.datetime.fromisoformat(when)))
        s.flush()
        lv = loan_valuation(s, loan)
        anchors = [d for d, _ in lv.anchors]
        probes = [[d.isoformat(), str(lv.at(d)), str(lv.scheduled(d)), lv.source(d)]
                  for d in _probes(start, months, anchors, rng)]
        s.rollback()
    return [
        [principal, rate, months, start.isoformat(), origination.isoformat() if origination else None,
         terms_set.isoformat(sep=" ")],
        balances,
        [[d.isoformat(), str(a)] for d, a in lv.anchors],
        probes,
    ]


def gen_valuation(rng: random.Random) -> list:
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    return [valuation_case(engine, rng, i + 1) for i in range(150)]


# --------------------------------------------------------------------------- depreciation


def depreciation_case(rng: random.Random) -> list:
    price = rng.choice([
        str(rng.randrange(1, 500_000)),
        str(Decimal(rng.randrange(1, 50_000_000)) / 100),
        str(Decimal(rng.randrange(1, 10**12)) / 1000),
    ])
    rate = rng.choice([str(rng.randrange(0, 101)), str(Decimal(rng.randrange(0, 10000)) / 100),
                       str(Decimal(rng.randrange(0, 1000)) / 10)])
    if rng.random() < 0.02:
        rate = str(rng.randrange(101, 200))  # above 100 %: Python fails at a fractional age
    purchase = _rand_day(rng, dt.date(2000, 1, 1), 9000)
    as_of = purchase + dt.timedelta(days=rng.randrange(-30, 365 * 40))
    floor = None
    if rng.random() < 0.5:
        floor = str(Decimal(rng.randrange(0, 10_000_000)) / 100)
    try:
        v: object = str(depreciation.value(Decimal(price), purchase, Decimal(rate), as_of,
                                           Decimal(floor) if floor is not None else None))
    except Exception as exc:  # noqa: BLE001 - the error class is the expected output
        v = {"error": type(exc).__name__}
    return [price, purchase.isoformat(), rate, as_of.isoformat(), floor, v]


def gen_depreciation(rng: random.Random) -> list:
    return [depreciation_case(rng) for _ in range(800)]


def gen_depreciation_sweep(rng: random.Random) -> list:
    return [depreciation_case(rng) for _ in range(16000)]


# --------------------------------------------------------------------------- output

GENERATORS = {
    "loans-assets-matching-data": (gen_matching_data, "[\"matching\", literals, sha256]"),
    "loans-amortization": (gen_amortization, ("[principal, rate, months, start, as_of, origination | null, "
                           "{summary fields as str, rows, first, last: [n, date, payment, interest, principal, "
                           "balance], digest: sha256 of the rows joined by | and newline}]")),
    "loans-valuation": (gen_valuation, ("[[principal, rate, months, start, origination | null, terms_set], "
                        "balances [[date, amount, created_at, source]] in id order, anchors [[date, amount]], "
                        "probes [[date, at, scheduled, source]]]")),
    "assets-depreciation": (gen_depreciation, "[price, purchase_date, rate, as_of, floor | null, value | {error}]"),
    "assets-depreciation-sweep": (gen_depreciation_sweep,
                                  "[price, purchase_date, rate, as_of, floor | null, value | {error}]"),
}


def render_rows(name: str, layout: str, rows: list) -> str:
    meta = {"meta": {"name": name, "count": len(rows), "layout": layout, "seed": SEED,
                     "generator": "parity/python/vectors_loans_assets.py",
                     "python": sys.version.split()[0], "unicode": unicodedata.unidata_version}}
    lines = [json.dumps(meta, ensure_ascii=False)]
    lines += [json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in rows]
    return "\n".join(lines) + "\n"


def outputs() -> dict[Path, bytes]:
    out: dict[Path, bytes] = {}
    for name, (fn, layout) in GENERATORS.items():
        rows = fn(random.Random(f"{SEED}:{name}"))
        out[OUT / f"{name}.jsonl"] = render_rows(name, layout, rows).encode("utf-8")
    return out


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail when a committed file differs")
    args = parser.parse_args(list(argv) if argv is not None else None)
    files = outputs()
    stale = []
    for path, content in files.items():
        if args.check:
            if not path.exists() or path.read_bytes() != content:
                stale.append(str(path.relative_to(ROOT)))
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    if args.check:
        if stale:
            print("stale files: " + ", ".join(sorted(stale)))
            return 1
        print(f"{len(files)} files up to date")
        return 0
    print(f"{len(files)} files written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
