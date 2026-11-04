#!/usr/bin/env python3
"""Synthetic parity vectors for the TypeScript port of the strategy loader (scope S14).

    .venv/bin/python parity/python/vectors_inv_strategy.py            # writes the vectors
    .venv/bin/python parity/python/vectors_inv_strategy.py --check    # regenerates in memory, fails on any diff

Writes ``packages/domain/test/vectors/inv-strategy-cases.jsonl`` (read by
``packages/domain/src/investments/strategy/strategy.vectors.test.ts``) and ``inv-strategy-random.jsonl``
(read by ``strategy.vectors.exhaustive.test.ts``). The oracle is the real ``load_strategy``: every row is
one ``(yaml, md)`` input and its whole ``StrategyLoadResult`` in the golden form (``canon.py``: dataclass
fields, sets sorted, Decimals as ``str()``, floats as JSON numbers), so the issue codes, params, paths,
lines and columns, the config, the partial config and the inactive rules are all compared.

Inputs are synthetic: every ``(yaml, md)`` the oracle test files pass to the loader (recorded while
pytest runs ``oracle/tests/investments/strategy`` and ``oracle/tests/test_message_codes.py``), the shipped templates,
hand-written documents for the codes and scalar forms the tests do not reach, then seeded line and
token mutations of those documents. An input on which Python raises outside the loader's contract (an exception from
an odd explicitly tagged scalar, an integer id that canon cannot place) is recorded as ``raises`` with
the exception type. Nothing reads a data dir or a database.

File format as ``vectors.py``: JSON Lines (ASCII-escaped), line 1 ``{"meta": {...}}``, then one array per
vector: ``["load", yaml, md, result]``, ``["raises", yaml, md, exception type]`` or
``["classify", message, null, [code, params]]`` (every issue message of the cases plus hand messages).
"""

from __future__ import annotations

import argparse
import functools
import json
import random
import sys
from collections.abc import Iterable
from pathlib import Path

import canon
from cashu.modules.investments.strategy import loader as loader_module
from cashu.modules.investments.strategy import load_strategy
from cashu.modules.investments.strategy.codes import classify
from cashu.modules.investments.templates import STRATEGY_TEMPLATE_NAMES, strategy_template

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "packages" / "domain" / "test" / "vectors"
ORACLE = ROOT / "parity" / "python" / "oracle"
TESTS = ORACLE / "tests" / "investments" / "strategy"
CODES_TEST = ORACLE / "tests" / "test_message_codes.py"
SEED = 2026_11_01
LAYOUT = ["kind", "yaml", "md", "result | exception type"]

# Tokens a mutation drops into a document: keys, kinds, values, numbers, YAML syntax and odd scalars.
TOKENS = [
    "version", "base_currency", "horizon_years", "contributions", "data", "buckets", "allocation",
    "rules", "watchlist", "benchmark", "notifications", "review", "targets", "rebalance", "match",
    "params", "kind", "id", "severity", "cooldown_days", "polarity", "when", "scope", "message",
    "asset_class", "tags", "mic", "currency", "instrument_ids", "threshold", "max_weight",
    "min_weight", "window_days", "grace_days", "period_days", "absolute_band_pp", "relative_band",
    "min_trade_value", "max_price_age_days", "max_unverified_days", "every", "day", "cards", "name",
    "allocation_drift", "custom", "cash_level", "loss_from_cost", "gain_from_cost", "tagged_weight",
    "drawdown_from_high", "position_concentration", "contribution_gap", "instrument", "bucket",
    "portfolio", "action", "info", "positive", "PLN", "EUR", "pln", "XX", "etf", "equity", "cash",
    "stocks", "bonds", "monday", "Friday", "month", "2weeks", "world", "decide",
    "0", "1", "-1", "0.5", "1.5", "2", "1e3", "0x1F", "0o17", "0b101", "1_000", "1:30", ".inf",
    "-.inf", ".nan", "~", "null", "true", "no", "yes", "2024-02-30", "2024-01-01", "2024-01-01 10:00:00",
    "2024-01-01T10:00:00.5+02:00", "99999999999999999999", "1e400",
    "{", "}", "[", "]", ":", ",", "-", "&a", "*a", "!!str", "!!int", "!!float", "!foo", "<<", "=",
    "'", '"', "#", "|", ">", "?", "%", "@", "`", "\t", "\x01", "\u00e9", "\u2028", "\U0001f600",
    '"weight > 10%"', "'cash_weight >> 1'", '"bucket_weight(\\"bnds\\") > 5%"', "drift_pp > 5",
    "[a, b]", "{a: 1}", "[[x]]", "-5", "300", "0.001",
]


BASE = "version: 1\nbase_currency: PLN\n"
BUCKETS = (
    "buckets:\n  - { id: stocks, match: { asset_class: equity } }\n"
    "  - { id: cash, match: { asset_class: cash } }\n"
    "allocation:\n  targets: { stocks: 0.8, cash: 0.2 }\n"
)

# Hand-written documents for the codes and scalar forms the test inputs do not reach.
HAND = [
    BASE + "benchmark: { id: b, proxy: VWCE.DE, currency: [EUR, USD] }\n",
    BASE + "benchmark: { id: b, proxy: '   ' }\n",
    BASE + "benchmark: { id: 'b c', proxy: X }\n",
    BASE + "rules:\n  - { id: c, kind: custom, params: { when: 'cash_weight > 1%', message: '  ' } }\n",
    BASE + "rules:\n  - { id: c, kind: custom, params: { when: 'cash_weight > 1%', message: '" + "x" * 201 + "' } }\n",
    BASE + "rules:\n  - id: c\n    kind: custom\n    params:\n      when: cash_weight > 1%\n      message: |\n        a\n        b\n",
    BASE + "rules:\n  - { id: c, kind: custom, params: { when: 'cash_weight > 1%', tags: [x], instrument_ids: [a] } }\n",
    BASE + BUCKETS + "rules:\n  - { id: c, kind: custom, params: { scope: instrument, when: 'weight > 1%', buckets: [stocks] } }\n",
    BASE + "rules:\n  - { id: c, kind: cash_level, params: { min_weight: 0.3, max_weight: 0.2 } }\n",
    BASE + "rules:\n  - { id: c, kind: cash_level, params: { min_weight: .inf } }\n",
    BASE + "rules:\n  - { id: c, kind: cash_level, params: { max_weight: .nan } }\n",
    BASE + "rules:\n  - { id: c, kind: cash_level, params: { max_weight: 99999999999999999999 } }\n",
    BASE + "rules:\n  - { id: c, kind: drawdown_from_high, params: { threshold: 0.1, window_days: 1.0 } }\n",
    BASE + "rules:\n  - { id: c, kind: drawdown_from_high, params: { threshold: 2024-01-01, window_days: 2024-01-01 10:00:00 } }\n",
    BASE + "rules:\n  - { id: c, kind: loss_from_cost, params: { threshold: 1.5 } }\n",
    BASE + "rules:\n  - { id: c, kind: gain_from_cost, params: { threshold: 3 } }\n",
    BASE + "rules:\n  - { id: c, kind: contribution_gap, params: { grace_days: -1, period_days: 0x10 } }\n",
    BASE + "contributions: { monthly_amount: '1_000.50' }\nrules:\n  - { id: c, kind: contribution_gap }\n",
    BASE + "contributions: { monthly_amount: 0 }\n",
    BASE + "contributions: { monthly_amount: abc, day_of_month: 32 }\n",
    BASE + "contributions: { monthly_amount: 1e3, day_of_month: 0o17 }\n",
    BASE + "contributions: { monthly_amount: 0.1 }\n",
    BASE + "data: { max_unverified_days: null, max_price_age_days: 1:30 }\n",
    BASE + "data: { max_unverified_days: 3651, max_stale_weight: 1.5 }\n",
    BASE + "data: { max_fx_age_days: !!int '12', max_stale_weight: !!float '0.5' }\n",
    BASE + "data: { max_fx_age_days: !!int '', max_stale_weight: !!float '' }\n",
    BASE + "data: { max_fx_age_days: !!int '0b', max_stale_weight: !!float 'x' }\n",
    BASE + "data: { max_fx_age_days: !!int ' 7 ', max_stale_weight: !!float ' 1e-1 ' }\n",
    BASE + "watchlist:\n  criteria: { max_pe: 20, min_roa: 1, max_pb: .inf, min_roe: yes, x: 2024-02-30 }\n",
    BASE + "watchlist:\n  criteria: { max_pe: 2024-01-01T10:00:00.123+02:00 }\n",
    BASE + "watchlist:\n  criteria: { max_pe: [1, 'a', 1.5, null, true, {a: 2001-12-14 21:59:43.10 -5}] }\n",
    BASE + BUCKETS.replace("0.8", "0.80000001") + "notifications: { immediate: [ACTION, urgent], digest_weekday: ' Sunday ' }\n",
    BASE + BUCKETS.replace("0.8", "'0.8'"),
    BASE + BUCKETS.replace("0.8", "[0.8]"),
    BASE + BUCKETS.replace("0.8", "true"),
    BASE + BUCKETS.replace("0.8", "1").replace("0.2", "0"),
    BASE + BUCKETS.replace("0.8", "0.7"),
    BASE + "review: { every: Month, day: ' Monday ', name: '  ', cards: [World, world, decide] }\n",
    BASE + "review: { cards: [] }\nnotifications: { immediate: [] }\n",
    BASE + "review: { name: 'Przegl\u0105d \U0001f600' }\n",
    BASE.replace("PLN", "' pln '"),
    BASE.replace("PLN", "PLNN"),
    BASE.replace("1", "1.0"),
    BASE.replace("1", "'1'"),
    BASE.replace("1", "true"),
    BASE.replace("1", "99999999999999999999"),
    BASE + "horizon_years: 101\n",
    BASE.replace("\n", "\r\n"),
    "\ufeff" + BASE,
    BASE + "buckets:\n\t- x\n",
    BASE + "x: 'caf\u00e9\U0001f600'\nversio: 1\n",
    BASE + "? [a, b]\n: 1\n",
    BASE + "x: !!binary aGk=\n",
    BASE + "x: !!set { a }\n",
    BASE + "x: =\n",
    BASE + "<<: { a: 1 }\n",
    BASE + "x: &a 1\ny: &a 2\n",
    BASE + "---\na: 1\n",
    "---\n...\n",
    "# only a comment\n",
    "~\n",
    "- a\n- b\n",
    "plain text\n",
    BASE + "x: " + "[" * 40 + "]" * 40 + "\n",
    BASE + BUCKETS + "rules:\n  - { id: d, kind: allocation_drift, params: { buckets: [stocks, cahs] } }\n",
    BASE + BUCKETS + "rules:\n  - id: c\n    kind: custom\n    params:\n      when: \"bucket_weight(\\\"stokcs\\\") > 5%\"\n",
    BASE + BUCKETS + "rules:\n  - id: c\n    kind: custom\n    params:\n      when: 'bucket_weight(\"x\") > 5% and cash_weight > \u00e91'\n",
    BASE + "rules:\n  - id: c\n    kind: custom\n    params:\n      when: >-\n        cash_weight\n        >> 1\n",
    BASE + "rules:\n  - { id: c, kind: custom, params: { scope: bucket, when: 'drift_pp > 5' }, polarity: positive, severity: ACTION }\n",
    BASE + "rules:\n  - { id: c, kind: custom, params: { scope: global, when: 'x' } }\n",
    BASE + "rules:\n  - { id: 'c\\n', kind: cash_level, params: { max_weight: 0.1 } }\n",
    BASE + "rules:\n  - { id: [c], kind: [cash_level] }\n  - 5\n  - { id: d, kind: cash_level, params: { max_weight: 0.1 }, cooldown_days: 1.5 }\n",
]

# Messages for ``classify`` alone: every template's shape plus multi-line and non-ASCII digit forms.
MESSAGES = [
    "Invalid YAML: a\nb\nc",
    "Invalid YAML: \n",
    "strategy.yaml is too large (\u0661\u0662 characters, max 5)",
    "Targets sum to \u0661.5, expected 1",
    "x must be at least 1, got 0 (fractions: 0.15 = 15%)",
    "x must be at least 1 and at most 2, got 3\n",
    "a.b[1] must be a finite number",
    "tags[1] is required",
    "Unknown key \"x\" (did you mean \"y\"?); it is ignored",
    'Unknown bucket "a" (no buckets are defined) (column 3 of the expression)',
    "",
    "something else",
]


@functools.cache
def record_test_inputs() -> list[tuple[str, str | None]]:
    """Every ``(yaml, md)`` the strategy tests hand to the loader, in call order, deduplicated."""
    import pytest

    seen: list[tuple[str, str | None]] = []
    original = loader_module._Parse.__init__

    def spy(self, catalog, source, md):  # noqa: ANN001 - mirrors _Parse.__init__
        if isinstance(source, str) and (md is None or isinstance(md, str)):
            seen.append((source, md))
        original(self, catalog, source, md)

    loader_module._Parse.__init__ = spy  # type: ignore[method-assign]
    try:
        code = pytest.main(
            ["-q", "-p", "no:cacheprovider", "-p", "no:randomly", str(TESTS), str(CODES_TEST)]
        )
    finally:
        loader_module._Parse.__init__ = original  # type: ignore[method-assign]
    if code != 0:
        raise SystemExit(f"the oracle tests failed (pytest exit {code})")
    return unique(seen)


def unique(items: Iterable[tuple[str, str | None]]) -> list[tuple[str, str | None]]:
    return list(dict.fromkeys(items))


def template_inputs() -> list[tuple[str, str | None]]:
    out: list[tuple[str, str | None]] = []
    for name in STRATEGY_TEMPLATE_NAMES:
        template = strategy_template(name)
        out += [(template.yaml, template.markdown), (template.yaml, None)]
    return out


def result_out(yaml_text: str, md: str | None) -> list:
    try:
        result = load_strategy(yaml_text, md)
        tree = canon.Canon(None).value(result)
    except Exception as error:  # noqa: BLE001 - an exception is the recorded outcome
        return ["raises", yaml_text, md, type(error).__name__]
    return ["load", yaml_text, md, tree]


def mutate(text: str, rng: random.Random) -> str:
    lines = text.split("\n")
    for _ in range(rng.randint(1, 3)):
        op = rng.randrange(8)
        i = rng.randrange(len(lines)) if lines else 0
        if not lines:
            lines = [rng.choice(TOKENS)]
        elif op == 0:
            del lines[i]
        elif op == 1:
            lines.insert(i, lines[rng.randrange(len(lines))])
        elif op == 2:
            j = rng.randrange(len(lines))
            lines[i], lines[j] = lines[j], lines[i]
        elif op == 3:
            lines[i] = " " * rng.choice([1, 2, 4]) + lines[i] if rng.random() < 0.5 else lines[i].lstrip()
        elif op == 4 or op == 5:
            words = lines[i].split(" ")
            k = rng.randrange(len(words))
            words[k] = rng.choice(TOKENS) if op == 4 else words[k] + rng.choice(TOKENS)
            lines[i] = " ".join(words)
        elif op == 6:
            line = lines[i]
            k = rng.randrange(len(line) + 1)
            lines[i] = line[:k] + rng.choice(TOKENS) + line[k:]
        else:
            key = rng.choice(TOKENS)
            lines.insert(i, f"{key}: {rng.choice(TOKENS)}")
    return "\n".join(lines)


def cases_rows() -> list[list]:
    hand = [(text, None) for text in HAND]
    inputs = unique([*template_inputs(), *record_test_inputs(), *hand])
    rows = [result_out(yaml_text, md) for yaml_text, md in inputs]
    messages = list(MESSAGES)
    for row in rows:
        if row[0] == "load":
            messages += [issue["message"] for issue in row[3]["issues"]]
    rows += [["classify", m, None, list(classify(m))] for m in dict.fromkeys(messages)]
    return rows


def random_rows(rng: random.Random) -> list[list]:
    bases = [yaml_text for yaml_text, _ in unique([*template_inputs(), *record_test_inputs()])]
    bases = [b for b in bases if len(b) < 20_000]
    docs: list[tuple[str, str | None]] = []
    for _ in range(4000):
        docs.append((mutate(rng.choice(bases), rng), rng.choice([None, "", "# Cel\n"])))
    return [result_out(yaml_text, md) for yaml_text, md in unique(docs)]


def render(name: str, rows: list[list]) -> bytes:
    meta = {
        "meta": {
            "name": name,
            "count": len(rows),
            "raises": sum(1 for row in rows if row[0] == "raises"),
            "layout": LAYOUT,
            "seed": SEED,
            "generator": "parity/python/vectors_inv_strategy.py",
            "python": sys.version.split()[0],
        }
    }
    lines = [json.dumps(meta)]
    lines += [json.dumps(row, separators=(",", ":"), sort_keys=True) for row in rows]
    return ("\n".join(lines) + "\n").encode("ascii")


def outputs() -> dict[Path, bytes]:
    return {
        OUT / "inv-strategy-cases.jsonl": render("inv-strategy-cases", cases_rows()),
        OUT / "inv-strategy-random.jsonl": render(
            "inv-strategy-random", random_rows(random.Random(SEED))
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
