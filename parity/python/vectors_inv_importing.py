#!/usr/bin/env python3
"""Synthetic parity vectors for the TypeScript investments importing contract port (scope S17a).

    .venv/bin/python parity/python/vectors_inv_importing.py            # writes the vectors
    .venv/bin/python parity/python/vectors_inv_importing.py --check    # regenerates in memory, fails on any diff

Writes ``packages/domain/test/vectors/inv-importing-*.jsonl``. Every input is synthetic: random with a
fixed seed, hand-picked edge cases, mutations of the documented examples of ``docs/import-format.md``.
Nothing reads a data dir. File format as ``vectors.py``: JSON Lines, line 1 ``{"meta": {...}}``, then one
JSON array per vector (layout in ``meta.layout``). Errors are ``{"error": "<class>"}``.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import random
import re
import sys
import unicodedata
from collections.abc import Callable, Iterable
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from cashu.modules.investments.domain import Currency, TxnType
from cashu.modules.investments.importing import (
    CanonicalImporter,
    ImportFile,
    ImportTextEncoding,
    decode_import_text,
    validate_import,
)
from cashu.modules.investments.importing import cash as cash_mod
from cashu.modules.investments.importing.csv_mapping import did_you_mean
from cashu.modules.investments.importing.csv_values import (
    DatePattern,
    DecimalFormat,
    parse_date_with_patterns,
    parse_datetime_with_patterns,
)
from cashu.modules.investments.importing.canonical import CSV_COLUMNS
from cashu.modules.investments.importing.text import parse_encoding

SEED = 20261031
OUT = ROOT / "packages" / "domain" / "test" / "vectors"
SPEC = ROOT / "docs" / "import-format.md"

if sys.version_info < (3, 14):
    raise SystemExit("vectors_inv_importing.py needs Python 3.14+ (csv / json messages are pinned)")


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def dstr(value: Decimal | None) -> object:
    return None if value is None else str(value)


def error_name(exc: BaseException) -> str:
    return type(exc).__name__


# --------------------------------------------------------------------------- canonical importer


def warning_row(w) -> list:
    return [w.message, w.row, w.blocking, w.kind]


def result_out(r) -> dict:
    return {
        "warnings": [warning_row(w) for w in r.warnings],
        "txns": [
            [
                t.row_index, t.trade_date.isoformat(), t.type.value, str(t.currency), dstr(t.gross_amount),
                dstr(t.cash_amount), str(t.cash_currency), t.external_ref,
                None if t.trade_time is None else t.trade_time.isoformat(),
                None if t.settle_date is None else t.settle_date.isoformat(), t.symbol, t.isin, t.name,
                t.exchange_hint, dstr(t.quantity), dstr(t.price), dstr(t.fee), dstr(t.tax), dstr(t.fx_rate),
                dstr(t.split_ratio), t.note, [[k, v] for k, v in t.raw_row.items()],
            ]
            for t in r.txns
        ],
        "positions": [
            [p.as_of.isoformat(), str(p.currency), dstr(p.quantity), p.symbol, p.isin, p.name, p.exchange_hint,
             dstr(p.avg_price), dstr(p.market_value)]
            for p in r.positions
        ],
        "actions": [
            [type(a).__name__, a.date.isoformat(), a.row_index, a.note,
             *(
                 [a.old_symbol, a.new_symbol, a.old_isin, a.new_isin, a.exchange_hint, a.new_exchange_hint,
                  a.new_name]
                 if type(a).__name__ == "ParsedRename"
                 else [a.symbol, a.isin, a.exchange_hint, a.frozen]
             )]
            for a in r.corporate_actions
        ],
        "account_hint": r.account_hint,
        "source": r.source,
    }


def canonical_out(content: bytes, name: str) -> dict:
    importer = CanonicalImporter()
    file = ImportFile(name, content)
    parsed = importer.parse(file)
    report = validate_import(file)
    return {
        **result_out(parsed),
        "can_parse": importer.can_parse(file),
        "report": {
            "ok": report.ok,
            "importer_id": report.importer_id,
            "errors": [warning_row(w) for w in report.errors],
            "warnings": [warning_row(w) for w in report.warnings],
            "summary": report.summary(),
        },
    }


def spec_blocks(language: str) -> list[str]:
    return re.findall(rf"```{language}\n(.*?)```", SPEC.read_text(encoding="utf-8"), flags=re.DOTALL)


def spec_csv() -> str:
    return next(b for b in spec_blocks("csv") if "position" in b)


def spec_json() -> str:
    return next(b for b in spec_blocks("json") if '"records": [\n' in b)


HEADER = ("format_version,record,date,time,type,external_ref,symbol,isin,exchange,quantity,price,currency,"
          "gross_amount,fee,tax,cash_amount,cash_currency,fx_rate,split_ratio,note")

TYPES = [t.value for t in TxnType] + ["Buy", "BUY", "trade", ""]
DATES = ["2026-01-05", "2026-02-28", "2024-02-29", "2026-02-30", "2026-13-01", "05.01.2026", "2026-1-5",
         "0000-01-01", "9999-12-31", "", " 2026-01-05 "]
TIMES = ["", "09:05", "9:5", "15:30:12", "24:00", "23:59:59", "12:60", "12:00:60", "ab"]
AMOUNTS = ["", "0", "1", "10", "-5", "-10.50", "0.1", "1234.5678", "1e3", "1,5", "+3", "0.00", "-0", "007",
           "1.", ".5", "x", "123456789012345678901234567890.123456789", "٣"]
POSITIVE = ["", "0", "1", "2", "2.5", "4", "0.1", "-1", "x"]
CURRENCIES = ["PLN", "USD", "EUR", "pln", "ZL", "", "PLNN", "GBP"]
SYMBOLS = ["", "ABC", "X", "BRK.B", "ŁÓDŹ", "A" * 65]
ISINS = ["", "PLABC0000011", "IE00B4L5Y983", "pl123", "PL1234567890", "XX"]
EXCHANGES = ["", "GPW", "XWAR", "NASDAQ"]
NOTES = ["", "note", "a, b", 'say "hi"', "x" * 1001]


def csv_cell(c: str) -> str:
    return '"' + c.replace('"', '""') + '"' if any(ch in c for ch in ',"\n\r') else c


def txn_row(rng: random.Random) -> list[str]:
    t = rng.choice(TYPES)
    sym = rng.choice(SYMBOLS) if t not in ("deposit", "withdrawal", "fx_conversion") or rng.random() < 0.1 else ""
    qty = rng.choice(POSITIVE) if rng.random() < 0.6 else ""
    cells = {
        "format_version": "1" if rng.random() < 0.97 else rng.choice(["2", "", "1.0"]),
        "record": "txn" if rng.random() < 0.97 else rng.choice(["position", "", "trade", "TXN"]),
        "date": rng.choice(DATES),
        "time": rng.choice(TIMES) if rng.random() < 0.3 else "",
        "type": t,
        "external_ref": rng.choice(["", "R1", "T-" + str(rng.randint(1, 99))]),
        "symbol": sym,
        "isin": rng.choice(ISINS) if sym and rng.random() < 0.3 else "",
        "exchange": rng.choice(EXCHANGES) if sym and rng.random() < 0.3 else "",
        "quantity": qty,
        "price": rng.choice(AMOUNTS) if rng.random() < 0.5 else "",
        "currency": rng.choice(CURRENCIES) if rng.random() < 0.9 else "PLN",
        "gross_amount": rng.choice(AMOUNTS) if rng.random() < 0.4 else "",
        "fee": rng.choice(AMOUNTS) if rng.random() < 0.3 else "",
        "tax": rng.choice(AMOUNTS) if rng.random() < 0.2 else "",
        "cash_amount": rng.choice(AMOUNTS) if rng.random() < 0.6 else "",
        "cash_currency": rng.choice(CURRENCIES) if rng.random() < 0.25 else "",
        "fx_rate": rng.choice(POSITIVE + ["4.0", "0.25"]) if rng.random() < 0.25 else "",
        "split_ratio": rng.choice(POSITIVE) if t == "split" or rng.random() < 0.1 else "",
        "note": rng.choice(NOTES) if rng.random() < 0.2 else "",
    }
    return [cells.get(col, "") for col in HEADER.split(",")]


def good_txn_row(rng: random.Random) -> list[str]:
    """A mostly valid row (so that the success paths of derive_amounts get exercised)."""
    kind = rng.choice(["buy", "sell", "dividend", "deposit", "withdrawal", "fee", "tax", "interest", "split",
                       "transfer_in", "adjustment", "fx_conversion"])
    cur = rng.choice(["PLN", "USD", "EUR"])
    cells = {"format_version": "1", "record": "txn", "date": f"2026-0{rng.randint(1, 9)}-1{rng.randint(0, 9)}",
             "type": kind, "currency": cur}
    qty = str(rng.randint(1, 20))
    price = rng.choice(["10", "10.5", "0.333", "1234.56"])
    if kind in ("buy", "sell", "transfer_in", "adjustment"):
        cells.update(symbol="ABC", quantity=qty)
        if rng.random() < 0.8:
            cells["price"] = price
    if kind in ("dividend", "fee", "tax", "interest") and rng.random() < 0.5:
        cells["symbol"] = "ABC"
    if kind == "split":
        cells.update(symbol="ABC", split_ratio=rng.choice(["2", "0.1", "4"]))
    if rng.random() < 0.4:
        cells["gross_amount"] = rng.choice(["100", "100.50", "12.345"])
    if rng.random() < 0.5:
        cells["cash_amount"] = rng.choice(["100", "-100", "-100.50", "99.99", "-101", "0", "12.5", "-0.01"])
    if rng.random() < 0.4:
        cells["fee"] = rng.choice(["0", "0.00", "1", "1.5"])
    if rng.random() < 0.3:
        cells["tax"] = rng.choice(["0", "0.57", "2"])
    if rng.random() < 0.3:
        cells["cash_currency"] = rng.choice(["PLN", "USD", "EUR"])
    if rng.random() < 0.3:
        cells["fx_rate"] = rng.choice(["4", "4.0", "0.25", "3.9876"])
    if kind == "fx_conversion":
        cells["cash_amount"] = rng.choice(["-4000", "1000.00", "25"])
        cells.pop("cash_currency", None)
        cells.pop("fx_rate", None)
    return [cells.get(col, "") for col in HEADER.split(",")]


def csv_doc(rows: list[list[str]], header: str = HEADER, eol: str = "\n") -> bytes:
    return (eol.join([header, *[",".join(csv_cell(c) for c in row) for row in rows]]) + eol).encode()


def json_literal(value: str) -> str:
    if value == "":
        return "null"
    if re.fullmatch(r"-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?", value):
        return value
    return json.dumps(value, ensure_ascii=False)


def json_doc(rows: list[list[str]], top: str = "") -> bytes:
    records = []
    for row in rows:
        items = [f'"{c}": {json_literal(v)}' for c, v in zip(HEADER.split(","), row) if c != "format_version" and v != ""]
        records.append("{" + ", ".join(items) + "}")
    extra = f"{top}," if top else ""
    return f'{{"format": "cashu-import", "format_version": 1, {extra} "records": [{", ".join(records)}]}}'.encode()


def gen_canonical(rng: random.Random) -> list:
    rows: list = []

    def add(content: bytes, name: str) -> None:
        rows.append([b64(content), name, canonical_out(content, name)])

    for text, name in ((spec_csv(), "x.csv"), (spec_json(), "x.json")):
        data = text.encode()
        add(data, name)
        for _ in range(40):  # truncations and byte flips of a valid document
            cut = rng.randint(0, len(data))
            add(data[:cut], name)
            flipped = bytearray(data)
            flipped[rng.randrange(len(data))] = rng.choice([0x22, 0x2C, 0x7B, 0x7D, 0xFF, 0x00, 0x20, 0x0A, 0x31])
            add(bytes(flipped), name)
    for block in spec_blocks("csv") + spec_blocks("json"):
        add(block.encode(), "b.csv" if block.startswith("format_version") or block.startswith("1,") else "b.json")
    for _ in range(300):  # random, mostly invalid rows
        add(csv_doc([txn_row(rng) for _ in range(rng.randint(1, 4))]), "r.csv")
    for _ in range(250):  # mostly valid rows
        add(csv_doc([good_txn_row(rng) for _ in range(rng.randint(1, 4))], eol=rng.choice(["\n", "\r\n"])), "g.csv")
        add(json_doc([good_txn_row(rng) for _ in range(rng.randint(1, 3))]), "g.json")
    for _ in range(100):
        add(json_doc([txn_row(rng) for _ in range(rng.randint(1, 3))]), "r.json")
    # corporate actions, positions, file-level values, header problems
    header = ",".join(CSV_COLUMNS)

    def full(**kv: str) -> list[str]:
        return [{"format_version": "1", **kv}.get(c, "") for c in CSV_COLUMNS]

    for _ in range(150):
        kinds = []
        for _ in range(rng.randint(1, 5)):
            rec = rng.choice(["position", "rename", "delisting", "txn", "position"])
            kv = {"record": rec, "date": rng.choice(["2026-01-31", "2026-01-30", "2026-02-01", "bad", ""]),
                  "symbol": rng.choice(["", "A", "B", "Z"]), "isin": rng.choice(["", "PLAAA0000011", "bad"]),
                  "quantity": rng.choice(["", "1", "2", "-1"]), "currency": rng.choice(["", "PLN", "usd"]),
                  "new_symbol": rng.choice(["", "A", "B"]), "new_isin": rng.choice(["", "PLAAA0000011"]),
                  "exchange": rng.choice(["", "XWAR"]), "new_exchange": rng.choice(["", "XNAS", "XWAR"]),
                  "frozen": rng.choice(["", "true", "TRUE", "yes", "false"]), "avg_price": rng.choice(["", "5"]),
                  "market_value": rng.choice(["", "6"]), "price": rng.choice(["", "1"]),
                  # legacy name: the pre-rename source still reads as cashu
                  "source": rng.choice(["", "mybroker", "other", "Bad Src", "finanse"]),
                  "account_hint": rng.choice(["", "ACC 1", "ACC 2", "x" * 201]),
                  "type": rng.choice(["deposit", "buy", ""]), "cash_amount": rng.choice(["", "5"])}
            kinds.append(full(**kv))
        add(csv_doc(kinds, header), "p.csv")
    for h in ["format_version,record,date,qty,date", "record,date", "format_version,record,date,quantiy",
              "format_version,record,date,SYMBOL", "\ufeffformat_version,record,date", "format_version,,date", "",
              "  ", "a,b,c", "format_version,record,date,source,source"]:
        add((h + "\n1,txn,2026-01-01,x\n").encode(), "h.csv")
        add((h + "\n").encode(), "h.csv")
    for raw in [b"", b"\n", b"\xef\xbb\xbf", b"\xef\xbb\xbfformat_version,record,date\n", b"\xff\xfe", b"a\xe2\x82",
                b"format_version,record,date\n1,txn,\xff\n", b"format_version,record,date\n1,txn,\xc3\n",
                b"format_version,record,date\n1,txn,\xe2\x82",
                b'format_version,record,date\n1,"txn"x,2026-01-01\n', b'format_version,record,date\n1,"txn,2026\n',
                b"format_version,record,date\n" + b"1,txn," + b"x" * 140000 + b"\n",
                b"format_version,record,date\r1,txn,2026-01-01\r", b"format_version,record,date\n\n\n1,txn\n"]:
        add(raw, "e.csv")
        if len(raw) < 1000:
            add(raw, "e.json")
    json_texts = [
        "[]", "{", "[1,", '{"a" 1}', '{"a":1,}', '"abc', '{"a":1}x', "\ufeff{}", "[1 2]", "{1:2}", '"\\x"',
        '"\\u12G4"', "\x00", "null", "5", '"s"', "true", "{}", '{"format": "cashu-import"}',
        '{"format": "cashu-import", "format": "x"}', '{"format": "cashu-import", "format_version": NaN}',
        '{"format": "cashu-import", "format_version": Infinity}',
        '{"format": "cashu-import", "format_version": -Infinity}',
        '{"format": "cashu-import", "format_version": 1.0, "records": []}',
        '{"format": "cashu-import", "format_version": 1E0, "records": []}',
        '{"format": "cashu-import", "format_version": 1.5, "records": []}',
        '{"format": "cashu-import", "format_version": true, "records": []}',
        '{"format": "cashu-import", "format_version": "1", "records": []}',
        # legacy name: the pre-rename format id is still accepted
        '{"format": "finanse-import", "format_version": 1, "records": []}',
        '{"format": "other", "format_version": "1", "record": []}',
        '{"format": "cashu-import", "format_version": 1, "records": [], "source": 5}',
        '{"format": "cashu-import", "format_version": 1, "records": [], "source": " ok_src "}',
        '{"format": "cashu-import", "format_version": 1, "records": [], "source": "Bad Src"}',
        '{"format": "cashu-import", "format_version": 1, "records": [], "account_hint": null}',
        '{"format": "cashu-import", "format_version": 1, "records": ["x", [], 5, null, {}]}',
        '{"format": "cashu-import", "format_version": 1, "records": [{"record": "txn", "date": "2026-01-05",'
        ' "type": "deposit", "currency": "PLN", "cash_amount": 1E+2, "note": null, "source": "x"}]}',
        '{"format": "cashu-import", "format_version": 1, "records": [{"record": "txn", "date": "2026-01-05",'
        ' "type": "deposit", "currency": "PLN", "cash_amount": [1]}]}',
        '{"format": "cashu-import", "format_version": 1, "records": [{"record": "txn", "date": "2026-01-05",'
        ' "type": "buy", "symbol": 123, "quantity": true, "price": 1, "currency": "PLN", "qty": 1}]}',
        '{"format": "cashu-import", "format_version": 1, "records": [{"record": "txn", "date": "2026-01-05",'
        ' "type": "buy", "symbol": "A", "quantity": 12345678901234567890123456789012345, "price": 0.0000001,'
        ' "currency": "PLN"}]}',
        '{"format": "cashu-import", "format_version": 1, "records": [{"record": "delisting", "date": "2026-01-05",'
        ' "symbol": "A", "frozen": "True"}, {"record": "delisting", "date": "2026-01-05", "symbol": "B",'
        ' "frozen": 1}]}',
        '{"format": "cashu-import", "format_version": 1, "records": [{"record": "txn", "date": "2026-01-05",'
        ' "type": "deposit", "currency": "PLN", "cash_amount": 1e400}]}',
        "[" * 40 + "]" * 40, '{"a":' * 40 + "1" + "}" * 40,
        '{"format": "cashu-import", "format_version": 1, "records": [{"record": "txn", "record": "x"}]}',
        '{"format": "cashu-import", "format_version": 1, "records": [], "records": []}',
        '{"format": "cashu-import",\n  "format_version": 1,\n  "records": [\n    {"record": "x" "date": 1}]}',
        '{"format": "cashu-import", "format_version": 1, "records": ["a\tb"]}',
        '{"format": "cashu-import", "format_version": 1, "records": [{"record": "txn", "date": "\\u0032026-01-05"}]}',
        '{"format": "cashu-import", "format_version": 1, "records": [{"record": "txn", "date": "\\ud83d\\ude00"}]}',
    ]
    for text in json_texts:
        add(text.encode("utf-8", errors="surrogatepass"), "j.json")
    # detection
    for name in ["x.csv", "x.CSV", "x.txt", "x.json", "x.JSON", "x.xlsx", "x", "x.", ".csv", "a.b.csv", "dir/x.csv",
                 "dir/", "x.csv/", ".hidden", "a..csv", "..", "x.Json", "ü.CSV"]:
        for data in (HEADER.encode() + b"\n", b"record,format_version,date\n", b' {"format": "cashu-import"}',
                     # legacy name: the pre-rename format id is still sniffed
                     b'{"format": "other"}', b'{"x": 1, "format": "finanse-import"}', b"date,type\n", b"",
                     ("\ufeff" + HEADER + "\n").encode(), b"\x1c" + HEADER.encode(),
                     b'\x1c{"format": "cashu-import"}',
                     ("\ufeff" + '{"format": "cashu-import"}').encode(), b'{"a":"' + b"x" * 5000 + b'"format": "cashu-import"'):
            add(data, name)
    return rows


# --------------------------------------------------------------------------- values


def decimal_out(fmt: DecimalFormat, raw: str) -> object:
    try:
        v = fmt.parse(raw)
        return None if v is None else str(v)
    except ValueError as e:
        return {"error": "ValueError", "message": str(e)}


NUM_ALPHABET = list("0123456789,. -+()'−  \t\nxeE")


def gen_decimals(rng: random.Random) -> list:
    rows: list = []
    seps = [(d, t) for d in DECIMAL_SEPS for t in THOUSANDS_SEPS if d != t]
    fixed = ["1 234,56", "1 234,56", "1 234,56", "  ", "", "12,", "12.", "-1,234.56", "1.234,56", ".5", "-.5",
             "−12,50", "12,50-", "(12,50)", "((12,50))", "(12,50)-", "-(12,50)", "+3", "--3", "1e5", "NaN",
             "Infinity", "12 34", "1,2,3", "abc", "(", ")", "()", "-", "+", ",", ".", "0", "-0", "0,00", "(0)",
             "(0,00)", "0-", "1\n", "12\n.", "1\n2", "١٢", "1 2", "'1'234", "1'234.5", "9" * 40 + "." + "9" * 40,
             "1" + "0" * 30, "0." + "0" * 30 + "1", "٣,٥", "1,5 ", "\t1,5\n", "1_000", "１２"]
    for fmt_sep in seps:
        fmt = DecimalFormat(*fmt_sep)
        for raw in fixed:
            rows.append([fmt_sep[0], fmt_sep[1], raw, decimal_out(fmt, raw)])
        for _ in range(120):
            raw = "".join(rng.choice(NUM_ALPHABET) for _ in range(rng.randint(0, 14)))
            rows.append([fmt_sep[0], fmt_sep[1], raw, decimal_out(fmt, raw)])
        for _ in range(60):  # plausible numbers
            digits = str(rng.randint(0, 10**rng.randint(1, 12)))
            raw = digits + rng.choice([fmt_sep[0], ""]) + str(rng.randint(0, 999))
            if rng.random() < 0.3:
                raw = rng.choice(["-", "(", "", "+"]) + raw + rng.choice(["", "-", ")"])
            if fmt_sep[1] and rng.random() < 0.5:
                raw = raw[:1] + fmt_sep[1] + raw[1:]
            rows.append([fmt_sep[0], fmt_sep[1], raw, decimal_out(fmt, raw)])
    for bad in [(";", ""), (",", ","), (".", "."), (",", "x"), ("", ""), (".", ";")]:
        try:
            DecimalFormat(*bad)
            res: object = "ok"
        except ValueError as e:
            res = {"error": "ValueError", "message": str(e)}
        rows.append([bad[0], bad[1], "<construct>", res])
    return rows


DECIMAL_SEPS = [".", ","]
THOUSANDS_SEPS = ["", " ", ".", ",", "'"]


def datetime_out(pattern: DatePattern, raw: str) -> object:
    parsed = pattern.try_parse_datetime(raw)
    if parsed is None:
        return None
    d, t = parsed
    return [d.isoformat(), None if t is None else t.isoformat()]


PATTERNS = ["dd.MM.yyyy", "yyyy-MM-dd", "d/M/yyyy", "yyyy-MM-dd HH:mm:ss", "dd.MM.yyyy HH:mm", "yyyyMMdd", "d.M.yyyy H:mm",
            "yyyy/MM/dd'T'", "MM/dd/yyyy", "yyyy-MM-dd HH", "dd-MM-yyyy (ss)", "ddMMyyyy", "yyyy.MM.dd.", "d MM yyyy",
            "dd.MM.yyyy HH:mm:ss", "yyyy-M-d", "dd.MM.yyyy mm", "yyyy-MM-dd HH:mm:ss.SSS", "[dd]/[MM]/[yyyy]",
            "dd.MM.yyyy yyyy"]
BAD_PATTERNS = ["MM.yyyy", "dd.MM", "yyyy", "", "HH:mm", "dd.dd.dd", "yyyy-MM"]
DATE_ALPHABET = list("0123456789-./: TZ\n[]()")


def gen_dates(rng: random.Random) -> list:
    rows: list = []
    fixed = ["05.01.2026", "2026-01-05", "5/1/2026", "2026-01-05 10:22", "2026-01-05 10:22:01", "2026-09-02T15:00",
             "2026-09-02T09:05:07", "2026-09-02 25:00", "2026-09-02 12:60", "2026-09-02 12:00:60", "2026-09-02 9:05",
             "2026-09-02 09:5", "2026-09-02 09", "2026-09-02  09:05", "2026-02-30", "2026-1-5", "0000-01-01",
             "9999-12-31", "05.01.2026 07:00", "02.09.2026 08:30", "2026-09-02 08:30 extra", "2026-09-02\n08:30",
             "2026-09-02 ", " 2026-09-02", "20260902", "02092026", "٢٠٢٦-٠١-٠٥", "2026-09-02 10:22\n"]
    for p in PATTERNS:
        pat = DatePattern(p)
        for raw in fixed:
            rows.append(["pattern", p, raw, datetime_out(pat, raw)])
        for _ in range(60):
            raw = "".join(rng.choice(DATE_ALPHABET) for _ in range(rng.randint(0, 22)))
            rows.append(["pattern", p, raw, datetime_out(pat, raw)])
        for _ in range(60):  # a plausible date in this pattern's shape
            y, m, d = rng.randint(1, 9999), rng.randint(0, 13), rng.randint(0, 32)
            raw = re.sub(r"yyyy", f"{y:04d}", p)
            raw = re.sub(r"MM", f"{m:02d}", raw)
            raw = re.sub(r"M", str(m), raw)
            raw = re.sub(r"dd", f"{d:02d}", raw)
            raw = re.sub(r"d", str(d), raw)
            raw = re.sub(r"HH", f"{rng.randint(0, 25):02d}", raw)
            raw = re.sub(r"H", str(rng.randint(0, 25)), raw)
            raw = re.sub(r"mm", f"{rng.randint(0, 61):02d}", raw)
            raw = re.sub(r"ss", f"{rng.randint(0, 61):02d}", raw)
            rows.append(["pattern", p, raw, datetime_out(pat, raw)])
    for p in BAD_PATTERNS:
        try:
            DatePattern(p)
            res: object = "ok"
        except ValueError as e:
            res = {"error": "ValueError", "message": str(e)}
        rows.append(["bad_pattern", p, res])
    combos = [["dd.MM.yyyy", "yyyy-MM-dd"], ["yyyy-MM-dd"], ["dd.MM.yyyy HH:mm", "yyyy-MM-dd HH:mm:ss", "d/M/yyyy"]]
    for pats in combos:
        patterns = [DatePattern(p) for p in pats]
        for raw in fixed + ["Jan 5", "", "  ", "2026-01-05 07:00", "05.01.2026 07:00"]:
            try:
                parsed = parse_datetime_with_patterns(raw, patterns)
                only = parse_date_with_patterns(raw, patterns)
                out: object = [None if parsed is None else [parsed[0].isoformat(), None if parsed[1] is None else parsed[1].isoformat()],
                               None if only is None else only.isoformat()]
            except ValueError as e:
                out = {"error": "ValueError", "message": str(e)}
            rows.append(["combo", pats, raw, out])
    return rows


# --------------------------------------------------------------------------- text


def gen_text(rng: random.Random) -> list:
    rows: list = []
    pieces = [b"a", b"\n", b"\r", b",", b"\xc5\x82", b"\xe2\x82\xac", b"\xf0\x9f\x98\x80", b"\xc5", b"\xe2\x82",
              b"\xf0\x9f\x98", b"\xc0\xaf", b"\xe0\x80\xaf", b"\xf0\x80\x80\xaf", b"\xed\xa0\x80", b"\xf4\x90\x80\x80",
              b"\xf5", b"\xff", b"\x80", b"\xbf", b"\xef\xbb\xbf", b"\xef\xbb", b"\x81", b"\x83", b"\x88", b"\x90",
              b"\x98", b"\xa5", b"\xb9", b"\xf1", b"\xe0\xa0", b"\xf0\x90", b"\xf4\x8f\xbf", b"\xf4\x8f"]
    for enc in ImportTextEncoding:
        for lenient in (False, True):
            for _ in range(500):
                data = b"".join(rng.choice(pieces) for _ in range(rng.randint(0, 6)))
                try:
                    out: object = ["ok", decode_import_text(data, enc, lenient=lenient)]
                except UnicodeDecodeError as e:
                    out = ["err", e.reason, e.start]
                rows.append(["decode", enc.value, lenient, b64(data), out])
    for name in ["utf-8", "UTF-8", "utf8", "utf-8-sig", "windows-1250", "Windows1250", "cp1250", "cp-1250", " Auto ",
                 "auto", "latin2", "", "utf_8", "CP1250", "K", "ﬁ"]:
        e = parse_encoding(name)
        rows.append(["encoding", name, None if e is None else e.value])
    for name in ["Export.CSV", "archive.tar.gz", "noext", ".hidden", "a.", "a.b.", "dir/x.csv", "dir/", "x.csv/", "..",
                 "a/./b.csv", "a//b.csv", "./", ".", "", "x.CsV", "ü.Ünï", "a.b.c.d", "/", "/.x", "x.İ", "x.İ",
                 ".a.b", "..a", "a..", "a. ", "a.\n"]:
        rows.append(["extension", name, ImportFile(name, b"").extension])
    return rows


# --------------------------------------------------------------------------- cash


def cash_out(**kw) -> object:
    try:
        a = cash_mod.derive_amounts(**kw)
        return ["ok", str(a.gross_amount), str(a.cash_amount)]
    except cash_mod.AmountError as e:
        return ["err", str(e), e.kind]


def gen_cash(rng: random.Random) -> list:
    rows: list = []
    amounts = [None, "0", "0.00", "1", "10", "100.50", "-100", "-100.50", "0.01", "3.333", "1234.5678",
               "123456789012345678901234567890123456789012345678901234567890.123",
               "-0", "1E+2", "0.000000000000000000000000000000000000000000000000000000000000000000001"]
    types = list(TxnType)
    curs = [Currency.PLN, Currency.USD, Currency.EUR]
    for _ in range(4000):
        kw = dict(
            txn_type=rng.choice(types), currency=rng.choice(curs), cash_currency=rng.choice(curs),
            gross=_d(rng.choice(amounts)), cash=_d(rng.choice(amounts)), quantity=_d(rng.choice(amounts)),
            price=_d(rng.choice(amounts)), fee=_d(rng.choice(amounts[1:])) or Decimal(0),
            tax=_d(rng.choice(amounts[1:])) or Decimal(0), fx_rate=_d(rng.choice([None, "0", "4", "4.0", "0.25", "3.9876"])),
        )
        rows.append([
            kw["txn_type"].value, str(kw["currency"]), str(kw["cash_currency"]),
            *[dstr(kw[k]) for k in ("gross", "cash", "quantity", "price", "fee", "tax", "fx_rate")],
            cash_out(**kw),
        ])
    return rows


def _d(v: str | None) -> Decimal | None:
    return None if v is None else Decimal(v)


def gen_misc(rng: random.Random) -> list:
    rows: list = []
    words = ["quantity", "symbol", "record", "format_version", "cash_amount", "price", "isin", "exchange", "Buy", "buy",
             "txn", "trade", "records", "format", "SYMBOL", "ISIN", "qty", "unknown_field_x", "", "ł", "İ", "İSIN"]
    pools = [list(CSV_COLUMNS), ["txn", "position", "rename", "delisting"], [t.value for t in TxnType],
             ["format", "format_version", "source", "account_hint", "records"], ["Symbol", "symbol", "SYMBOL"], ["İsin", "isin"]]
    for pool in pools:
        for w in words:
            rows.append(["did_you_mean", w, pool, did_you_mean(w, pool)])
        for _ in range(60):
            w = rng.choice(pool)
            i = rng.randrange(len(w) + 1)
            mutated = rng.choice([w[:i] + w[i + 1:], w[:i] + "x" + w[i:], w.upper(), w[:i] + w[i:i + 1] * 2 + w[i + 1:], w[::-1]])
            rows.append(["did_you_mean", mutated, pool, did_you_mean(mutated, pool)])
    return rows


# --------------------------------------------------------------------------- repr (block hashes)


def block_hashes() -> list[str]:
    out = []
    for block in range(0x110000 // 4096):
        h = hashlib.sha256()
        for c in range(block * 4096, (block + 1) * 4096):
            if 0xD800 <= c <= 0xDFFF:
                continue
            h.update((repr(chr(c)) + "\0").encode("utf-8"))
        out.append(h.hexdigest()[:16])
    return out


def gen_repr(_rng: random.Random) -> list:
    samples = ["", "a", "it's", 'say "hi"', "both ' and \"", "tab\there", "nl\nx", "back\\slash", "\x00\x7f\x80\xa0\xad",
               "  ", "\ud800", "😀", "\U000e0001", "ŁÓDŹ", "x​y"]
    rows: list = [["samples", s, repr(s)] for s in samples]
    rows.append(["blocks", block_hashes()])
    return rows


GENERATORS: dict[str, tuple[Callable[[random.Random], list], str]] = {
    "inv-importing-canonical": (gen_canonical, "[content base64, file name, {warnings, txns, positions, actions, "
                                "account_hint, source, can_parse, report}]"),
    "inv-importing-decimals": (gen_decimals, "[decimal separator, thousands separator, raw, str(Decimal) | null | "
                               "{error, message}]"),
    "inv-importing-dates": (gen_dates, "['pattern', pattern, raw, [date, time] | null] | ['bad_pattern', pattern, "
                            "result] | ['combo', patterns, raw, [[date, time] | null, date | null] | {error, message}]"),
    "inv-importing-text": (gen_text, "['decode', encoding, lenient, base64, ['ok', text] | ['err', reason, start]] | "
                           "['encoding', name, value | null] | ['extension', file name, extension]"),
    "inv-importing-cash": (gen_cash, "[type, currency, cash currency, gross, cash, quantity, price, fee, tax, fx_rate, "
                           "['ok', gross, cash] | ['err', message, kind]]"),
    "inv-importing-misc": (gen_misc, "['did_you_mean', text, candidates, hint]"),
    "inv-importing-repr": (gen_repr, "['samples', text, repr] | ['blocks', 272 sha256 prefixes of repr(chr(c)) + NUL "
                           "per 4096 code points, surrogates skipped]"),
}


def render_rows(name: str, layout: str, rows: list) -> str:
    meta = {"meta": {"name": name, "count": len(rows), "layout": layout, "seed": SEED,
                     "generator": "parity/python/vectors_inv_importing.py", "python": sys.version.split()[0],
                     "unicode": unicodedata.unidata_version}}
    lines = [json.dumps(meta)]
    lines += [json.dumps(row, separators=(",", ":")) for row in rows]
    return "\n".join(lines) + "\n"


def outputs() -> dict[Path, bytes]:
    out: dict[Path, bytes] = {}
    for name, (fn, layout) in GENERATORS.items():
        rows = fn(random.Random(f"{SEED}:{name}"))
        out[OUT / f"{name}.jsonl"] = render_rows(name, layout, rows).encode("ascii")
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
