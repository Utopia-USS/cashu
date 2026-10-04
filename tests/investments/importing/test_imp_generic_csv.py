"""Generic CSV importer (port of generic_csv_importer_test, incl. R5 cross-currency cash)."""

from __future__ import annotations

from dataclasses import replace
from datetime import time

from imp_support import (
    SIMPLE_HEADER,
    csv_file,
    d,
    day,
    pl_export_cp1250,
    pl_export_utf8_bom,
    pl_mapping,
    simple_mapping,
)

from finanse.modules.investments.domain import Currency, TxnType
from finanse.modules.investments.importing import (
    AmountSign,
    CsvField,
    CsvMapping,
    DecimalFormat,
    GenericCsvImporter,
    ImportFile,
    ImportTextEncoding,
    RowErrorPolicy,
)


def pl_file(name: str = "pl_broker.csv", cp1250: bool = False) -> ImportFile:
    return ImportFile(name, pl_export_cp1250() if cp1250 else pl_export_utf8_bom())


# --- can_parse ------------------------------------------------------------------------------------


def test_accepts_the_fixture_in_its_own_encoding() -> None:
    assert GenericCsvImporter(pl_mapping()).can_parse(pl_file())
    assert GenericCsvImporter(pl_mapping("windows-1250")).can_parse(pl_file(cp1250=True))
    assert GenericCsvImporter(pl_mapping("auto")).can_parse(pl_file(cp1250=True))


def test_does_not_claim_other_headers_encodings_extensions_or_binary() -> None:
    importer = GenericCsvImporter(pl_mapping())
    assert not importer.can_parse(csv_file("Date;Type;Amount\n2026-01-05;buy;1\n"))
    assert not importer.can_parse(csv_file(""))
    assert not importer.can_parse(pl_file(cp1250=True)), "Polish header letters garble as UTF-8"
    assert not importer.can_parse(ImportFile("export.xlsx", pl_export_utf8_bom()))
    binary = bytes((i * 37) % 256 for i in range(512))
    assert not importer.can_parse(ImportFile("x.csv", binary))


def test_large_utf8_file_is_sniffed_as_utf8_by_auto_even_when_64k_cuts_a_character() -> None:
    mapping = CsvMapping(
        encoding=ImportTextEncoding.AUTO,
        delimiter=";",
        default_currency=Currency.PLN,
        columns={
            CsvField.TRADE_DATE: "Data",
            CsvField.TYPE: "Typ",
            CsvField.CASH_AMOUNT: "Kwota",
            CsvField.NOTE: "Opłata",
        },
    )

    def build(pad: str) -> bytes:
        lines = ["Data;Typ;Kwota;Opłata"]
        lines += [f"2026-01-05;deposit;1;{pad if i == 0 else ''}{'ż' * 20}" for i in range(2000)]
        return ("\n".join(lines) + "\n").encode()

    data = build("")
    if data[64 * 1024] & 0xC0 != 0x80:
        data = build("x")
    assert data[64 * 1024] & 0xC0 == 0x80
    assert GenericCsvImporter(mapping).can_parse(ImportFile("big.csv", data))


def test_header_names_match_trimmed_and_case_insensitively() -> None:
    importer = GenericCsvImporter(simple_mapping())
    assert importer.can_parse(
        csv_file(" REF ,Date,TYPE,symbol,isin,exchange,qty,price,ccy,fee,cash,extra\n")
    )
    assert not importer.can_parse(
        csv_file("ref,date,type,symbol,isin,exchange,qty,price,ccy,fee\n")
    )


# --- parse ----------------------------------------------------------------------------------------


def test_utf8_bom_fixture_decimal_comma_thousands_types_signs_derived_amounts() -> None:
    result = GenericCsvImporter(pl_mapping()).parse(pl_file())
    assert not result.has_blocking_warnings
    assert len(result.txns) == 7
    (warning,) = result.warnings
    assert warning.message == 'Type "Blokada środków" is ignored by the mapping'
    assert warning.row == 7

    deposit = result.txns[0]
    assert deposit.type == TxnType.DEPOSIT
    assert deposit.trade_date == day("2026-01-05")
    assert deposit.cash_amount == d("10000")
    assert deposit.gross_amount == d("10000")
    assert deposit.note == "Wpłata własna"

    buy = result.txns[1]
    assert buy.type == TxnType.BUY
    assert (buy.symbol, buy.isin, buy.name) == ("ZGJ", "PLZGJ0000010", "Zażółć Gęślą Jaźń SA")
    assert buy.exchange_hint == "GPW"
    assert (buy.quantity, buy.price, buy.gross_amount) == (d("10"), d("62.5"), d("625"))
    assert (buy.fee, buy.cash_amount) == (d("3.13"), d("-628.13"))
    assert buy.currency == buy.cash_currency == Currency.PLN
    assert buy.raw_row["Giełda"] == "GPW"
    assert result.txns[2].row_index == 2
    assert replace(result.txns[2], row_index=1) == buy, "two identical rows are both parsed"

    etf = result.txns[3]
    assert (etf.price, etf.cash_amount) == (d("1234.5"), d("-3708.5"))
    sell = result.txns[4]
    assert sell.type == TxnType.SELL and sell.cash_amount == d("348.25")
    assert sell.note == "Częściowa sprzedaż"
    dividend = result.txns[5]
    assert dividend.quantity is None
    assert dividend.gross_amount == d("12.15"), "derived from the cash amount"
    assert dividend.note == "DYWIDENDA ŹRÓDŁO ŁÓDŹ ĄĆĘŃÓŚŻ"
    fee = result.txns[6]
    assert (fee.type, fee.cash_amount, fee.gross_amount) == (TxnType.FEE, d("-9.99"), d("9.99"))


def test_windows_1250_fixture_parses_to_the_same_transactions() -> None:
    utf8 = GenericCsvImporter(pl_mapping()).parse(pl_file())
    cp1250 = GenericCsvImporter(pl_mapping("windows-1250")).parse(pl_file(cp1250=True))
    assert cp1250.warnings == utf8.warnings
    assert cp1250.txns == utf8.txns
    assert cp1250.txns[1].name == "Zażółć Gęślą Jaźń SA"


def test_windows_1250_file_read_as_utf8_is_one_blocking_error() -> None:
    mapping = CsvMapping(
        default_currency=Currency.PLN,
        delimiter=";",
        columns={CsvField.TRADE_DATE: "Data", CsvField.TYPE: "Typ", CsvField.CASH_AMOUNT: "Kwota"},
    )
    result = GenericCsvImporter(mapping).parse(pl_file(cp1250=True))
    assert result.txns == ()
    (warning,) = result.warnings
    assert warning.blocking and "not valid UTF-8" in warning.message


def test_missing_columns_and_missing_header_are_blocking() -> None:
    result = GenericCsvImporter(simple_mapping()).parse(
        csv_file("ref,date,type\n1,2026-01-05,buy\n")
    )
    assert result.has_blocking_warnings
    assert result.warnings[0].message.startswith('Missing columns: "symbol"')
    empty = GenericCsvImporter(simple_mapping()).parse(csv_file(""))
    assert empty.warnings[0].message == "File has no header row at record 0"


def test_amount_sign_absolute_derives_the_direction_from_the_type() -> None:
    mapping = CsvMapping(
        amount_sign=AmountSign.ABSOLUTE,
        default_currency=Currency.PLN,
        columns={
            CsvField.TRADE_DATE: "date",
            CsvField.TYPE: "type",
            CsvField.CASH_AMOUNT: "amount",
            CsvField.TAX: "tax",
        },
    )
    result = GenericCsvImporter(mapping).parse(
        csv_file(
            "date,type,amount,tax\n2026-01-05,deposit,100,\n2026-01-06,withdrawal,40,\n"
            "2026-01-07,dividend,85,15\n"
        )
    )
    assert [t.cash_amount for t in result.txns] == [d("100"), d("-40"), d("85")]
    assert result.txns[2].gross_amount == d("100"), "net 85 + tax 15"
    fx = GenericCsvImporter(mapping).parse(
        csv_file("date,type,amount,tax\n2026-01-05,fx_conversion,100,\n")
    )
    assert fx.warnings[0].blocking
    assert "signed amounts" in fx.warnings[0].message


def test_cash_derived_from_gross_fee_and_tax_when_the_file_has_none() -> None:
    mapping = CsvMapping(
        default_currency=Currency.USD,
        columns={
            CsvField.TRADE_DATE: "date",
            CsvField.TYPE: "type",
            CsvField.QUANTITY: "qty",
            CsvField.PRICE: "price",
            CsvField.FEE: "fee",
            CsvField.SPLIT_RATIO: "ratio",
        },
    )
    result = GenericCsvImporter(mapping).parse(
        csv_file(
            "date,type,qty,price,fee,ratio\n2026-01-05,buy,-2,10,1,\n2026-01-06,sell,2,12,1,\n"
            "2026-01-07,split,,,,4\n"
        )
    )
    assert not result.has_blocking_warnings
    assert result.txns[0].quantity == d("2"), "quantities are absolute"
    assert result.txns[0].cash_amount == d("-21")
    assert result.txns[1].cash_amount == d("23")
    assert (result.txns[2].cash_amount, result.txns[2].gross_amount) == (d("0"), d("0"))
    assert result.txns[2].split_ratio == d("4")
    assert result.txns[0].currency == Currency.USD


def test_cash_derived_across_currencies_uses_fx_rate_else_blocking_r5() -> None:
    mapping = CsvMapping(
        columns={
            CsvField.EXTERNAL_REF: "ref",
            CsvField.TRADE_DATE: "date",
            CsvField.TYPE: "type",
            CsvField.SYMBOL: "symbol",
            CsvField.QUANTITY: "qty",
            CsvField.PRICE: "price",
            CsvField.CURRENCY: "ccy",
            CsvField.FEE: "fee",
            CsvField.CASH_AMOUNT: "cash",
            CsvField.CASH_CURRENCY: "cash_ccy",
            CsvField.FX_RATE: "fx",
            CsvField.GROSS_AMOUNT: "gross",
        },
    )
    result = GenericCsvImporter(mapping).parse(
        csv_file(
            "ref,date,type,symbol,qty,price,ccy,fee,cash,cash_ccy,fx,gross\n"
            "a,2026-01-05,buy,AAPL,10,100,USD,1,,PLN,4.0,\n"  # -(1000 + 1) USD x 4.0 = -4004 PLN
            "b,2026-01-06,sell,AAPL,5,110,USD,0,,PLN,4.1,\n"  # 550 USD x 4.1 = 2255 PLN
            "c,2026-01-07,dividend,AAPL,,,USD,0,40,PLN,4.0,\n"  # gross from cash: 40 / 4.0 = 10 USD
            "d,2026-01-08,buy,AAPL,1,100,USD,0,,USD,,\n"  # same currency: no rate needed
            "e,2026-01-09,buy,AAPL,10,100,USD,0,,PLN,,\n"  # no rate: never guess
            "f,2026-01-10,dividend,AAPL,,,USD,0,40,PLN,,\n"  # no rate, no gross: never guess
        )
    )
    assert [t.external_ref for t in result.txns] == ["a", "b", "c", "d"]
    assert [(t.cash_amount, t.cash_currency) for t in result.txns] == [
        (d("-4004"), Currency.PLN),
        (d("2255"), Currency.PLN),
        (d("40"), Currency.PLN),
        (d("-100"), Currency.USD),
    ]
    assert [t.gross_amount for t in result.txns] == [d("1000"), d("550"), d("10"), d("100")]
    assert result.txns[0].fx_rate == d("4.0")
    by_row = {w.row: w for w in result.warnings}
    assert by_row[4].blocking
    assert "cash_currency PLN differs from currency USD: fx_rate" in by_row[4].message
    assert by_row[5].blocking
    assert (
        "gross_amount is empty and cash_currency PLN differs from currency USD" in by_row[5].message
    )


ERROR_ROWS = (
    f"{SIMPLE_HEADER}\n"
    "a,2026-01-05,buy,PKN,,GPW,1,10,PLN,0,-10\n"
    "b,2026-01-06,teleport,PKN,,GPW,1,10,PLN,0,-10\n"
    "c,05.01.2026,buy,PKN,,GPW,1,10,PLN,0,-10\n"
    "d,2026-01-07,buy,PKN,,GPW,1,ten,PLN,0,-10\n"
    "e,2026-01-07,buy,PKN,,GPW,1,10,ZL,0,-10\n"
    ",,,,,,,,,,\n"
    "f,,,PKN,,,,,,,\n"
)


def test_row_errors_block_by_default() -> None:
    result = GenericCsvImporter(simple_mapping()).parse(csv_file(ERROR_ROWS))
    assert [t.external_ref for t in result.txns] == ["a"]
    by_row = {w.row: w for w in result.warnings}
    assert 'unknown type "teleport"' in by_row[1].message
    assert 'trade_date: "05.01.2026"' in by_row[2].message
    assert 'price: "ten" is not a number' in by_row[3].message
    assert 'currency: "ZL"' in by_row[4].message
    assert all(by_row[i].blocking for i in (1, 2, 3, 4))
    assert 5 not in by_row, "empty records are skipped silently"
    assert not by_row[6].blocking, "a row without date and type is skipped"


def test_row_errors_are_skipped_with_on_row_error_skip() -> None:
    mapping = replace(simple_mapping(), on_row_error=RowErrorPolicy.SKIP)
    result = GenericCsvImporter(mapping).parse(csv_file(ERROR_ROWS))
    assert not result.has_blocking_warnings
    assert sum(1 for w in result.warnings if w.message.endswith("row skipped")) == 4


def test_quoted_fields_header_offset_wire_types_and_invalid_isins() -> None:
    mapping = CsvMapping(
        header_row=1,
        number_format=DecimalFormat(".", ","),
        columns={
            CsvField.TRADE_DATE: "date",
            CsvField.TYPE: "type",
            CsvField.NAME: "name",
            CsvField.ISIN: "isin",
            CsvField.CURRENCY: "ccy",
            CsvField.CASH_AMOUNT: "cash",
        },
    )
    result = GenericCsvImporter(mapping).parse(
        csv_file(
            "Account statement 2026\n"
            "date,type,name,isin,ccy,cash\n"
            '2026-01-05,Interest,"Savings, ""plus""",pl123,EUR,"1,234.5"\n'
        )
    )
    (txn,) = result.txns
    assert txn.type == TxnType.INTEREST, "type wire names work without a types map"
    assert txn.name == 'Savings, "plus"'
    assert txn.isin is None
    assert result.warnings[0].message == 'Ignored invalid ISIN "PL123"'
    assert txn.cash_amount == d("1234.5")


def test_time_of_day_from_the_date_cell_r9() -> None:
    result = GenericCsvImporter(simple_mapping()).parse(
        csv_file(f"{SIMPLE_HEADER}\nr1,2026-09-02 10:00,buy,PKN,,GPW,10,60,PLN,0,-600\n")
    )
    assert result.txns[0].trade_time == time(10, 0)
    assert result.txns[0].trade_date == day("2026-09-02")


def test_importer_identity() -> None:
    importer = GenericCsvImporter(simple_mapping(broker_id="mbank"))
    assert (importer.broker_id, importer.display_name, importer.version) == (
        "mbank",
        "Generic CSV",
        1,
    )


def test_warning_kinds_of_row_errors() -> None:
    from finanse.modules.investments.importing import ImportWarningKind

    result = GenericCsvImporter(simple_mapping()).parse(csv_file(ERROR_ROWS))
    by_row = {w.row: w.kind for w in result.warnings}
    assert by_row[1] == ImportWarningKind.UNMAPPED_TYPE
    assert by_row[2] == ImportWarningKind.INVALID_VALUE
    assert by_row[6] == ImportWarningKind.IGNORED_ROW
    missing = GenericCsvImporter(simple_mapping()).parse(csv_file("ref,date\n"))
    assert missing.warnings[0].kind == ImportWarningKind.MISSING_COLUMN
    skipping = GenericCsvImporter(replace(simple_mapping(), on_row_error=RowErrorPolicy.SKIP))
    assert {w.kind for w in skipping.parse(csv_file(ERROR_ROWS)).warnings} == {
        ImportWarningKind.IGNORED_ROW
    }
    fx = GenericCsvImporter(
        CsvMapping(
            columns={
                CsvField.TRADE_DATE: "date",
                CsvField.TYPE: "type",
                CsvField.QUANTITY: "qty",
                CsvField.PRICE: "price",
                CsvField.CURRENCY: "ccy",
                CsvField.CASH_CURRENCY: "cash_ccy",
            }
        )
    ).parse(csv_file("date,type,qty,price,ccy,cash_ccy\n2026-01-05,buy,1,1,USD,PLN\n"))
    assert fx.warnings[0].kind == ImportWarningKind.FX_MISSING
