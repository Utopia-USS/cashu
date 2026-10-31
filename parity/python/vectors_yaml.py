#!/usr/bin/env python3
"""Synthetic parity vectors for the TypeScript port of PyYAML's composer (scope S17b).

    .venv/bin/python parity/python/vectors_yaml.py            # writes the vectors
    .venv/bin/python parity/python/vectors_yaml.py --check    # regenerates in memory, fails on any diff

Writes ``packages/domain/test/vectors/yaml-*.jsonl``: for every document ``yaml.compose(text,
Loader=yaml.SafeLoader)`` (PyYAML 6.0.3, pure Python loader) as a node tree or the error it raises.
Every input is synthetic: hand-written cases, random documents with a fixed seed, random mutations of
those and of the repository's synthetic mapping example. Nothing reads a data dir; only ``yaml`` and
the standard library are imported.

File format as ``vectors.py``: JSON Lines, line 1 ``{"meta": {...}}``, then ``[text, outcome]`` per
document. ``outcome`` is ``{"node": tree | null}`` or ``{"error": {...}}``. A tree node is
``["s", tag, value, style, *marks]``, ``["q", tag, flow_style, *marks, [children]]``,
``["m", tag, flow_style, *marks, [[key, value], ...]]`` or ``["r", n]`` (the n-th node of the
pre-order walk again: an alias), with ``marks`` = start line, column, index, end line, column, index.
An error is ``{"kind": "marked", "context", "context_mark", "problem", "problem_mark", "note",
"text"}`` (marks as ``[line, column, index]``) or ``{"kind": "reader", "text"}``. Documents on which
PyYAML raises a non-YAML exception (``chr()`` range, recursion depth) are left out.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import unicodedata
from collections.abc import Callable, Iterable
from pathlib import Path

import yaml
from yaml.nodes import MappingNode, ScalarNode, SequenceNode

ROOT = Path(__file__).resolve().parents[2]
SEED = 20261031
OUT = ROOT / "packages" / "domain" / "test" / "vectors"
EXAMPLE = ROOT / "src" / "cashu" / "modules" / "investments" / "importing" / "generic_csv_example.yaml"

if yaml.__version__ != "6.0.3":
    raise SystemExit(f"vectors_yaml.py pins PyYAML 6.0.3, found {yaml.__version__}")

# --------------------------------------------------------------------------- serialization


def mark_out(mark) -> list | None:
    return None if mark is None else [mark.line, mark.column, mark.index]


def node_out(root) -> list:
    seen: dict[int, int] = {}

    def walk(node) -> list:
        if id(node) in seen:
            return ["r", seen[id(node)]]
        seen[id(node)] = len(seen)
        s, e = node.start_mark, node.end_mark
        marks = [s.line, s.column, s.index, e.line, e.column, e.index]
        if isinstance(node, ScalarNode):
            return ["s", node.tag, node.value, node.style, *marks]
        if isinstance(node, SequenceNode):
            return ["q", node.tag, node.flow_style, *marks, [walk(c) for c in node.value]]
        assert isinstance(node, MappingNode)
        return ["m", node.tag, node.flow_style, *marks, [[walk(k), walk(v)] for k, v in node.value]]

    return walk(root)


def outcome(text: str) -> dict | None:
    """The vector outcome, or None when PyYAML raises something that is not a YAMLError."""
    try:
        node = yaml.compose(text, Loader=yaml.SafeLoader)
    except yaml.MarkedYAMLError as e:
        return {"error": {"kind": "marked", "context": e.context, "context_mark": mark_out(e.context_mark),
                          "problem": e.problem, "problem_mark": mark_out(e.problem_mark), "note": e.note,
                          "text": str(e)}}
    except yaml.YAMLError as e:
        return {"error": {"kind": "reader", "text": str(e)}}
    except (ValueError, RecursionError):
        return None
    return {"node": None if node is None else node_out(node)}


# --------------------------------------------------------------------------- hand-written cases

PL_MAPPING_YAML = """\
# Synthetic Polish broker export mapping used by the import tests (no real data).
version: 1
name: "Synthetic PL broker"
broker_id: generic_csv
encoding: utf-8
delimiter: ";"
decimal_separator: ","
thousands_separator: " "
date_formats: ["dd.MM.yyyy"]
default_currency: PLN
amount_sign: signed
columns:
  trade_date: "Data"
  type: "Typ"
  symbol: "Symbol"
  isin: "ISIN"
  name: "Nazwa"
  exchange: "Giełda"
  quantity: "Ilość"
  price: "Cena"
  currency: "Waluta"
  fee: "Prowizja"
  cash_amount: "Kwota"
  note: "Opis"
types:
  "Kupno": buy
  "Sprzedaż": sell
  "Dywidenda": dividend
  "Wpłata": deposit
  "Opłata": fee
  "Blokada środków": ignore
"""

VALID = [
    "", " ", "\n", "# only a comment\n", "---", "--- ", "---\n...\n", "...", "a", "a\n", "- a\n- b\n",
    "a: 1\nb: 2\n", "a:\n  b:\n    c: d\n", "a:\n- 1\n- 2\nb: x\n", "- - a\n  - b\n- c\n", "- a: 1\n  b: 2\n- c\n",
    "[a, b, c]", "{a: 1, b: 2}", "[a, [b, c], {d: e}]", "{a: [1, 2], b: {c: d}}", "[]", "{}", "[ ]", "{ }",
    "[a, b, ]", "{a: 1, }", "[a: 1, b: 2]", "[? a : b]", "{? a}", "{a, b: c}", "[a,b]", "{a:1}", "{\"a\":1}",
    "? a\n: b\n", "? - a\n  - b\n: - c\n", "? a\n? b\n", ": a\n", "?\n:\n", "- \n- a\n", "-\n-\n", "a:\nb:\n",
    "a: |\n  line1\n  line2\n", "a: >\n  folded\n  text\n\n  para\n", "a: |-\n  x\n\n", "a: |+\n  x\n\n\n",
    "a: >-\n  x\n  y\n", "a: >+\n  x\n\n", "a: |2\n   x\n  y\n", "a: |1-\n  x\n", "a: >2+\n   x\n", "- |\n  a\n- >\n  b\n",
    "|\n  top\n", ">\n\n  folded after blank\n", "a: |\n\n\n  late\n", "a: |\n  x\n # not comment\n", "a: >\n  a\n   b\n  c\n",
    "a: |  # comment\n  x\n", "a: >\n\ta\n", "a: |\n  \ttab\n", "'single'", "'it''s'", "\"double\"", "\"esc \\n \\t \\\\ \\\" \\/\"",
    "\"\\x41\\u0105\\U0001F600\"", "\"\\0\\a\\b\\e\\f\\r\\v\\N\\_\\L\\P\\ \"", "\"line\\\n  continued\"", "'multi\n  line\n\n  para'",
    "\"multi\n  line\n\n  para\"", "\"a\tb\"", "'a\tb'", "\"  lead and trail  \"", "plain with spaces", "plain\n  continued\n  lines",
    "a: plain\n  continued\n", "a: b # comment\n", "a: b#not comment\n", "a: 'b' # c\n", "# c\na: b\n# d\n", "a: b\n\n\nc: d\n",
    "&a x", "&a [*a]", "&a {k: *a}", "a: &x 1\nb: *x\n", "- &a a\n- *a\n- *a\n", "a: &anchor\n  b: c\nd: *anchor\n",
    "&a !!str x", "!!str &a x", "!!int 1", "!!str 1", "!!map {a: 1}", "!!seq [a]", "!custom x", "! x", "! 1", "!<tag:x> y",
    "!<!> 1", "%TAG !e! tag:example.com,2000:\n---\n!e!foo x\n", "%YAML 1.1\n---\na\n", "%YAML 1.2\n--- a\n", "%FOO bar baz\n--- x\n",
    "%TAG ! tag:x,1:\n--- !y z\n", "%YAML 1.1 # comment\n---\nx\n", "--- !!set\n? a\n? b\n", "a: !!binary aGVsbG8=\n", "!!null ''",
    "--- >\n  folded doc\n", "--- |\n  literal doc\n...\n", "---\na: b\n...\n", "... \n", "a: -1\nb: -.5\nc: +12\n",
    "- ~\n- null\n- Null\n- NULL\n- nULL\n-\n", "- yes\n- No\n- ON\n- off\n- y\n- n\n- True\n- tRUE\n", "<<: {a: 1}\n", "= \n", "a: =\n",
    "key with spaces: value with spaces\n", "\"quoted key\": 1\n'single key': 2\n", "[a, 'b', \"c\"]", "{'a': \"b\"}", "a: [1, 2]\nb: {c: d}\n",
    "\ufeffa: b\n", "\ufeff", "\ufeff# c\n", "a: b\r\nc: d\r\n", "a: b\rc: d\r", "a: |\r\n  x\r\n  y\r\n", "a\x85b", "a: b\x85c: d\x85",
    "a: b\u2028c: d", "a\u2029b", "\"a\u2028b\"", "a: \"x\r\n  y\"\n", "zażółć: gęślą jaźń\n", "ŁÓDŹ: Ćma\n", "emoji: 😀\n😀: a\n", "a: 😀😀 b\n",
    "\"😀\\U0001F600\"", "- 😀\n- [😀, x]\n", "key: \u00a0nbsp\n", "a: \u2003em space\n", "a: x\n  # comment in value\n", "a:\n  # c\n  b: 1\n",
    "a: 1 # c\n# c2\nb: 2\n", "- a # c\n- b\n", "[a, # c\n b]", "{a: 1, # c\n b: 2}", "a: [\n  1,\n  2\n]\n", "a: {\n b: 1\n}\n",
    "a:\n    - 1\n    - 2\n", "a:\n  - b:\n      c\n", "- - - deep\n", "[[[[[deep]]]]]", "{a: {b: {c: {d: e}}}}", "a: 'x'\nb: \"y\"\nc: z\n",
    "time: 12:30:45\nsexa: 190:20:30\n", "date: 2026-01-05\nts: 2001-12-14t21:59:43.10-05:00\n", "f: 1_000.5\ni: 0b1010\nh: 0x_1F\no: 017\n",
    "- .inf\n- -.Inf\n- +.INF\n- .NaN\n- .nan\n- 1e3\n- 1.0e+3\n- 1.e-3\n- .5e+1\n", "- 0\n- -0\n- +0\n- 00\n- 09\n- 08.5\n- 1__0\n",
    "a:\tb\n", "a: b\t\n", "a: b\t# c\n", "-\ta\n", "? a\t\n: b\n", "{a:\tb}", "[a,\tb]", "a: 'b'\t\n",
    "a: b\n...\n", "--- a\n...\n# trailing comment\n", "---\n---\n"[0:4] + "x\n",
]

LONG = "x" * 120
VALID += [
    f"a: {LONG}\n", f"{LONG}: b\n", f"k: \"{LONG}\"\n", "a: " + " ".join(["word"] * 40) + "\n",
    "k" * 1030 + ": v\n", "? " + "k" * 1030 + "\n: v\n", "[" + ", ".join(str(i) for i in range(300)) + "]\n",
    "".join(f"key{i}: value {i}\n" for i in range(200)), "".join(f"- item {i}\n" for i in range(200)),
    "a: |\n" + "".join(f"  line {i}\n" for i in range(100)), "\n" * 50 + "a: b\n" + "\n" * 50,
    PL_MAPPING_YAML, PL_MAPPING_YAML.replace("\n", "\r\n"), PL_MAPPING_YAML.replace("encoding: utf-8", "encoding: cp1250"),
]

INVALID = [
    "a: b: c", "a: b\n c: d\n", "a:\n  b: c\n d: e\n", "- a\nb: c\n", "a: [b, c", "a: {b: c", "[a, b]]", "{a: b}}", "]", "}",
    "'unclosed", "\"unclosed", "\"bad \\q escape\"", "\"bad \\x4\"", "\"bad \\u12G4\"", "\"\\U0011FFFF\""[:0] + "\"\\UFFFFFFFZ\"",
    "a: 'x\n---\ny'", "a: \"x\n...\n\"", "*undefined", "a: *undefined\n", "a: &x 1\nb: &x 2\n", "&a &b x", "!!str !!int x",
    "--- a\n--- b\n", "a\n---\nb\n", "a: 1\n--- \nb: 2\n", "%YAML 1.1\n%YAML 1.1\n--- x\n", "%YAML 2.0\n--- x\n", "%YAML 1\n--- x\n",
    "%YAML 1.x\n--- x\n", "%YAML a\n", "%TAG !e! x\n%TAG !e! y\n--- z\n", "%TAG e x\n--- z\n", "%TAG !e x\n--- z\n", "%TAG !e!\n--- z\n",
    "% x\n", "%YAML 1.1 x\n--- x\n", "%YAML 1.1\na\n", "!e!x y", "!<x y", "!<> y", "!a!b!c d", "!%zz x", "!<%ff> x", "!<%e2%82> x",
    "!<%c3%28> x", "!a\x85 x", "&\n", "& x", "&a\tx"[0:0] + "&a,b x", "*", "* x", "a: |0\n  x\n", "a: |-0\n", "a: |x\n", "a: | x\n",
    "a: >1 2\n", "a: |++\n", "\tkey: v\n", "a:\n\t- b\n", "- a\n\t- b\n", "a: @x\n", "a: `x\n", "@a", "`a", "a: %x\n", "a\x00b",
    "a\x01", "\x7f", "a: \x08\n", "a\ud800b", "a\ufffeb", "\uffff", "x\x9f", "a\n\x1b[0m", "- a\n  - b\n - c\n", "a:\n  - b\n  c: d\n",
    "? a\n? b\nc\n", "a: b\n- c\n", "[a, b: c, d: ]x", "{a: b, [c]: d, e}f", "[a\nb]"[0:0] + "[a\n- b]", "{a\n: b}", "- [a,\n- b]",
    "a: !!str\n  - x\n  y\n", "key: \"val\" trailing\n", "key: 'val' trailing\n", "[a] b", "{a: b} c", "a: [b] c\n", "\"a\": \"b\": c",
    "a:\n  b\n  c: d\n", "- a\n- b\n  c\n- d: e\n", "a: b\n  - c\n", "|\nx\n", "a: |\n x\n  y\nz\n", "a: >\n  x\n y\n",
    "k" * 1030 + "x: v\n", "x" * 200 + " !bad ! tag\n" + "y" * 100, "a: '" + "z" * 100 + "\n" + "w" * 100, "😀: [😀, 😀\n",
    "😀😀😀: b: c\n", "zażółć: gęślą: jaźń\n", "\ufeff\ufeffa: b: c\n", "a: b\r\n c: d\r\n", "a: b\rc: d: e\r", "a\u2028: b: c",
    "- a\n-b\n- [c\n", "{a: 1, a: 2}", "a: 1\na: 2\n", "? |\n  x\n: y\n- z\n", "-- a\n", "--- --- a\n", "----\n", "... a\n",
    "a: ...\n", "a: ---\n", "[---]", "{...: a}", "a:\n---\nb\n", "---\n- a\n...\n- b\n",
]

# Implicit resolver edge values, each composed in several contexts.
ATOMS = [
    "", "~", "null", "Null", "NULL", "nUll", "nul", "nulls", "yes", "Yes", "YES", "yEs", "no", "No", "NO", "nO", "true", "True",
    "TRUE", "tRue", "false", "False", "FALSE", "on", "On", "ON", "oN", "off", "Off", "OFF", "y", "Y", "n", "N", "0", "-0", "+0",
    "00", "007", "08", "0o17", "0b1010", "-0b1", "0b", "0b2", "0b1_0", "0x1F", "0x_", "0xG", "-0x1f", "+0xFF", "1_000", "1__", "_1",
    "1,000", "190:20:30", "-190:20:30", "1:60", "1:59", "0:30", "1:2:3", "12:30:45", "12:3", "1.0", "1.", ".5", "-.5", "+.5", "1e3",
    "1.0e+3", "1.0e3", "1.e-3", "1.0E-3", ".5e+1", "6.8523015e+5", "685.230_15e+03", "685_230.15", "190:20:30.15", "1:20.5",
    ".inf", ".Inf", ".INF", "-.inf", "+.inf", ".iNf", "inf", ".nan", ".NaN", ".NAN", "-.nan", "nan", ".", "-", "+", "..", "1.2.3",
    "2026-01-05", "2026-1-5", "2001-12-14t21:59:43.10-05:00", "2001-12-14 21:59:43.10 -5", "2001-12-15T02:59:43.1Z",
    "2002-12-14", "2001-12-14 21:59:43.10", "2001-12-14\t21:59:43.10", "2001-12-14  21:59:43", "2001-12-14T21:59",
    "20011214", "2001-12-14Z", "2001-12-14 21:59:43 +05:00", "2001-12-14 21:59:43+5:3", "<<", "<", "<<<", "=", "==", "!", "&",
    "*", "!!", "yes\n", "~\n", "1\n", "1\n\n", "0x", "-", "1 000", "1_", "0_7", "0.", "-.", "+1_0.0_1", "1e+3", "1E+03", "e3",
    "Ąę", "żółw", "😀", "1😀",
]


def atom_cases() -> list[str]:
    out: list[str] = []
    for a in ATOMS:
        esc_double = a.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\t", "\\t")
        esc_single = a.replace("'", "''")
        out += [a, f"k: {a}\n", f"- {a}\n", f"[{a}]", f"{{{a}: v}}", f"'{esc_single}'", f"\"{esc_double}\"",
                f"! \"{esc_double}\"", f"! {a}", f"!!str {a}", f"&x {a}", f"k: |\n  {a}\n"]
    return out


def gen_cases(_rng: random.Random) -> list[str]:
    example = EXAMPLE.read_text(encoding="utf-8")
    return [*VALID, example, example.replace("\n", "\r\n"), *INVALID, *atom_cases()]


# --------------------------------------------------------------------------- random documents

WORDS = ["a", "key", "value", "trade_date", "Kwota", "Giełda", "ŁÓDŹ", "zażółć gęślą", "x y", "1", "-2", "3.5", "1e3", "yes",
         "No", "~", "null", "2026-01-05", "12:30", "0x1F", "😀", "a:b", "a#b", "-x", "?x", ":x", "x-", "it's", "say \"hi\"",
         "tab\there", "back\\slash", "", " lead", "trail ", "a, b", "[x]", "{y}", "<<", "=", "#", "&a", "*a", "!t", "%p", "@q",
         "`r", "|", ">", "'", "\"", "line\nbreak", "two\n\nbreaks", "\u00a0", "ą\u2028b", "a\x85b", "end\n"]
KEYS = ["version", "name", "broker_id", "encoding", "delimiter", "columns", "types", "date_formats", "a", "b", "c", "key",
        "zażółć", "😀", "1", "true", "x y", "-k", "?k"]


def rand_scalar_text(rng: random.Random, value: str, block_ok: bool, indent: str, nl: str) -> str:
    style = rng.choice(["plain", "plain", "plain", "single", "double", "double", "literal", "folded"])
    if style in ("literal", "folded") and not block_ok:
        style = "double"
    if style == "plain":
        return value.replace("\n", " ")
    if style == "single":
        return "'" + value.replace("'", "''").replace("\n", nl + indent + "  " + nl + indent + "  ") + "'"
    if style == "double":
        out = []
        for ch in value:
            if ch in "\"\\":
                out.append("\\" + ch)
            elif ch == "\n":
                out.append(rng.choice(["\\n", "\\n", "\\" + nl + indent + "  \\n"]))
            elif ch == "\t":
                out.append(rng.choice(["\\t", "\t"]))
            elif ord(ch) > 0x7e and rng.random() < 0.5:
                cp = ord(ch)
                out.append(f"\\x{cp:02x}" if cp < 0x100 else f"\\u{cp:04x}" if cp < 0x10000 else f"\\U{cp:08x}")
            else:
                out.append(ch)
        return "\"" + "".join(out) + "\""
    header = "|" if style == "literal" else ">"
    chomp = rng.choice(["", "", "-", "+"])
    ind = rng.choice(["", "", "", "1", "2", "3"])
    header += rng.choice([chomp + ind, ind + chomp])
    if rng.random() < 0.2:
        header += " # c"
    lines = value.split("\n")
    body_indent = indent + " " * rng.randint(1, 3)
    body = nl.join(body_indent + line if line else "" for line in lines)
    return header + nl + body + nl * rng.randint(0, 2)


def rand_tree(rng: random.Random, depth: int):
    r = rng.random()
    if depth >= 4 or r < 0.45:
        return rng.choice(WORDS)
    n = rng.randint(0, 4)
    if r < 0.72:
        return [rand_tree(rng, depth + 1) for _ in range(n)]
    return [(rng.choice(KEYS + WORDS[:20]), rand_tree(rng, depth + 1)) for _ in range(n)]


class Emitter:
    def __init__(self, rng: random.Random, nl: str, step: int):
        self.rng = rng
        self.nl = nl
        self.step = step
        self.anchors: list[str] = []

    def props(self) -> str:
        rng = self.rng
        out = []
        if rng.random() < 0.08:
            out.append(rng.choice(["!!str", "!!map", "!!seq", "!local", "!", "!<tag:x,1:y>", "!e!t", "!!int", "!!null"]))
        if rng.random() < 0.1:
            name = f"a{len(self.anchors)}" if rng.random() < 0.9 else rng.choice(self.anchors or ["a0"])
            self.anchors.append(name)
            out.append("&" + name)
        if rng.random() < 0.5:
            out.reverse()
        return " ".join(out)

    def alias(self) -> str | None:
        if self.anchors and self.rng.random() < 0.1:
            return "*" + self.rng.choice(self.anchors)
        return None

    def comment(self) -> str:
        return self.rng.choice(["", "", "", "", " # note", "  #c", " #"])

    def flow(self, tree) -> str:
        alias = self.alias()
        if alias:
            return alias
        p = self.props()
        pre = p + " " if p else ""
        if isinstance(tree, str):
            text = rand_scalar_text(self.rng, tree, False, "", self.nl)
            return pre + text
        sep = self.rng.choice([", ", ",", " , ", "," + self.nl + " "])
        if tree and isinstance(tree[0], tuple):
            items = [f"{self.flow(k)}: {self.flow(v)}" for k, v in tree]
            return pre + "{" + sep.join(items) + "}"
        if tree == [] and self.rng.random() < 0.5:
            return pre + "{}"
        return pre + "[" + sep.join(self.flow(t) for t in tree) + "]"

    def block(self, tree, indent: str) -> str:
        """The text after `key:` / `- ` (starts with a space or a line break)."""
        rng = self.rng
        nl = self.nl
        if isinstance(tree, str) or not tree or rng.random() < 0.2:
            alias = self.alias()
            if alias:
                return " " + alias + self.comment() + nl
            if isinstance(tree, str):
                p = self.props()
                text = rand_scalar_text(rng, tree, True, indent, nl)
                body = (p + " " if p else "") + text
                return " " + body + ("" if body.endswith(nl) else self.comment() + nl)
            return " " + self.flow(tree) + self.comment() + nl
        p = self.props()
        head = (" " + p if p else "") + self.comment() + nl
        child = indent + " " * self.step
        if isinstance(tree[0], tuple):
            lines = []
            for k, v in tree:
                key = self.flow(k) if rng.random() < 0.9 else "? " + self.flow(k) + nl + child[:-self.step]
                lines.append(child + key + ":" + self.block(v, child))
            return head + "".join(lines)
        indentless = rng.random() < 0.3
        dash_indent = indent if indentless else child
        return head + "".join(dash_indent + "-" + self.block(t, dash_indent) for t in tree)


def rand_document(rng: random.Random) -> str:
    nl = rng.choice(["\n"] * 8 + ["\r\n", "\r\n", "\r", "\x85", "\u2028"])
    em = Emitter(rng, nl, rng.choice([1, 2, 2, 2, 3, 4]))
    tree = rand_tree(rng, 0)
    if not isinstance(tree, list) or not tree or not isinstance(tree[0], tuple):
        tree = [(rng.choice(KEYS), tree)] + [(rng.choice(KEYS), rand_tree(rng, 1)) for _ in range(rng.randint(0, 3))]
    if rng.random() < 0.15:
        body = em.flow(tree) + nl
    else:
        body = "".join(em.flow(k) + ":" + em.block(v, "") for k, v in tree)
    head = ""
    if rng.random() < 0.1:
        head += rng.choice(["%YAML 1.1", "%TAG !e! tag:example.com,2000:", "%YAML 1.1" + nl + "%TAG !e! tag:e,1:"]) + nl
    if head or rng.random() < 0.2:
        head += "---" + rng.choice([nl, " # doc" + nl])
    if rng.random() < 0.1:
        head = "\ufeff" + head
    tail = rng.choice(["", "", "", "..." + nl, "# end" + nl, nl + nl])
    return head + body + tail


def dump_document(rng: random.Random) -> str:
    tree = rand_tree(rng, 0)

    def plain(t):
        if isinstance(t, list):
            if t and isinstance(t[0], tuple):
                return {k: plain(v) for k, v in t}
            return [plain(x) for x in t]
        return t

    data = plain(tree)
    if rng.random() < 0.3:
        shared = plain(rand_tree(rng, 2))
        data = {"first": shared, "second": shared, "rest": data}
    options = {
        "default_flow_style": rng.choice([False, True, None]),
        "allow_unicode": rng.random() < 0.7,
        "indent": rng.choice([2, 2, 4, 3]),
        "width": rng.choice([80, 20, 1000]),
        "explicit_start": rng.random() < 0.2,
        "explicit_end": rng.random() < 0.1,
        "canonical": rng.random() < 0.1,
        "line_break": rng.choice([None, None, "\r\n", "\r"]),
        "sort_keys": rng.random() < 0.5,
    }
    style = rng.choice([None, None, None, "'", '"', "|", ">"])
    if style:
        options["default_style"] = style
    return yaml.dump(data, Dumper=yaml.Dumper if rng.random() < 0.1 else yaml.SafeDumper, **options)


def gen_random(rng: random.Random) -> list[str]:
    docs = [rand_document(rng) for _ in range(1500)]
    docs += [dump_document(rng) for _ in range(600)]
    return docs


# --------------------------------------------------------------------------- mutations

INSERTS = [":", " ", "  ", "-", "- ", "?", "? ", ",", "[", "]", "{", "}", "#", " #", "&", "&a ", "*", "*a", "!", "!!", "! ", "|",
           ">", "'", "\"", "\\", "%", "@", "`", "\t", "\n", "\r", "\r\n", "\n  ", "\n- ", "\x85", "\u2028", "\ufeff", "\x00",
           "\x07", "\ud800", "\ufffe", "ą", "😀", "---", "...", "\n---\n", "\n...\n", "a", "0", ".", "~", "<<", "=", "\\U0011FFFF",
           "\\x4", "%TAG ! x:\n", "%YAML 1.1\n", "!<", ">", "\\", "\"\n"]


def mutate(rng: random.Random, text: str) -> str:
    for _ in range(rng.choice([1, 1, 1, 2, 2, 3])):
        n = len(text)
        op = rng.random()
        i = rng.randrange(n + 1)
        if op < 0.35 and n:
            j = min(n, i + rng.choice([1, 1, 1, 2, 3, 5]))
            text = text[:i] + text[j:]
        elif op < 0.8:
            text = text[:i] + rng.choice(INSERTS) + text[i:]
        elif op < 0.9 and n:
            lines = text.splitlines(keepends=True)
            k = rng.randrange(len(lines))
            text = "".join(lines[:k] + [lines[k]] + lines[k:])
        elif n > 1:
            i = min(i, n - 2)
            text = text[:i] + text[i + 1] + text[i] + text[i + 2:]
    # Never two surrogates in a row: JSON would read them as one astral character.
    return text.replace("\ud800\ud800", "\ud800")


def gen_mutations(rng: random.Random) -> list[str]:
    sources = gen_cases(random.Random(f"{SEED}:yaml-cases"))[: len(VALID) + 2]
    sources += gen_random(random.Random(f"{SEED}:yaml-random"))[:300]
    sources = [s for s in sources if 0 < len(s) < 4000]
    return [mutate(rng, rng.choice(sources)) for _ in range(3000)]


# --------------------------------------------------------------------------- token soup

SOUP = ["a", "b", "1", "0x", ".", ":", ": ", "-", "- ", "?", "? ", ",", "[", "]", "{", "}", "#", " #", "&a", "&b ", "*a", "*b",
        "!", "!!str ", "!e!", "!<x>", "%TAG !e! p:\n", "%YAML 1.1\n", "--- ", "---\n", "...\n", "|", "|-", "|2", ">+", "'",
        "''", "\"", "\\", "\\x41", "\\u00e9", "\\U0001F600", "\\\n", " ", "  ", "   ", "\t", "\n", "\r", "\r\n",
        "\x85", "\u2028", "\ufeff", "ą", "😀", "~", "yes", "null", "2026-01-05", "12:30", "<<", "=", "%41", "%c3%a9", "%ff",
        "@", "`"]


def gen_soup(rng: random.Random) -> list[str]:
    """Short random sequences of indicators, properties, escapes and breaks (directives, tags, URIs)."""
    return ["".join(rng.choice(SOUP) for _ in range(rng.randint(1, 30))) for _ in range(2000)]


# --------------------------------------------------------------------------- output

GENERATORS: dict[str, Callable[[random.Random], list[str]]] = {
    "yaml-cases": gen_cases,
    "yaml-random": gen_random,
    "yaml-mutations": gen_mutations,
    "yaml-soup": gen_soup,
}

LAYOUT = ("[text, {node: tree | null} | {error: {kind: marked, context, context_mark, problem, problem_mark, note, "
          "text} | {kind: reader, text}}]; tree: [s, tag, value, style, marks*6] | [q, tag, flow_style, marks*6, "
          "children] | [m, tag, flow_style, marks*6, pairs] | [r, preorder index]")


def rows_for(texts: list[str]) -> tuple[list, int]:
    rows: list = []
    skipped = 0
    seen: set[str] = set()
    for text in texts:
        if text in seen:
            continue
        seen.add(text)
        result = outcome(text)
        if result is None:
            skipped += 1
            continue
        rows.append([text, result])
    return rows, skipped


def render_rows(name: str, rows: list, skipped: int) -> str:
    meta = {"meta": {"name": name, "count": len(rows), "layout": LAYOUT, "seed": SEED, "skipped_non_yaml_errors": skipped,
                     "generator": "parity/python/vectors_yaml.py", "pyyaml": yaml.__version__,
                     "python": sys.version.split()[0], "unicode": unicodedata.unidata_version}}
    lines = [json.dumps(meta)]
    lines += [json.dumps(row, separators=(",", ":")) for row in rows]
    return "\n".join(lines) + "\n"


def outputs() -> dict[Path, bytes]:
    out: dict[Path, bytes] = {}
    for name, fn in GENERATORS.items():
        rows, skipped = rows_for(fn(random.Random(f"{SEED}:{name}")))
        out[OUT / f"{name}.jsonl"] = render_rows(name, rows, skipped).encode("ascii")
    return out


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail when a committed file differs")
    args = parser.parse_args(list(argv) if argv is not None else None)
    files = outputs()
    if args.check:
        stale = [str(p.relative_to(ROOT)) for p, c in files.items() if not p.exists() or p.read_bytes() != c]
        if stale:
            print("stale files: " + ", ".join(sorted(stale)))
            return 1
        print(f"{len(files)} files up to date")
        return 0
    for path, content in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    print(f"{len(files)} files written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
