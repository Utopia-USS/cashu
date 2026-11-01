#!/usr/bin/env python3
"""Bounded synthetic expression evaluator vectors; no database or data-dir reads."""

from __future__ import annotations

import argparse
import json
import sys
from decimal import Decimal, localcontext
from pathlib import Path

from cashu.core.i18n import use_language
from cashu.modules.investments.rules.expr import Unknown, compile_expression, evaluate

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "packages/domain/test/vectors/inv-rules-evaluator.jsonl"


def encode(value):
    if isinstance(value, Decimal):
        return ["decimal", str(value)]
    if isinstance(value, Unknown):
        return ["unknown", list(value.reasons)]
    return ["boolean" if isinstance(value, bool) else "string", value]


def cases():
    for op in ["<", "<=", ">", ">=", "==", "!="]:
        for value in ["-1.1e-9", "-1e-9", "-0", "0", "1e-9", "1.1e-9"]:
            yield f"weight {op} 0", {"weight": Decimal(value)}
    states = [Decimal(-1), Decimal(1), Unknown(("first", "shared"))]
    for op in ["and", "or"]:
        for left in states:
            for right in states:
                yield (
                    f"weight > 0 {op} unrealized_pct > 0",
                    {
                        "weight": left,
                        "unrealized_pct": right,
                    },
                )
    for op in ["+", "-", "*", "/"]:
        for left, right in [
            ("1", "3"),
            ("0", "0"),
            ("-0", "-0"),
            ("0.1", "0.2"),
            ("9007199254740993", "9007199254740992"),
            ("9e999999", "2"),
            ("1e-999999", "100000000000000000000000"),
        ]:
            yield (
                f"market_value {op} cost_basis > 0",
                {
                    "market_value": Decimal(left),
                    "cost_basis": Decimal(right),
                },
            )
    yield (
        "weight + unrealized_pct > 0 and market_value > 0 and weight > 0",
        {
            "weight": Unknown(("shared", "first", "shared")),
            "unrealized_pct": Unknown(("second", "shared")),
            "market_value": Unknown(("third",)),
        },
    )
    yield (
        'true or (holding_has_tag(" x ") and holding_has_tag("x") and drawdown_from_high(002) > weight)',
        {
            'holding_has_tag("x")': Unknown(("missing",)),
            "drawdown_from_high(2)": Decimal("0.2"),
            "weight": Decimal("0.1"),
        },
    )
    yield (
        'holding_has_tag("🙂") and weight / 0 > 1',
        {
            'holding_has_tag("🙂")': True,
            "weight": Decimal(1),
        },
    )
    yield 'asset_class == "etf" and symbol != "PKN"', {"asset_class": "etf", "symbol": "表🙂"}
    yield 'holding_has_tag("x") == false', {'holding_has_tag("x")': False}
    # Value permits these resolver values; Python only explicitly rejects floats.
    yield 'not holding_has_tag("x")', {'holding_has_tag("x")': Decimal(0)}
    yield 'holding_has_tag("x") == false', {'holding_has_tag("x")': Decimal(0)}
    yield 'holding_has_tag("x") == true', {'holding_has_tag("x")': Decimal(1)}
    yield 'not holding_has_tag("x")', {'holding_has_tag("x")': ""}
    yield (
        "weight / 3 == cost_basis",
        {
            "weight": Decimal(1),
            "cost_basis": Decimal("0.3333333333333333333333333333"),
        },
    )
    for unary in ["+", "-"]:
        yield (
            f"{unary}weight == cost_basis",
            {
                "weight": Decimal(123456789012345678901234567890123),
                "cost_basis": Decimal(f"{unary}123456789012345678901234567900000"),
            },
        )
    yield "false and +weight > 0", {"weight": Decimal("1e1000000")}
    yield "true or weight > 0", {"weight": Decimal("1e1000000")}
    yield "not (weight > 0)", {"weight": Unknown(("missing",))}


def rows():
    result = []
    for lang in ["en", "pl"]:
        for source, values in cases():
            compiled = compile_expression(source, "instrument")
            with use_language(lang), localcontext() as context:
                context.prec = 3
                try:
                    evaluated = evaluate(compiled, lambda ref, values=values: values[ref.label])
                    expected = {
                        "result": evaluated.result,
                        "reasons": list(evaluated.reasons),
                        "values": [
                            [label, encode(value)] for label, value in evaluated.values.items()
                        ],
                    }
                except (ArithmeticError, TypeError) as error:
                    expected = {"error": type(error).__name__}
            result.append(
                [source, lang, {label: encode(value) for label, value in values.items()}, expected]
            )
    return result


def render():
    vectors = rows()
    meta = {
        "meta": {
            "name": "inv-rules-evaluator",
            "count": len(vectors),
            "layout": "[source, lang, {label: [type, value]}, {result,reasons,values:[[label,[type,value]]]} | {error:name}]; ambient precision 3",
            "generator": "parity/python/vectors_inv_rules_evaluator.py",
            "python": sys.version.split()[0],
        }
    }
    return (
        "\n".join(
            json.dumps(row, ensure_ascii=True, separators=(",", ":")) for row in [meta, *vectors]
        )
        + "\n"
    ).encode("ascii")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    content = render()
    if args.check:
        stale = not OUT.exists() or OUT.read_bytes() != content
        print("stale evaluator vectors" if stale else "up to date")
        return int(stale)
    OUT.write_bytes(content)
    print(f"{OUT.relative_to(ROOT)} written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
