#!/usr/bin/env python3
"""Synthetic parity vectors for the TypeScript domain primitives (scope S05).

    .venv/bin/python parity/python/vectors.py            # writes packages/domain/test/vectors/*.jsonl
    .venv/bin/python parity/python/vectors.py --check    # regenerates in memory, fails on any diff

Every value is synthetic (random with a fixed seed, plus hand-picked edge cases); nothing reads a
data dir or a database. The oracles are the real Python functions where they exist
(``core/text.py``, ``importing/dedup.py:decimal_key``, ``domain/values.py``, ``performance/report.py``)
and the standard library (``decimal`` = libmpdec, ``datetime``, ``dateutil.relativedelta``) otherwise.

File format: JSON Lines. Line 1 is ``{"meta": {...}}`` with the vector count; every other line is
one vector (a JSON array, layout documented per file in ``meta.layout``). Errors are encoded as
``{"error": "<class>"}``. The TS suite (``packages/domain/src/*.vectors.test.ts``) must reproduce
100% of them.
"""

from __future__ import annotations

# ruff: noqa: B023  (every lambda below is called at once by run(), inside its loop iteration)
import argparse
import calendar
import datetime as dt
import hashlib
import json
import math
import random
import struct
import sys
import unicodedata
from collections.abc import Callable, Iterable
from decimal import (
    ROUND_05UP,
    ROUND_CEILING,
    ROUND_DOWN,
    ROUND_FLOOR,
    ROUND_HALF_DOWN,
    ROUND_HALF_EVEN,
    ROUND_HALF_UP,
    ROUND_UP,
    Context,
    Decimal,
    DivisionByZero,
    InvalidOperation,
    Overflow,
    localcontext,
)
from pathlib import Path

from dateutil.relativedelta import relativedelta

from cashu.core.text import iban_key, normalize_iban, normalize_text
from cashu.modules.investments.domain.values import Currency, divided_by, ratio
from cashu.modules.investments.importing.dedup import decimal_key
from cashu.modules.investments.performance.report import months_back

SEED = 20261031
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "packages" / "domain" / "test" / "vectors"

ROUNDINGS = [
    ROUND_DOWN,
    ROUND_HALF_UP,
    ROUND_HALF_EVEN,
    ROUND_CEILING,
    ROUND_FLOOR,
    ROUND_UP,
    ROUND_HALF_DOWN,
    ROUND_05UP,
]
# (prec, rounding, Emin, Emax): the contexts the Python code uses, plus small ones that reach the
# rounding, subnormal and overflow branches with short numbers.
APP_CONTEXTS = [
    (28, ROUND_HALF_EVEN, -999999, 999999),  # default context
    (60, ROUND_HALF_UP, -999999, 999999),  # values.EXACT_CONTEXT
    (80, ROUND_DOWN, -999999, 999999),  # values.divided_by work context
    (40, ROUND_HALF_EVEN, -999999, 999999),  # values.ratio
    (20, ROUND_HALF_UP, -999999, 999999),  # lot_engine QUANTITY_DIGITS
]
SMALL_EMIN, SMALL_EMAX = -12, 12


def error_name(exc: BaseException) -> str:
    if isinstance(exc, InvalidOperation):
        return "InvalidOperation"
    if isinstance(exc, DivisionByZero):
        return "DivisionByZero"
    if isinstance(exc, Overflow):
        return "Overflow"
    if isinstance(exc, OverflowError):
        return "OverflowError"
    if isinstance(exc, ValueError):
        return "ValueError"
    raise exc


def run(fn: Callable[[], object]) -> object:
    try:
        return fn()
    except (ArithmeticError, ValueError) as exc:
        return {"error": error_name(exc)}


def ctx_of(spec: tuple[int, str, int, int]) -> Context:
    prec, rounding, emin, emax = spec
    return Context(prec=prec, rounding=rounding, Emin=emin, Emax=emax)


def dstr(value: object) -> object:
    if isinstance(value, Decimal):
        if not value.is_finite():
            return {"error": "NonFinite"}
        return str(value)
    return value


# --------------------------------------------------------------------------- random decimals


def rand_digits(rng: random.Random) -> str:
    bucket = rng.random()
    if bucket < 0.3:
        n = rng.randint(1, 3)
    elif bucket < 0.7:
        n = rng.randint(4, 12)
    elif bucket < 0.9:
        n = rng.randint(13, 30)
    else:
        n = rng.randint(31, 70)
    digits = "".join(rng.choice("0123456789") for _ in range(n))
    if rng.random() < 0.2:
        digits += "0" * rng.randint(1, 6)
    if rng.random() < 0.15:  # runs of 9s and 5s hit carries and ties
        digits = digits[: max(1, len(digits) - 4)] + rng.choice(
            ["9999", "5000", "4999", "5001", "5"]
        )
    return digits.lstrip("0") or "0"


def rand_exp(rng: random.Random) -> int:
    if rng.random() < 0.8:
        return rng.randint(-12, 4)
    return rng.randint(-40, 40)


def rand_dec(rng: random.Random, zero_rate: float = 0.05) -> Decimal:
    sign = rng.randint(0, 1)
    digits = "0" if rng.random() < zero_rate else rand_digits(rng)
    return Decimal((sign, tuple(int(c) for c in digits), rand_exp(rng)))


def rand_money(rng: random.Random) -> Decimal:
    """Amount-shaped: up to 9 integer digits, 0-4 decimals, as a bank export would carry."""
    places = rng.choice([0, 1, 2, 2, 2, 3, 4])
    units = rng.randint(0, 10 ** rng.randint(1, 9))
    sign = "-" if rng.random() < 0.5 else ""
    text = str(units)
    if places:
        text += "." + "".join(rng.choice("0123456789") for _ in range(places))
    return Decimal(sign + text)


EDGE_DECIMALS = [
    "0",
    "-0",
    "0.00",
    "-0.00",
    "0E+3",
    "-0E-7",
    "1",
    "-1",
    "10",
    "1E+1",
    "1E+2",
    "-1E+1",
    "1.0",
    "1.50",
    "0.5",
    "0.05",
    "0.005",
    "-0.005",
    "0.015",
    "0.025",
    "2.5",
    "3.5",
    "-2.5",
    "-3.5",
    "0.125",
    "0.375",
    "0.0001",
    "0.000001",
    "0.0000001",
    "1E-7",
    "1.23E-7",
    "123456789012345678901234567890",
    "1234567890123456789012345678",
    "12345678901234567890123456789",
    "9999999999999999999999999999",
    "99999999999999999999999999995",
    "0.1234567890123456789012345",
    "1.000000000000000000001",
    "123.456",
    "-123.456",
    "1E+30",
    "1E-30",
    "5E-31",
    "999999999999.995",
    "0.999999999999999999999",
    "100",
    "1000.000",
    "12.5",
    "-12.50",
    "125",
    "-125.5",
    "0.30",
    "3E+2",
    "1.2E+5",
    "-7E-3",
    "0.000000000000000000001",
    "100000000000000000000.5",
]


# --------------------------------------------------------------------------- decimal files


def gen_decimal_parse(rng: random.Random) -> list:
    cases = [
        "",
        " ",
        "1",
        "-1",
        "+1",
        "-0",
        "+0.00",
        "0.",
        ".5",
        "5.",
        ".",
        "-.5",
        "+.",
        "1e5",
        "1E5",
        "1e+5",
        "1e-5",
        "1E-0",
        "1e",
        "e5",
        "1e+",
        "1.5e3",
        "-1.5E-3",
        "1_000",
        "_1",
        "1__0",
        "1_",
        "_",
        "1_e5",
        "1e_5",
        "1.5e+0_1",
        " 1.5\n",
        "\t-2\r",
        "\x1c1\x1f",
        "\xa01",
        "1\u3000",
        "1 0",
        "1,5",
        "1.2.3",
        "--1",
        "+-1",
        "١٢",
        "۳.۵",
        "١٢e٣",
        "١_٢",
        "１２",
        "\U0001d7ce",
        "0x10",
        "Inf",
        "-inf",
        "Infinity",
        "+infinity",
        "infinit",
        "nan",
        "NaN",
        "-nan",
        "snan",
        "sNaN12",
        "nan12",
        "nan1_2",
        "in_f",
        "1e999999",
        "1e-999999",
        "0e999999999",
        "00012.3400",
        "-000.000",
        "1.",
        "\x00",
        "1\x00",
        "12345678901234567890123456789012345678901234567890",
        "0.0000000000000000000000000000000000000000001",
        "7E",
        "7.E1",
        "7.e-1",
        "1e1.5",
    ]
    cases += EDGE_DECIMALS
    alphabet = "0123456789" * 4 + ".-+eE_ " + "\t" + "١" + "a"
    for _ in range(1200):
        d = rand_dec(rng)
        text = str(d)
        mode = rng.random()
        if mode < 0.3:
            text = format(d, "f")
        elif mode < 0.4:
            text = text.lower()
        elif mode < 0.5:
            text = rng.choice([" ", "\t", "\n", "\xa0", ""]) + text + rng.choice([" ", "\n", ""])
        elif mode < 0.6:
            i = rng.randint(0, len(text))
            text = text[:i] + "_" + text[i:]
        cases.append(text)
    for _ in range(800):
        cases.append("".join(rng.choice(alphabet) for _ in range(rng.randint(1, 10))))
    out = []
    for text in cases:
        try:
            d = Decimal(text)
        except InvalidOperation:
            out.append([text, {"error": "InvalidOperation"}])
            continue
        if not d.is_finite():
            out.append([text, {"error": "NonFinite"}])
        else:
            sign, digits, exp = d.as_tuple()
            out.append([text, str(d), sign, "".join(map(str, digits)), exp])
    return out


def gen_decimal_format(rng: random.Random) -> list:
    specs = [
        "f",
        ".0f",
        ".1f",
        ".2f",
        ".3f",
        ".4f",
        ".10f",
        ",.2f",
        ",.0f",
        ",f",
        "+.1f",
        "+.2f",
        "+f",
        " .2f",
        "-.2f",
        "+,.2f",
    ]
    values = [Decimal(v) for v in EDGE_DECIMALS]
    values += [rand_dec(rng) for _ in range(1500)] + [rand_money(rng) for _ in range(1000)]
    out = []
    with localcontext(Context()):
        for d in values:
            row = [str(d), decimal_key(d), str(int(d)), repr(float(d))]
            row.append([format(d, spec) for spec in specs])
            out.append(row)
    return [["specs", specs]] + out


def pair(rng: random.Random) -> tuple[Decimal, Decimal]:
    a = rand_dec(rng)
    mode = rng.random()
    if mode < 0.5:
        b = rand_dec(rng)
    elif mode < 0.6:
        b = -a
    elif mode < 0.7:  # nearly equal: cancellation
        b = a.copy_negate() + Decimal(
            (rng.randint(0, 1), (rng.randint(1, 9),), a.as_tuple().exponent)
        )
    elif mode < 0.8:  # huge exponent gap (the _normalize shortcut in addition)
        b = Decimal(
            (rng.randint(0, 1), tuple(int(c) for c in rand_digits(rng)), rng.randint(-90, 90))
        )
    elif mode < 0.9:
        b = rand_money(rng)
        a = rand_money(rng)
    else:
        b = Decimal(rng.choice(EDGE_DECIMALS))
    return a, b


def gen_decimal_arith(rng: random.Random) -> list:
    out = []
    ops = {
        "add": lambda c, a, b: c.add(a, b),
        "sub": lambda c, a, b: c.subtract(a, b),
        "mul": lambda c, a, b: c.multiply(a, b),
        "div": lambda c, a, b: c.divide(a, b),
    }
    for _ in range(9000):
        op = rng.choice(list(ops))
        spec = ctx_spec(rng)
        a, b = pair(rng)
        if op == "div" and rng.random() < 0.03:
            b = Decimal(rng.choice(["0", "-0", "0.00"]))
        ctx = ctx_of(spec)
        out.append([op, list(spec), str(a), str(b), dstr(run(lambda: ops[op](ctx, a, b)))])
    return out


def ctx_spec(rng: random.Random) -> tuple[int, str, int, int]:
    r = rng.random()
    if r < 0.5:
        return APP_CONTEXTS[0] if rng.random() < 0.5 else rng.choice(APP_CONTEXTS)
    if r < 0.85:
        return (rng.choice([1, 2, 3, 5, 9, 16, 28, 34]), rng.choice(ROUNDINGS), -999999, 999999)
    return (rng.choice([1, 3, 5, 9]), rng.choice(ROUNDINGS), SMALL_EMIN, SMALL_EMAX)


def gen_decimal_unary(rng: random.Random) -> list:
    """neg / plus / abs / normalize / copy_abs / copy_negate / to_integral_value / scaleb /
    quantize / compare."""
    out = []
    for _ in range(9000):
        spec = ctx_spec(rng)
        ctx = ctx_of(spec)
        a = (
            rand_dec(rng, zero_rate=0.1)
            if rng.random() < 0.85
            else Decimal(rng.choice(EDGE_DECIMALS))
        )
        op = rng.choice(
            [
                "neg",
                "plus",
                "abs",
                "normalize",
                "copy_abs",
                "copy_negate",
                "to_integral_value",
                "scaleb",
                "quantize",
                "quantize",
                "quantize",
                "compare",
            ]
        )
        if op == "neg":
            out.append([op, list(spec), str(a), dstr(run(lambda: ctx.minus(a)))])
        elif op == "plus":
            out.append([op, list(spec), str(a), dstr(run(lambda: ctx.plus(a)))])
        elif op == "abs":
            out.append([op, list(spec), str(a), dstr(run(lambda: ctx.abs(a)))])
        elif op == "normalize":
            out.append([op, list(spec), str(a), dstr(run(lambda: ctx.normalize(a)))])
        elif op == "copy_abs":
            out.append([op, list(spec), str(a), str(a.copy_abs())])
        elif op == "copy_negate":
            out.append([op, list(spec), str(a), str(a.copy_negate())])
        elif op == "to_integral_value":
            rounding = rng.choice(ROUNDINGS)
            out.append(
                [
                    op,
                    list(spec),
                    str(a),
                    rounding,
                    dstr(run(lambda: a.to_integral_value(rounding=rounding, context=ctx))),
                ]
            )
        elif op == "scaleb":
            n = rng.randint(-40, 40)
            out.append([op, list(spec), str(a), n, dstr(run(lambda: ctx.scaleb(a, Decimal(n))))])
        elif op == "quantize":
            if rng.random() < 0.5:
                a = rand_money(rng) if rng.random() < 0.5 else a
            q_exp = rng.choice([-2, -2, -2, -1, 0, -4, -10, -3, rng.randint(-30, 5)])
            q = Decimal((0, (1,), q_exp))
            rounding = rng.choice(ROUNDINGS + [ROUND_HALF_UP, ROUND_HALF_EVEN] * 3)
            out.append(
                [
                    op,
                    list(spec),
                    str(a),
                    q_exp,
                    rounding,
                    dstr(run(lambda: a.quantize(q, rounding=rounding, context=ctx))),
                ]
            )
        else:
            b = pair(rng)[1] if rng.random() < 0.7 else a.copy_negate()
            out.append([op, list(spec), str(a), str(b), (a > b) - (a < b)])
    # deliberate quantize ties for the two app rounding modes
    for _ in range(1500):
        units = rng.randint(0, 10 ** rng.randint(1, 8))
        places = rng.randint(1, 6)
        a = Decimal(f"{rng.choice(['', '-'])}{units}.{'0' * (places - 1)}5")
        q_exp = -rng.randint(0, places)
        rounding = rng.choice(
            [ROUND_HALF_UP, ROUND_HALF_EVEN, ROUND_HALF_DOWN, ROUND_DOWN, ROUND_05UP]
        )
        spec = APP_CONTEXTS[0]
        out.append(
            [
                "quantize",
                list(spec),
                str(a),
                q_exp,
                rounding,
                dstr(run(lambda: a.quantize(Decimal((0, (1,), q_exp)), rounding=rounding))),
            ]
        )
    return out


def gen_decimal_pow(rng: random.Random) -> list:
    out = []
    with localcontext(Context()):
        for _ in range(1200):
            # loans/amortization.py: factor = (1 + i) ** n, i = annual% / 100 / 12
            annual = rand_money(rng).copy_abs() % 40
            i = annual / 100 / 12
            n = rng.randint(1, 480)
            base = Decimal(1) + i
            out.append([list(APP_CONTEXTS[0]), str(base), n, dstr(run(lambda: base**n))])
    for _ in range(1800):
        spec = ctx_spec(rng)
        ctx = ctx_of(spec)
        base = (
            rand_dec(rng, zero_rate=0.05)
            if rng.random() < 0.6
            else Decimal(
                rng.choice(
                    [
                        "1",
                        "1.0",
                        "1.000",
                        "-1",
                        "-1.00",
                        "10",
                        "0.1",
                        "2",
                        "1.1",
                        "0",
                        "-0",
                        "0.00",
                        "-2.5",
                        "1.10",
                        "3",
                        "0.5",
                    ]
                )
            )
        )
        if rng.random() < 0.3:
            base = Decimal(
                (
                    rng.randint(0, 1),
                    tuple(int(c) for c in str(rng.randint(1, 999))),
                    rng.randint(-3, 2),
                )
            )
        n = rng.choice([0, 1, 2, 3, 5, 7, 12, 30, -1, -2, -3, rng.randint(-40, 400)])
        out.append([list(spec), str(base), n, dstr(run(lambda: ctx.power(base, Decimal(n))))])
    return out


def gen_money(rng: random.Random) -> list:
    """values.divided_by, values.ratio (float repr), Currency normalisation."""
    out = []
    for _ in range(2500):
        a, b = pair(rng)
        if rng.random() < 0.4:
            a, b = rand_money(rng), rand_money(rng)
        if rng.random() < 0.03:
            b = Decimal(0)
        scale = rng.choice([10, 10, 10, 2, 4, 6, 0, 20])
        out.append(
            ["divided_by", str(a), str(b), scale, dstr(run(lambda: divided_by(a, b, scale)))]
        )
        r = run(lambda: ratio(a, b))
        out.append(
            [
                "ratio",
                str(a),
                str(b),
                r if isinstance(r, dict) else (None if r is None else repr(r)),
            ]
        )
    codes = [
        "PLN",
        "pln",
        " usd ",
        "Eur",
        "\tchf\n",
        "US",
        "USDX",
        "U S",
        "",
        "123",
        "ÄBC",
        "ąbc",
        "\xa0gbp\u3000",
        "uſd",
        "ßPL",
        "ﬁab",
        "PLN\n",
        "pın",
        "İAB",
        "\x1cPLN\x1f",
        "plń",
    ]
    for _ in range(300):
        codes.append("".join(rng.choice("aAbBzZ \t\xa0ıſß1ą") for _ in range(rng.randint(0, 5))))
    for code in codes:
        out.append(["currency", code, run(lambda: str(Currency(code)))])
    return out


# --------------------------------------------------------------------------- floats


def f2hex(x: float) -> str:
    return struct.pack(">d", x).hex()


def gen_floats(rng: random.Random) -> list:
    values = [
        0.0,
        -0.0,
        1.0,
        -1.0,
        0.1,
        0.2,
        0.3,
        1e16,
        1e15,
        9999999999999998.0,
        1234567890123456.0,
        0.0001,
        0.00001,
        1e-5,
        1.5e-5,
        1e-7,
        123.456,
        1e22,
        1e21,
        1e100,
        5e-324,
        2.2250738585072014e-308,
        1.7976931348623157e308,
        0.125,
        0.375,
        2.5,
        3.5,
        0.005,
        0.015,
        0.025,
        1.005,
        2.675,
        1e300,
        -1e-300,
        math.inf,
        -math.inf,
        math.nan,
        100.0,
        1e-4,
        9.999999999999999e15,
        0.5,
        1.5,
        12345.678,
        -0.5,
        -1.5,
    ]
    for _ in range(1500):
        bits = rng.getrandbits(64)
        values.append(struct.unpack(">d", bits.to_bytes(8, "big"))[0])
    for _ in range(1500):
        values.append(float(rand_money(rng)))
    for _ in range(500):
        values.append(rng.uniform(-1, 1) * 10 ** rng.randint(-8, 18))
    out = []
    specs = [".0f", ".1f", ".2f", ".3f", ".4f", ".6f", ",.2f", ",.0f", "+.1f"]
    for x in values:
        finite = math.isfinite(x)
        row = [f2hex(x), repr(x), str(Decimal(x)) if finite else None]
        if finite and abs(x) < 1e30:
            row.append([format(x, s) for s in specs])
            row.append([repr(round(x, n)) for n in range(7)] + [str(round(x))])
        else:
            row += [None, None]
        out.append(row)
    return [["specs", specs]] + out


# --------------------------------------------------------------------------- dates


def rand_date(rng: random.Random) -> dt.date:
    r = rng.random()
    if r < 0.75:
        start, end = dt.date(1990, 1, 1).toordinal(), dt.date(2060, 12, 31).toordinal()
    elif r < 0.85:
        return dt.date(rng.randint(1900, 2100), rng.randint(1, 12), 1) - dt.timedelta(
            days=rng.randint(0, 3)
        )
    else:
        start, end = 1, dt.date.max.toordinal()
    return dt.date.fromordinal(rng.randint(start, end))


def gen_dates(rng: random.Random) -> list:
    out = []
    edge = [
        dt.date(2024, 1, 31),
        dt.date(2024, 2, 29),
        dt.date(2023, 1, 31),
        dt.date(2000, 2, 29),
        dt.date(1900, 2, 28),
        dt.date(2024, 12, 31),
        dt.date(1, 1, 1),
        dt.date(9999, 12, 31),
        dt.date(2026, 3, 31),
        dt.date(2026, 5, 31),
        dt.date(2026, 8, 31),
        dt.date(2025, 12, 29),
        dt.date(2027, 1, 3),
        dt.date(2020, 12, 31),
        dt.date(2021, 1, 3),
    ]
    days = edge + [rand_date(rng) for _ in range(4000)]
    for d in days:
        iso = d.isocalendar()
        out.append(
            [
                "info",
                d.isoformat(),
                d.toordinal(),
                d.weekday(),
                d.isoweekday(),
                [iso[0], iso[1], iso[2]],
                f"{iso[0]}-W{iso[1]:02d}",
                (d - dt.timedelta(days=d.isoweekday() - 1)).isoformat()
                if d.toordinal() > 7
                else None,
                calendar.monthrange(d.year, d.month)[1],
            ]
        )
        for _ in range(2):
            n = rng.choice(
                [
                    1,
                    -1,
                    12,
                    -12,
                    13,
                    rng.randint(-30, 30),
                    rng.randint(-1500, 1500),
                    rng.randint(-120000, 120000),
                ]
            )
            r = run(lambda: (d + relativedelta(months=n)).isoformat())
            out.append(["add_months", d.isoformat(), n, r])
        n = rng.randint(-480, 480)
        out.append(["months_back", d.isoformat(), n, run(lambda: months_back(d, n).isoformat())])
        n = rng.choice(
            [1, -1, 7, -7, 365, rng.randint(-400, 400), rng.randint(-4_000_000, 4_000_000)]
        )
        out.append(
            ["add_days", d.isoformat(), n, run(lambda: (d + dt.timedelta(days=n)).isoformat())]
        )
        e = rand_date(rng)
        out.append(["days_between", d.isoformat(), e.isoformat(), (e - d).days])
    for _ in range(1500):
        y = rng.choice([rng.randint(1, 9999), rng.randint(1990, 2060), 0, 10000])
        w = rng.choice([rng.randint(0, 54), 52, 53, 1])
        wd = rng.choice([rng.randint(0, 8), 1, 7])
        out.append(
            [
                "fromisocalendar",
                y,
                w,
                wd,
                run(lambda: dt.date.fromisocalendar(y, w, wd).isoformat()),
            ]
        )
    texts = [
        "2026-01-01",
        "20260101",
        "2026-W01-1",
        "2026W011",
        "2026-W01",
        "2026W01",
        "2026-W53",
        "2026-W53-7",
        "2025-W53-1",
        "2026-W00",
        "20260101xx",
        "2026-W011",
        "2026W01-1",
        "2026-0101",
        "202601-01",
        "2026-1-01",
        "2026-01-1",
        "+2026-01-01",
        "2026-001",
        "2026001",
        " 2026-01-01",
        "2026-01-01 ",
        "00000101",
        "0001-01-01",
        "9999-12-31",
        "2026-13-01",
        "2026-02-29",
        "2024-02-29",
        "2026-04-31",
        "2026-00-10",
        "2026-01-00",
        "２０２６-01-01",
        "2026-01-0１",
        "2026-W01-0",
        "2026-W01-8",
        "9999-W52-5",
        "9999-W52-6",
        "0001-W01-1",
        "2026-W5x",
        "",
        "2026",
        "2026-01-01T00:00",
        "2026/01/01",
        "2026-01-01\n",
        "2026-01-01x",
        "2026-01-0x",
        "2004-W53-7",
    ]
    alphabet = "0123456789" * 3 + "-W" * 3 + " xT"
    for _ in range(2500):
        n = rng.choice([7, 8, 10, 10, 10, 9, 11])
        if rng.random() < 0.5:
            d = rand_date(rng)
            base = rng.choice(
                [
                    d.isoformat(),
                    d.strftime("%Y%m%d"),
                    d.strftime("%G-W%V-%u"),
                    d.strftime("%GW%V%u"),
                    d.strftime("%G-W%V"),
                    d.strftime("%GW%V"),
                ]
            )
            if rng.random() < 0.3:
                i = rng.randrange(len(base))
                base = base[:i] + rng.choice(alphabet) + base[i + 1 :]
            texts.append(base)
        else:
            texts.append("".join(rng.choice(alphabet) for _ in range(n)))
    for text in texts:
        out.append(["fromisoformat", text, run(lambda: dt.date.fromisoformat(text).isoformat())])
    return out


def gen_datetimes(rng: random.Random) -> list:
    """Timestamps as SQLite stores them (naive UTC) and as isoformat writes them, read back with
    datetime.fromisoformat, normalised like core/api.py utc_iso."""
    from cashu.core.api import utc_iso

    out = []
    for _ in range(3000):
        d = rand_date(rng)
        if d.year < 2 or d.year > 9998:
            d = d.replace(year=2026)
        micro = rng.choice([0, 0, rng.randint(0, 999999), rng.randint(0, 999) * 1000])
        moment = dt.datetime(
            d.year,
            d.month,
            d.day,
            rng.randint(0, 23),
            rng.randint(0, 59),
            rng.randint(0, 59),
            micro,
        )
        form = rng.random()
        if form < 0.3:
            text = moment.strftime("%Y-%m-%d %H:%M:%S.%f")  # SQLAlchemy's SQLite storage format
        elif form < 0.5:
            text = moment.isoformat()
        elif form < 0.6:
            text = moment.isoformat(sep=" ")
        elif form < 0.7:
            text = moment.replace(tzinfo=dt.UTC).isoformat().replace("+00:00", "Z")
        else:
            minutes = rng.choice([0, 60, 120, -300, 330, -570, 840, -720, rng.randint(-1439, 1439)])
            seconds = rng.choice([0, 0, 0, 0, rng.randint(1, 59)]) if minutes else 0
            sign = 1 if minutes >= 0 else -1
            tz = dt.timezone(dt.timedelta(minutes=minutes, seconds=sign * seconds))
            text = moment.replace(tzinfo=tz).isoformat(sep=rng.choice(["T", " "]))
        parsed = dt.datetime.fromisoformat(text)
        out.append(
            [
                text,
                parsed.isoformat(),
                utc_iso(parsed),
                parsed.astimezone(dt.UTC).replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S.%f")
                if parsed.tzinfo
                else parsed.strftime("%Y-%m-%d %H:%M:%S.%f"),
            ]
        )
    return out


# --------------------------------------------------------------------------- text


TEXT_POOL = (
    list("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
    + list("ąćęłńóśźżĄĆĘŁŃÓŚŹŻ") * 4
    + list("äöüßÄÖÜéèêëàâîïôûçñÉÈÀÇÑåøæÅØÆ")
    + list("İıſﬁﬂﬀﬃŉǰΐΰẞ") * 2
    + list("ΑΒΓΣσςαβγΩωάέΆ")
    + list("АБВабвЁёЙй")
    + list(" " * 12)
    + list(
        "\t\n\r\x0b\x0c\x1c\x1d\x1e\x1f\x85\xa0\u1680\u2000\u2007\u200a\u2028\u2029\u202f\u205f\u3000"
    )
    + list("\u200b\ufeff\u00ad\u034f\u200d")
    + list(
        "\u0301\u0300\u0308\u0327\u0328\u0307\u0338\u20dd\u05b0\u0e31\u093c\u302a\u1ab0\U0001d165"
    )
    + list("ＡＢＣ１２３ｱｲｳ①②½²™℃㎏㍿ǅǈǋ")
    + list("中文日本語한국어😀👍🏽\U0001f1f5\U0001f1f1")
    + list(".,;:-_/'\"()[]#%&*+=!?@$€")
)


def rand_text(rng: random.Random) -> str:
    n = rng.choice([0, 1, 2, rng.randint(1, 12), rng.randint(5, 40)])
    chars = []
    for _ in range(n):
        if rng.random() < 0.05:
            c = rng.randint(0, 0x10FFFF)
            if 0xD800 <= c <= 0xDFFF:
                c = 0x41
            chars.append(chr(c))
        else:
            chars.append(rng.choice(TEXT_POOL))
    return "".join(chars)


TEXT_EDGE = [
    "",
    " ",
    "  \t\n ",
    "Łódź",
    "ŁÓDŹ",
    "zażółć gęślą jaźń",
    "ZAŻÓŁĆ GĘŚLĄ JAŹŃ",
    "Straße",
    "ﬁrma",
    "İstanbul",
    "ıi",
    "ſklep",
    "Café  au\tlait",
    "BIEDRONKA  WARSZAWA",
    "\x1cA\x1fB\x1e",
    "A\x85B",
    "A\u200bB",
    "\ufeffA",
    "A\u00adB",
    "ǅ",
    "Ⅻ",
    "①②",
    "½",
    "ＡＢＣ",
    "ﾊﾟ",
    "ΟΔΟΣ",
    "ΣΑΣ Σ",
    "ǰ",
    "ΐ",
    "e\u0301",
    "a\u0328",
    "\u0301",
    "  x  ",
    "x\u3000y",
    "A\u2028B",
    "😀 x",
    "DATA TRANSAKCJI: 2026-01-01",
    "Ł\u0301",
    "ŉ",
    "ﬃ",
    "㍿",
    "℡",
    "\u0345",
    "ΐ",
]


def block_hashes(fn: Callable[[str], str]) -> list[str]:
    """sha256 per 4096-code-point block of fn(chr(c)) joined by U+0000 (surrogates skipped)."""
    hashes = []
    for block in range(0x110000 // 4096):
        h = hashlib.sha256()
        for c in range(block * 4096, (block + 1) * 4096):
            if 0xD800 <= c <= 0xDFFF:
                continue
            h.update(fn(chr(c)).encode("utf-8", "surrogatepass"))
            h.update(b"\x00")
        hashes.append(h.hexdigest()[:16])
    return hashes


def gen_text(rng: random.Random) -> list:
    out = []
    space = [c for c in range(0x110000) if chr(c).isspace()]
    combining = []
    for c in range(0x110000):
        if unicodedata.combining(chr(c)):
            if combining and combining[-1][1] == c - 1:
                combining[-1][1] = c
            else:
                combining.append([c, c])
    import re

    regex_space = [
        c for c in range(0x110000) if not 0xD800 <= c <= 0xDFFF and re.match(r"\s", chr(c))
    ]
    out.append(["isspace", space])
    out.append(["re_s", regex_space])
    out.append(["combining", combining])
    out.append(["unicode", unicodedata.unidata_version])
    out.append(["nd_zeros", [c for c in range(0x110000) if unicodedata.decimal(chr(c), -1) == 0]])
    out.append(["blocks", "normalize_text", block_hashes(normalize_text)])
    out.append(["blocks", "upper", block_hashes(str.upper)])
    out.append(["blocks", "lower", block_hashes(str.lower)])
    out.append(["blocks", "strip", block_hashes(lambda s: ("x" + s + "x" + s).strip())])
    strings = TEXT_EDGE + [rand_text(rng) for _ in range(5000)]
    for s in strings:
        out.append(
            ["str", s, normalize_text(s), s.upper(), s.lower(), s.strip(), " ".join(s.split())]
        )
    out.append(["none", normalize_text(None)])
    return out


def gen_iban(rng: random.Random) -> list:
    out = []
    edge = [
        "",
        " ",
        "PL61 1090 1014 0000 0712 1981 2874",
        "61109010140000071219812874",
        "'61109010140000071219812874",
        "pl61109010140000071219812874",
        "DE89370400440532013000",
        "PL",
        "P",
        "PL1",
        "12",
        "1",
        "XX00TEST0000",
        "GB82-WEST-1234-5698-7654-32",
        "١٢٣٤",
        "PL６１",
        "ПЛ61",
        "Pł61",
        "pL61",
        "P1L61",
        "\xa0PL 61\t",
        "ab",
        "abc",
        "1PL61",
        "ſ61",
        "İL61",
        "PL61\u200b1090",
        "N/A",
        "--",
        "'",
        "PL'61",
        "   pl  ",
        "ß1234",
    ]
    alphabet = "0123456789" * 5 + "PLDEGBXplde" + " '-./\t\xa0" + "ął١٢İıſ"
    strings = edge
    for _ in range(3000):
        r = rng.random()
        if r < 0.5:
            digits = "".join(rng.choice("0123456789") for _ in range(26))
            s = rng.choice(["", "PL", "pl", "Pl", "DE", "'", "'PL"]) + digits
            if rng.random() < 0.5:
                s = " ".join(s[i : i + 4] for i in range(0, len(s), 4))
            if rng.random() < 0.3:
                i = rng.randrange(len(s) + 1)
                s = s[:i] + rng.choice(alphabet) + s[i:]
        else:
            s = "".join(rng.choice(alphabet) for _ in range(rng.randint(0, 30)))
        strings.append(s)
    for s in strings:
        out.append([s, normalize_iban(s), iban_key(s)])
    out.append([None, normalize_iban(None), iban_key(None)])
    return out


# --------------------------------------------------------------------------- driver

GENERATORS: dict[str, tuple[Callable[[random.Random], list], str]] = {
    "decimal-parse": (gen_decimal_parse, "[text, str | error, sign, digits, exp]"),
    "decimal-format": (
        gen_decimal_format,
        "first ['specs', [...]]; then [str, decimal_key, str(int(d)), repr(float(d)), [format(d, spec)...]]",
    ),
    "decimal-arith": (
        gen_decimal_arith,
        "[op, [prec, rounding, Emin, Emax], a, b, result | error]",
    ),
    "decimal-unary": (
        gen_decimal_unary,
        (
            "[op, ctx, a, ...args, result]; quantize: [.., a, quantumExp, rounding, r]; "
            "to_integral_value: [.., a, rounding, r]; scaleb: [.., a, n, r]; compare: [.., a, b, -1|0|1]"
        ),
    ),
    "decimal-pow": (
        gen_decimal_pow,
        "[ctx, base, n, result | error] (Context.power with an integer exponent)",
    ),
    "money": (
        gen_money,
        "[divided_by, a, b, scale, r] | [ratio, a, b, repr(float) | null] | [currency, in, out]",
    ),
    "floats": (
        gen_floats,
        (
            "first ['specs', [...]]; then [hex64, repr, str(Decimal(x)) | null, [format(x, spec)...] | null, "
            "[repr(round(x, 0..6))..., str(round(x))] | null]"
        ),
    ),
    "dates": (gen_dates, "[op, ...args, result | error]"),
    "datetimes": (
        gen_datetimes,
        "[text, fromisoformat(text).isoformat(), utc_iso, naive UTC storage form]",
    ),
    "text": (
        gen_text,
        (
            "tables (isspace, re_s, combining, unicode, blocks) then "
            "[str, s, normalize_text, upper, lower, strip, ' '.join(split())]"
        ),
    ),
    "iban": (gen_iban, "[s, normalize_iban(s), iban_key(s)]"),
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
            "generator": "parity/python/vectors.py",
            "python": sys.version.split()[0],
            "unicode": unicodedata.unidata_version,
        }
    }
    lines = [json.dumps(meta, ensure_ascii=False)]
    lines += [json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in rows]
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
        count = text.count("\n") - 1
        if args.check:
            if not path.exists() or path.read_text(encoding="utf-8") != text:
                stale.append(name)
            continue
        path.write_text(text, encoding="utf-8")
        print(f"{name}: {count} vectors, {len(text.encode()) // 1024} KiB")
    if stale:
        print("stale vector files: " + ", ".join(stale))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
