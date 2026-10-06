"""The canonical cashu-import format: CSV and JSON variants, strict validation, spec examples."""

from __future__ import annotations

import re
from dataclasses import replace
from datetime import time
from pathlib import Path

import pytest
from imp_support import d, day

from cashu.modules.investments.domain import Currency, TxnType
from cashu.modules.investments.importing import (
    CanonicalImporter,
    ImportFile,
    ImportParseResult,
    ImportWarningKind,
    ParsedDelisting,
    ParsedRename,
    parse_canonical_csv,
    parse_canonical_json,
)
from cashu.modules.investments.importing.canonical import CSV_COLUMNS, RECORD_FIELDS

SPEC = Path(__file__).resolve().parents[3] / "docs" / "import-format.md"
HEADER = "format_version,record,date,time,type,external_ref,symbol,isin,exchange,quantity,price,currency,gross_amount,fee,tax,cash_amount,cash_currency,fx_rate,split_ratio,note"


def code_blocks(language: str) -> list[str]:
    text = SPEC.read_text(encoding="utf-8")
    return re.findall(rf"```{language}\n(.*?)```", text, flags=re.DOTALL)


def csv_rows(*rows: str, header: str = HEADER) -> ImportParseResult:
    return parse_canonical_csv(("\n".join([header, *rows]) + "\n").encode())


def txn_row(**fields: str) -> str:
    """One CSV row for :data:`HEADER` (unset columns empty, format_version 1, record txn)."""
    values = {"format_version": "1", "record": "txn", **fields}
    return ",".join(values.get(column, "") for column in HEADER.split(","))


def json_doc(*records: str, top: str = "") -> ImportParseResult:
    body = ",\n".join(records)
    extra = f"{top}," if top else ""
    text = f'{{"format": "cashu-import", "format_version": 1, {extra} "records": [{body}]}}'
    return parse_canonical_json(text.encode())


def errors(result: ImportParseResult) -> dict[str, str]:
    """Blocking messages keyed by their leading field name (or the whole message)."""
    found: dict[str, str] = {}
    for warning in result.warnings:
        if warning.blocking:
            key = warning.message.split(":", 1)[0]
            found.setdefault(key, warning.message)
    return found


# --- the spec ---------------------------------------------------------------------------------


def test_every_csv_example_in_the_spec_validates() -> None:
    blocks = [b for b in code_blocks("csv") if b.startswith("format_version")]
    assert len(blocks) >= 2
    for block in blocks:
        result = parse_canonical_csv(block.encode())
        assert result.warnings == (), block[:80]


def test_every_json_example_in_the_spec_validates() -> None:
    blocks = [b for b in code_blocks("json") if '"records": [\n' in b]
    assert blocks
    for block in blocks:
        result = parse_canonical_json(block.encode())
        assert result.warnings == ()


def test_spec_csv_and_json_examples_carry_the_same_data() -> None:
    csv_result = parse_canonical_csv(
        next(b for b in code_blocks("csv") if "position" in b).encode()
    )
    json_result = parse_canonical_json(
        next(b for b in code_blocks("json") if '"records": [\n' in b).encode()
    )

    def strip(result: ImportParseResult):
        return [replace(t, raw_row={}) for t in result.txns]

    assert strip(csv_result) == strip(json_result)
    assert csv_result.positions == json_result.positions
    assert csv_result.corporate_actions == json_result.corporate_actions
    assert (csv_result.source, csv_result.account_hint) == ("examplebroker", "Account 12-3456")
    assert (json_result.source, json_result.account_hint) == ("examplebroker", "Account 12-3456")
    assert len(csv_result.txns) == 11 and len(csv_result.positions) == 3


def test_spec_documents_every_column() -> None:
    text = SPEC.read_text(encoding="utf-8")
    for column in CSV_COLUMNS:
        assert f"`{column}`" in text, column
    for kind in TxnType:
        assert f"`{kind.value}`" in text, kind
    assert chr(0x2014) not in text, "the em dash character is not used"


def test_spec_example_values() -> None:
    result = parse_canonical_csv(next(b for b in code_blocks("csv") if "position" in b).encode())
    derived = next(t for t in result.txns if t.external_ref == "T-1004")
    assert (derived.cash_amount, derived.cash_currency, derived.gross_amount) == (
        d("-4004"),
        Currency.PLN,
        d("1000"),
    )
    assert derived.trade_time == time(16, 0)
    split = next(t for t in result.txns if t.type == TxnType.SPLIT)
    assert split.split_ratio == d("4") and split.cash_amount == 0
    rename, delisting = result.corporate_actions
    assert isinstance(rename, ParsedRename) and isinstance(delisting, ParsedDelisting)
    assert (rename.old_symbol, rename.new_symbol, rename.new_isin) == (
        "ABC",
        "ABCN",
        "PLABCN000012",
    )
    assert rename.date == day("2026-02-15") and rename.row_index == 11
    assert delisting.frozen and delisting.symbol == "ZZZ"
    assert {p.as_of for p in result.positions} == {day("2026-02-28")}


# --- detection --------------------------------------------------------------------------------


def test_can_parse() -> None:
    importer = CanonicalImporter()
    assert importer.can_parse(ImportFile("x.csv", f"{HEADER}\n".encode()))
    assert importer.can_parse(ImportFile("x.CSV", ("﻿" + HEADER + "\n").encode()))
    assert importer.can_parse(ImportFile("x.txt", b"record,format_version,date\n"))
    assert not importer.can_parse(ImportFile("x.csv", b"date,type,amount\n"))
    assert not importer.can_parse(ImportFile("x.csv", b""))
    assert importer.can_parse(ImportFile("x.json", b' {"format": "cashu-import"}'))
    assert not importer.can_parse(ImportFile("x.json", b'{"format": "other"}'))
    assert not importer.can_parse(ImportFile("x.xlsx", f"{HEADER}\n".encode()))
    assert (importer.broker_id, importer.version) == ("cashu", 1)


def test_parse_dispatches_by_extension() -> None:
    importer = CanonicalImporter()
    csv_result = importer.parse(ImportFile("x.csv", f"{HEADER}\n".encode()))
    assert csv_result.warnings == ()
    json_result = importer.parse(
        ImportFile("x.json", b'{"format": "cashu-import", "format_version": 1, "records": []}')
    )
    assert json_result.warnings == ()


# --- CSV structure ------------------------------------------------------------------------------


def test_header_problems_are_blocking_file_errors() -> None:
    result = csv_rows(header="format_version,record,date,qty,date")
    by_message = {w.message: w for w in result.warnings}
    unknown = next(m for m in by_message if m.startswith('Unknown column "qty"'))
    assert by_message[unknown].kind == ImportWarningKind.UNKNOWN_FIELD
    assert 'Duplicate column "date"' in by_message
    missing = csv_rows(header="record,date")
    assert missing.warnings[0].message == 'Missing required column "format_version"'
    assert missing.warnings[0].kind == ImportWarningKind.MISSING_COLUMN
    typo = csv_rows(header="format_version,record,date,quantiy")
    assert 'did you mean "quantity"' in typo.warnings[0].message


def test_empty_invalid_utf8_and_broken_quotes() -> None:
    assert parse_canonical_csv(b"").warnings[0].message.startswith("File is empty")
    bad = parse_canonical_csv(b"format_version,record,date\n1,txn,\xff\n")
    assert "not valid UTF-8" in bad.warnings[0].message
    assert bad.warnings[0].kind == ImportWarningKind.FILE_FORMAT
    quotes = parse_canonical_csv(b'format_version,record,date\n1,"txn"x,2026-01-01\n')
    assert "not valid CSV" in quotes.warnings[0].message


def test_bom_and_crlf_are_accepted() -> None:
    text = "\r\n".join(
        [HEADER, txn_row(date="2026-01-05", type="deposit", currency="PLN", cash_amount="5")]
    )
    result = parse_canonical_csv(("﻿" + text + "\r\n").encode())
    assert result.warnings == ()
    assert result.txns[0].cash_amount == d("5")


def test_format_version_and_cell_count_per_row() -> None:
    good = txn_row(date="2026-01-05", type="deposit", currency="PLN", cash_amount="5")
    result = csv_rows(good.replace("1,", "2,", 1), good + ",extra", "", good)
    by_row = {w.row: w for w in result.warnings}
    assert by_row[0].message == 'format_version: must be 1 (got "2")'
    assert "cells but the header has" in by_row[1].message
    assert 2 not in by_row, "blank lines are skipped (but counted)"
    assert [t.row_index for t in result.txns] == [3]


# --- record validation -----------------------------------------------------------------------


def test_minimal_rows_of_every_type() -> None:
    result = csv_rows(
        txn_row(date="2026-01-02", type="deposit", currency="PLN", cash_amount="1000"),
        txn_row(
            date="2026-01-03",
            type="buy",
            symbol="ABC",
            quantity="2",
            price="10",
            currency="PLN",
            fee="1",
        ),
        txn_row(
            date="2026-01-04", type="sell", symbol="ABC", quantity="1", price="12", currency="PLN"
        ),
        txn_row(
            date="2026-01-05",
            type="dividend",
            symbol="ABC",
            currency="PLN",
            gross_amount="3",
            tax="0.57",
        ),
        txn_row(date="2026-01-06", type="interest", currency="PLN", cash_amount="0.12"),
        txn_row(date="2026-01-07", type="withdrawal", currency="PLN", cash_amount="-100"),
        txn_row(date="2026-01-08", type="fee", currency="PLN", cash_amount="-5"),
        txn_row(date="2026-01-09", type="tax", currency="PLN", cash_amount="-2"),
        txn_row(date="2026-01-10", type="fx_conversion", currency="USD", cash_amount="25"),
        txn_row(date="2026-01-11", type="split", symbol="ABC", currency="PLN", split_ratio="2"),
        txn_row(date="2026-01-12", type="transfer_in", symbol="XYZ", quantity="3", currency="PLN"),
        txn_row(date="2026-01-13", type="transfer_out", symbol="XYZ", quantity="1", currency="PLN"),
        txn_row(
            date="2026-01-14",
            type="adjustment",
            symbol="XYZ",
            quantity="1",
            price="9",
            currency="PLN",
        ),
    )
    assert result.warnings == ()
    cash = [t.cash_amount for t in result.txns]
    assert cash == [
        d("1000"),
        d("-21"),
        d("12"),
        d("2.43"),
        d("0.12"),
        d("-100"),
        d("-5"),
        d("-2"),
        d("25"),
        d("0"),
        d("0"),
        d("0"),
        d("0"),
    ]
    assert result.txns[1].gross_amount == d("20")
    assert result.txns[13 - 1].gross_amount == d("9")


def test_value_formats_are_strict() -> None:
    result = csv_rows(
        txn_row(date="05.01.2026", type="deposit", currency="PLN", cash_amount="5"),
        txn_row(date="2026-02-30", type="deposit", currency="PLN", cash_amount="5"),
        txn_row(date="2026-01-05", time="9:5", type="deposit", currency="PLN", cash_amount="5"),
        txn_row(date="2026-01-05", time="24:00", type="deposit", currency="PLN", cash_amount="5"),
        txn_row(date="2026-01-05", type="deposit", currency="PLN", cash_amount='"1,5"'),
        txn_row(date="2026-01-05", type="deposit", currency="PLN", cash_amount="1e3"),
        txn_row(date="2026-01-05", type="deposit", currency="pln", cash_amount="5"),
        txn_row(
            date="2026-01-05",
            type="buy",
            symbol="A",
            isin="pl123",
            quantity="1",
            price="1",
            currency="PLN",
        ),
        txn_row(
            date="2026-01-05", type="buy", symbol="A", quantity="-1", price="1", currency="PLN"
        ),
        txn_row(date="2026-01-05", type="Buy", symbol="A", quantity="1", price="1", currency="PLN"),
        txn_row(
            date="2026-01-05",
            type="buy",
            symbol="A",
            quantity="1",
            price="1",
            currency="PLN",
            fx_rate="0",
        ),
    )
    assert result.txns == ()
    by_row = {w.row: w for w in result.warnings}
    assert "is not a date in YYYY-MM-DD format" in by_row[0].message
    assert "not a real calendar date" in by_row[1].message
    assert "HH:MM or HH:MM:SS" in by_row[2].message
    assert "not a valid time of day" in by_row[3].message
    assert '"1,5" is not a decimal number' in by_row[4].message
    assert "is not a decimal number" in by_row[5].message
    assert "upper-case ISO 4217" in by_row[6].message
    assert "is not an ISIN" in by_row[7].message
    assert "must not be negative" in by_row[8].message
    assert '"Buy" is not a transaction type (did you mean "buy"?)' in by_row[9].message
    assert by_row[9].kind == ImportWarningKind.UNMAPPED_TYPE
    assert by_row[10].message == "fx_rate: must be greater than 0"
    assert all(w.blocking for w in result.warnings)
    assert by_row[0].kind == ImportWarningKind.INVALID_VALUE


def test_required_values_and_type_rules() -> None:
    result = csv_rows(
        txn_row(type="deposit", currency="PLN", cash_amount="5"),
        txn_row(date="2026-01-05", currency="PLN", cash_amount="5"),
        txn_row(date="2026-01-05", type="buy", quantity="1", price="1", currency="PLN"),
        txn_row(date="2026-01-05", type="buy", symbol="A", price="1", currency="PLN"),
        txn_row(date="2026-01-05", type="buy", symbol="A", quantity="0", price="1", currency="PLN"),
        txn_row(date="2026-01-05", type="deposit", symbol="A", currency="PLN", cash_amount="5"),
        txn_row(date="2026-01-05", type="fee", quantity="1", currency="PLN", cash_amount="-5"),
        txn_row(date="2026-01-05", type="split", symbol="A", currency="PLN"),
        txn_row(
            date="2026-01-05",
            type="buy",
            symbol="A",
            quantity="1",
            price="1",
            currency="PLN",
            split_ratio="2",
        ),
        txn_row(date="2026-01-05", type="fx_conversion", currency="PLN"),
        txn_row(
            date="2026-01-05",
            type="fx_conversion",
            currency="PLN",
            cash_amount="5",
            cash_currency="USD",
        ),
        txn_row(date="2026-01-05", type="deposit", cash_amount="5"),
    )
    by_row = {w.row: w for w in result.warnings}
    assert by_row[0].message == "date: is required (YYYY-MM-DD)"
    assert by_row[0].kind == ImportWarningKind.MISSING_VALUE
    assert by_row[1].message == "type: is required"
    assert by_row[2].kind == ImportWarningKind.MISSING_INSTRUMENT
    assert by_row[3].message == "quantity: is required for buy"
    assert by_row[3].kind == ImportWarningKind.MISSING_QUANTITY
    assert by_row[4].message == "quantity: must be greater than 0"
    assert by_row[5].message == "symbol: must be empty for deposit"
    assert by_row[6].message == "quantity: must be empty for fee"
    assert by_row[7].kind == ImportWarningKind.UNKNOWN_SPLIT_RATIO
    assert by_row[8].message == "split_ratio: only allowed for split"
    assert "is required for fx_conversion" in by_row[9].message
    assert "each fx_conversion leg is booked in its own currency" in by_row[10].message
    assert by_row[11].message.startswith("currency: is required")
    assert result.txns == ()


def test_all_problems_of_a_row_are_reported() -> None:
    result = csv_rows(txn_row(date="bad", type="buy", quantity="x", currency="usd"))
    messages = [w.message for w in result.warnings]
    assert any(m.startswith("date:") for m in messages)
    assert any(m.startswith("quantity:") for m in messages)
    assert any(m.startswith("currency:") for m in messages)
    assert {w.row for w in result.warnings} == {0}


def test_cash_sign_rules() -> None:
    result = csv_rows(
        txn_row(
            date="2026-01-05",
            type="buy",
            symbol="A",
            quantity="1",
            price="1",
            currency="PLN",
            cash_amount="1",
        ),
        txn_row(
            date="2026-01-05",
            type="sell",
            symbol="A",
            quantity="1",
            price="1",
            currency="PLN",
            cash_amount="-1",
        ),
        txn_row(date="2026-01-05", type="deposit", currency="PLN", cash_amount="-1"),
        txn_row(date="2026-01-05", type="withdrawal", currency="PLN", cash_amount="1"),
        txn_row(date="2026-01-05", type="tax", currency="PLN", cash_amount="3"),
        txn_row(date="2026-01-05", type="dividend", symbol="A", currency="PLN", cash_amount="-3"),
        txn_row(
            date="2026-01-05",
            type="transfer_in",
            symbol="A",
            quantity="1",
            currency="PLN",
            cash_amount="-2",
        ),
    )
    by_row: dict[int, list] = {}
    for warning in result.warnings:
        by_row.setdefault(warning.row, []).append(warning)
    for row in (0, 1, 2, 3):
        assert by_row[row][0].blocking and by_row[row][0].kind == ImportWarningKind.CASH_SIGN
    for row in (4, 5, 6):
        assert not by_row[row][0].blocking and by_row[row][0].kind == ImportWarningKind.CASH_SIGN
    assert [t.row_index for t in result.txns] == [4, 5, 6]
    assert result.txns[0].gross_amount == d("3"), "a tax refund: gross from the cash amount"


def test_cross_currency_without_fx_rate_is_blocking_r5() -> None:
    result = csv_rows(
        txn_row(
            date="2026-01-05",
            type="buy",
            symbol="A",
            quantity="10",
            price="100",
            currency="USD",
            fee="1",
            cash_currency="PLN",
        ),
        txn_row(
            date="2026-01-05",
            type="buy",
            symbol="A",
            quantity="10",
            price="100",
            currency="USD",
            fee="1",
            cash_currency="PLN",
            fx_rate="4.0",
        ),
        txn_row(
            date="2026-01-05",
            type="dividend",
            symbol="A",
            currency="USD",
            cash_amount="40",
            cash_currency="PLN",
        ),
    )
    by_row = {w.row: w for w in result.warnings}
    assert by_row[0].blocking and by_row[0].kind == ImportWarningKind.FX_MISSING
    assert "fx_rate" in by_row[0].message
    assert by_row[2].kind == ImportWarningKind.FX_MISSING
    (txn,) = result.txns
    assert (txn.cash_amount, txn.cash_currency, txn.fx_rate) == (d("-4004"), Currency.PLN, d("4.0"))


def test_inconsistent_amounts_are_a_warning() -> None:
    result = csv_rows(
        txn_row(
            date="2026-01-05",
            type="buy",
            symbol="A",
            quantity="1",
            price="100",
            currency="PLN",
            gross_amount="100",
            fee="1",
            cash_amount="-100",
        ),
        txn_row(
            date="2026-01-05",
            type="buy",
            symbol="A",
            quantity="1",
            price="100",
            currency="PLN",
            gross_amount="100",
            fee="1",
            cash_amount="-101.005",
        ),
    )
    (warning,) = result.warnings
    assert warning.row == 0 and not warning.blocking
    assert warning.kind == ImportWarningKind.AMOUNT_MISMATCH
    assert "expected -101" in warning.message
    assert len(result.txns) == 2


def test_fields_must_belong_to_the_record_kind() -> None:
    header = ",".join(CSV_COLUMNS)

    def row(**fields: str) -> str:
        values = {"format_version": "1", **fields}
        return ",".join(values.get(column, "") for column in CSV_COLUMNS)

    result = csv_rows(
        row(
            record="position",
            date="2026-01-31",
            symbol="A",
            quantity="1",
            currency="PLN",
            price="5",
        ),
        row(record="rename", date="2026-01-31", symbol="A", new_symbol="B", quantity="1"),
        row(
            record="txn",
            date="2026-01-31",
            type="deposit",
            currency="PLN",
            cash_amount="1",
            frozen="true",
        ),
        row(record="trade", date="2026-01-31"),
        row(date="2026-01-31"),
        header=header,
    )
    by_row = {w.row: w for w in result.warnings}
    assert by_row[0].message == "price: not allowed in a position record"
    assert by_row[0].kind == ImportWarningKind.UNKNOWN_FIELD
    assert by_row[1].message == "quantity: not allowed in a rename record"
    assert by_row[2].message == "frozen: not allowed in a txn record"
    assert '"trade" is not a record kind' in by_row[3].message
    assert by_row[4].message.startswith("record: is required")
    assert result.txns == () and result.positions == () and result.corporate_actions == ()


def test_positions_and_corporate_actions() -> None:
    header = ",".join(CSV_COLUMNS)

    def row(**fields: str) -> str:
        values = {"format_version": "1", **fields}
        return ",".join(values.get(column, "") for column in CSV_COLUMNS)

    result = csv_rows(
        row(
            record="position",
            date="2026-01-31",
            symbol="A",
            quantity="1",
            currency="PLN",
            avg_price="5",
            market_value="6",
        ),
        row(record="position", date="2026-01-30", symbol="A", quantity="2", currency="PLN"),
        row(record="position", date="2026-01-31", quantity="2", currency="PLN"),
        row(record="rename", date="2026-02-01", symbol="A", new_symbol="A"),
        row(
            record="rename",
            date="2026-02-01",
            symbol="A",
            new_symbol="A",
            new_exchange="XNAS",
            exchange="XWAR",
        ),
        row(record="delisting", date="2026-02-02", symbol="Z", frozen="TRUE"),
        row(record="delisting", date="2026-02-02", symbol="Y"),
        row(record="delisting", date="2026-02-02", symbol="X", frozen="yes"),
        row(record="delisting", date="2026-02-02"),
        header=header,
    )
    by_row = {w.row: w for w in result.warnings if w.row is not None}
    assert by_row[2].kind == ImportWarningKind.MISSING_INSTRUMENT
    assert by_row[3].message.startswith("new_symbol: a rename must change")
    assert '"yes" is not true or false' in by_row[7].message
    assert by_row[8].message == "symbol: is required"
    file_level = [w for w in result.warnings if w.row is None]
    assert any("2 different dates" in w.message for w in file_level)
    assert all(w.kind == ImportWarningKind.POSITION_SNAPSHOT for w in file_level)
    assert len(result.positions) == 2
    assert result.positions[0].avg_price == d("5") and result.positions[0].market_value == d("6")
    rename, frozen, plain = result.corporate_actions
    assert isinstance(rename, ParsedRename) and rename.new_exchange_hint == "XNAS"
    assert frozen.frozen and not plain.frozen


def test_duplicate_positions_warn() -> None:
    header = ",".join(CSV_COLUMNS)
    row = "1,position,2026-01-31" + "," * (len(CSV_COLUMNS) - 3)
    cells = row.split(",")
    cells[CSV_COLUMNS.index("isin")] = "PLAAA0000011"
    cells[CSV_COLUMNS.index("quantity")] = "1"
    cells[CSV_COLUMNS.index("currency")] = "PLN"
    line = ",".join(cells)
    result = csv_rows(line, line, header=header)
    assert [w.message for w in result.warnings] == [
        "2 position records for PLAAA0000011 on 2026-01-31; they are added up"
    ]


def test_source_and_account_hint() -> None:
    header = HEADER + ",source,account_hint"
    base = txn_row(date="2026-01-05", type="deposit", currency="PLN", cash_amount="5")
    result = csv_rows(
        base + ",mybroker,ACC 1", base + ",,", base + ",mybroker,ACC 2", header=header
    )
    assert result.source == "mybroker" and result.account_hint == "ACC 1"
    (warning,) = result.warnings
    assert warning.row == 2 and warning.kind == ImportWarningKind.INCONSISTENT_FILE
    bad = csv_rows(base + ",My Broker,", header=header)
    assert "source:" in bad.warnings[0].message and bad.source is None


# --- JSON ----------------------------------------------------------------------------------------


def test_json_numbers_are_exact_and_strings_work_too() -> None:
    result = json_doc(
        '{"record": "txn", "date": "2026-01-05", "type": "buy", "symbol": "A", "quantity": 0.1,'
        ' "price": "0.2", "currency": "PLN", "fee": 0}',
        '{"record": "delisting", "date": "2026-01-06", "symbol": "A", "frozen": true}',
        '{"record": "txn", "date": "2026-01-07", "type": "deposit", "currency": "PLN",'
        ' "cash_amount": 1E+2, "note": null}',
    )
    assert result.warnings == ()
    buy, deposit = result.txns
    assert buy.quantity == d("0.1") and buy.gross_amount == d("0.02")
    assert deposit.cash_amount == d("100")
    assert result.corporate_actions[0].frozen


def test_json_document_structure_errors() -> None:
    assert parse_canonical_json(b"[]").warnings[0].message == "The JSON document must be an object"
    assert "not valid JSON" in parse_canonical_json(b"{").warnings[0].message
    dup = parse_canonical_json(b'{"format": "cashu-import", "format": "x"}')
    assert "duplicate key" in dup.warnings[0].message
    nan = parse_canonical_json(b'{"format": "cashu-import", "format_version": NaN}')
    assert "not valid JSON" in nan.warnings[0].message
    result = parse_canonical_json(b'{"format": "other", "format_version": "1", "record": []}')
    messages = [w.message for w in result.warnings]
    assert 'format: must be "cashu-import"' in messages
    assert "format_version: must be the number 1" in messages
    assert "records: must be an array of record objects" in messages
    assert any(m.startswith('Unknown key "record" (did you mean "records"?)') for m in messages)
    assert all(w.kind for w in result.warnings)
    boolean = parse_canonical_json(
        b'{"format": "cashu-import", "format_version": true, "records": []}'
    )
    assert boolean.warnings[0].message == "format_version: must be the number 1"


def test_json_record_errors() -> None:
    result = json_doc(
        '"not an object"',
        '{"record": "txn", "date": "2026-01-05", "type": "deposit", "currency": "PLN",'
        ' "cash_amount": 1, "source": "x"}',
        '{"record": "txn", "date": "2026-01-05", "type": "deposit", "currency": "PLN",'
        ' "cash_amount": [1]}',
        '{"record": "txn", "date": "2026-01-05", "type": "buy", "symbol": 123, "quantity": 1,'
        ' "price": 1, "currency": "PLN"}',
        '{"record": "txn", "date": "2026-01-05", "type": "buy", "symbol": "A", "quantity": true,'
        ' "price": 1, "currency": "PLN", "qty": 1}',
    )
    by_row: dict[int, list[str]] = {}
    for warning in result.warnings:
        by_row.setdefault(warning.row, []).append(warning.message)
    assert by_row[0] == ["Record must be a JSON object"]
    assert by_row[1] == ["source: belongs at the top level of the document"]
    assert by_row[2] == ["cash_amount: must be a single value"]
    assert by_row[3] == ["symbol: must be text (in JSON a quoted string)"]
    assert any(m.startswith("qty: unknown field") for m in by_row[4])
    assert any(m.startswith('quantity: "true" is not a decimal number') for m in by_row[4])
    assert result.txns == ()


def test_json_top_level_source_and_account_hint() -> None:
    result = json_doc(top='"source": "examplebroker", "account_hint": " A-1 "')
    assert (result.source, result.account_hint) == ("examplebroker", "A-1")
    bad = json_doc(top='"source": 5')
    assert bad.warnings[0].message == "source: must be a string"


def test_record_fields_cover_every_parsed_txn_field() -> None:
    covered = {
        "row_index",
        "raw_row",
        "trade_date",
        "trade_time",
        "exchange_hint",
    }
    from dataclasses import fields

    from cashu.modules.investments.importing import ParsedTxn

    mapping = {"trade_date": "date", "trade_time": "time", "exchange_hint": "exchange"}
    for field_ in fields(ParsedTxn):
        if field_.name in ("row_index", "raw_row"):
            continue
        name = mapping.get(field_.name, field_.name)
        assert name in RECORD_FIELDS, field_.name
    assert covered


@pytest.mark.parametrize("variant", ["csv", "json"])
def test_raw_row_is_kept(variant: str) -> None:
    if variant == "csv":
        result = csv_rows(
            txn_row(date="2026-01-05", type="deposit", currency="PLN", cash_amount="5")
        )
        assert result.txns[0].raw_row["cash_amount"] == "5"
        assert result.txns[0].raw_row["format_version"] == "1"
    else:
        result = json_doc(
            '{"record": "txn", "date": "2026-01-05", "type": "deposit", "currency": "PLN",'
            ' "cash_amount": 5.50}'
        )
        assert result.txns[0].raw_row["cash_amount"] == "5.50"
