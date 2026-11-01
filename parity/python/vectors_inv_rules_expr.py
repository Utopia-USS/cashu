#!/usr/bin/env python3
"""Synthetic parity vectors for the TypeScript port of the custom-rule expression compiler (scope S14).

    .venv/bin/python parity/python/vectors_inv_rules_expr.py            # writes the vectors
    .venv/bin/python parity/python/vectors_inv_rules_expr.py --check    # regenerates in memory, fails on any diff

Writes ``packages/domain/test/vectors/inv-rules-expr-cases.jsonl`` (read by
``packages/domain/src/investments/rules/expr/expr.vectors.test.ts``) and
``inv-rules-expr-random.jsonl`` (read by ``expr.vectors.exhaustive.test.ts``). The oracles are the real
Python functions of ``rules/expr`` (``tokenize``, ``compile_expression``, the ``MetricRef.label`` /
``CompiledExpression`` properties, the catalog). Only the compile front-end is covered; the evaluator
is a later scope.

Every input is synthetic: every string literal of the two oracle test files (harvested with ``ast``),
the generated sources of the security tests, every metric name in templates, every catalog function with
valid and invalid arguments, then seeded random token soups (ASCII, non-ASCII, astral, control
characters, a lone low surrogate), random mutations of valid expressions and random well-formed trees.
Nothing reads a data dir or a database.

File format as ``vectors.py``: JSON Lines (ASCII-escaped, so a lone surrogate survives), line 1
``{"meta": {...}}``, then one array per vector, layout in ``meta.layout``.
"""

from __future__ import annotations

import argparse
import ast
import dataclasses
import json
import random
import sys
from collections.abc import Iterable
from decimal import Decimal
from pathlib import Path

from cashu.modules.investments.rules.expr import (
    METRICS,
    ExpressionError,
    Scope,
    compile_expression,
    names_in_scope,
)
from cashu.modules.investments.rules.expr.lexer import tokenize
from cashu.modules.investments.rules.expr.limits import (
    MAX_DEPTH,
    MAX_EXPRESSION_LENGTH,
    MAX_FUNCTION_ARGS,
    MAX_TOKENS,
)

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "packages" / "domain" / "test" / "vectors"
TESTS = [
    ROOT / "tests" / "investments" / "rules" / "test_rules_expr_grammar.py",
    ROOT / "tests" / "investments" / "rules" / "test_rules_expr_security.py",
]
SEED = 2026_11_01
SCOPES = list(Scope)
BAD_SCOPES = ["global", "", "Portfolio", "INSTRUMENT", " bucket", "bucket ", "portfolios", "ę"]

LAYOUT = (
    "['catalog', [[name, type, unit, [scopes in Scope order], doc, args | null, choices | null]]] "
    "with args = [[name, type, minimum, maximum, choices, reference, variadic]] | "
    "['names', scope, [names_in_scope]] | "
    "['tokens', source, [[type, text, column, value]] | {error: [message, column]}] | "
    "['compile', source, [outcome per scope in Scope order]] | "
    "['scope', source, scope, outcome]; outcome = {ok: {tree, metrics: [[name, [args], column, label]], "
    "bucket_references: [[bucket, column]], normalized}} | {error: [message, column, str(error)]} | "
    "{value_error: str(error)}; a tree node is {type: class name, <dataclass fields in order>}, "
    "Decimal values as str(Decimal)"
)

# --------------------------------------------------------------------------- serialization


def node_out(node) -> dict:
    out: dict = {"type": type(node).__name__}
    for field in dataclasses.fields(node):
        out[field.name] = value_out(getattr(node, field.name))
    return out


def value_out(value):
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, tuple):
        return [value_out(item) for item in value]
    if dataclasses.is_dataclass(value):
        return node_out(value)
    assert value is None or isinstance(value, (bool, int, str)), type(value)
    return value


def error_out(error: ExpressionError) -> dict:
    return {"error": [error.message, error.column, str(error)]}


def compile_out(source: str, scope: str) -> dict:
    try:
        compiled = compile_expression(source, scope)
    except ExpressionError as error:
        return error_out(error)
    except ValueError as error:  # an unknown scope (ExpressionError is a ValueError, caught above)
        return {"value_error": str(error)}
    return {
        "ok": {
            "tree": node_out(compiled.tree),
            "metrics": [[ref.name, list(ref.args), ref.column, ref.label] for ref in compiled.metrics],
            "bucket_references": [list(pair) for pair in compiled.bucket_references],
            "normalized": compiled.normalized,
        }
    }


def tokens_out(source: str):
    try:
        tokens = tokenize(source)
    except ExpressionError as error:
        return error_out(error)
    return [[t.type.value, t.text, t.column, value_out(t.value)] for t in tokens]


def catalog_row() -> list:
    specs = []
    for spec in METRICS.values():
        args = None
        if spec.args is not None:
            args = [
                [a.name, a.type.value, a.minimum, a.maximum,
                 None if a.choices is None else list(a.choices), a.reference, a.variadic]
                for a in spec.args
            ]
        specs.append([
            spec.name, spec.type.value, spec.unit.value,
            [s.value for s in SCOPES if s in spec.scopes], spec.doc, args,
            None if spec.choices is None else list(spec.choices),
        ])
    return ["catalog", specs]


# --------------------------------------------------------------------------- corpus


def test_strings() -> list[str]:
    """Every string constant of the two oracle test files (inputs, and messages as extra inputs)."""
    found: list[str] = []
    for path in TESTS:
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                found.append(node.value)
    return found


def security_generated() -> list[str]:
    """The sources the security tests build at run time."""
    args = ", ".join(f'"t{i}"' for i in range(MAX_FUNCTION_ARGS + 1))
    depth = MAX_DEPTH - 3
    return [
        "weight > 1 and " * 10_000 + "weight > 1",
        " or ".join(["weight>1"] * 60),
        "(" * (MAX_DEPTH + 1) + "weight > 1" + ")" * (MAX_DEPTH + 1),
        "not " * (MAX_DEPTH + 1) + "weight > 1",
        "-" * (MAX_DEPTH + 1) + "weight > 1",
        " + ".join(["weight"] * (MAX_DEPTH + 2)) + " > 1",
        "(" * 400 + "weight > 1" + ")" * 400,
        "(" * depth + "weight > 1" + ")" * depth,
        "weight > " + "9" * 100,
        f'holding_has_tag("{"a" * 500}")',
        "w" * 100 + " > 1",
        f"tagged_weight({args}) > 0",
        f"tagged_weight({args[: args.rindex(',')]}) > 0",
        "x" * MAX_EXPRESSION_LENGTH,
        "x" * (MAX_EXPRESSION_LENGTH + 1),
        "😀" * (MAX_EXPRESSION_LENGTH + 1),
        "😀" * MAX_EXPRESSION_LENGTH,
        " " * (MAX_EXPRESSION_LENGTH - 10) + "weight > 1",
        " or ".join(["weight>1"] * 49),
        " or ".join(["weight>1"] * 50) + " or w",
        " + ".join(["weight"] * (MAX_DEPTH - 1)) + " > 1",
        " + ".join(["weight"] * MAX_DEPTH) + " > 1",
        "-" * MAX_DEPTH + "weight > 1",
        "-" * (MAX_DEPTH - 1) + "weight > 1",
        "not " * MAX_DEPTH + "weight > 1",
        "not " * (MAX_DEPTH - 1) + "weight > 1",
        "(" * MAX_DEPTH + "weight > 1" + ")" * MAX_DEPTH,
        "(" * (MAX_DEPTH - 1) + "weight > 1" + ")" * (MAX_DEPTH - 1),
        "a" * 64 + " > 1",
        "a" * 65 + " > 1",
        "weight > " + "1" * 24,
        "weight > " + "1" * 25,
        "weight > 0." + "1" * 22,
        "weight > " + "1" * 24 + "%",
        f'holding_has_tag("{"a" * 100}")',
        f'holding_has_tag("{"a" * 101}")',
        f'holding_has_tag("{"ż" * 100}")',
        f'holding_has_tag("{"😀" * 100}")',
        f'holding_has_tag("{"😀" * 101}")',
        "_" + "a" * 100 + " > 1",
    ]


ARG_VARIANTS = [
    "", "2", "252", "2520", "1", "0", "2521", "5000", "-5", "+5", "007", "2.0", "2.5", "252.000",
    "0.5", ".5", "10%", "2520.0%", "999999999999999999999999", "1" + "0" * 23, '"x"', "' x '",
    '""', '"  "', "weight", "true", "(5)", "5 + 1", '"etf"', '"stocks"', '"Etf"', '"etff"',
    '" etf "', '"bonds"', '"a", "a"', '"a", "b"', '"a", "b", "a"', '"a", " a"', "5, 5", '"a", 5',
    '5, "a"', '"a", "b", "c", "d", "e", "f", "g", "h", "i", "j"', '"bucket", "x"', "drawdown_from_high(5)",
    '"złoto"', '"Zloto"', '"cash"', '"treasury_bond"', '"treasury bond"', '"crypto "', "'claim'",
]


def catalog_sources() -> list[str]:
    out: list[str] = []
    names = list(METRICS) + ["wieght", "Weight", "WEIGHT", "AND", "Or", "NOT", "True", "FALSE",
                             "constructor", "toString", "hasOwnProperty", "prototype", "valueOf",
                             "bucket", "asset", "symbl", "drift", "unrealised_pct", "x"]
    for name in names:
        out += [
            name, f"{name} > 1", f"{name}()", f"{name}() > 0", f'{name} == "x"', f'"etf" == {name}',
            f"not {name}", f"-{name} < 0", f"{name} and true", f"{name} == true", f"{name} + 1 > 0",
            f"{name} != {name}", f'{name} == "etf"', f'{name} == "etff"', f'{name} == "ETF"',
            f'{name} != " etf"', f"{name}(1) > 0", f'{name}("a") > 0', f'{name}("a")',
            f"{name} > 1 and {name} > 2", f"{name} > {name}",
        ]
    for name, spec in METRICS.items():
        if spec.args is None:
            continue
        for variant in ARG_VARIANTS:
            out += [f"{name}({variant}) > 0", f"{name}({variant})", f"not {name}({variant})"]
        out += [
            f"{name}(2) > 0 and {name}(2.0) > 0",
            f'{name}("bonds") > 0 and {name}("bonds") < 1 and {name}("eq") > 0',
            f'bucket_weight("a") > bucket_target("b") and {name}("c") > 0',
        ]
    return out


HAND = [
    "weight > 5%", "weight > 12.5%", "weight > 0%", "weight > 0.00%", "weight > 1.50%",
    "weight > 100%", "weight > 007%", "weight > .5%", "weight > 0.000000000000000000001%",
    "weight > 123456789012345678901234", "weight > 12345678901234567890123%",
    "weight >= 1 or weight <= 2 or weight == 3 or weight != 4", "weight<1", "weight>=-1",
    "weight > 1 and weight < 2 or not weight == 3 and true", "(weight > 1)", "((weight > 1))",
    "weight > (1)", "weight > -(-(1))", "weight * 2 / 3 - 1 + 4 > 0", "weight > 1 and", "or weight > 1",
    "weight >", "> 1", "weight 1", "weight > 1,", "weight(", "weight)", "holding_has_tag(", "f(1,)",
    "holding_has_tag('x',)", "holding_has_tag(,'x')", "holding_has_tag('x' 'y')", "holding_has_tag('x'",
    "holding_has_tag('x')) ", "( )", "()", "", " ", "\t\n\r ", "\u00a0weight > 1", "weight\u3000> 1",
    "weight > 1\u2028", "weight > 1 \x0b", "weight > 1 \x0c", "weight > 1\x1c", "weight\x85 > 1",
    'symbol == "a\u00a0b"', 'symbol == "a\u200bb"', 'symbol == "a\x7fb"', 'symbol == "\U0001f600"',
    'symbol == "\udfff"', "symbol == '\udfff'", "weight > 1 \udfff", "\U0001f600 weight > 1",
    "weight\U0001f600 > 1", 'symbol == "😀" and weight > "😀"', "weight > 1 \u00e9", "weight > 1 é",
    "weight > 1 ż", 'holding_has_tag("ż") and weight > 1 + "😀"', "weight >= 1e", "weight > 1e+",
    "weight > 1E-5", "weight > 1e", "weight > 1ex", "weight > 1_000", "weight > 1.5.", "weight > 1..2",
    "weight > .", "weight > .e5", "weight > 5.%", "weight > 5%%", "weight > 5% 5", "weight > %5",
    "weight > 5%.5", "weight > 5%x", "weight =< 1", "weight => 1", "weight // 2 > 1", "weight ~ 1",
    "weight & 1", "weight | 1", "weight ^ 1", "weight @ 1", "weight ? 1", "weight : 1", "a.b",
    "weight > 1 = 2", "weight == = 1", "weight !== 1", "weight === 1", "weight <== 1", "weight >== 1",
    "weight <<= 1", "weight >>= 1", "weight < > 1", "weight <", "weight !", "weight =", "weight &",
    "!", "=", "<", ">", "<=", "-", "+", "*", "/", "not", "and", "or", "true", "false", "true == false",
    "not true", "not not true", "true and false", "1 + 1", "1 == 1", '"a" == "a"', '"a"', "'a'",
    "weight > 1 and true", "weight > 1 or false", "true and weight > 1", "weight == weight",
    'symbol == symbol', 'symbol == "x" and currency == "USD" and mic == "XWAR"',
    'asset_class == "etf" or asset_class == "Etf" or asset_class == "stocks"',
    '"etf" != asset_class', '"etff" == asset_class', 'asset_class == " etf"',
    'asset_class == asset_class', 'bucket_id == "x"', 'drift_rel < -10% and value > 0',
    'weight > 1 and symbol', 'symbol and weight > 1', 'not symbol', '-symbol > 1',
    'symbol + 1 > 0', '1 + symbol > 0', 'symbol < 1', '1 < symbol', 'symbol < symbol',
    'holding_has_tag("x") > 1', 'holding_has_tag("x") == 1', '1 == holding_has_tag("x")',
    'holding_has_tag("x") + 1 > 0', '(weight > 1) + 1 > 0', '(weight > 1) == (weight < 2)',
    '(weight > 1) != true', 'weight > 1 == true', '-(weight > 1)', '-(1 + 2) > weight',
    '-(1 + weight) > (weight > 1)', '(weight + 1) * 2 > (1 + 2) * weight',
    "drawdown_from_high(252) >= 15% and weight < 5%",
    'tagged_weight("core", "satellite") > 50% and bucket_drift_pp("bonds") < -5',
    'bucket_drift_pp("bonds") < -5 and bucket_weight("bonds") > 0 and weight > 1',
    'bucket_value(" bonds ") > 0 and bucket_target("bonds") > 0',
    'tagged_weight("a") > 0 and tagged_weight("a") > 1 and tagged_weight(" a") > 2',
    "weight\n  >\t5%", "weight  >\n 1", "  weight > 1  ", "weight\r\n>\r\n1",
    "weight > 1 # comment", "weight > 1 -- comment", "weight > 1 /* c */",
    "weight > 1 and AND", "weight > 1 aNd weight < 2", "Weight > 1", "_weight > 1",
    "weight_ > 1", "w8 > 1", "8w > 1", "weight > 0x10", "weight > 0b1", "weight > 1j",
]


def mutate(text: str, rng: random.Random, alphabet: list[str]) -> str:
    chars = list(text)
    for _ in range(rng.randint(1, 3)):
        op = rng.random()
        pos = rng.randint(0, len(chars))
        if op < 0.4:
            chars.insert(pos, rng.choice(alphabet))
        elif op < 0.7 and chars:
            del chars[min(pos, len(chars) - 1)]
        elif chars:
            chars[min(pos, len(chars) - 1)] = rng.choice(alphabet)
    return "".join(chars)


SOUP_TOKENS = [
    *METRICS, "and", "or", "not", "true", "false", "AND", "True", "x", "_x", "wieght", "weigh",
    "0", "1", "2", "5", "252", "2520", "2521", ".5", "12.5", "5%", "12.5%", "007", "1e5", "1.",
    "1.2.3", "9" * 25, "2.0", '"etf"', "'x'", '"a b"', '"złoto"', '"bonds"', '""', '" "', '"\t"',
    '"x', "'", '"a\\"', "+", "-", "*", "/", "<", ">", "<=", ">=", "==", "!=", "(", ")", "(", ")",
    ",", "=", "!", "&&", "||", "**", "%", ".", "[", "]", "{", "}", "#", ";", "\\", "`", "$", "?",
    "é", "ż", "\u00a0", "\u200b", "\u2028", "😀", "\u0661", "ｗ", "\x00", "\x1f", "\x7f", "\udfff",
    "\u2014",
]
WHITESPACE = [" ", " ", " ", " ", "", "\t", "\n", "\r", "  "]
CHAR_ALPHABET = list("abcwxyz_0123456789.%+-*/<>=!()\"', \t\n&|^~@;:#$?`[]{}\\") + [
    "é", "ż", "\u00a0", "\u200b", "😀", "\x00", "\x7f", "\udfff", "\u2028",
]


CLEAN_TOKENS = [
    *METRICS, "and", "or", "not", "true", "false", "1", "5%", "0.5", '"etf"', "+", "-", "*", "/",
    "<", ">", "<=", ">=", "==", "!=", "(", ")", ",",
]


def soup(rng: random.Random) -> str:
    pool = CLEAN_TOKENS if rng.random() < 0.5 else SOUP_TOKENS
    parts = [rng.choice(pool) for _ in range(rng.randint(1, 14))]
    return "".join(part + rng.choice(WHITESPACE) for part in parts)


_NUM_LEAVES = ["cash_weight", "total_value", "holdings_count", "stale_weight", "weight", "target",
               "drawdown_from_high(252)", "price_change(20)", 'bucket_weight("bonds")',
               'bucket_drift_pp("eq")', 'tagged_weight("a", "b")', 'asset_class_weight("etf")',
               "1", "0.5", "5%", "12.5%", "007", "2.50", "100"]
_TEXT_LEAVES = ["symbol", "asset_class", "currency", "bucket_id", '"etf"', '"x"', "'USD'"]


def typed_num(rng: random.Random, depth: int) -> str:
    if depth <= 0 or rng.random() < 0.35:
        return rng.choice(_NUM_LEAVES)
    kind = rng.random()
    if kind < 0.6:
        op = rng.choice(["+", "-", "*", "/"])
        return f"{typed_num(rng, depth - 1)} {op} {typed_num(rng, depth - 1)}"
    if kind < 0.8:
        return f"{rng.choice(['-', '+'])}{typed_num(rng, depth - 1)}"
    return f"({typed_num(rng, depth - 1)})"


def typed_bool(rng: random.Random, depth: int) -> str:
    kind = rng.random()
    if depth <= 0 or kind < 0.35:
        op = rng.choice(["<", "<=", ">", ">=", "==", "!="])
        return f"{typed_num(rng, depth - 1)} {op} {typed_num(rng, depth - 1)}"
    if kind < 0.45:
        return f"{rng.choice(_TEXT_LEAVES)} {rng.choice(['==', '!='])} {rng.choice(_TEXT_LEAVES)}"
    if kind < 0.7:
        op = rng.choice(["and", "or"])
        return f" {op} ".join(typed_bool(rng, depth - 1) for _ in range(rng.randint(2, 3)))
    if kind < 0.8:
        return f"not {typed_bool(rng, depth - 1)}"
    if kind < 0.9:
        return rng.choice(['holding_has_tag("core")', "true", "false"])
    return f"({typed_bool(rng, depth - 1)})"


def well_formed(rng: random.Random, depth: int) -> str:
    """A random expression from the grammar (types may still mismatch; depth may exceed the limit)."""
    leaves = [*METRICS, "1", "0.5", "5%", '"etf"', "true", "false", "drawdown_from_high(252)",
              'bucket_weight("bonds")', 'tagged_weight("a", "b")', 'holding_has_tag("core")',
              'asset_class_weight("etf")', "price_change(20)"]
    if depth <= 0 or rng.random() < 0.25:
        return rng.choice(leaves)
    kind = rng.random()
    if kind < 0.3:
        op = rng.choice(["<", "<=", ">", ">=", "==", "!="])
        return f"{well_formed(rng, depth - 1)} {op} {well_formed(rng, depth - 1)}"
    if kind < 0.5:
        op = rng.choice(["and", "or"])
        return f" {op} ".join(well_formed(rng, depth - 1) for _ in range(rng.randint(2, 4)))
    if kind < 0.7:
        op = rng.choice(["+", "-", "*", "/"])
        return f"{well_formed(rng, depth - 1)} {op} {well_formed(rng, depth - 1)}"
    if kind < 0.8:
        return f"not {well_formed(rng, depth - 1)}"
    if kind < 0.9:
        return f"-{well_formed(rng, depth - 1)}"
    return f"({well_formed(rng, depth - 1)})"


def deep(rng: random.Random) -> str:
    """Nesting near MAX_DEPTH from mixed constructs."""
    wrappers = ["(", "not ", "-", "+", "abs(", "bucket_weight("]
    chosen = [rng.choice(wrappers) for _ in range(rng.randint(MAX_DEPTH - 3, MAX_DEPTH + 3))]
    core = rng.choice(["weight > 1", "weight", "1", '"x"'])
    closing = "".join(")" for w in chosen if w.endswith("("))
    tail = rng.choice(["", " > 0", " and weight > 1"])
    return "".join(chosen) + core + closing + tail


def unique(items: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(items))


def compile_row(source: str) -> list:
    return ["compile", source, [compile_out(source, scope) for scope in SCOPES]]


def cases_rows() -> list[list]:
    rows: list[list] = [catalog_row()]
    rows += [["names", scope.value, names_in_scope(scope)] for scope in SCOPES]
    sources = unique([*test_strings(), *security_generated(), *HAND, *catalog_sources()])
    for source in sources:
        rows.append(["tokens", source, tokens_out(source)])
        rows.append(compile_row(source))
    for source in ["weight > 1", "cash_weight > 10%", "", "weight >", "$"]:
        for scope in BAD_SCOPES + [s.value for s in SCOPES]:
            rows.append(["scope", source, scope, compile_out(source, scope)])
    return rows


def random_rows(rng: random.Random) -> list[list]:
    valid = [s for s in unique([*HAND, *catalog_sources()]) if "ok" in compile_out(s, "instrument")]
    sources: list[str] = []
    sources += [soup(rng) for _ in range(3000)]
    sources += [mutate(rng.choice(valid), rng, CHAR_ALPHABET) for _ in range(2000)]
    sources += [well_formed(rng, rng.randint(1, 7)) for _ in range(1500)]
    sources += [deep(rng) for _ in range(300)]
    sources += [typed_bool(rng, rng.randint(1, 8)) for _ in range(2000)]
    rows: list[list] = []
    for source in unique(sources):
        rows.append(["tokens", source, tokens_out(source)])
        rows.append(compile_row(source))
    return rows


def render(name: str, rows: list[list]) -> bytes:
    meta = {
        "meta": {
            "name": name,
            "count": len(rows),
            "layout": LAYOUT,
            "seed": SEED,
            "generator": "parity/python/vectors_inv_rules_expr.py",
            "python": sys.version.split()[0],
        }
    }
    lines = [json.dumps(meta)]
    lines += [json.dumps(row, separators=(",", ":")) for row in rows]
    return ("\n".join(lines) + "\n").encode("ascii")


def outputs() -> dict[Path, bytes]:
    return {
        OUT / "inv-rules-expr-cases.jsonl": render("inv-rules-expr-cases", cases_rows()),
        OUT / "inv-rules-expr-random.jsonl": render(
            "inv-rules-expr-random", random_rows(random.Random(SEED))
        ),
    }


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail when the committed files differ")
    args = parser.parse_args(list(argv) if argv is not None else None)
    stale = 0
    for path, content in outputs().items():
        if args.check:
            if not path.exists() or path.read_bytes() != content:
                print(f"stale: {path.relative_to(ROOT)}")
                stale += 1
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        print(f"{path.relative_to(ROOT)} written")
    if args.check:
        print("up to date" if not stale else f"{stale} stale file(s)")
    return 1 if stale else 0


if __name__ == "__main__":
    sys.exit(main())
