"""The catalog twins of the built-in bank CSV parsers (``connectors/mbank-csv``, ``erste-csv``,
``pekao-csv``) are equivalent to them, before the switch-over removes the built-ins.

Not marked ``catalog``: these connectors are meant to replace core code, so a core change that breaks
the equivalence (a parser fix not ported, a dedup key change) must fail the core run, not only the
informational catalog job. They run the connector with ``deno`` directly (no macOS sandbox, so the
test also runs where the sandbox does not), with Deno's own read-only permission; the real sandbox
run of every fixture is ``tests/test_connector_catalog.py`` (``pytest -m catalog``). Skipped when no
``deno`` is on the fixed search path.

1. Python-compatible primitives: ``pycompat.ts`` against Python itself (csv, decoding, strip,
   splitlines, ``parse_pl_amount``, ``parse_pl_date``, ``find_account_number``) on random input.
2. For every fixture and edge case: the built-in statement and the connector's document (through the
   real budget-format validator) give identical content-key hashes (``base_hash``), stored fields,
   own account number, currency, institution and end-of-day balances; neither sets a transaction id.
3. ``detect``: each connector says yes only for its own bank's files.
4. Import scenarios on a temp DB through the app's import (HTTP preview / commit, the connector
   installed and approved, NoSandbox): built-in first then the connector, and the reverse; zero
   duplicates, exactly the new rows. Plus the one case where the rules necessarily differ.

All data is synthetic.
"""

from __future__ import annotations

import base64
import io
import json
import os
import random
import shutil
import subprocess
from decimal import Decimal
from pathlib import Path

import pytest
from connector_support import NoSandbox
from sqlmodel import select

from cashu.core import paths
from cashu.core.connectors import manifest as mf
from cashu.core.connectors import runner, service
from cashu.core.db import get_session
from cashu.core.models import Account, Balance, Source
from cashu.core.text import iban_key, normalize_iban
from cashu.modules.budget.ingestion import canonical
from cashu.modules.budget.ingestion.csv_import import detect_importer, get_importer
from cashu.modules.budget.ingestion.csv_import.base import (
    _read_text,
    find_account_number,
    parse_pl_amount,
    parse_pl_date,
)
from cashu.modules.budget.ingestion.normalize import base_hash
from cashu.modules.budget.models import Transaction
from cashu.modules.budget.service import _end_of_day_balances

DENO = shutil.which("deno", path=os.pathsep.join(mf.SYSTEM_SEARCH_PATH))
pytestmark = pytest.mark.skipif(DENO is None, reason="no deno on the fixed search path")

CATALOG = paths.PROJECT_ROOT / "connectors"
CONNECTOR = {"mbank": "mbank-csv", "erste": "erste-csv", "pekao": "pekao-csv"}
BANK_OF = {cid: bank for bank, cid in CONNECTOR.items()}
SHARED_FILES = ("connector.ts", "pycompat.ts")


# --------------------------------------------------------------------------- #
# Running the connectors
# --------------------------------------------------------------------------- #


@pytest.fixture(scope="module")
def deno_dir(tmp_path_factory):
    return tmp_path_factory.mktemp("deno")


def _deno(script: Path, stdin: str, read: list[Path], deno_dir: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [DENO, "run", "--no-config", "--no-lock", "--no-remote", "--no-npm", "--no-prompt",
         f"--allow-read={','.join(str(p) for p in read)}", str(script)],
        input=stdin, capture_output=True, text=True, timeout=120, check=False,
        env={"PATH": "/usr/bin:/bin", "HOME": str(deno_dir), "DENO_DIR": str(deno_dir),
             "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
    )


def run_connector(cid: str, command: str, path: Path, deno_dir: Path) -> tuple[int, dict]:
    request = {"api_version": 1, "command": command, "module": "budget",
               "file": {"path": str(path), "name": path.name}, "params": {}}
    proc = _deno(CATALOG / cid / "connector.ts", json.dumps(request),
                 [CATALOG / cid, path.parent], deno_dir)
    assert proc.stdout.count("\n") == 1, proc.stderr  # exactly one JSON line on stdout
    return proc.returncode, json.loads(proc.stdout)


def convert_document(cid: str, path: Path, deno_dir: Path) -> dict:
    code, out = run_connector(cid, "convert", path, deno_dir)
    assert code == 0, out
    return out["document"]


# --------------------------------------------------------------------------- #
# Synthetic inputs: the fixtures plus edge cases
# --------------------------------------------------------------------------- #


def fixtures() -> list[tuple[str, Path]]:
    return [
        (BANK_OF[d.name], f)
        for d in sorted(CATALOG.iterdir()) if d.name in BANK_OF
        for f in sorted((d / "fixtures").glob("*.csv"))
    ]


MBANK_HEADER = (
    "#Data księgowania;#Data operacji;#Opis operacji;#Tytuł;#Nadawca/Odbiorca;#Numer konta;"
    "#Kwota;#Saldo po operacji;\n"
)
MBANK_EDGE = (
    "mBank S.A. Bankowość Detaliczna;\n\n#Waluta;\npln;\n\n#Numer rachunku;\n"
    "PL99 1140 0000 0000 0000 0000 0009;\n\n" + MBANK_HEADER
    + "05.09.2026;04.09.2026;ZAKUP;\"TYTUŁ  Z  SPACJAMI\";\" ANNA TESTOWA \";'';"
      "\"1 234,56\";\"2 000,00\";\n"
    + "2026-09-06; 2026-9-5 ;PRZELEW;\"\";\"\";'99 1050 0000 0000 0000 0000 0555';+5,00;\"2 005,00\";\n"
    + "2026-09-06;2026-02-30;OPŁATA;\"OPŁATA, \"\"EKSPRES\"\"\";;'';-0,00;\"2 005,00\";\n"
    + "2026-09-07;;;\"" + "DŁUGI TYTUŁ " * 15 + "\";\"X\";'';-1.234,50;770,50;\n"
    + "2026-09-07;;KRÓTKI;\nniedata;;;;;;-1,00;;\n;;;;;;#Saldo końcowe;770,50;\n"
)
ERSTE_ROW = '"{d}","{d}","{t}","{c}","{a}","{x}","{b}","1",""\n'
ERSTE_NO_SUMMARY = (  # no summary row: the account number is the first one in the file
    ERSTE_ROW.format(d="02-09-2026", t="ZAKUP KARTĄ", c="SKLEP TEST", a="", x="-10,00", b="90,00")
    + ERSTE_ROW.format(d="01-09-2026", t="PRZELEW", c="JAN TEST", a="99109000000000000000000004",
                       x="100,00", b="100,00")
)
ERSTE_ASCENDING = (  # oldest first, no row with a balance on the export date
    "2026-09-03,01-09-2026,'99109000000000000000000001,Konto,eur,03-09-2026,\"80,00\",2\n"
    + "01-09-2026,01-09-2026,WPŁATA,JAN TEST,99109000000000000000000004,\"100,00\",\"100,00\",1\n"
    + "02-09-2026,02-09-2026,ZAKUP,SKLEP TEST,,\"-20,00\",\"80,00\",2\n"
)
ERSTE_SINGLE = (  # one row on the export date: not "newest first", the row's balance wins
    "2026-09-03,01-09-2026,'99109000000000000000000001,Konto,PLN,03-09-2026,\"75,00\",1\n"
    + "03-09-2026,03-09-2026,ZAKUP,SKLEP TEST,,\"-5,00\",\"80,00\",1\n"
)
PEKAO_HEADER = (
    "Data księgowania;Data waluty;Nadawca / Odbiorca;Adres nadawcy / odbiorcy;Rachunek źródłowy;"
    "Rachunek docelowy;Tytułem;Kwota operacji;Waluta;Numer referencyjny;Typ operacji;Kategoria\n"
)
PEKAO_TIE = PEKAO_HEADER + (  # two accounts seen equally often: the first one seen is the own one
    "2026-09-01;;JAN TEST;;'99124000000000000000000001;'99124000000000000000000002;A;-1,00;;R1;T;K\n"
    "2026-09-02;;JAN TEST;;'99124000000000000000000002;'99124000000000000000000001;B;1,00;;R2;T;K\n"
    "2026-09-03;;KTOŚ;;;;C;\"2 000,00\";PLN;R3;T;K\n"
    "brak daty;;;;'99124000000000000000000001;;D;5,00;PLN;R4;T;K\n"
)

EDGE_CASES: list[tuple[str, str, bytes]] = [
    ("mbank", "mbank-edge.csv", MBANK_EDGE.encode("cp1250")),
    ("mbank", "mbank-utf8.csv", MBANK_EDGE.encode("utf-8")),  # read as cp1250 first, as before
    ("mbank", "mbank-crlf-bom.csv", ("﻿" + MBANK_EDGE).replace("\n", "\r\n").encode("utf-8")),
    ("erste", "erste-no-summary.csv", ERSTE_NO_SUMMARY.encode("utf-8-sig")),
    ("erste", "erste-ascending.csv", ERSTE_ASCENDING.encode("utf-8")),
    ("erste", "erste-single.csv", ERSTE_SINGLE.encode("cp1250")),
    ("pekao", "pekao-tie.csv", PEKAO_TIE.encode("utf-8-sig")),
    ("pekao", "pekao-cr.csv", PEKAO_TIE.replace("\n", "\r").encode("cp1250")),
]


def all_cases(tmp_path_factory) -> list[tuple[str, Path]]:
    folder = tmp_path_factory.mktemp("edge")
    cases = list(fixtures())
    for bank, name, content in EDGE_CASES:
        (folder / name).write_bytes(content)
        cases.append((bank, folder / name))
    return cases


CASE_IDS = [p.name for _, p in fixtures()] + [name for _, name, _ in EDGE_CASES]


@pytest.fixture(scope="module")
def cases(tmp_path_factory):
    return {p.name: (bank, p) for bank, p in all_cases(tmp_path_factory)}


# --------------------------------------------------------------------------- #
# 1. The Python-compatible primitives against Python
# --------------------------------------------------------------------------- #

HARNESS = """
import * as py from "{pycompat}";
const cases = JSON.parse(await new Response(Deno.stdin.readable).text());
const out = [];
const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
for (const [fn, ...args] of cases) {{
  try {{
    if (fn === "csv") out.push(py.csvRows(args[0], args[1]));
    else if (fn === "strip") out.push(py.pyStrip(args[0]));
    else if (fn === "splitlines") out.push(py.pySplitlines(args[0]));
    else if (fn === "amount") out.push(py.parsePlAmount(args[0]));
    else if (fn === "date") out.push(py.parsePlDate(args[0]));
    else if (fn === "account") out.push(py.findAccountNumber(args[0]));
    else if (fn === "decode") out.push(py.readText(bytes(args[0]), args[1]));
  }} catch (e) {{
    out.push({{ error: e.constructor.name }});
  }}
}}
console.log(JSON.stringify(out));
"""


def _python(fn: str, *args):
    try:
        if fn == "csv":
            import csv

            return list(csv.reader(io.StringIO(args[0]), delimiter=args[1]))
        if fn == "strip":
            return args[0].strip()
        if fn == "splitlines":
            return args[0].splitlines()
        if fn == "amount":
            value = parse_pl_amount(args[0])
            return None if value is None else value
        if fn == "date":
            value = parse_pl_date(args[0])
            return None if value is None else value.isoformat()
        if fn == "account":
            return find_account_number(args[0])
        if fn == "decode":
            folder = Path(args[2])
            f = folder / "in.bin"
            f.write_bytes(base64.b64decode(args[0]))
            return _read_text(f, tuple(args[1]))
    except Exception as e:  # noqa: BLE001 - the error itself is the compared outcome
        return {"error": type(e).__name__}
    raise AssertionError(fn)


def _random_text(rng: random.Random, alphabet: str, n: int) -> str:
    return "".join(rng.choice(alphabet) for _ in range(rng.randint(0, n)))


def _primitive_cases(rng: random.Random, folder: Path) -> list[list]:
    spaces = " \t\x0b\x0c\x1c\x1d\x1e\x1f\x85\xa0     　﻿"
    cases: list[list] = []
    for _ in range(400):
        cases.append(["csv", _random_text(rng, 'ab ;,"\'\nł', 30), rng.choice([";", ","])])
        cases.append(["strip", _random_text(rng, "ab" + spaces, 8)])
        cases.append(["splitlines", _random_text(rng, "ab\n\x0b\x0c\x1c\x1d\x1e\x1f\x85 ", 10)])
        cases.append(["amount", _random_text(rng, "0123456789 ,.-+PLNx\xa0٣", 10)])
        cases.append(["date", _random_text(rng, "0123456789-./ ٢", 11)])
        cases.append(["date", rng.choice(["%04d-%d-%d", "%02d.%02d.%04d", "%d-%d-%04d", "%04d/%02d/%d",
                                          "%d/%d/%04d", "%04d-%02d- %d"])
                      % tuple(rng.randint(0, 40) if i else rng.randint(0, 2100) for i in range(3))])
        cases.append(["account", _random_text(rng, "0123456789 PL\xa0x", 40)])
    for _ in range(200):
        raw = bytes(rng.choice(b"ab\r\n\x81\x98\xb9\xea\xc4\x99\xef\xbb\xbf\xff") for _ in range(12))
        encodings = rng.choice([
            ["cp1250", "utf-8-sig", "iso-8859-2", "utf-8"],
            ["utf-8-sig", "cp1250", "iso-8859-2", "utf-8"],
            ["utf-8-sig", "utf-8", "cp1250", "iso-8859-2"],
        ])
        cases.append(["decode", base64.b64encode(raw).decode(), encodings, str(folder)])
    cases.append(["decode", base64.b64encode(bytes(range(256))).decode(), ["cp1250"], str(folder)])
    cases.append(["decode", base64.b64encode(bytes(range(256))).decode(), ["iso-8859-2"], str(folder)])
    cases.append(["decode", base64.b64encode(bytes(i for i in range(256) if i not in
                  (0x81, 0x83, 0x88, 0x90, 0x98))).decode(), ["cp1250"], str(folder)])
    return cases


def test_pycompat_primitives_match_python(tmp_path, deno_dir):
    pycompat = CATALOG / "mbank-csv" / "pycompat.ts"
    harness = tmp_path / "harness.ts"
    harness.write_text(HARNESS.format(pycompat=pycompat.as_uri()))
    cases = _primitive_cases(random.Random(20261030), tmp_path)
    proc = _deno(harness, json.dumps([c[:3] if c[0] == "decode" else c for c in cases]),
                 [tmp_path, pycompat.parent], deno_dir)
    assert proc.returncode == 0, proc.stderr
    got = json.loads(proc.stdout)
    mismatches = []
    for case, ts in zip(cases, got, strict=True):
        expected = _python(*case)
        if case[0] == "amount" and isinstance(expected, Decimal):
            # the same value and exponent, in the format's decimal syntax
            same = (
                isinstance(ts, str)
                and canonical._NUMBER.match(ts) is not None
                and Decimal(ts) == expected
                and Decimal(ts).as_tuple().exponent == expected.as_tuple().exponent
            )
        elif isinstance(expected, dict):  # Python raised: the port must refuse too
            same = isinstance(ts, dict) and "error" in ts
        else:
            same = ts == expected
        if not same:
            mismatches.append((case[:2], expected, ts))
    assert not mismatches, mismatches[:10]


def test_shared_files_are_identical_in_the_three_connectors():
    for name in SHARED_FILES:
        contents = {cid: (CATALOG / cid / name).read_bytes() for cid in CONNECTOR.values()}
        assert len(set(contents.values())) == 1, f"{name} differs between {sorted(contents)}"


# --------------------------------------------------------------------------- #
# 2. Equivalence of the parsed statements
# --------------------------------------------------------------------------- #


def _stored(t) -> tuple:
    """What the import stores of a row (``to_transaction``) and keys it by (``base_hash``)."""
    return (
        t.booking_date, t.value_date, t.amount, t.currency.upper(), t.counterparty_name,
        normalize_iban(t.counterparty_iban) or None, t.description, t.reference,
        t.bank_transaction_id,
    )


def _eod(stmt) -> dict:
    eod = _end_of_day_balances(stmt.transactions, stmt.balances)
    eod.update(dict(stmt.closing_balances))
    return eod


def _connector_statement(bank: str, path: Path, deno_dir: Path):
    document = convert_document(CONNECTOR[bank], path, deno_dir)
    result = canonical.parse_budget_document(
        json.dumps(document).encode(), "converted.json", source=Source.CONNECTOR
    )
    assert result.ok, [str(i) for i in result.issues]
    assert not result.warnings or {w.kind for w in result.warnings} == {"currency_mismatch"}
    return document, result.statement


@pytest.mark.parametrize("name", CASE_IDS)
def test_connector_statement_equals_the_built_in(name, cases, deno_dir):
    bank, path = cases[name]
    builtin = get_importer(bank).parse(path)
    document, conn = _connector_statement(bank, path, deno_dir)

    assert document["source"] == f"{bank}_csv"
    assert conn.bank == builtin.bank == bank  # account.institution: existing accounts match
    assert iban_key(conn.account_number) == iban_key(builtin.account_number)
    assert conn.currency == builtin.currency.upper()
    assert len(conn.transactions) == len(builtin.transactions) > 0
    for a, b in zip(builtin.transactions, conn.transactions, strict=True):
        assert base_hash(1, a) == base_hash(1, b), (_stored(a), _stored(b))
        if len(a.reference or "") <= canonical.MAX_ID:
            assert _stored(a) == _stored(b)
        assert a.bank_transaction_id is None and b.bank_transaction_id is None
    assert _eod(conn) == _eod(builtin)


# --------------------------------------------------------------------------- #
# 3. Detection
# --------------------------------------------------------------------------- #

FOREIGN = {
    "random.csv": b"a,b,c\n1,2,3\nfoo;bar;baz\n",
    "empty.csv": b"",
    "binary.csv": bytes(range(256)) * 4,
    "budget-format.csv": b"format_version,booking_date,amount,currency\n1,2026-10-01,-1.00,PLN\n",
    "deno-example.csv": (paths.PROJECT_ROOT / "examples/connectors/deno-budget-example/sample.csv")
    .read_bytes(),
    "example-bank.csv": (CATALOG / "example-bank-csv/fixtures/sample.csv").read_bytes(),
}


@pytest.mark.parametrize("name", CASE_IDS)
def test_detect_answers_only_for_its_own_bank(name, cases, deno_dir):
    bank, path = cases[name]
    answers = {}
    for cid in CONNECTOR.values():
        code, out = run_connector(cid, "detect", path, deno_dir)
        assert code == 0
        answers[BANK_OF[cid]] = out["match"]
        assert out["match"] == (out["confidence"] >= 0.5)
    expected = {b: b == bank for b in CONNECTOR}
    if name == "erste-no-summary.csv":  # no bank name and no summary row: nobody recognises it
        expected[bank] = False
        assert detect_importer(path) is None
    assert answers == expected


@pytest.mark.parametrize("name", sorted(FOREIGN))
def test_detect_says_no_to_foreign_files(name, tmp_path, deno_dir):
    path = tmp_path / name
    path.write_bytes(FOREIGN[name])
    for cid in CONNECTOR.values():
        code, out = run_connector(cid, "detect", path, deno_dir)
        assert (code, out) == (0, {"match": False, "confidence": 0}), cid


def test_convert_refuses_a_foreign_file_value_free(tmp_path, deno_dir):
    path = tmp_path / "random.csv"
    path.write_bytes(FOREIGN["random.csv"])
    for cid in CONNECTOR.values():
        code, out = run_connector(cid, "convert", path, deno_dir)
        assert code == 1 and out["error"]["kind"] == "bad_file", (cid, out)
        assert not any(v in out["error"]["message"] for v in ("foo", "bar", "1,2,3"))


# --------------------------------------------------------------------------- #
# 4. Import scenarios: the app's import, built-in and connector on one account
# --------------------------------------------------------------------------- #

# A newer export of each fixture's account that overlaps it: the overlapping rows (same texts), a
# second, different row on the stored newest day and rows after it.
MBANK_B = (
    "mBank S.A. Bankowość Detaliczna;\n\nElektroniczne zestawienie operacji;\n\n#Waluta;\nPLN;\n\n"
    "#Numer rachunku;\n99 1140 0000 0000 0000 0000 0001;\n\n" + MBANK_HEADER
    + '2026-09-08;2026-09-06;ZAKUP PRZY UŻYCIU KARTY;"SKLEP TEST   /KRAKÓW   DATA TRANSAKCJI: '
      "2026-09-06\";\"\";'';-1 234,56;7 083,44;\n"
    + "2026-09-10;2026-09-10;PRZELEW NA TELEFON BLIK;\"ZWROT ZA BILETY\";\"ANNA TESTOWA\";"
      "'99105000000000000000000555';150,00;7 233,44;\n"
    + "2026-09-10;2026-09-10;ZAKUP PRZY UŻYCIU KARTY;\"PIEKARNIA TEST DATA TRANSAKCJI: 2026-09-10\";"
      "\"\";'';-20,00;7 213,44;\n"
    + "2026-09-15;2026-09-15;ZAKUP PRZY UŻYCIU KARTY;\"STACJA TEST\";\"\";'';-200,00;7 013,44;\n"
    + "2026-09-20;2026-09-20;PRZELEW PRZYCHODZĄCY;\"ZWROT\";\"JAN TEST\";'99102000000000000000000777';"
      "13,44;7 026,88;\n"
)
ERSTE_B = (
    '"2026-10-05","01-10-2026","\'99 1090 0000 0000 0000 0000 0001","Konto Godne Polecenia",'
    '"PLN","05-10-2026","5 020,40","4"\n'
    + ERSTE_ROW.format(d="05-10-2026", t="ZAKUP KARTĄ STACJA TEST", c="STACJA TEST", a="",
                       x="-80,00", b="5 020,40")
    + ERSTE_ROW.format(d="30-09-2026", t="ZAKUP KARTĄ PIEKARNIA TEST", c="PIEKARNIA TEST", a="",
                       x="-20,00", b="5 100,40")
    + '"30-09-2026","30-09-2026","ZAKUP PRZY UŻYCIU KARTY SKLEP TEST","SKLEP TEST","","-57,30",'
      '"5 120,40","1",""\n'
    + '"29-09-2026","29-09-2026","OPŁATA ZA PRZELEW, EKSPRES","","","-5,00","5 177,70","2",""\n'
)
PEKAO_B = PEKAO_HEADER + (
    "10.09.2026;10.09.2026;JAN TESTOWY;;'99124000000000000000000001;'99124000000000000000000002;"
    "OSZCZĘDNOŚCI;-1 000,00;PLN;C0000000000005;PRZELEW WŁASNY;Przelewy\n"
    "15.09.2026;14.09.2026;SERWIS TEST;DUBLIN;'99124000000000000000000001;;SERWIS TEST 9.99 EUR;-43,15;EUR;"
    "C0000000000006;TRANSAKCJA KARTĄ PŁATNICZĄ;Rozrywka\n"
    "15.09.2026;15.09.2026;PIEKARNIA TEST;;'99124000000000000000000001;;PIEKARNIA TEST;-20,00;PLN;"
    "C0000000000007;TRANSAKCJA KARTĄ PŁATNICZĄ;Jedzenie\n"
    "20.09.2026;20.09.2026;STACJA TEST;;'99124000000000000000000001;;STACJA TEST;-200,00;PLN;"
    "C0000000000008;TRANSAKCJA KARTĄ PŁATNICZĄ;Transport\n"
)
SCENARIOS = {  # bank: (file A, encoding of B, B, rows of B that are new after A)
    "mbank": ("mbank-zestawienie.csv", "cp1250", MBANK_B, 3),
    "erste": ("erste-historia.csv", "utf-8-sig", ERSTE_B, 2),
    "pekao": ("pekao-historia.csv", "utf-8", PEKAO_B, 2),
}


@pytest.fixture
def budget_app(api_empty, monkeypatch):
    """A profile with the budget module and the three catalog connectors installed and approved
    (run with the tests' NoSandbox double: the real sandbox run is the catalog test)."""
    monkeypatch.setattr(runner, "default_sandbox", lambda: NoSandbox())
    client = api_empty
    slug = client.post("/api/profiles", json={"name": "Jan Test", "modules": ["budget"]}).json()["slug"]
    for cid in CONNECTOR.values():
        service.install(CATALOG / cid)
        d = client.get(f"/api/connectors/{cid}").json()
        r = client.post(f"/api/connectors/{cid}/approve", json={
            "content_sha256": d["content_sha256"], "interpreter_path": d["interpreter_path"]})
        assert r.status_code == 200, r.text
    return client, slug


def _import(client, slug, name: str, content: bytes, importer: str) -> tuple[dict, dict]:
    r = client.post(f"/api/p/{slug}/budget/import/preview",
                    files={"file": (name, content, "text/csv")}, data={"bank": importer})
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["bank"]["id"] == importer
    r = client.post(f"/api/p/{slug}/budget/import/commit", json={
        "file_id": p["file_id"], "file_name": p["file_name"], "bank": importer})
    assert r.status_code == 201, r.text
    return p, r.json()


def _state() -> tuple:
    """What is stored, without ids, sources and batches: accounts, rows, end-of-day balances."""
    with get_session() as s:
        accounts = sorted((a.bank, a.iban, a.currency) for a in s.exec(select(Account)).all())
        rows = sorted(
            (t.booking_date, t.value_date, str(t.amount), t.currency, t.counterparty_name or "",
             t.counterparty_iban or "", t.description or "", t.reference or "", t.occurrence,
             t.bank_transaction_id or "")
            for t in s.exec(select(Transaction)).all()
        )
        balances = sorted((b.date, str(b.amount)) for b in s.exec(select(Balance)).all())
    return accounts, rows, balances


def _scenario(client, slug, bank: str, first: str, then: str) -> tuple:
    """File A with ``first``, A again with ``then`` (all duplicates), then the newer overlapping
    file B with ``then`` (exactly its new rows)."""
    a_name, b_encoding, b_text, b_new = SCENARIOS[bank]
    a_path = CATALOG / CONNECTOR[bank] / "fixtures" / a_name
    a, b = a_path.read_bytes(), b_text.encode(b_encoding)
    importer = {"builtin": bank, "connector": f"connector:{CONNECTOR[bank]}"}
    n_a = len(get_importer(bank).parse(a_path).transactions)

    _, c = _import(client, slug, a_name, a, importer[first])
    assert c["inserted"] == n_a and c["account"]["created"]
    p, c = _import(client, slug, a_name, a, importer[then])  # the same file through the other path
    assert p["account"]["existing"] and p["account"]["institution"]["id"] == bank
    assert (p["counts"]["new"], p["counts"]["overlap"]) == (0, 0)
    assert (c["inserted"], c["duplicates"]) == (0, n_a) and not c["account"]["created"]
    p, c = _import(client, slug, "newer.csv", b, importer[then])  # a newer, overlapping export
    assert c["inserted"] == b_new, p["rows"]
    assert p["counts"]["overlap"] == 0  # every overlapping row matched by its content key
    state = _state()
    accounts, rows, _ = state
    assert len(accounts) == 1 and accounts[0][0] == bank
    assert len(rows) == n_a + b_new
    return state


@pytest.mark.parametrize("bank", sorted(SCENARIOS))
def test_import_built_in_then_connector(bank, budget_app):
    _scenario(*budget_app, bank, "builtin", "connector")


@pytest.mark.parametrize("bank", sorted(SCENARIOS))
def test_import_connector_then_built_in(bank, budget_app):
    _scenario(*budget_app, bank, "connector", "builtin")


@pytest.mark.parametrize("bank", sorted(SCENARIOS))
def test_both_orders_store_the_same(bank, budget_app):
    """Same account, rows (texts, occurrences) and balances whichever path came first."""
    from cashu.modules.budget.models import ImportBatch

    first = _scenario(*budget_app, bank, "builtin", "connector")
    with get_session() as s:  # start over in the same profile
        for model in (Transaction, Balance, ImportBatch, Account):
            for row in s.exec(select(model)).all():
                s.delete(row)
            s.flush()
        s.commit()
    assert _state() == ([], [], [])
    assert _scenario(*budget_app, bank, "connector", "builtin") == first


def test_where_the_rules_necessarily_differ(budget_app):
    """A row the stored history lacks, dated inside the stored span before its newest day (booked
    late, or missing from the earlier export): the built-in parser's plain dedup imports it, the
    connector path's newest-day rule takes it for the same transaction from another source and
    leaves it out (counted as overlap, preview warning ``import.overlap``)."""
    client, slug = budget_app
    a = (CATALOG / "mbank-csv/fixtures/mbank-zestawienie.csv").read_bytes()
    late = (
        "mBank S.A.;\n#Numer rachunku;\n99 1140 0000 0000 0000 0000 0001;\n" + MBANK_HEADER
        + "2026-09-07;2026-09-07;ZAKUP PRZY UŻYCIU KARTY;\"KIOSK TEST\";\"\";'';-4,00;7 079,44;\n"
    ).encode("cp1250")
    _import(client, slug, "a.csv", a, "mbank")
    p, c = _import(client, slug, "late.csv", late, "connector:mbank-csv")
    assert (p["counts"]["overlap"], c["inserted"]) == (1, 0)
    assert any(w["kind"] == "overlap" for w in p["warnings"])
    _, c = _import(client, slug, "late.csv", late, "mbank")  # the built-in parser imports it
    assert c["inserted"] == 1


def test_where_the_format_forces_a_difference(tmp_path, deno_dir):
    """Two values the budget import format cannot carry as the built-in parser kept them: a title
    over 200 characters (``reference`` is cut to 200) and a counterparty account number shorter than
    8 characters (left out, so the name keys the row). The import still works; only these rows hash
    differently from the built-in parser's, so a re-import of them through the other path is
    recognised by the newest-day rule (overlap) instead of the content key."""
    path = tmp_path / "mbank.csv"
    path.write_bytes((
        "mBank S.A.;\n#Numer rachunku;\n99 1140 0000 0000 0000 0000 0001;\n" + MBANK_HEADER
        + "2026-09-01;;OPIS;\"" + "T" * 250 + "\";\"SKLEP TEST\";'';-1,00;1,00;\n"
        + "2026-09-02;;OPIS;\"TYTUŁ\";\"JAN TEST\";'12345';-1,00;0,00;\n"
        + "2026-09-03;;OPIS;\"TYTUŁ\";\"JAN TEST\";'99105000000000000000000555';-1,00;-1,00;\n"
    ).encode("cp1250"))
    builtin = get_importer("mbank").parse(path)
    _, conn = _connector_statement("mbank", path, deno_dir)
    long_title, short_account, normal = zip(builtin.transactions, conn.transactions, strict=True)
    assert len(long_title[1].reference) == 200 and long_title[0].reference == "T" * 250
    assert short_account[0].counterparty_iban == "'12345'" and short_account[1].counterparty_iban is None
    assert base_hash(1, long_title[0]) != base_hash(1, long_title[1])
    assert base_hash(1, short_account[0]) != base_hash(1, short_account[1])
    assert base_hash(1, normal[0]) == base_hash(1, normal[1])
