"""The budget import format ``cashu-budget-import`` v1 (F10): JSON and CSV variants, one strict
validator with value-free issues, the mapping to ``RawTransaction``, ``Source.CONNECTOR``, dedup
against bank CSV rows, and the documentation examples. All data is synthetic."""

from __future__ import annotations

import json
import re
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
from sqlmodel import select

from cashu.core.accounts import get_or_create_account
from cashu.core.models import Balance, Source
from cashu.modules.budget import service
from cashu.modules.budget.ingestion import canonical
from cashu.modules.budget.ingestion.canonical import (
    BudgetIssue,
    IssueKind,
    looks_like_budget_document,
    parse_budget_document,
    validate_budget_document,
)
from cashu.modules.budget.ingestion.csv_import import parse_file
from cashu.modules.budget.models import Transaction

ROOT = Path(__file__).resolve().parents[1]
IBAN = "PL99114000000000000000000001"
SECRET = "ZZSENTINELZZ"  # appears in values only: never in an issue message


def doc(**over) -> dict:
    base = {
        "format": "cashu-budget-import",
        "format_version": 1,
        "source": "test_api",
        "account": {"iban": IBAN, "name": "Konto Test", "currency": "PLN"},
        "balances": [{"date": "2026-10-05", "amount": "1234.56"}],
        "transactions": [
            {
                "booking_date": "2026-10-04",
                "amount": "-42.10",
                "currency": "PLN",
                "counterparty_name": "SKLEP TEST",
                "description": "ZAKUP PRZY UZYCIU KARTY",
                "reference": "SKLEP TEST WARSZAWA",
                "transaction_id": "T1",
                "balance_after": "1234.56",
            },
            {"booking_date": "2026-10-03", "amount": 9000, "currency": "pln", "reference": "WYPLATA"},
        ],
    }
    base.update(over)
    return base


def as_json(d: dict) -> bytes:
    return json.dumps(d).encode()


def issues(result) -> set[tuple]:
    return {(i.kind, i.row, i.field) for i in result.issues}


def test_valid_json_maps_to_raw_transactions():
    r = parse_budget_document(as_json(doc()), "x.json")
    assert r.ok and r.variant == "json" and r.source == "test_api"
    stmt = r.statement
    assert stmt.bank == "test_api"  # no account.institution: the source names the new account's bank
    assert stmt.account_number == IBAN and stmt.account_name == "Konto Test" and stmt.currency == "PLN"
    t0, t1 = stmt.transactions
    assert t0.booking_date == date(2026, 10, 4) and t0.amount == Decimal("-42.10")
    assert t0.counterparty_name == "SKLEP TEST" and t0.reference == "SKLEP TEST WARSZAWA"
    assert t0.bank_transaction_id == "T1" and t0.source == Source.CSV
    assert t1.amount == Decimal(9000) and t1.currency == "PLN"  # upper-cased
    assert stmt.balances == [(date(2026, 10, 4), Decimal("1234.56"))]
    assert stmt.closing_balances == [(date(2026, 10, 5), Decimal("1234.56"))]
    assert r.issues == []


def test_institution_names_the_bank_and_an_unknown_one_is_a_warning():
    d = doc()
    d["account"]["institution"] = "mbank"
    assert parse_budget_document(as_json(d), "x.json").statement.bank == "mbank"
    d["account"]["institution"] = "nowybank"
    r = parse_budget_document(as_json(d), "x.json")
    assert r.ok and r.statement.bank == "nowybank"
    assert [(i.kind, i.blocking) for i in r.issues] == [(IssueKind.UNKNOWN_INSTITUTION, False)]


def test_connector_source_marks_the_rows():
    r = parse_budget_document(as_json(doc()), "x.json", source=Source.CONNECTOR)
    assert {t.source for t in r.statement.transactions} == {Source.CONNECTOR}


@pytest.mark.parametrize(
    ("mutate", "expected"),
    [
        (lambda d: d.update(format="cashu-import"), (IssueKind.FILE_FORMAT, None, "format")),
        (lambda d: d.update(format_version=2), (IssueKind.FILE_FORMAT, None, "format_version")),
        (lambda d: d.update(format_version=True), (IssueKind.FILE_FORMAT, None, "format_version")),
        (lambda d: d.pop("account"), (IssueKind.MISSING_VALUE, None, "account")),
        (lambda d: d["account"].pop("currency"), (IssueKind.MISSING_VALUE, None, "account.currency")),
        (lambda d: d.update(extra=1), (IssueKind.UNKNOWN_FIELD, None, "extra")),
        (lambda d: d.update(source="Bad Source"), (IssueKind.INVALID_VALUE, None, "source")),
        (lambda d: d.update(transactions={}), (IssueKind.FILE_FORMAT, None, "transactions")),
        (lambda d: d["account"].update(iban="12"), (IssueKind.INVALID_VALUE, None, "account.iban")),
        (lambda d: d["transactions"][1].pop("amount"), (IssueKind.MISSING_VALUE, 2, "amount")),
        (lambda d: d["transactions"][1].update(amount="1,5"), (IssueKind.INVALID_VALUE, 2, "amount")),
        (lambda d: d["transactions"][1].update(amount=True), (IssueKind.INVALID_VALUE, 2, "amount")),
        (lambda d: d["transactions"][1].update(amount="1e5"), (IssueKind.INVALID_VALUE, 2, "amount")),
        (lambda d: d["transactions"][1].update(amount="1.234"), (IssueKind.INVALID_VALUE, 2, "amount")),
        (lambda d: d["transactions"][1].update(booking_date="04.10.2026"),
         (IssueKind.INVALID_VALUE, 2, "booking_date")),
        (lambda d: d["transactions"][1].update(booking_date="2026-02-30"),
         (IssueKind.INVALID_VALUE, 2, "booking_date")),
        (lambda d: d["transactions"][1].update(currency="ZLOTY"), (IssueKind.INVALID_VALUE, 2, "currency")),
        (lambda d: d["transactions"][1].update(description="x" * 501),
         (IssueKind.INVALID_VALUE, 2, "description")),
        (lambda d: d["transactions"][1].update(reference="x" * 201),
         (IssueKind.INVALID_VALUE, 2, "reference")),
        (lambda d: d["transactions"][1].update(note="x"), (IssueKind.UNKNOWN_FIELD, 2, "note")),
        (lambda d: d["transactions"][1].update(transaction_id="T1"),
         (IssueKind.DUPLICATE_ID, 2, "transaction_id")),
        (lambda d: d["balances"][0].update(date="x"), (IssueKind.INVALID_VALUE, None, "balances[1].date")),
    ],
)
def test_validator_table(mutate, expected):
    d = doc()
    mutate(d)
    r = parse_budget_document(as_json(d), "x.json")
    assert not r.ok and r.statement is None
    assert expected in issues(r), r.issues
    assert all(i.blocking for i in r.blocking)


def test_three_decimal_currencies_allow_three_places():
    d = doc()
    d["transactions"][1].update(amount="1.234", currency="KWD")
    r = parse_budget_document(as_json(d), "x.json")
    assert r.ok
    assert [i.kind for i in r.issues] == [IssueKind.CURRENCY_MISMATCH]  # a warning only


def test_broken_json_is_a_file_format_issue():
    for content in (b"{", b"[1, 2]", b'{"a": 1, "a": 2}', b"\xff\xfe", b'{"x": NaN}'):
        r = parse_budget_document(content, "x.json")
        assert not r.ok and [i.kind for i in r.issues] == [IssueKind.FILE_FORMAT], content


def test_messages_never_carry_values():
    d = doc()
    d["transactions"][1].update(
        amount=SECRET, booking_date=SECRET, currency=SECRET, counterparty_iban=SECRET + "!",
        description=SECRET * 60,
    )
    d["account"]["iban"] = SECRET[:3]
    d[SECRET.lower() + "x"] = 1  # an unknown key is a field name: still never a value
    r = parse_budget_document(as_json(d), "x.json")
    assert len(r.issues) >= 5
    text = json.dumps([i.as_dict() for i in r.issues])
    assert SECRET not in text.replace(SECRET.lower() + "x", "")
    csv_text = (
        "format_version,booking_date,amount,currency,description\n"
        f"1,{SECRET},{SECRET},{SECRET},{SECRET * 60}\n"
    )
    r = parse_budget_document(csv_text.encode(), "x.csv")
    assert r.issues and SECRET not in json.dumps([i.as_dict() for i in r.issues])


# --- CSV variant ---------------------------------------------------------------------------------

CSV_OK = (
    "format_version,booking_date,amount,currency,counterparty_name,reference,transaction_id,"
    "account_iban,account_currency,source\n"
    f"1,2026-10-01,-10.00,PLN,KAWIARNIA TEST,KAWA,C1,{IBAN},PLN,my_conv\n"
    "\n"
    f"1,2026-10-02,25.50,PLN,,ZWROT,C2,{IBAN},PLN,my_conv\n"
)


def test_csv_variant():
    r = parse_budget_document(("﻿" + CSV_OK).encode(), "x.csv")
    assert r.ok and r.variant == "csv" and r.source == "my_conv"
    stmt = r.statement
    assert stmt.account_number == IBAN and stmt.currency == "PLN" and stmt.bank == "my_conv"
    assert [t.amount for t in stmt.transactions] == [Decimal("-10.00"), Decimal("25.50")]
    assert [t.bank_transaction_id for t in stmt.transactions] == ["C1", "C2"]


def test_csv_account_currency_is_inferred_from_one_row_currency():
    content = b"format_version,booking_date,amount,currency\n1,2026-10-01,-1.00,EUR\n"
    r = parse_budget_document(content, "x.csv")
    assert r.ok and r.statement.currency == "EUR"
    mixed = content + b"1,2026-10-02,-1.00,PLN\n"
    r = parse_budget_document(mixed, "x.csv")
    assert (IssueKind.MISSING_COLUMN, None, "account_currency") in issues(r)


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        (b"format_version,booking_date,amount\n1,2026-10-01,1\n",
         (IssueKind.MISSING_COLUMN, None, "currency")),
        (b"format_version,booking_date,amount,currency,descripton\n",
         (IssueKind.UNKNOWN_FIELD, None, "descripton")),
        (b"format_version,booking_date,amount,currency,amount\n",
         (IssueKind.FILE_FORMAT, None, "amount")),
        (b"format_version,booking_date,amount,currency\n2,2026-10-01,1,PLN\n",
         (IssueKind.FILE_FORMAT, 1, "format_version")),
        (b"format_version,booking_date,amount,currency\n1,2026-10-01,1\n",
         (IssueKind.FILE_FORMAT, 1, None)),
        (b"format_version,booking_date,amount,currency,source\n1,2026-10-01,1,PLN,a\n1,2026-10-01,1,PLN,b\n",
         (IssueKind.INCONSISTENT_FILE, 2, "source")),
        (b"format_version,booking_date,amount,currency,account_currency\n1,2026-10-01,1,PLN,PLNX\n",
         (IssueKind.INVALID_VALUE, None, "account_currency")),
        (b"format_version,booking_date,amount,currency\n1,,1,PLN\n",
         (IssueKind.MISSING_VALUE, 1, "booking_date")),
        (b"", (IssueKind.FILE_FORMAT, None, None)),
    ],
)
def test_csv_validator_table(content, expected):
    r = parse_budget_document(content, "x.csv")
    assert not r.ok and expected in issues(r), r.issues


def test_detection():
    assert looks_like_budget_document(as_json(doc()), "statement.json")
    assert looks_like_budget_document(as_json(doc()), "noext")
    assert looks_like_budget_document(CSV_OK.encode(), "x.csv")
    assert not looks_like_budget_document(b'{"format": "cashu-import"}', "x.json")
    assert not looks_like_budget_document(b"#Data operacji;#Kwota\n", "mbank.csv")
    assert not looks_like_budget_document(b"\x00\x01\x02", "x.bin")


def test_validation_report_is_value_free_and_counts():
    report = validate_budget_document(as_json(doc()), "x.json")
    assert report.ok and report.transactions == 2 and report.balances == 1
    out = report.as_dict()
    assert out["date_range"] == {"from": "2026-10-03", "to": "2026-10-04"}
    assert out["currencies"] == ["PLN"] and out["issues"] == [] and out["variant"] == "json"
    bad = doc()
    bad["transactions"][0]["amount"] = "abc"
    report = validate_budget_document(as_json(bad), "x.json")
    assert not report.ok and report.transactions == 2
    assert report.as_dict()["issue_counts"] == {"invalid_value": 1}
    assert "row 1: amount:" in report.summary() and "abc" not in report.summary()


def test_issue_shape():
    issue = BudgetIssue(IssueKind.INVALID_VALUE, "is required", row=3, field="amount")
    assert issue.code == "import.invalid_value"
    assert issue.as_dict() == {
        "kind": "invalid_value", "code": "import.invalid_value", "row": 3, "field": "amount",
        "message": "is required", "blocking": True,
    }


# --- persistence: Source.CONNECTOR, dedup against bank CSV rows ----------------------------------

MBANK_CSV = """mBank S.A.
#Numer rachunku
99 1140 0000 0000 0000 0000 0001
#Waluta
PLN
#Data operacji;#Opis operacji;#Tytuł;#Nadawca/Odbiorca;#Numer konta;#Kwota;#Saldo po operacji
2026-10-01;ZAKUP PRZY UZYCIU KARTY;KAWIARNIA TEST;KAWIARNIA TEST;;-12,50;987,50
2026-10-02;PRZELEW PRZYCHODZACY;ZWROT;JAN TEST;99109000000000000000000003;100,00;1 087,50
"""


def test_connector_rows_round_trip_and_dedup_against_csv_rows(session, tmp_path):
    path = tmp_path / "mbank.csv"
    path.write_text(MBANK_CSV, encoding="cp1250")
    account, batch = service.import_csv(session, path)
    assert batch.num_inserted == 2
    # The same two rows as a connector document: same account (by number, any bank), all duplicates.
    d = {
        "format": "cashu-budget-import",
        "format_version": 1,
        "source": "mbank_api",
        "account": {"iban": "PL99114000000000000000000001", "currency": "PLN"},
        "transactions": [
            {"booking_date": "2026-10-01", "amount": "-12.50", "currency": "PLN",
             "counterparty_name": "KAWIARNIA TEST", "description": "ZAKUP PRZY UZYCIU KARTY",
             "reference": "KAWIARNIA TEST", "transaction_id": "X1"},
            {"booking_date": "2026-10-02", "amount": "100.00", "currency": "PLN",
             "counterparty_name": "JAN TEST", "counterparty_iban": "99109000000000000000000003",
             "description": "PRZELEW PRZYCHODZACY", "reference": "ZWROT"},
            {"booking_date": "2026-10-03", "amount": "-5.00", "currency": "PLN", "reference": "NOWY"},
        ],
        "balances": [{"date": "2026-10-03", "amount": "1082.50"}],
    }
    stmt = parse_budget_document(as_json(d), "x.json", source=Source.CONNECTOR).statement
    acc2, batch2 = service.import_statement(
        session, stmt, account=account, source=Source.CONNECTOR, filename="x.json"
    )
    session.commit()
    assert acc2.id == account.id
    assert (batch2.num_inserted, batch2.num_duplicates) == (1, 2)
    assert batch2.source == Source.CONNECTOR
    new = session.exec(select(Transaction).where(Transaction.import_batch_id == batch2.id)).one()
    session.expire_all()
    assert session.get(Transaction, new.id).source == Source.CONNECTOR  # the enum round-trips
    balances = session.exec(select(Balance).where(Balance.account_id == account.id)).all()
    assert {(b.date, b.source) for b in balances} >= {(date(2026, 10, 3), Source.CONNECTOR)}


def test_closing_balance_wins_over_running_balance(session):
    d = doc()
    d["balances"] = [{"date": "2026-10-04", "amount": "999.00"}]
    stmt = parse_budget_document(as_json(d), "x.json").statement
    acc = get_or_create_account(session, bank="test_api", iban=IBAN)
    service.import_statement(session, stmt, account=acc)
    session.flush()
    rows = session.exec(select(Balance).where(Balance.account_id == acc.id)).all()
    assert [(b.date, b.amount) for b in rows] == [(date(2026, 10, 4), Decimal("999.00"))]


def test_bank_parsers_count_skipped_rows(tmp_path):
    path = tmp_path / "mbank.csv"
    path.write_text(MBANK_CSV + ";;;;;;\nSuma;;;;;;\n2026-10-05;BEZ KWOTY;;;;;\n", encoding="cp1250")
    stmt = parse_file(path)
    assert len(stmt.transactions) == 2 and stmt.skipped_rows == 2  # the blank row does not count


# --- documentation ---------------------------------------------------------------------------------


def _doc_blocks(lang: str) -> list[str]:
    text = (ROOT / "docs" / "budget-import-format.md").read_text(encoding="utf-8")
    return re.findall(rf"```{lang}\n(.*?)```", text, flags=re.DOTALL)


def test_the_documented_full_examples_validate():
    json_blocks = [b for b in _doc_blocks("json") if '"transactions": [\n' in b]
    assert len(json_blocks) == 1
    report = validate_budget_document(json_blocks[0].encode(), "example.json")
    assert report.ok and report.transactions == 4 and report.balances == 1, report.summary()
    assert [i.kind for i in report.issues] == [IssueKind.CURRENCY_MISMATCH, IssueKind.UNKNOWN_INSTITUTION]
    (csv_block,) = _doc_blocks("csv")
    report = validate_budget_document(csv_block.encode(), "example.csv")
    assert report.ok and report.transactions == 3, report.summary()


def test_the_documented_field_lists_match_the_model():
    text = (ROOT / "docs" / "budget-import-format.md").read_text(encoding="utf-8")
    for name in canonical.TRANSACTION_FIELDS + canonical.ACCOUNT_FIELDS + canonical.CSV_COLUMNS:
        assert f"`{name}`" in text, name
