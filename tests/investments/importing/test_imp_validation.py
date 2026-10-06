"""validate_import_file / validate_import: file checks without a database."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from imp_support import SIMPLE_HEADER, pl_export_utf8_bom, pl_mapping_yaml, simple_mapping

from cashu.modules.investments.importing import (
    CsvMappingError,
    ImportFile,
    ImportParseResult,
    ImportWarningKind,
    validate_import,
    validate_import_file,
)
from cashu.modules.investments.importing import validation as validation_module

SPEC = Path(__file__).resolve().parents[3] / "docs" / "import-format.md"


def spec_block(language: str, needle: str) -> str:
    blocks = re.findall(rf"```{language}\n(.*?)```", SPEC.read_text(encoding="utf-8"), re.DOTALL)
    return next(block for block in blocks if needle in block)


def test_valid_canonical_csv_and_json(tmp_path: Path) -> None:
    csv_path = tmp_path / "converted.csv"
    csv_path.write_text(spec_block("csv", "position"), encoding="utf-8")
    report = validate_import_file(csv_path)
    assert report.ok
    assert (report.txn_count, report.position_count, report.corporate_action_count) == (11, 3, 2)
    assert report.importer_id == "cashu"
    summary = report.summary()
    assert summary.startswith("converted.csv: OK (cashu)")
    assert "transactions: 11, positions: 3, corporate actions: 2" in summary

    json_path = tmp_path / "converted.json"
    json_path.write_text(spec_block("json", '"records": [\n'), encoding="utf-8")
    assert validate_import_file(str(json_path)).ok


def test_invalid_canonical_file_lists_every_problem(tmp_path: Path) -> None:
    path = tmp_path / "broken.csv"
    path.write_text(
        "format_version,record,date,type,currency,cash_amount,quantity\n"
        "1,txn,2026-01-05,deposit,PLN,-5,\n"
        "1,txn,2026-13-01,buy,PLN,,1\n"
        "1,txn,2026-01-06,tax,PLN,3,\n",
        encoding="utf-8",
    )
    report = validate_import_file(path)
    assert not report.ok
    assert {issue.row for issue in report.errors} == {0, 1}
    assert [w.kind for w in report.warnings] == [ImportWarningKind.CASH_SIGN]
    text = report.summary()
    assert "INVALID" in text
    assert "error   row 0: cash_amount: -5 must be >= 0 for deposit" in text
    assert "warning row 2: cash_amount: 3 is positive for tax" in text


def test_unrecognized_file(tmp_path: Path) -> None:
    path = tmp_path / "export.csv"
    path.write_text("Date;Type;Amount\n", encoding="utf-8")
    report = validate_import_file(path)
    assert not report.ok and report.importer_id is None
    (error,) = report.errors
    assert error.kind == ImportWarningKind.IMPORTER_ERROR
    assert "docs/import-format.md" in error.message


def test_generic_csv_with_a_mapping_file(tmp_path: Path) -> None:
    data = tmp_path / "pl_broker.csv"
    data.write_bytes(pl_export_utf8_bom())
    mapping = tmp_path / "mapping.yaml"
    mapping.write_text(pl_mapping_yaml(), encoding="utf-8")
    report = validate_import_file(data, mapping=mapping)
    assert report.ok and report.importer_id == "generic_csv"
    assert report.txn_count == 7
    assert [w.kind for w in report.warnings] == [ImportWarningKind.IGNORED_ROW]
    bad_mapping = tmp_path / "bad.yaml"
    bad_mapping.write_text("version: 1\n", encoding="utf-8")
    with pytest.raises(CsvMappingError):
        validate_import_file(data, mapping=bad_mapping)
    with pytest.raises(OSError):
        validate_import_file(tmp_path / "missing.csv")


def test_generic_csv_gets_the_semantic_checks() -> None:
    content = f"{SIMPLE_HEADER}\na,2026-01-05,buy,,,,1,10,PLN,0,-10\nb,2026-01-05,split,PKN,,GPW,,,PLN,,\n"
    report = validate_import(ImportFile("x.csv", content.encode()), _generic())
    kinds = {issue.kind for issue in report.errors}
    assert ImportWarningKind.MISSING_INSTRUMENT in kinds
    assert ImportWarningKind.UNKNOWN_SPLIT_RATIO in kinds


def _generic():
    from cashu.modules.investments.importing import GenericCsvImporter

    return GenericCsvImporter(simple_mapping())


def test_too_large_and_crashing_importers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "big.csv"
    path.write_text("format_version,record,date\n", encoding="utf-8")
    monkeypatch.setattr(validation_module, "MAX_FILE_BYTES", 5)
    report = validate_import_file(path)
    assert not report.ok and "too large" in report.errors[0].message

    class Crashing:
        broker_id = "crash"
        display_name = "Crash"
        version = 1

        def can_parse(self, file: ImportFile) -> bool:
            return True

        def parse(self, file: ImportFile) -> ImportParseResult:
            raise RuntimeError("boom")

    crashed = validate_import(ImportFile("x.csv", b""), Crashing())
    assert not crashed.ok and "Importer crash failed: boom" in crashed.errors[0].message
