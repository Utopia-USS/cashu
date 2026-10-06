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

from cashu.core.mcp.registry import ToolError
from cashu.core.mcp.tools import exports


def _plain(tree):
    """Labelled tree -> values (labels are checked elsewhere; here we look at what is masked)."""
    from cashu.core.mcp.redaction import Redactor

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
    assert sample[8] == "<w> <w>"  # a name: neither the words nor their lengths


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
    from cashu.core import paths

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
    from cashu.core import paths
    from cashu.core.mcp.tools.investments_proposals import _mapping_text

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

    from cashu.core import paths

    root = tmp_path / unicodedata.normalize("NFC", "Dane-Józefa")
    monkeypatch.setenv("CASHU_DATA_DIR", str(root))
    secret = paths.data_dir() / "imports" / "other" / "x.csv"
    secret.parent.mkdir(parents=True, exist_ok=True)
    secret.write_text("a,b\n1,2\n")
    variant = unicodedata.normalize("NFD", str(secret))
    if not __import__("os").path.exists(variant):
        pytest.skip("the file system distinguishes Unicode normalization forms")
    with pytest.raises(ToolError, match="data dir"):
        exports.checked_path(variant, "x")


# --------------------------------------------------------------------------- #
# F10 11.3.4: free text as token shapes; 11.3.5: a header below a "label: value" preamble
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("text", "shape"),
    [
        ("OPEN BUY CDR.PL 10 @ 120.5", "OPEN BUY <w> 99 @ 999.9"),
        ("CLOSE SELL EUNL.DE 3.0000 @ 98.1200", "CLOSE SELL <w> 9.9999 @ 99.9999"),
        ("DYWIDENDA AAPL.US 0.24 USD/SHR", "DYWIDENDA <w> 9.99 <w>"),
        ("Przelew od JAN KOWALSKI za czynsz 10/2026", "Przelew <w> <w> <w> <w> <w> 99/9999"),
        ("Jan Przelewski", "<w> <w>"),  # a vocabulary-like surname next to a name stays hidden
        ("zwrot PL61109010140000071219812874", "<w> [identifier]"),
        ("PROWIZJA 1.50 PLN", "PROWIZJA 9.99 PLN"),
        # BE-8: no letter counts of an e-mail, a nickname with digits or a vocabulary-like surname
        ("mail jan.kowalski1@gmail.com", "<w> [email]"),
        ("Zakup BLIK Anna2000", "Zakup <w> <w>9999"),
        ("PRZELEWSKI 12", "<w> 99"),
        ("PROWIZJI 2.00", "PROWIZJI 9.99"),
        ("AB12 TX-9", "AA99 AA-9"),
    ],
)
def test_text_is_shown_as_token_shapes(text, shape):
    assert exports.text_shape(text) == shape


def test_a_name_in_a_transfer_title_never_leaks(tmp_path, db_engine):
    path = tmp_path / "wyciag.csv"
    rows = ["Data;Tytul;Kwota"] + [
        f"2026-09-0{i};Przelew od Grzegorz Brzeczyszczykiewicz {i};-1{i},00" for i in range(1, 6)
    ]
    path.write_text("\n".join(rows) + "\n", encoding="utf-8")
    data = _plain(exports.inspect(str(path), slug="x"))
    blob = json.dumps(data)
    assert "Grzegorz" not in blob and "Brzeczyszczykiewicz" not in blob
    # no letter counts of a name either: names are <w>, never AAAA
    assert "AAAAAAAA" not in blob
    assert data["sheets"][0]["samples"][0][1] == "Przelew <w> <w> <w> 9"
    assert "token" in data["masking"] and "<w>" in data["masking"]


def _xlsx(path, sheets: dict[str, list[list]]) -> None:
    import zipfile
    from xml.sax.saxutils import escape

    def cell(ref: str, value) -> str:
        if isinstance(value, (int, float)):
            return f'<c r="{ref}"><v>{value}</v></c>'
        return f'<c r="{ref}" t="inlineStr"><is><t>{escape(str(value))}</t></is></c>'

    with zipfile.ZipFile(path, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        names = list(sheets)
        z.writestr(
            "xl/workbook.xml",
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
            + "".join(
                f'<sheet name="{escape(n)}" sheetId="{i + 1}" r:id="rId{i + 1}"/>'
                for i, n in enumerate(names)
            )
            + "</sheets></workbook>",
        )
        z.writestr(
            "xl/_rels/workbook.xml.rels",
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + "".join(
                f'<Relationship Id="rId{i + 1}" Target="worksheets/sheet{i + 1}.xml"/>'
                for i in range(len(names))
            )
            + "</Relationships>",
        )
        for i, name in enumerate(names):
            body = []
            for r, row in enumerate(sheets[name], start=1):
                cells = "".join(
                    cell(f"{chr(65 + c)}{r}", v) for c, v in enumerate(row) if v not in ("", None)
                )
                body.append(f'<row r="{r}">{cells}</row>')
            z.writestr(
                f"xl/worksheets/sheet{i + 1}.xml",
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                f"<sheetData>{''.join(body)}</sheetData></worksheet>",
            )


def test_header_below_an_account_preamble_in_an_xtb_like_xlsx(tmp_path, db_engine):
    """Several sheets, each with 5-10 "label: value" preamble rows above a short table (2 data rows
    and a totals row): the header is the table's, not the first preamble row."""
    preamble = [
        ["Imie i nazwisko", "Grzegorz Brzeczyszczykiewicz"],
        ["Numer rachunku", "12345678"],
        ["Waluta", "PLN"],
        ["Typ rachunku", "Standard"],
        ["Data od", "2026-01-01"],
        ["Data do", "2026-09-30"],
        [],
    ]
    header = ["Position", "Symbol", "Type", "Volume", "Open time", "Open price", "Market price",
              "Gross P/L"]
    positions = preamble + [
        header,
        [123456781, "CDR.PL", "BUY", 10, "2026-03-02 10:15:00", 120.5, 130.2, 97.0],
        [123456782, "EUNL.DE", "BUY", 3, "2026-04-11 09:00:01", 98.12, 100.0, 5.64],
        ["Total", "", "", "", "", "", "", 102.64],
    ]
    cash = preamble[:5] + [
        [],
        ["ID", "Type", "Time", "Comment", "Symbol", "Amount"],
        [987654321, "Deposit", "2026-02-01 12:00:00", "Przelew od Grzegorz Brzeczyszczykiewicz", "", 5000],
        [987654322, "Stocks/ETF purchase", "2026-03-02 10:15:00", "OPEN BUY 10 @ 120.50", "CDR.PL",
         -1205.0],
        ["Total", "", "", "", "", 3795.0],
    ]
    path = tmp_path / "account_12345678_pl.xlsx"
    _xlsx(path, {"OPEN POSITION 30092026": positions, "CASH OPERATION HISTORY": cash})
    data = _plain(exports.inspect(str(path), slug="x"))
    blob = json.dumps(data)
    assert "Brzeczyszczykiewicz" not in blob and "Grzegorz" not in blob
    pos, ops = data["sheets"]
    assert pos["header_row"] == 8 and pos["preamble_rows"] == 7 and pos["rows"] == 3
    assert [c["header"] for c in pos["columns"]][:3] == ["Position", "Symbol", "Type"]
    assert ops["header_row"] == 7 and ops["preamble_rows"] == 6
    comment = [c["header"] for c in ops["columns"]].index("Comment")
    assert ops["samples"][1][comment] == "OPEN BUY 99 @ 999.99"
    assert ops["samples"][0][comment] == "Przelew <w> <w> <w>"


def test_header_below_a_wide_account_summary(tmp_path, db_engine):
    """BE-10: a one-row horizontal account summary wider than the operations table above it (a
    common broker layout, synthetic): the header is the table's, not the summary's."""
    rows = [
        ["Raport TEST"],
        [],
        ["Name and surname", "Account", "Currency", "Balance", "Equity", "Margin", "Free margin",
         "Margin level"],
        ["Grzegorz Brzeczyszczykiewicz", 12345678, "PLN", 1000.5, 1000.5, 0, 1000.5, 0],
        [],
        ["ID", "Type", "Time", "Comment", "Symbol", "Amount"],
        [987654321, "Deposit", "2026-02-01 12:00:00", "Wplata", "", 5000],
        [987654322, "Stocks/ETF purchase", "2026-03-02 10:15:00", "OPEN BUY 10 @ 120.50", "CDR.PL",
         -1205.0],
        [987654323, "Dividend", "2026-04-02 10:15:00", "DYWIDENDA", "CDR.PL", 12.0],
        ["Total", "", "", "", "", 3807.0],
    ]
    path = tmp_path / "summary_pl.xlsx"
    _xlsx(path, {"CASH OPERATION HISTORY": rows})
    data = _plain(exports.inspect(str(path), slug="x"))
    (sheet,) = data["sheets"]
    assert sheet["header_row"] == 6
    assert [c["header"] for c in sheet["columns"]][:3] == ["ID", "Type", "Time"]
    assert "Brzeczyszczykiewicz" not in json.dumps(data)
