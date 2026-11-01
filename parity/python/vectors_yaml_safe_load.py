#!/usr/bin/env python3
"""Synthetic parity vectors for ``yaml.safe_load`` and the strategy documents' frontmatter (scope S22b).

    .venv/bin/python parity/python/vectors_yaml_safe_load.py            # writes the vectors
    .venv/bin/python parity/python/vectors_yaml_safe_load.py --check    # fails on any diff

Writes two JSON Lines files (line 1 ``{"meta": {...}}``, then one vector per line):

- ``packages/domain/test/vectors/yaml-safe-load.jsonl``: ``[text, outcome]``, ``outcome`` =
  ``{"value": v}`` (the value ``yaml.safe_load(text)`` returns, PyYAML 6.0.3) or ``{"error": true}``
  (a ``yaml.YAMLError``) or ``{"error": "<name>"}`` (a non-YAML exception PyYAML lets escape for an
  odd explicitly tagged scalar, e.g. ``!!int ''``: the TS port returns ``ok: false`` for it too). ``v``: null / bool / str as JSON, ``{"int": "<digits>"}``,
  ``{"float": "<repr>"}``, ``{"date": iso}``, ``{"datetime": isoformat(" ")}``, a list, or
  ``{"map": [[str(key), v], ...]}`` (keys as ``str(key)``, equal texts folded: first position, last
  value, like the TS port's contract).
- ``packages/store/test/vectors/strategy-frontmatter.jsonl``: ``[md_text, fields, body]`` from
  ``service.strategy_docs.frontmatter``.

Every input is hand-written and synthetic; nothing reads a data dir. Inputs on which the TS port
deliberately differs (``!!set`` / ``!!omap`` / ``!!pairs`` / ``!!binary``, recursive aliases) are not
included.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
SAFE_OUT = ROOT / "packages" / "domain" / "test" / "vectors" / "yaml-safe-load.jsonl"
FRONT_OUT = ROOT / "packages" / "store" / "test" / "vectors" / "strategy-frontmatter.jsonl"

if yaml.__version__ != "6.0.3":
    raise SystemExit(f"vectors_yaml_safe_load.py pins PyYAML 6.0.3, found {yaml.__version__}")

sys.path.insert(0, str(ROOT / "src"))
from cashu.modules.investments.service.strategy_docs import frontmatter  # noqa: E402

SAFE_CASES = [
    "",
    "# only a comment\n",
    "title: Plan emerytalny\n",
    "title: 'Strategia: ETF'\nstatus: draft\ndescription: >\n  Długi\n  opis\n",
    "title: \"Zażółć gęślą jaźń\"\n",
    "a: 1\nb: -0\nc: 0o17\nd: 017\ne: 0x1F\nf: 1_000\ng: 1:30\nh: +12\n",
    "a: 1.5\nb: .inf\nc: -.Inf\nd: .NaN\ne: 1e3\nf: 6.8523015e+5\ng: 190:20:30.15\nh: 1.\n",
    "a: yes\nb: No\nc: on\nd: OFF\ne: true\nf: False\ng: y\nh: n\n",
    "a: ~\nb: null\nc:\nd: Null\n",
    "a: 2026-11-01\nb: 2026-11-01 12:30:00\nc: 2026-11-01T12:30:00.5Z\nd: 2026-11-01t12:30:00+02:00\n",
    "a: 2026-1-1 1:02:03.000123 -5\n",
    "list: [1, two, 3.0, null]\nnested: {x: {y: [a, b]}}\n",
    "- 1\n- [a, b]\n- {k: v}\n",
    "plain scalar\n",
    "42\n",
    "a: !!str 1\nb: !!float 1\nc: !!int '7'\nd: !!bool yes\ne: !!null ''\nf: !!timestamp 2026-01-02\n",
    "a: !!int ''\n",
    "a: !!bool maybe\n",
    "a: !!timestamp nope\n",
    "a: !foo bar\n",
    "a: !!python/name:os.system ''\n",
    "? [a, b]\n: 1\n",
    "? {k: v}\n: 1\n",
    "1: one\n1.0: float one\ntrue: bool one\n'1': text one\n",
    "a: 1\na: 2\n",
    "2026-11-01: day key\n~: null key\n.5: half\n",
    "base: &b {x: 1, y: 2}\nother:\n  <<: *b\n  y: 3\n",
    "a: &a {x: 1}\nb: &b {x: 2, z: 3}\nc:\n  <<: [*a, *b]\n  w: 0\n",
    "a: {<<: {k: v}, k: own}\n",
    "a: {<<: 1}\n",
    "a: {<<: [1]}\n",
    "a: {=: value key}\n",
    "x: &v [1, 2]\ny: *v\n",
    "a: [unclosed\n",
    "a: b: c\n",
    "a:\n\t- tab\n",
    "--- \nfirst\n--- \nsecond\n",
    "key: |\n  line one\n  line two\n",
    "title: Strategia\nstatus: aktywna\ndescription: ''\nversion: 3\nweight: 0.25\n",
    "a: '\\u00e9 not an escape'\nb: \"\\u00e9 escape\"\n",
    "a: 12345678901234567890123\nb: -0b1010\nc: 0b_1\n",
    "a: 1.0e+400\nb: 0.1\nc: -1_0.5\n",
]

FRONT_CASES = [
    "# Bez frontmatter\n\nTekst.\n",
    "---\ntitle: Plan IKE\nstatus: draft\ndescription: Krótki opis\n---\n# Nagłówek\n\nTreść.\n",
    "---\r\ntitle: CRLF\r\n---\r\nbody\r\n",
    "---\ntitle: brak końca\n# Nagłówek\n",
    "---\ntitle: [nie zamknięta\n---\nbody\n",
    "---\n- lista\n- nie mapa\n---\nbody\n",
    "---\ntitle: '  spacje  '\nempty: ''\nnumber: 7\nflag: yes\nratio: 0.5\nnone: ~\nlist: [a]\nwhen: 2026-11-01\n---\nbody",
    "---\ntitle: !foo x\n---\nbody\n",
    "---\n1: liczba\ntrue: prawda\n---\n",
    "---\n---\nbody\n",
    "---\ntitle: x\n---",
    "  ---\ntitle: x\n---\nbody\n",
]


def encode(value) -> object:
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return {"int": str(value)}
    if isinstance(value, float):
        return {"float": repr(value)}
    if isinstance(value, dt.datetime):
        return {"datetime": value.isoformat(" ")}
    if isinstance(value, dt.date):
        return {"date": value.isoformat()}
    if isinstance(value, list):
        return [encode(v) for v in value]
    if isinstance(value, dict):
        out: dict[str, object] = {}
        for k, v in value.items():
            out[str(k)] = encode(v)
        return {"map": [[k, v] for k, v in out.items()]}
    raise TypeError(f"unexpected value {type(value).__name__}")


def safe_outcome(text: str) -> dict:
    try:
        return {"value": encode(yaml.safe_load(text))}
    except yaml.YAMLError:
        return {"error": True}
    except (IndexError, KeyError, AttributeError, ValueError) as e:  # escapes safe_load (PyYAML bug)
        return {"error": type(e).__name__}


def render(name: str, rows: list, layout: str) -> str:
    meta = {
        "meta": {
            "name": name,
            "count": len(rows),
            "layout": layout,
            "generator": "parity/python/vectors_yaml_safe_load.py",
            "python": sys.version.split()[0],
            "pyyaml": yaml.__version__,
        }
    }
    lines = [json.dumps(meta, ensure_ascii=False)]
    lines += [json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in rows]
    return "\n".join(lines) + "\n"


def files() -> dict[Path, str]:
    safe = [[text, safe_outcome(text)] for text in SAFE_CASES]
    front = [[text, *frontmatter(text)] for text in FRONT_CASES]
    return {
        SAFE_OUT: render("yaml-safe-load", safe, "[text, {value} | {error: true | exception name}]"),
        FRONT_OUT: render("strategy-frontmatter", front, "[md_text, fields, body]"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail when a committed file differs")
    args = parser.parse_args()
    stale = []
    for path, text in files().items():
        if args.check:
            if not path.exists() or path.read_text(encoding="utf-8") != text:
                stale.append(path.name)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        print(f"{path.name}: {text.count(chr(10)) - 1} vectors")
    if stale:
        print("stale vector files: " + ", ".join(stale))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
