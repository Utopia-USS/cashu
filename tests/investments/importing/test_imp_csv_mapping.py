"""CSV mapping YAML loading and validation (port of csv_mapping_test)."""

from __future__ import annotations

import pytest
from imp_support import pl_mapping

from finanse.modules.investments.domain import Currency, TxnType
from finanse.modules.investments.importing import (
    AmountSign,
    CsvField,
    CsvMapping,
    CsvMappingError,
    DecimalFormat,
    ImportTextEncoding,
    RowErrorPolicy,
    example_mapping_yaml,
)
from finanse.modules.investments.importing.csv_mapping import KNOWN_KEYS, CsvMappingIssue

MINIMAL = """\
version: 1
default_currency: PLN
columns:
  trade_date: Date
  type: Type
  cash_amount: Amount
"""


def issues(yaml_text: str) -> tuple[CsvMappingIssue, ...]:
    with pytest.raises(CsvMappingError) as error:
        CsvMapping.from_yaml(yaml_text)
    return error.value.issues


def test_parses_every_key_of_the_fixture_mapping() -> None:
    mapping = pl_mapping()
    assert mapping.broker_id == "generic_csv"
    assert mapping.display_name == "Synthetic PL broker"
    assert mapping.encoding == ImportTextEncoding.UTF8
    assert mapping.delimiter == ";"
    assert mapping.number_format == DecimalFormat(",", " ")
    assert mapping.date_formats == ("dd.MM.yyyy",)
    assert mapping.default_currency == Currency.PLN
    assert mapping.amount_sign == AmountSign.SIGNED
    assert mapping.columns[CsvField.EXCHANGE] == "Giełda"
    assert mapping.columns[CsvField.QUANTITY] == "Ilość"
    assert len(mapping.columns) == 12
    assert mapping.types["Sprzedaż"] == TxnType.SELL
    assert mapping.types["Wpłata"] == TxnType.DEPOSIT
    assert mapping.ignored_types == frozenset({"Blokada środków"})
    assert pl_mapping("windows-1250").encoding == ImportTextEncoding.WINDOWS_1250


def test_defaults_of_a_minimal_mapping() -> None:
    mapping = CsvMapping.from_yaml(MINIMAL)
    assert mapping.broker_id == "generic_csv"
    assert mapping.display_name == "Generic CSV"
    assert mapping.encoding == ImportTextEncoding.UTF8
    assert mapping.delimiter == ","
    assert mapping.quote == '"'
    assert mapping.number_format == DecimalFormat()
    assert mapping.date_formats == ("yyyy-MM-dd",)
    assert mapping.header_row == 0
    assert mapping.amount_sign == AmountSign.SIGNED
    assert mapping.on_row_error == RowErrorPolicy.BLOCK
    assert mapping.extensions == ("csv", "txt", "tsv")
    assert mapping.types == {}


def test_tab_delimiter_keywords_and_scalar_text() -> None:
    mapping = CsvMapping.from_yaml(
        """\
version: 1
broker_id: mbank
delimiter: tab
thousands_separator: space
decimal_separator: ","
date_formats: dd-MM-yyyy
header_row: 2
amount_sign: absolute
on_row_error: skip
extensions: [CSV, .txt]
columns:
  trade_date: Date
  type: Type
  currency: 2024
  gross_amount: Value
types:
  NO: buy
"""
    )
    assert mapping.broker_id == "mbank"
    assert mapping.delimiter == "\t"
    assert mapping.number_format.thousands_separator == " "
    assert mapping.date_formats == ("dd-MM-yyyy",)
    assert mapping.header_row == 2
    assert mapping.amount_sign == AmountSign.ABSOLUTE
    assert mapping.on_row_error == RowErrorPolicy.SKIP
    assert mapping.extensions == ("csv", "txt")
    assert mapping.columns[CsvField.CURRENCY] == "2024", "numeric YAML header text stays text"
    assert mapping.types == {"NO": TxnType.BUY}, "no YAML 1.1 boolean coercion of keys"


def test_the_shipped_example_documents_a_valid_mapping_with_every_key_and_field() -> None:
    text = example_mapping_yaml()
    mapping = CsvMapping.from_yaml(text)
    assert set(mapping.columns) == set(CsvField), "the example shows every field"
    assert mapping.ignored_types
    assert {TxnType.BUY, TxnType.SELL, TxnType.FX_CONVERSION} <= set(mapping.types.values())
    for key in KNOWN_KEYS:
        assert f"\n{key}:" in text, f"the example documents {key}"
    assert chr(0x2014) not in text, "the em dash character is not used"


def test_unknown_keys_fields_and_types_have_suggestions_and_positions() -> None:
    found = issues(
        """\
version: 1
decimal_seperator: ","
default_currency: PLN
columns:
  trade_dat: Date
  type: Type
  cash_amount: Amount
types:
  Kupno: bye
"""
    )
    by_path = {issue.path: issue for issue in found}
    assert {"decimal_seperator", "columns.trade_dat", "types.Kupno"} <= set(by_path)
    typo = by_path["decimal_seperator"]
    assert 'did you mean "decimal_separator"' in typo.message
    assert (typo.line, typo.column) == (2, 1)
    assert '"trade_date"' in by_path["columns.trade_dat"].message
    assert (by_path["columns.trade_dat"].line, by_path["columns.trade_dat"].column) == (5, 3)
    assert '"buy"' in by_path["types.Kupno"].message
    assert "Missing required field trade_date" in [i.message for i in found]
    assert "line 2:1: decimal_seperator: Unknown key" in str(typo)


def test_validates_required_content_and_value_domains() -> None:
    found = issues(
        """\
version: 2
broker_id: My Broker
encoding: latin2
delimiter: ";;"
decimal_separator: ","
thousands_separator: ","
date_formats: [MM.yyyy]
header_row: -1
default_currency: zloty
amount_sign: reversed
columns:
  symbol: Ticker
"""
    )
    paths = {issue.path for issue in found}
    assert {
        "version",
        "broker_id",
        "encoding",
        "delimiter",
        "thousands_separator",
        "date_formats[0]",
        "header_row",
        "default_currency",
        "amount_sign",
        "columns",
    } <= paths
    column_messages = {issue.message for issue in found if issue.path == "columns"}
    assert {
        "Missing required field trade_date",
        "Missing required field type",
        "Map cash_amount, gross_amount, or quantity and price",
        "Map a currency column or set default_currency",
    } <= column_messages


def test_duplicates_and_value_shapes_are_errors() -> None:
    found = issues(
        """\
version: 1
version: 1
default_currency: PLN
quote: "''"
columns:
  trade_date: Date
  trade_date: Other
  type: [a, b]
  cash_amount: ""
types:
  Kupno: buy
  kupno: sell
"""
    )
    messages = {(issue.path, issue.message) for issue in found}
    assert ("version", "Duplicate key") in messages
    assert ("quote", "Must be exactly one character") in messages
    assert ("columns.trade_date", "Duplicate field") in messages
    assert ("columns.type", "Must be a single value") in messages
    assert ("columns.cash_amount", "Header text must not be empty") in messages
    assert ("types.kupno", "Duplicate broker type") in messages


def test_yaml_syntax_errors_and_non_map_documents() -> None:
    syntax = issues("version: 1\ncolumns: [unclosed")
    assert len(syntax) == 1 and syntax[0].line is not None
    assert issues("- just\n- a list")[0].message == "The mapping must be a YAML map"
    assert issues("")[0].message == "The mapping must be a YAML map"
    with pytest.raises(CsvMappingError, match="columns"):
        CsvMapping.from_yaml("version: 1")


def test_oversized_mapping_is_rejected() -> None:
    assert "too large" in issues("#" * 300_000)[0].message
