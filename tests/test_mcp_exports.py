"""``inspect_export``: structure without values (CSV with a preamble, XLSX, JSON) and the path rules
(hidden directories, the data dir, extensions, size)."""

from __future__ import annotations

import json

import pytest
from mcp_support import (
    AMOUNTS,
    IBAN_P2P,
    PROFILE_NAME,
    amount_renderings,
    write_export_csv,
    write_export_xlsx,
)

from finanse.core.mcp.registry import ToolError
from finanse.core.mcp.tools import exports


def _plain(tree):
    """Labelled tree -> values (labels are checked elsewhere; here we look at what is masked)."""
    from finanse.core.mcp.redaction import Redactor

    return Redactor("amounts").apply(tree)


def _no_values(data) -> None:
    blob = json.dumps(data, ensure_ascii=False)
    assert IBAN_P2P not in blob and IBAN_P2P[-10:] not in blob
    assert "Kowalczyk" not in blob and "KOWALCZYK" not in blob and "WISNIEWSKA" not in blob
    for value in AMOUNTS:
        for r in amount_renderings(value):
            assert r not in blob, r
    for raw in ("41,37", "187,13", "52,11", "137", "03.01.2024"):
        assert f'"{raw}"' not in blob


def test_csv_with_preamble(tmp_path, db_engine):
    data = _plain(exports.inspect(str(write_export_csv(tmp_path)), max_samples=10, slug="x"))
    _no_values(data)
    sheet = data["sheets"][0]
    assert data["file"]["delimiter"] == ";" and data["file"]["encoding"] == "utf-8"
    assert sheet["header_row"] == 4 and sheet["preamble_rows"] == 3 and sheet["rows"] == 6
    cols = {c["header"]: c for c in sheet["columns"]}
    assert cols["Data"]["type"] == "date" and cols["Data"]["format"] == "DD.MM.YYYY"
    assert cols["Kwota"]["type"] == "decimal" and cols["Kwota"]["negatives"] is True
    assert "decimal separator ','" in cols["Kwota"]["format"]
    assert "thousands separator ' '" in cols["Kwota"]["format"]
    assert cols["Rachunek"]["type"] == "identifier" and cols["Rachunek"]["values"] == []
    assert cols["Wlasciciel"]["values"] == []  # name-ish header: never enumerated
    assert sorted(cols["Typ"]["values"]) == ["Kupno", "Sprzedaz", "Wplata"]
    assert sorted(cols["ISIN"]["values"]) == ["PLPKO0000016", "US0378331005"]
    sample = sheet["samples"][1]
    assert sample[0] == "DD.MM.YYYY" and sample[6] == "-N NNN,NN" and sample[7] == "[identifier]"
    assert sample[8].startswith("<text")


def test_xlsx(tmp_path, db_engine):
    data = _plain(exports.inspect(str(write_export_xlsx(tmp_path)), slug="x"))
    _no_values(data)
    sheet = data["sheets"][0]
    cols = {c["header"]: c for c in sheet["columns"]}
    assert cols["Date"]["type"] == "date"
    assert cols["Amount"]["type"] == "decimal" and cols["Amount"]["negatives"] is True
    assert cols["Account"]["type"] == "identifier"
    assert PROFILE_NAME not in json.dumps(data)


def test_json(tmp_path, db_engine):
    path = tmp_path / "export.json"
    path.write_text(
        json.dumps(
            {
                "account": IBAN_P2P,
                "owner": PROFILE_NAME,
                "operations": [
                    {"date": "2024-01-03", "type": "DEPOSIT", "amount": "76543.21"},
                    {"date": "2024-01-10", "type": "BUY", "amount": "-5667.69"},
                    {"date": "2024-01-11", "type": "BUY", "amount": "-12.00"},
                    {"date": "2024-01-12", "type": "DEPOSIT", "amount": "100.00"},
                ],
            }
        )
    )
    data = _plain(exports.inspect(str(path), slug="x"))
    _no_values(data)
    assert {x["key"] for x in data["structure"]} == {"account", "owner"}
    cols = {c["header"]: c for c in data["sheets"][0]["columns"]}
    assert cols["date"]["format"] == "YYYY-MM-DD" and cols["amount"]["type"] == "decimal"
    assert sorted(cols["type"]["values"]) == ["BUY", "DEPOSIT"]


def test_path_rules(tmp_path, db_engine):
    from finanse.core import paths

    hidden = tmp_path / ".secret"
    hidden.mkdir()
    (hidden / "a.csv").write_text("a,b\n1,2\n")
    with pytest.raises(ToolError, match="hidden"):
        exports.checked_path(str(hidden / "a.csv"), "x")
    (tmp_path / "key.pem").write_text("x")
    with pytest.raises(ToolError, match="unsupported"):
        exports.checked_path(str(tmp_path / "key.pem"), "x")
    with pytest.raises(ToolError, match="not found"):
        exports.checked_path(str(tmp_path / "missing.csv"), "x")
    inside = paths.data_dir() / "backups" / "dump.csv"
    inside.parent.mkdir(parents=True, exist_ok=True)
    inside.write_text("a\n")
    with pytest.raises(ToolError, match="data dir"):
        exports.checked_path(str(inside), "x")
    own = paths.data_dir() / "profiles" / "x" / "extensions" / "out.csv"
    own.parent.mkdir(parents=True, exist_ok=True)
    own.write_text("a\n")
    assert exports.checked_path(str(own), "x") == own.resolve()
    with pytest.raises(ToolError, match="data dir"):
        exports.checked_path(str(own), "other")
    link = tmp_path / "link.csv"
    link.symlink_to(inside)
    with pytest.raises(ToolError, match="data dir"):
        exports.checked_path(str(link), "x")
    big = tmp_path / "big.csv"
    big.write_bytes(b"a" * (exports.MAX_BYTES + 1))
    with pytest.raises(ToolError, match="too large"):
        exports.checked_path(str(big), "x")


def test_bad_xlsx_and_json_are_tool_errors(tmp_path, db_engine):
    bad = tmp_path / "bad.xlsx"
    bad.write_bytes(b"not a zip")
    with pytest.raises(ToolError):
        exports.inspect(str(bad), slug="x")
    broken = tmp_path / "bad.json"
    broken.write_text("{nope")
    with pytest.raises(ToolError):
        exports.inspect(str(broken), slug="x")


def test_headerless_file_never_shows_data_as_headers(tmp_path, db_engine):
    path = tmp_path / "raw.csv"
    path.write_text(
        "Jan Kowalski;Przelew;100,00;Konto glowne\n"
        "Anna Nowak;Przelew;200,00;Konto glowne\n"
        "Jan Kowalski;Zakup;12,00;Konto glowne\n"
        "Anna Nowak;Zakup;13,00;Konto glowne\n"
    )
    data = _plain(exports.inspect(str(path), slug="x"))
    blob = json.dumps(data, ensure_ascii=False)
    assert "Kowalski" not in blob and "Nowak" not in blob
    assert "Konto glowne" not in blob  # a constant text column is never enumerated


def test_case_variants_hidden_files_and_mapping_location(tmp_path, db_engine):
    from finanse.core import paths
    from finanse.core.mcp.tools.investments_proposals import _mapping_text

    secret = paths.data_dir() / "imports" / "other" / "x.csv"
    secret.parent.mkdir(parents=True, exist_ok=True)
    secret.write_text("a,b\n1,2\n")
    variant = str(secret).replace("/data/", "/DATA/").replace("/imports/", "/IMPORTS/")
    with pytest.raises(ToolError):
        exports.checked_path(variant, "x")
    hidden = tmp_path / ".export.csv"
    hidden.write_text("a,b\n1,2\n")
    with pytest.raises(ToolError, match="hidden"):
        exports.checked_path(str(hidden), "x")
    outside = tmp_path / "mapping.yaml"
    outside.write_text("version: 1\n")
    with pytest.raises(ToolError, match="profile"):
        _mapping_text(str(outside), "x")
    own = paths.data_dir() / "profiles" / "x" / "extensions" / "mapping.yaml"
    own.parent.mkdir(parents=True, exist_ok=True)
    own.write_text("version: 1\n")
    assert _mapping_text(str(own), "x") == "version: 1\n"
    assert _mapping_text("delimiter: ';'\n", "x") == "delimiter: ';'\n"


def test_single_word_names_and_headerless_rows_are_masked(tmp_path, db_engine):
    named = tmp_path / "kto.csv"
    named.write_text(
        "Data;Kto;Typ;Kwota\n"
        + "".join(
            f"2026-01-0{i};{who};{kind};1{i}0,00\n"
            for i, (who, kind) in enumerate(
                [("Anna", "Kupno"), ("Marek", "Sprzedaz"), ("Anna", "Kupno"), ("Marek", "Kupno")],
                start=1,
            )
        )
    )
    data = _plain(exports.inspect(str(named), slug="x"))
    cols = {c["header"]: c for c in data["sheets"][0]["columns"]}
    assert cols["Kto"]["values"] == [] and cols["Typ"]["values"] == ["Kupno", "Sprzedaz"]
    assert "Anna" not in json.dumps(data) and "Marek" not in json.dumps(data)
    headerless = tmp_path / "raw.csv"
    headerless.write_text("2026-01-01;Kowalski;KUPNO;950\n2026-01-02;Nowak;KUPNO;951\n")
    raw = _plain(exports.inspect(str(headerless), slug="x"))
    sheet = raw["sheets"][0]
    assert sheet["header_row"] is None and sheet["rows"] == 2
    assert [c["header"] for c in sheet["columns"]] == [f"column {i}" for i in range(1, 5)]
    blob = json.dumps(raw)
    assert "Kowalski" not in blob and "Nowak" not in blob and "950" not in blob


def test_unicode_variant_of_the_data_dir_is_refused(tmp_path, monkeypatch):
    import unicodedata

    from finanse.core import paths

    root = tmp_path / unicodedata.normalize("NFC", "Dane-Józefa")
    monkeypatch.setenv("FINANSE_DATA_DIR", str(root))
    secret = paths.data_dir() / "imports" / "other" / "x.csv"
    secret.parent.mkdir(parents=True, exist_ok=True)
    secret.write_text("a,b\n1,2\n")
    variant = unicodedata.normalize("NFD", str(secret))
    if not __import__("os").path.exists(variant):
        pytest.skip("the file system distinguishes Unicode normalization forms")
    with pytest.raises(ToolError, match="data dir"):
        exports.checked_path(variant, "x")
