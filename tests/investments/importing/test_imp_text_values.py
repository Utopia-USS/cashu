"""Text decoding and cell value parsing (port of text_decoding_test / csv_values_test)."""

from __future__ import annotations

from datetime import time

import pytest
from imp_support import d, day, pl_export_cp1250, pl_export_utf8_bom

from finanse.modules.investments.importing.csv_values import (
    DatePattern,
    DecimalFormat,
    parse_date_with_patterns,
    parse_datetime_with_patterns,
)
from finanse.modules.investments.importing.text import (
    ImportTextEncoding,
    decode_import_text,
    has_utf8_bom,
    parse_encoding,
)

POLISH = "ĄĆĘŁŃÓŚŹŻąćęłńóśźż"


def test_windows_1250_decodes_every_polish_letter() -> None:
    expected = {
        0xA5: "Ą",
        0xC6: "Ć",
        0xCA: "Ę",
        0xA3: "Ł",
        0xD1: "Ń",
        0xD3: "Ó",
        0x8C: "Ś",
        0x8F: "Ź",
        0xAF: "Ż",
        0xB9: "ą",
        0xE6: "ć",
        0xEA: "ę",
        0xB3: "ł",
        0xF1: "ń",
        0xF3: "ó",
        0x9C: "ś",
        0x9F: "ź",
        0xBF: "ż",
    }
    for byte, letter in expected.items():
        assert decode_import_text(bytes([byte]), ImportTextEncoding.WINDOWS_1250) == letter


def test_windows_1250_round_trip_and_undefined_bytes() -> None:
    text = f"Zażółć gęślą jaźń {POLISH} ascii 123"
    assert decode_import_text(text.encode("cp1250"), ImportTextEncoding.WINDOWS_1250) == text
    assert decode_import_text(bytes([0x81, 0x41]), ImportTextEncoding.WINDOWS_1250) == "�A"


def test_utf8_bom_is_stripped() -> None:
    assert has_utf8_bom(b"\xef\xbb\xbfabc")
    assert decode_import_text(b"\xef\xbb\xbfabc", ImportTextEncoding.UTF8) == "abc"
    assert decode_import_text("﻿abc".encode(), ImportTextEncoding.UTF8) == "abc"


def test_malformed_utf8_raises_unless_lenient() -> None:
    bad = b"ab\xff"
    with pytest.raises(UnicodeDecodeError):
        decode_import_text(bad, ImportTextEncoding.UTF8)
    assert decode_import_text(bad, ImportTextEncoding.UTF8, lenient=True) == "ab�"


def test_auto_picks_utf8_or_windows_1250() -> None:
    assert decode_import_text("łódź".encode(), ImportTextEncoding.AUTO) == "łódź"
    assert decode_import_text("łódź".encode("cp1250"), ImportTextEncoding.AUTO) == "łódź"


def test_both_fixture_encodings_decode_to_the_same_text() -> None:
    utf8 = decode_import_text(pl_export_utf8_bom(), ImportTextEncoding.UTF8)
    cp1250 = decode_import_text(pl_export_cp1250(), ImportTextEncoding.WINDOWS_1250)
    assert utf8.replace("\r\n", "\n") == cp1250


def test_encoding_names() -> None:
    assert parse_encoding("UTF-8") == ImportTextEncoding.UTF8
    assert parse_encoding("utf8") == ImportTextEncoding.UTF8
    assert parse_encoding("cp1250") == ImportTextEncoding.WINDOWS_1250
    assert parse_encoding(" Windows-1250 ") == ImportTextEncoding.WINDOWS_1250
    assert parse_encoding("auto") == ImportTextEncoding.AUTO
    assert parse_encoding("latin2") is None


def test_decimal_comma_with_space_thousands_including_no_break_spaces() -> None:
    fmt = DecimalFormat(",", " ")
    assert fmt.parse("1 234,56") == d("1234.56")
    assert fmt.parse("1 234,56") == d("1234.56")
    assert fmt.parse("1 234,56") == d("1234.56")
    assert fmt.parse("  ") is None
    assert fmt.parse("12,") == d("12")


def test_decimal_separators_variants() -> None:
    assert DecimalFormat(",", ".").parse("1.234,56") == d("1234.56")
    assert DecimalFormat(".", ",").parse("-1,234.56") == d("-1234.56")
    assert DecimalFormat().parse(".5") == d("0.5")


def test_decimal_signs() -> None:
    fmt = DecimalFormat(",")
    assert fmt.parse("−12,50") == d("-12.5")
    assert fmt.parse("12,50-") == d("-12.5")
    assert fmt.parse("(12,50)") == d("-12.5")
    assert fmt.parse("+3") == d("3")


@pytest.mark.parametrize("raw", ["abc", "1.234,56", "1e5", "NaN", "Infinity", "12 34", "1,2,3"])
def test_decimal_rejects_non_numbers(raw: str) -> None:
    with pytest.raises(ValueError):
        DecimalFormat(",").parse(raw)


def test_decimal_format_validates_separators() -> None:
    with pytest.raises(ValueError):
        DecimalFormat(";")
    with pytest.raises(ValueError):
        DecimalFormat(",", ",")


def test_date_patterns() -> None:
    assert DatePattern("dd.MM.yyyy").try_parse("05.01.2026") == day("2026-01-05")
    assert DatePattern("yyyy-MM-dd").try_parse("2026-01-05") == day("2026-01-05")
    assert DatePattern("d/M/yyyy").try_parse("5/1/2026") == day("2026-01-05")
    assert DatePattern("yyyy-MM-dd").try_parse("2026-01-05 10:22") == day("2026-01-05")
    assert DatePattern("yyyy-MM-dd HH:mm:ss").try_parse("2026-01-05 10:22:01") == day("2026-01-05")


def test_time_of_day_is_kept_as_sort_key_r9() -> None:
    pattern = DatePattern("yyyy-MM-dd")
    assert pattern.try_parse_datetime("2026-09-02 15:00") == (day("2026-09-02"), time(15, 0))
    assert pattern.try_parse_datetime("2026-09-02T09:05:07") == (day("2026-09-02"), time(9, 5, 7))
    assert pattern.try_parse_datetime("2026-09-02") == (day("2026-09-02"), None)
    assert pattern.try_parse_datetime("2026-09-02 25:00") == (day("2026-09-02"), None)
    timed = DatePattern("dd.MM.yyyy HH:mm")
    assert timed.try_parse_datetime("02.09.2026 08:30") == (day("2026-09-02"), time(8, 30))


def test_non_matching_and_impossible_dates() -> None:
    assert DatePattern("yyyy-MM-dd").try_parse("05.01.2026") is None
    assert DatePattern("yyyy-MM-dd").try_parse("2026-02-30") is None
    assert DatePattern("yyyy-MM-dd").try_parse("2026-1-5") is None


def test_a_pattern_needs_year_month_and_day() -> None:
    with pytest.raises(ValueError):
        DatePattern("MM.yyyy")


def test_patterns_are_tried_in_order() -> None:
    patterns = [DatePattern("dd.MM.yyyy"), DatePattern("yyyy-MM-dd")]
    assert parse_date_with_patterns("2026-01-05", patterns) == day("2026-01-05")
    assert parse_date_with_patterns(" ", patterns) is None
    assert parse_datetime_with_patterns("05.01.2026 07:00", patterns) == (
        day("2026-01-05"),
        time(7, 0),
    )
    with pytest.raises(ValueError, match="dd.MM.yyyy / yyyy-MM-dd"):
        parse_date_with_patterns("Jan 5", patterns)
