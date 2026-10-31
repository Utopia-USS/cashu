#!/usr/bin/env python3
"""Synthetic parity vectors for the TypeScript budget ingestion port (scope S07).

    .venv/bin/python parity/python/vectors_budget.py            # writes the vectors and fixtures
    .venv/bin/python parity/python/vectors_budget.py --check    # regenerates in memory, fails on any diff

Writes ``packages/domain/test/vectors/budget-*.jsonl``, ``budget-matching-data.jsonl`` and the
synthetic CSV fixtures under ``packages/domain/test/fixtures/budget-csv/``. Every input is synthetic:
random with a fixed seed, hand-picked edge cases, the oracle tests' own constants (imported, never
retyped) and byte copies of the connector fixtures. Nothing reads a data dir; the dedup scenarios run
``prepare_new_transactions`` on an in-memory SQLite engine.

File format as ``vectors.py``: JSON Lines, line 1 ``{"meta": {...}}``, then one JSON array per vector
(layout in ``meta.layout``). Errors are ``{"error": "<class>"}``.
"""

from __future__ import annotations

import argparse
import ast
import base64
import csv
import dataclasses
import datetime as dt
import difflib
import hashlib
import inspect
import io
import json
import random
import re
import sys
import tempfile
import textwrap
import unicodedata
from collections.abc import Callable, Iterable
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests"))

from sqlmodel import Session, SQLModel, create_engine

import cashu.models  # noqa: F401  (registers every table for create_all)
from cashu.core.models import Source
from cashu.core.text import iban_key, normalize_text
from cashu.modules.budget.ingestion import normalize as normalize_mod
from cashu.modules.budget.ingestion.csv_import import base as base_mod
from cashu.modules.budget.ingestion.csv_import import (
    detect_importer,
    get_importer,
)
from cashu.modules.budget.ingestion.csv_import.base import (
    ColumnMap,
    DelimitedImporter,
    find_account_number,
    parse_pl_amount,
    parse_pl_date,
)
from cashu.modules.budget.ingestion.csv_import.erste import ErsteImporter
from cashu.modules.budget.ingestion.csv_import.mbank import MBankImporter
from cashu.modules.budget.ingestion.csv_import.pekao import PekaoImporter
from cashu.modules.budget.ingestion.dedup import prepare_new_transactions
from cashu.modules.budget.ingestion.normalize import (
    RawTransaction,
    base_hash,
    merchant_key,
)
from cashu.modules.budget.models import Transaction

SEED = 20261030
OUT = ROOT / "packages" / "domain" / "test" / "vectors"
FIXTURES = ROOT / "packages" / "domain" / "test" / "fixtures" / "budget-csv"
BANKS = ("mbank", "erste", "pekao")
CODECS = ("utf-8", "utf-8-sig", "cp1250", "iso-8859-2")

if sys.version_info < (3, 14):
    raise SystemExit("vectors_budget.py needs Python 3.14+ (csv / strptime behaviour is pinned)")


def error_name(exc: BaseException) -> str:
    return type(exc).__name__


def dstr(value: Decimal) -> list:
    """A Decimal as [str(d), exponent] (scale is part of the contract)."""
    return [str(value), value.as_tuple().exponent]


def rand_text(rng: random.Random, alphabet: str, n: int) -> str:
    return "".join(rng.choice(alphabet) for _ in range(rng.randint(0, n)))


# --------------------------------------------------------------------------- codecs


def decode_strict(raw: bytes, codec: str) -> list:
    try:
        return ["ok", raw.decode(codec)]
    except UnicodeDecodeError as e:
        return ["err", e.start]


UTF8_PIECES = [
    b"a", b"\n", b"\r", b"\xc5\x82", b"\xe2\x82\xac", b"\xf0\x9f\x98\x80",  # valid
    b"\xc5", b"\xe2\x82", b"\xf0\x9f\x98",  # truncated
    b"\xc0\xaf", b"\xe0\x80\xaf", b"\xf0\x80\x80\xaf",  # overlong
    b"\xed\xa0\x80", b"\xed\xbf\xbf",  # surrogates
    b"\xf4\x90\x80\x80", b"\xf5", b"\xff", b"\x80", b"\xbf",  # out of range / lone continuation
    b"\xef\xbb\xbf", b"\xef\xbb",  # BOM, partial BOM
]


def gen_codecs(rng: random.Random) -> list:
    rows: list = []
    table_1250 = [ord(c) if (c := bytes([b]).decode("cp1250", "replace")) != "�" else None
                  for b in range(256)]
    table_8859 = [ord(bytes([b]).decode("iso-8859-2")) for b in range(256)]
    rows.append(["table", "cp1250", table_1250])
    rows.append(["table", "iso-8859-2", table_8859])
    samples: list[bytes] = [b"", bytes(range(256))]
    for _ in range(1200):
        samples.append(bytes(rng.choice(b"ab\r\n\x81\x98\xb9\xea\xc4\x99\xef\xbb\xbf\xff")
                             for _ in range(rng.randint(0, 14))))
    for _ in range(800):
        samples.append(b"".join(rng.choice(UTF8_PIECES) for _ in range(rng.randint(1, 6))))
    for raw in samples:
        b64 = base64.b64encode(raw).decode()
        rows.append(["bytes", b64,
                     {c: decode_strict(raw, c) for c in CODECS},
                     {c: raw.decode(c, "replace") for c in CODECS}])
    return rows


# --------------------------------------------------------------------------- csv

CSV_REASONS = (
    ("field larger than field limit", "field_limit"),
    ("new-line character seen in unquoted field", "newline_in_unquoted"),
    ("expected after", "quote_expected"),
    ("unexpected end of data", "unexpected_eof"),
)


def csv_outcome(source: Iterable[str], delimiter: str, strict: bool) -> list:
    reader = csv.reader(source, delimiter=delimiter, strict=strict)
    try:
        rows = list(reader)
    except csv.Error as e:
        message = str(e)
        reason = next((r for frag, r in CSV_REASONS if frag in message), None)
        if reason is None:
            raise
        return ["err", reason, reader.line_num]
    return ["ok", rows, reader.line_num]


def gen_csv(rng: random.Random) -> list:
    rows: list = []
    alphabet = "ab ;,\"'\n\r\x0b\tł"
    for _ in range(3000):
        text = rand_text(rng, alphabet, 30)
        delimiter = rng.choice([";", ",", "\t"])
        strict = rng.random() < 0.5
        lines = rng.choice(["lf", "universal"])
        stream = io.StringIO(text) if lines == "lf" else io.StringIO(text, newline="")
        rows.append(["text", text, delimiter, strict, lines, csv_outcome(stream, delimiter, strict)])
    limit = csv.field_size_limit()
    for n in (limit - 1, limit, limit + 1):
        for quoted in (False, True):
            text = ('"' + "x" * n + '"' if quoted else "x" * n) + "\na,b\n"
            outcome = csv_outcome(io.StringIO(text), ",", False)
            if outcome[0] == "ok":  # the long field as its length (the TS test rebuilds the text)
                outcome = ["ok", [[len(r[0])] if len(r) == 1 and len(r[0]) > 2 else r for r in outcome[1]],
                           outcome[2]]
            rows.append(["limit", n, quoted, outcome])
    for _ in range(300):
        line = rand_text(rng, alphabet, 20)
        strict = rng.random() < 0.5
        rows.append(["lines", [line], ",", strict, csv_outcome([line], ",", strict)])
    return rows


# --------------------------------------------------------------------------- text

SPLIT_ALPHABET = "ab\n\r\x0b\x0c\x1c\x1d\x1e\x1f\x85   \t"


def gen_text(rng: random.Random) -> list:
    rows: list = []
    digit_only = [c for c in range(0x110000)
                  if not 0xD800 <= c <= 0xDFFF and chr(c).isdigit() and not chr(c).isdecimal()]
    decimal = [c for c in range(0x110000) if not 0xD800 <= c <= 0xDFFF and chr(c).isdecimal()]
    rows.append(["isdigit_only", digit_only])
    rows.append(["isdecimal_count", len(decimal)])
    for _ in range(1000):
        s = rand_text(rng, SPLIT_ALPHABET, 12)
        rows.append(["splitlines", s, s.splitlines()])
    for _ in range(1000):
        s = rand_text(rng, "ab;'﻿ \x85", 10)
        chars = rng.choice([";", "'", "﻿", "; ", "ab"])
        rows.append(["strip", s, chars, s.strip(chars), s.lstrip(chars), s.rstrip(chars)])
    return rows


# --------------------------------------------------------------------------- Polish formats


def amount_out(value: str | None) -> object:
    try:
        d = parse_pl_amount(value)
    except Exception as e:  # noqa: BLE001 - the error class is the vector
        return {"error": error_name(e)}
    return None if d is None else dstr(d)


def date_out(value: str | None) -> object:
    d = parse_pl_date(value)
    return None if d is None else d.isoformat()


AMOUNT_EDGE = [
    None, "", "  ", "-", "+", ".", ",", "-1 234,56 PLN", "1.234,56", "1.234", "1,234", "-12,50", "5",
    "1.234.567", "1-2", "--5", "1,2,3", "+5,00", "٣", "٣,٥", "1\xa0234,50", "1 234,50", "0,001",
    "-0,001", "1.2.3", "12.", ".5", ",5", "-,5", "1e5", "NaN", "Infinity", "1_000", "12,50 EUR",
]
DATE_EDGE = [
    None, "", "2024-01-05", "05.01.2024", "garbage", "2026-02-30", "0000-01-01", " 5.1.2024",
    "2024-1-5", "2024-01-05 trailing", "05-01-2024", "2024/01/05", "05/01/2024", "٢٠٢٤-٠١-٠٥",
    "29.02.2024", "29.02.2023", "2024-01-5 ", "1.1.0001", "31.12.9999", "2024-13-01", "2024-00-10",
]


def gen_plformats(rng: random.Random) -> list:
    rows: list = [["amount", v, amount_out(v)] for v in AMOUNT_EDGE]
    rows += [["date", v, date_out(v)] for v in DATE_EDGE]
    for _ in range(1300):
        v = rand_text(rng, "0123456789 ,.-+PLNx\xa0٣५ ", 10)
        rows.append(["amount", v, amount_out(v)])
    for _ in range(700):
        v = rand_text(rng, "0123456789-./ ٢", 11)
        rows.append(["date", v, date_out(v)])
    for _ in range(700):
        v = rng.choice(["%04d-%d-%d", "%02d.%02d.%04d", "%d-%d-%04d", "%04d/%02d/%d", "%d/%d/%04d",
                        "%04d-%02d- %d"]) % tuple(
            rng.randint(0, 40) if i else rng.randint(0, 2100) for i in range(3))
        rows.append(["date", v, date_out(v)])
    for _ in range(1300):
        v = rand_text(rng, "0123456789 PL\xa0x\t ٣", 40)
        if rng.random() < 0.3:
            v = rand_text(rng, "x ", 3) + "".join(rng.choice("0123456789 ") for _ in range(30))
        rows.append(["account", v, find_account_number(v)])
    return rows


# --------------------------------------------------------------------------- content hash

NAMES = ["SKLEP TESTOWY", "Sklep ąę", "ŁÓDŹ TEST", "  jan\xa0test ", "x\x1cy", "a\x85b", "Café",
         "é", "", None, "ANNA  NOWAK", "ł", "Ł"]
IBANS = [None, "", "'99 1050 0000 0000 0000 0000 0555", "PL99105000000000000000000555",
         "pl 99 1050", "'", "99105000000000000000000555", "DE89370400440532013000", "AB", "12"]
TEXTS = [None, "", "ZAKUP TESTOWY", "zakup  testowy", "OPŁATA", "x y", "TYTUŁ  Z  SPACJAMI",
         "DATA TRANSAKCJI: 2026-01-01", "\t", "Ünïcödé"]
AMOUNTS = ["-12.50", "0", "-0", "-0.001", "0.005", "0.015", "1.234", "-1234.56", "1E+2", "5", "100.10",
           "-0.00", "999999.995", "0.125"]
CURRENCIES = ["PLN", "pln", "EUR", "eur", "Pln", "ß", ""]


def content_key(rt: RawTransaction) -> str:
    counterparty = iban_key(rt.counterparty_iban) or normalize_text(rt.counterparty_name)
    return "|".join([rt.booking_date.isoformat(), f"{rt.amount:.2f}", rt.currency.upper(),
                     counterparty, normalize_text(rt.memo)])


def raw_json(rt: RawTransaction) -> dict:
    return {
        "booking_date": rt.booking_date.isoformat(),
        "value_date": rt.value_date.isoformat() if rt.value_date else None,
        "amount": str(rt.amount),
        "currency": rt.currency,
        "counterparty_name": rt.counterparty_name,
        "counterparty_iban": rt.counterparty_iban,
        "description": rt.description,
        "reference": rt.reference,
        "bank_transaction_id": rt.bank_transaction_id,
        "source": rt.source.value,
    }


def hash_row(rt: RawTransaction) -> list:
    key = content_key(rt)
    v2 = hashlib.sha1(key.encode("utf-8")).hexdigest()
    v1 = {}
    for aid in (1, 12345):
        v1[str(aid)] = base_hash(aid, rt)
        # the v2 definition is v1 minus the account prefix, checked here on every vector
        assert v1[str(aid)] == hashlib.sha1(f"{aid}|{key}".encode()).hexdigest()
    return ["hash", raw_json(rt), key, v2, v1]


MERCHANT_EDGE = [
    ["CARREFOUR EXPRESS K/KRAKOW              DATA TRANSAKCJI: 2022-03-22"],
    ["  ", "ANNA NOWAK  UL.PRZYKLADOWA 40"],
    [None, None],
    ["SKLEP data transakcji: 2022"],
    ["SKLEP DATA TRANSAKCJI: x\n"],
    ["SKLEP DATA TRANSAKCJI: x\ny"],
    ["SKLEP DATA TRANSAKCJI: x\r\ny"],
    ["SKLEP DATA TRANSAKCJı: x"],
    ["SKLEP DATA TRANſAKCJI: x"],
    ["SKLEP KRAKOW  x"],
    ["SKLEP\r\rRESZTA"],
    ["SKLEP\x85\x85RESZTA"],
    ["SKLEP \nRESZTA"],
    ["SKLEP  RESZTA\n"],
    ["SKLEP\n"],
    ["  ", "", "TRZECI"],
    ["DATA TRANSAKCJI: 2022", "DRUGI"],
    ["SKLEP  X"],
]


def gen_hash(rng: random.Random) -> list:
    rows: list = []
    base = RawTransaction(booking_date=dt.date(2026, 1, 15), amount=Decimal("-12.50"), currency="PLN",
                          counterparty_name="SKLEP TESTOWY", description="ZAKUP TESTOWY", source=Source.CSV)
    rows.append(hash_row(base))
    for _ in range(3000):
        rt = RawTransaction(
            booking_date=dt.date(2026, 1, 1) + dt.timedelta(days=rng.randint(0, 400)),
            value_date=rng.choice([None, dt.date(2026, 2, 2)]),
            amount=Decimal(rng.choice(AMOUNTS)) if rng.random() < 0.6 else
            Decimal(rng.randint(-10**7, 10**7)).scaleb(-rng.randint(0, 3)),
            currency=rng.choice(CURRENCIES),
            counterparty_name=rng.choice(NAMES),
            counterparty_iban=rng.choice(IBANS),
            description=rng.choice(TEXTS),
            reference=rng.choice(TEXTS),
            bank_transaction_id=rng.choice([None, "", "B1"]),
            source=rng.choice(list(Source)),
        )
        rows.append(hash_row(rt))
    for fields in MERCHANT_EDGE:
        rows.append(["merchant", fields, merchant_key(*fields)])
    for _ in range(600):
        fields = [rng.choice([None, rand_text(rng, "DATA TRANSAKCJI: ıſKk ab\r\n\x85\t ", 24)])
                  for _ in range(rng.randint(1, 3))]
        rows.append(["merchant", fields, merchant_key(*fields)])
    return rows


# --------------------------------------------------------------------------- dedup scenarios


def stored_json(t: Transaction) -> dict:
    return {"dedup_hash": t.dedup_hash, "booking_date": t.booking_date.isoformat(),
            "amount": str(t.amount), "bank_transaction_id": t.bank_transaction_id,
            "occurrence": t.occurrence}


def v2_of(rt: RawTransaction) -> str:
    return hashlib.sha1(content_key(rt).encode("utf-8")).hexdigest()


def rand_dedup_raw(rng: random.Random, days: list[dt.date]) -> RawTransaction:
    return RawTransaction(
        booking_date=rng.choice(days),
        amount=Decimal(rng.choice(["-12.50", "-12.5", "-49.99", "100.00", "-12.50"])),
        currency=rng.choice(["PLN", "pln"]),
        counterparty_name=rng.choice(["Sklep ABC", "SKLEP ABC", "Kawiarnia", None]),
        counterparty_iban=rng.choice([None, None, "PL10000000000000000000000005"]),
        description=rng.choice(["test", "test", "inny"]),
        bank_transaction_id=rng.choice([None, None, None, "X1", "X2", "X3"]),
        source=rng.choice([Source.CSV, Source.OPEN_BANKING, Source.CONNECTOR]),
    )


def gen_dedup(rng: random.Random) -> list:
    rows: list = []
    for n in range(300):
        engine = create_engine("sqlite://")
        SQLModel.metadata.create_all(engine)
        rule = rng.random() < 0.5
        base_day = dt.date(2026, 3, 1)
        days = [base_day + dt.timedelta(days=i) for i in range(rng.randint(1, 4))]
        pre: list[dict] = []
        batches_out: list = []
        with Session(engine) as session:
            for k in range(rng.randint(0, 2)):  # non-content rows (cash legs, legacy)
                t = Transaction(account_id=1, booking_date=rng.choice(days + [base_day - dt.timedelta(days=3)]),
                                amount=Decimal("-7.00"), currency="PLN", source=Source.MANUAL,
                                dedup_hash=f"cashleg:{n}:{k}", occurrence=0)
                session.add(t)
                pre.append(stored_json(t))
            session.commit()
            for _ in range(rng.randint(1, 4)):
                if rng.random() < 0.3:
                    days = days + [days[-1] + dt.timedelta(days=1)]
                raws = [rand_dedup_raw(rng, days) for _ in range(rng.randint(0, 6))]
                result = prepare_new_transactions(session, 1, raws, newest_day_rule=rule)
                out = {
                    "raws": [raw_json(r) for r in raws],
                    "statuses": result.statuses,
                    "num_duplicates": result.num_duplicates,
                    "num_overlap": result.num_overlap,
                    "inserted": [[v2_of(r), t.occurrence] for r, t in
                                 zip([r for r, s in zip(raws, result.statuses, strict=True) if s == "new"],
                                     result.to_insert, strict=True)],
                }
                for t in result.to_insert:
                    session.add(t)
                session.commit()
                batches_out.append(out)
        engine.dispose()
        rows.append(["scenario", rule, pre, batches_out])
    return rows


# --------------------------------------------------------------------------- fixtures and statements

CONNECTOR_DIRS = {"mbank": "mbank-csv", "erste": "erste-csv", "pekao": "pekao-csv"}


class DebitCreditImporter(DelimitedImporter):
    """Generator-only importer exercising the engine's debit / credit branch (no bank uses it)."""

    bank = "test_dc"
    colmap = ColumnMap(booking_date=("data",), debit=("obciazenia",), credit=("uznania",))


DEBIT_CREDIT_CSV = (
    "Data;Opis;Obciazenia;Uznania\n"
    "2026-09-01;A;10,00;\n"
    "2026-09-02;B;;20,50\n"
    "2026-09-03;C;5,00;7,00\n"
    "2026-09-04;D;0,00;0,00\n"
    "2026-09-05;E;;\n"
    "2026-09-06;F;-3,10;0\n"
    "2026-09-07;G;0;-4,20\n"
    "2026-09-08;H;1.234,5;\n"
)


def fixture_files() -> dict[str, bytes]:
    """Relative path -> bytes of every fixture (copies, the oracle tests' constants, edge files)."""
    import test_budget_import_format as tbif
    import test_catalog_bank_parsers as tcat
    import test_parsing as tparsing
    import test_pekao as tpekao

    files: dict[str, bytes] = {}
    for bank, cid in CONNECTOR_DIRS.items():
        for f in sorted((ROOT / "connectors" / cid / "fixtures").glob("*.csv")):
            files[f"{bank}/{f.name}"] = f.read_bytes()
    files["foreign/example-bank-sample.csv"] = (ROOT / "connectors" / "example-bank-csv" / "fixtures"
                                                / "sample.csv").read_bytes()
    files["foreign/budget-csv-example-sample.csv"] = (ROOT / "examples" / "connectors"
                                                      / "budget-csv-example" / "sample.csv").read_bytes()
    for bank, name, content in tcat.EDGE_CASES:
        files[f"{bank}/{name}"] = content
    files["oracle/test_parsing_mbank.csv"] = tparsing.MBANK_CSV.encode("cp1250")
    files["oracle/test_pekao.csv"] = tpekao.PEKAO_CSV.encode("utf-8")
    files["oracle/test_budget_import_format_mbank.csv"] = tbif.MBANK_CSV.encode("cp1250")
    files["oracle/test_budget_import_format_skipped.csv"] = (
        tbif.MBANK_CSV + ";;;;;;\nSuma;;;;;;\n2026-10-05;BEZ KWOTY;;;;;\n").encode("cp1250")
    header = tcat.MBANK_HEADER
    files["mbank/mbank-garbage-amount.csv"] = (
        "mBank S.A.;\n" + header + "2026-09-05;2026-09-05;ZAKUP;T;X;'';-1,00;10,00;\n"
        "2026-09-06;2026-09-06;ZAKUP;T;X;'';1-2;10,00;\n").encode("cp1250")
    files["mbank/mbank-footer-garbage.csv"] = (
        "mBank S.A.;\n" + header + "2026-09-05;2026-09-05;ZAKUP;T;X;'';-1,00;10,00;\n"
        ";;;;;;--5;;\n").encode("cp1250")
    files["mbank/mbank-utf8-diacritics.csv"] = (
        "mBank S.A.;\n#Waluta;\nPLN;\n" + header
        + "2026-09-05;2026-09-05;ZAKUP ą;TYTUL ż;SKLEP;'';-1,00;10,00;\n").encode("utf-8")
    files["erste/erste-quoted-no-bank.csv"] = (
        '"2026-09-30","01-09-2026","\'99109000000000000000000001","Konto","PLN","30-09-2026","90,00","2"\n'
        '"02-09-2026","02-09-2026","ZAKUP","SKLEP TEST","","-10,00","90,00","1",""\n'
        '"01-09-2026","01-09-2026","PRZELEW","JAN TEST","99109000000000000000000004","100,00","100,00","1",""\n'
    ).encode("utf-8-sig")
    files["pekao/pekao-eur-row.csv"] = (
        tcat.PEKAO_HEADER
        + "2026-09-01;;JAN TEST;;'99124000000000000000000001;'99124000000000000000000002;A;-1,00;EUR;R1;T;K\n"
        + "2026-09-02;;JAN TEST;;'99124000000000000000000002;'99124000000000000000000001;B;2,00;;R2;T;K\n"
    ).encode("utf-8")
    files["engine/debit-credit.csv"] = DEBIT_CREDIT_CSV.encode("utf-8")
    # S07 review F1: Python detects mBank although the first line is a quoted Erste summary row.
    files["mbank/mbank-quoted-summary-first.csv"] = (
        '"2026-09-30","01-09-2026","\'99109000000000000000000001","Konto","PLN","30-09-2026","90","2"\n'
        "mBank S.A.;\n"
        "#Data księgowania;#Opis operacji;#Tytul;#Nadawca/Odbiorca;#Numer konta;#Kwota;#Saldo po operacji;\n"
        "2026-09-05;ZAKUP;T;SKLEP TEST;;-1,00;10,00;\n"
    ).encode("cp1250")
    return files


def statement_json(stmt) -> dict:
    return {
        "bank": stmt.bank,
        "account_number": stmt.account_number,
        "account_name": stmt.account_name,
        "currency": stmt.currency,
        "skipped_rows": stmt.skipped_rows,
        "balances": [[d.isoformat(), str(a)] for d, a in stmt.balances],
        "closing_balances": [[d.isoformat(), str(a)] for d, a in stmt.closing_balances],
        "transactions": [{**raw_json(t), "raw": t.raw, "v2": v2_of(t), "v1": base_hash(1, t)}
                         for t in stmt.transactions],
    }


def parse_outcome(importer: DelimitedImporter, path: Path) -> object:
    try:
        return statement_json(importer.parse(path))
    except Exception as e:  # noqa: BLE001 - the error class is the vector
        return {"error": error_name(e)}


def gen_statements(_rng: random.Random, folder: Path) -> list:
    rows: list = []
    for rel, content in sorted(fixture_files().items()):
        path = folder / rel.replace("/", "__")
        path.write_bytes(content)
        forced = {bank: parse_outcome(get_importer(bank), path) for bank in BANKS}
        detected = detect_importer(path)
        engine = parse_outcome(DebitCreditImporter(), path) if rel.startswith("engine/") else None
        rows.append(["file", rel, forced, detected.bank if detected else None, engine])
    return rows


# --------------------------------------------------------------------------- matching data


def string_constants(fn: Callable) -> list[str]:
    tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
    return [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)
            and n.value.startswith("#")]


def ignorecase_class(ch: str) -> list[int]:
    pattern = re.compile("(?i)" + re.escape(ch))
    return [c for c in range(0x110000) if not 0xD800 <= c <= 0xDFFF and pattern.fullmatch(chr(c))]


def matching_data() -> dict:
    return {
        "base": {
            "DEFAULT_ENCODINGS": list(base_mod.DEFAULT_ENCODINGS),
            "DEFAULT_DELIMITERS": list(base_mod.DEFAULT_DELIMITERS),
            "DATE_FORMATS": list(base_mod._DATE_FORMATS),
            "ACCOUNT_RE": base_mod._ACCOUNT_RE.pattern,
        },
        "mbank": {
            "encodings": list(MBankImporter.encodings),
            "delimiters": list(MBankImporter.delimiters),
            "signature": list(MBankImporter.signature),
            "colmap": {k: list(v) for k, v in dataclasses.asdict(MBankImporter.colmap).items()},
            "colmap_order": [f.name for f in dataclasses.fields(ColumnMap)],
            "meta_markers": string_constants(MBankImporter.extract_meta),
        },
        "erste": {"encodings": list(ErsteImporter.encodings), "signature": list(ErsteImporter.signature)},
        "pekao": {
            "encodings": list(PekaoImporter.encodings),
            "delimiters": list(PekaoImporter.delimiters),
            "signature": list(PekaoImporter.signature),
            "cols": {k: list(v) for k, v in PekaoImporter._COLS.items()},
            "cols_order": list(PekaoImporter._COLS),
        },
        "normalize": {
            "TX_DATE_SUFFIX": normalize_mod._TX_DATE_SUFFIX.pattern,
            "TX_DATE_SUFFIX_IGNORECASE": [ignorecase_class(ch) for ch in "DATA TRANSAKCJI:"],
        },
    }


def gen_matching_data(_rng: random.Random) -> list:
    """One row: the matching data and the sha256 of its canonical serialisation (sorted keys, compact)."""
    obj = matching_data()
    text = json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return [["matching", obj, hashlib.sha256(text.encode("utf-8")).hexdigest()]]


# --------------------------------------------------------------------------- difflib and person names

TYPO_ALPHABET = "abcdefghijklmnopqrstuvwxyz_ "


def typo(rng: random.Random, word: str) -> str:
    chars = list(word)
    for _ in range(rng.randint(1, 3)):
        op = rng.randint(0, 3)
        i = rng.randint(0, max(0, len(chars) - 1))
        if op == 0 and chars:
            del chars[i]
        elif op == 1:
            chars.insert(i, rng.choice(TYPO_ALPHABET))
        elif op == 2 and chars:
            chars[i] = rng.choice(TYPO_ALPHABET)
        elif len(chars) > 1:
            j = min(i + 1, len(chars) - 1)
            chars[i], chars[j] = chars[j], chars[i]
    return "".join(chars)


def gen_difflib(rng: random.Random) -> list:
    from cashu.modules.budget.ingestion.canonical import CSV_COLUMNS

    rows: list = [["columns", list(CSV_COLUMNS)]]
    for _ in range(700):
        word = typo(rng, rng.choice(CSV_COLUMNS)) if rng.random() < 0.8 else rand_text(rng, TYPO_ALPHABET, 14)
        rows.append(["close", word, difflib.get_close_matches(word, CSV_COLUMNS, n=1, cutoff=0.75)])
    for _ in range(250):
        a = rand_text(rng, "abcab ł", 30)
        b = rand_text(rng, "abcab ł", 30)
        rows.append(["ratio", a, b, difflib.SequenceMatcher(None, a, b).ratio()])
    for n in (199, 200, 260):  # autojunk applies from 200 elements of b
        a = rand_text(rng, "ab", 60)
        b = "".join(rng.choice("aab c") for _ in range(n))
        rows.append(["ratio", a, b, difflib.SequenceMatcher(None, a, b).ratio()])
    for _ in range(50):
        word = rand_text(rng, "abc", 5)
        pool = [rand_text(rng, "abc", 5) for _ in range(rng.randint(0, 8))]
        n = rng.randint(1, 4)
        cutoff = rng.choice([0.0, 0.3, 0.6, 0.75, 1.0])
        rows.append(["close_n", word, pool, n, cutoff, difflib.get_close_matches(word, pool, n=n, cutoff=cutoff)])
    return rows


FIRST = ["ANNA", "JAN", "Łucja", "józef", "Zoë", "Ørjan", "O'NEIL", "MARIA-ANNA", "A.", "X"]
LAST = ["TESTOWA", "NOWAK", "Kowalska-Test", "Æbelø", "BAR", "DOM", "Straße", "ĐURIC"]
BUSINESS_WORDS = ["SKLEP", "SP. Z O.O.", "BANK", "PHU", "APTEKA", "STUDIO", "SALON", "AUTO", "ZUS"]
ADDRESS_WORDS = ["UL. POLNA 5", "AL. TESTOWA 12", "OS. ZIELONE 3", "WARSZAWA", "00-001", "PL. X 1"]


def gen_person(rng: random.Random) -> list:
    from cashu.core.mcp import names as N

    rows: list = [["sets", sorted(N.BUSINESS_MARKERS), sorted(N.AMBIGUOUS_MARKERS), sorted(N._ADDRESS),
                   N._FOLD_EXTRA]]
    pool = FIRST + LAST + BUSINESS_WORDS + ADDRESS_WORDS + ["", "  ", "1234", "A1", "-", "x\u0301", "\xa0"]
    for _ in range(1000):
        text = " ".join(rng.choice(pool) for _ in range(rng.randint(0, 6)))
        if rng.random() < 0.1:
            text = rand_text(rng, "ab .,-'1Łł\u0301\t", 12)
        rows.append(["name", text, N.fold(text), N.normalize(text), N.person_part(text), N.looks_like_person(text)])
    rows.append(["name", None, N.fold(""), N.normalize(None), N.person_part(None), N.looks_like_person(None)])
    return rows


# --------------------------------------------------------------------------- canonical budget documents


def canonical_out(content: bytes, name: str, source: str) -> dict:
    from cashu.modules.budget.ingestion import canonical as C

    r = C.parse_budget_document(content, name, source=Source(source))
    stmt = r.statement
    report = C.validate_budget_document(content, name) if source == "csv" else None
    return {
        "issues": [[i.kind, i.row, i.field, i.message, i.blocking] for i in r.issues],
        "ok": r.ok,
        "variant": r.variant,
        "source": r.source,
        "institution": r.institution,
        "transactions": r.transactions,
        "balances": r.balances,
        "statement": None if stmt is None else {
            "bank": stmt.bank,
            "account_number": stmt.account_number,
            "account_name": stmt.account_name,
            "currency": stmt.currency,
            "transactions": [{**raw_json(t), "raw": t.raw} for t in stmt.transactions],
            "balances": [[d.isoformat(), str(a)] for d, a in stmt.balances],
            "closing_balances": [[d.isoformat(), str(a)] for d, a in stmt.closing_balances],
        },
        "report": None if report is None else report.as_dict(),
        "summary": None if report is None else report.summary(),
        "looks_like": C.looks_like_budget_document(content, name),
    }


def base_doc() -> dict:
    import test_budget_import_format as tbif

    return tbif.doc()


MUTATION_VALUES: list = [
    "<missing>", None, "", "  ", 0, 1, -1, Decimal("1.5"), True, False, [], {}, "x", "x" * 501, "x" * 201,
    "x" * 121, "2026-02-30", "2026-10-04", "04.10.2026", "1,5", "1e5", "-12.345", "12.5", "PLN", "pln", "ZLOTY",
    "Bad Source", "my_src", "a" * 33, "PL99114000000000000000000001", "12", "٣.٥", "٢٠٢٦-١٠-٠٤", "1.0",
    Decimal("1.0"), Decimal("1E+2"), 2, "mbank", "nowybank", "-", "a\n", "1", Decimal("1.00"), Decimal("1E0"),
    Decimal("10E-1"), Decimal("-0"),
]
FIELD_PATHS = [
    ("format",), ("format_version",), ("source",), ("account",), ("transactions",), ("balances",),
    ("account", "currency"), ("account", "iban"), ("account", "name"), ("account", "institution"),
    *[("transactions", 0, f) for f in ("booking_date", "amount", "currency", "value_date", "counterparty_name",
                                      "counterparty_iban", "description", "reference", "transaction_id",
                                      "balance_after")],
    ("transactions", 1, "amount"), ("transactions", 1), ("balances", 0, "date"), ("balances", 0, "amount"),
    ("balances", 0),
]


def mutate(d: dict, path: tuple, value) -> dict:
    import copy

    d = copy.deepcopy(d)
    target = d
    for p in path[:-1]:
        target = target[p]
    if value == "<missing>":
        if isinstance(target, dict):
            target.pop(path[-1], None)
        else:
            del target[path[-1]]
    else:
        target[path[-1]] = value
    return d


def _wrap_decimals(o):
    if isinstance(o, Decimal):
        return f"__DEC__{o}__"
    if isinstance(o, dict):
        return {k: _wrap_decimals(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_wrap_decimals(v) for v in o]
    return o


def as_json(d) -> bytes:
    """JSON with Decimal values written as number literals (``1.5``, ``1E+2``)."""
    text = json.dumps(_wrap_decimals(d), ensure_ascii=False)
    return re.sub(r'"__DEC__([^"]*)__"', r"\1", text).encode("utf-8")


CSV_HEADER_POOL = ["format_version", "booking_date", "amount", "currency", "value_date", "counterparty_name",
                   "counterparty_iban", "description", "reference", "transaction_id", "balance_after",
                   "account_iban", "account_currency", "account_name", "account_institution", "source",
                   "descripton", "Anna Testowa", "kwota 1234", "note", "  Amount ", "﻿format_version", ""]
CSV_CELL_POOL = ["1", "2", "2026-10-01", "-10.00", "25.5", "PLN", "EUR", "", " ", "x", "C1", "my_conv",
                 "PL99114000000000000000000001", "1,5", "a,b", "\"q\"", "ŁÓDŹ", "KWD", "1.234"]


def csv_line(cells: list[str]) -> str:
    out = []
    for c in cells:
        out.append('"' + c.replace('"', '""') + '"' if any(ch in c for ch in ',"\n\r') else c)
    return ",".join(out)


def gen_canonical(rng: random.Random) -> list:
    import test_budget_import_format as tbif

    rows: list = []

    def add(content: bytes, name: str, source: str = "csv") -> None:
        rows.append(["doc", base64.b64encode(content).decode(), name, source, canonical_out(content, name, source)])

    base = base_doc()
    add(as_json(base), "x.json")
    add(as_json(base), "x.json", "connector")
    for path in FIELD_PATHS:
        for value in MUTATION_VALUES:
            add(as_json(mutate(base, path, value)), "x.json")
    for parent in ((), ("account",), ("transactions", 0), ("balances", 0)):
        d = mutate(base, (*parent, "extra_key"), 1) if parent else {**base, "descripton": 1}
        add(as_json(d), "x.json")
    # legacy name: the pre-rename format id is still read
    add(as_json({**base, "format": "finanse-budget-import"}), "x.json")
    add(as_json({**base, "transactions": []}), "x.json")
    add(as_json({**base, "balances": [{"date": "2026-10-01", "amount": "1"}] * 10001}), "x.json")
    many = {**base, "transactions": [{**base["transactions"][1], "currency": "EUR"}] * 25}
    add(as_json(many), "x.json")
    for content in (b"{", b"[1, 2]", b'{"a": 1, "a": 2}', b"\xff\xfe", b'{"x": NaN}', b"", b"  ", b'"x"',
                    b'{"a": {"b": 1, "b": 2}}', b"\xef\xbb\xbf{}", b'\xef\xbb\xbf\xef\xbb\xbf{}', b'{"a": 1e999}',
                    b'{"a": -Infinity}', b'{"a": "\\ud800"}', b'{"a": 1' + b"0" * 5000 + b"}", b"[" * 600 + b"]" * 600,
                    b'{"a":\n [1,\n 2,]}', b'{"a": "x\ty"}', b'{"a": 01}', b"{\"a\": \"\xc5\x82\"} x"):
        add(content, "x.json")
    valid = as_json(base)
    for _ in range(250):
        cut = rng.randint(0, len(valid))
        add(valid[:cut], "x.json")
    for _ in range(250):
        b = bytearray(valid)
        b[rng.randrange(len(b))] = rng.choice(b'{}[]",:0a \\\n\xff')
        add(bytes(b), "x.json")
    # CSV variant: the oracle tables plus random headers / rows
    add(("﻿" + tbif.CSV_OK).encode(), "x.csv")
    add(tbif.CSV_OK.encode(), "x.csv", "connector")
    for content, _ in [(b"format_version,booking_date,amount,currency\n1,2026-10-01,-1.00,EUR\n", None),
                       ((b"format_version,booking_date,amount,currency\n1,2026-10-01,-1.00,EUR\n"
                        b"1,2026-10-02,-1.00,PLN\n"), None)]:
        add(content, "x.csv")
    for content in (b"format_version,booking_date,amount\n1,2026-10-01,1\n",
                    b"format_version,booking_date,amount,currency,descripton\n",
                    b"format_version,booking_date,amount,currency,amount\n",
                    b"format_version,booking_date,amount,currency\n2,2026-10-01,1,PLN\n",
                    b"format_version,booking_date,amount,currency\n1,2026-10-01,1\n",
                    b"format_version,booking_date,amount,currency,source\n1,2026-10-01,1,PLN,a\n1,2026-10-01,1,PLN,b\n",
                    b"format_version,booking_date,amount,currency,account_currency\n1,2026-10-01,1,PLN,PLNX\n",
                    b"format_version,booking_date,amount,currency\n1,,1,PLN\n", b"", b"\n\n", b"a,b\n1,2\n",
                    b'format_version,booking_date\n"1,x', b"format_version,amount\r\n1,\"a\"b\r\n",
                    b"#Data operacji;#Kwota\n", b"\x00\x01\x02", b"format_version,booking_date,amount,currency\r1,2026-10-01,1,PLN\r"):
        add(content, "x.csv")
    for _ in range(400):
        header = rng.sample(CSV_HEADER_POOL[:4], k=rng.randint(2, 4)) + rng.sample(CSV_HEADER_POOL[4:], k=rng.randint(0, 4))
        rng.shuffle(header)
        lines = [csv_line(header)]
        for _ in range(rng.randint(0, 4)):
            n = len(header) + (rng.choice([-1, 1]) if rng.random() < 0.1 else 0)
            cells = []
            for col in header[:n] + [""] * max(0, n - len(header)):
                name = col.strip().lstrip("﻿").strip().lower()
                if name == "format_version":
                    cells.append(rng.choice(["1", "1", "1", "2", " 1 "]))
                elif rng.random() < 0.15:
                    cells.append(rng.choice(CSV_CELL_POOL))
                else:
                    cells.append({"booking_date": "2026-10-01", "amount": "-10.00", "currency": "PLN",
                                  "account_currency": "PLN", "source": "my_conv",
                                  "account_iban": "PL99114000000000000000000001"}.get(name, rng.choice(CSV_CELL_POOL)))
            lines.append(csv_line(cells) if rng.random() < 0.95 else "")
        text = rng.choice(["\n", "\r\n"]).join(lines) + rng.choice(["", "\n"])
        add((("﻿" if rng.random() < 0.1 else "") + text).encode("utf-8"), rng.choice(["x.csv", "x", "x.JSON"]))
    # detection only
    for content, name in [(as_json(base), "statement.json"), (as_json(base), "noext"),
                          (b'{"format": "cashu-import"}', "x.json"), (b"#Data operacji;#Kwota\n", "mbank.csv"),
                          # legacy name: the pre-rename format id is still read
                          (b"\x00\x01\x02", "x.bin"), (b'\xef\xbb\xbf  {"format": "finanse-budget-import"', "x"),
                          (b'format_version,"booking_date\n', "x.csv"), (b"\xff" * 10, "x.csv")]:
        add(content, name)
    return rows


def gen_canonical_docs(_rng: random.Random) -> list:
    """The documented full examples (docs/budget-import-format.md section 5) and the field lists."""
    import test_budget_import_format as tbif

    from cashu.modules.budget.ingestion import canonical as C

    rows: list = [["fields", list(C.TRANSACTION_FIELDS), list(C.ACCOUNT_FIELDS), list(C.TOP_LEVEL_KEYS),
                   list(C.CSV_COLUMNS), list(C.REQUIRED_CSV_COLUMNS), sorted(C.THREE_DECIMAL_CURRENCIES)]]
    for lang, name in (("json", "example.json"), ("csv", "example.csv")):
        for block in tbif._doc_blocks(lang):
            content = block.encode()
            rows.append(["example", lang, block, canonical_out(content, name, "csv")])
    return rows


# --------------------------------------------------------------------------- detection sweep

DETECT_FRAGMENTS = [
    '"2026-09-30","01-09-2026","\'99109000000000000000000001","Konto","PLN","30-09-2026","90","2"',
    "2026-09-30,01-09-2026,'99109000000000000000000001,Konto,PLN,30-09-2026,\"90,00\",2",
    '"02-09-2026","02-09-2026","ZAKUP","SKLEP TEST","","-10,00","90,00","1",""',
    "mBank S.A.;", "Elektroniczne zestawienie operacji;", "#Data operacji;#Kwota;",
    "#Data księgowania;#Opis operacji;#Tytul;#Nadawca/Odbiorca;#Numer konta;#Kwota;#Saldo po operacji;",
    "2026-09-05;ZAKUP;T;SKLEP TEST;;-1,00;10,00;",
    "Santander Bank Polska", "Erste Bank", "BZWBK", "Rachunek źródłowy;Rachunek docelowy;",
    "Numer referencyjny;Typ operacji", "Data księgowania;Kwota operacji;Waluta", "", "  ",
    '"a,b",c', "x y", "\x85", "'99109000000000000000000004", '"\'1",2,3,4,5,6,7',
]


def gen_detect(rng: random.Random) -> list:
    rows: list = []
    for _ in range(1500):
        lines = [rng.choice(DETECT_FRAGMENTS) for _ in range(rng.randint(1, 6))]
        if rng.random() < 0.5:  # the quoted summary row first, as in the review's case
            lines.insert(0, DETECT_FRAGMENTS[0])
        text = rng.choice(["\n", "\r\n", "\r"]).join(lines) + rng.choice(["", "\n"])
        encoding = rng.choice(["cp1250", "utf-8", "utf-8-sig"])
        try:
            content = text.encode(encoding)
        except UnicodeEncodeError:
            content = text.encode("utf-8")
        if rng.random() < 0.15:
            b = bytearray(content)
            for _ in range(rng.randint(1, 3)):
                b.insert(rng.randint(0, len(b)), rng.choice(b'",;\x00\x81\x98\xff\r\n'))
            content = bytes(b)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "in.csv"
            path.write_bytes(content)
            detected = detect_importer(path)
        rows.append(["detect", base64.b64encode(content).decode(), detected.bank if detected else None])
    return rows


# --------------------------------------------------------------------------- driver

GENERATORS: dict[str, tuple[Callable, str]] = {
    "budget-codecs": (gen_codecs, ("['table', codec, [cp|null x256]] | ['bytes', base64, {codec: ['ok', text] | "
                      "['err', start]}, {codec: replace text}]")),
    "budget-csv": (gen_csv, ("['text', text, delimiter, strict, 'lf'|'universal', outcome] | ['lines', [line], "
                   "delimiter, strict, outcome] | ['limit', n, quoted, outcome (long field as [len])]; outcome ['ok', rows, line_num] | ['err', reason, line_num]")),
    "budget-text": (gen_text, ("['isdigit_only', [cp]] | ['isdecimal_count', n] | ['splitlines', s, parts] | "
                    "['strip', s, chars, strip, lstrip, rstrip]")),
    "budget-plformats": (gen_plformats, ("['amount', s, [str, exp] | null | {error}] | ['date', s, iso | null] | "
                         "['account', s, str | null]")),
    "budget-hash": (gen_hash, "['hash', raw, content_key_v2, v2, {account_id: v1}] | ['merchant', fields, key]"),
    "budget-dedup": (gen_dedup, ("['scenario', newest_day_rule, pre_rows, [{raws, statuses, num_duplicates, "
                     "num_overlap, inserted: [[v2, occurrence]]}]]")),
    "budget-difflib": (gen_difflib, ("['columns', CSV_COLUMNS] | ['close', word, get_close_matches(word, CSV_COLUMNS, "
                        "1, 0.75)] | ['ratio', a, b, ratio] | ['close_n', word, pool, n, cutoff, matches]")),
    "budget-person": (gen_person, ("['sets', business, ambiguous, address, fold_extra] | ['name', text, fold, "
                      "normalize, person_part, looks_like_person]")),
    "budget-canonical": (gen_canonical, ("['doc', base64 content, name, source, {issues: [[kind, row, field, "
                         "message, blocking]], ok, variant, ..., statement, report, summary, looks_like}]")),
    "budget-canonical-docs": (gen_canonical_docs, ("['fields', ...lists] | ['example', lang, block, outcome] "
                              "(docs/budget-import-format.md)")),
    "budget-detect": (gen_detect, "['detect', base64 content, detect_importer bank | null]"),
    "budget-matching-data": (gen_matching_data, ("['matching', data, sha256 of json.dumps(data, "
                             "ensure_ascii=False, sort_keys=True, separators=(',', ':'))]")),
}
STATEMENTS_LAYOUT = ("['file', relpath, {bank: statement | {error}}, detected | null, debit_credit_engine "
                     "statement | null]")


def render_rows(name: str, layout: str, rows: list) -> str:
    meta = {"meta": {"name": name, "count": len(rows), "layout": layout, "seed": SEED,
                     "generator": "parity/python/vectors_budget.py", "python": sys.version.split()[0],
                     "unicode": unicodedata.unidata_version}}
    lines = [json.dumps(meta, ensure_ascii=False)]
    lines += [json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in rows]
    return "\n".join(lines) + "\n"


def outputs(tmp: Path) -> dict[Path, bytes]:
    out: dict[Path, bytes] = {}
    for name, (fn, layout) in GENERATORS.items():
        rows = fn(random.Random(f"{SEED}:{name}"))
        out[OUT / f"{name}.jsonl"] = render_rows(name, layout, rows).encode("utf-8")
    rows = gen_statements(random.Random(SEED), tmp)
    out[OUT / "budget-statements.jsonl"] = render_rows("budget-statements", STATEMENTS_LAYOUT, rows).encode()
    for rel, content in fixture_files().items():
        out[FIXTURES / rel] = content
    return out


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail when a committed file differs")
    args = parser.parse_args(list(argv) if argv is not None else None)
    with tempfile.TemporaryDirectory(prefix="cashu-vectors-budget-") as tmp:
        files = outputs(Path(tmp))
    stale = []
    for path, content in files.items():
        if args.check:
            if not path.exists() or path.read_bytes() != content:
                stale.append(str(path.relative_to(ROOT)))
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    if args.check:
        known = {p for p in files if p.is_relative_to(FIXTURES)}
        extra = [str(p.relative_to(ROOT)) for p in FIXTURES.rglob("*") if p.is_file() and p not in known]
        stale += extra
        if stale:
            print("stale or extra files: " + ", ".join(sorted(stale)))
            return 1
        print(f"{len(files)} files up to date")
        return 0
    print(f"{len(files)} files written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
