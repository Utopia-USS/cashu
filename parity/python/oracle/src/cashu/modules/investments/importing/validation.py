"""File validation without a database: parse an import file and report every problem.

``validate_import_file(path)`` checks a canonical ``cashu-import`` file (CSV or JSON, see
``docs/import-format.md``), or a CSV export against a generic CSV mapping when ``mapping`` is given. The
CLI command (persistence wave) is a thin wrapper around it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from os import PathLike
from pathlib import Path

from .canonical import CanonicalImporter
from .contract import (
    BrokerImporter,
    ImportFile,
    ImportParseResult,
    ImportWarning,
    ImportWarningKind,
)
from .csv_mapping import CsvMapping
from .generic_csv import GenericCsvImporter
from .plan import semantic_issues

MAX_FILE_BYTES = 64 * 1024 * 1024
"""Largest file the validator reads (a real export is far smaller)."""


@dataclass(frozen=True, slots=True, kw_only=True)
class ValidationReport:
    """Outcome of validating one file."""

    file_name: str
    importer_id: str | None
    """Broker id of the importer that parsed the file; None when none could."""
    errors: tuple[ImportWarning, ...] = ()
    """Blocking problems: the file cannot be imported until they are fixed."""
    warnings: tuple[ImportWarning, ...] = ()
    """Suspicious but importable rows."""
    result: ImportParseResult | None = field(default=None, repr=False)

    @property
    def ok(self) -> bool:
        return self.importer_id is not None and not self.errors

    @property
    def txn_count(self) -> int:
        return 0 if self.result is None else len(self.result.txns)

    @property
    def position_count(self) -> int:
        return 0 if self.result is None else len(self.result.positions)

    @property
    def corporate_action_count(self) -> int:
        return 0 if self.result is None else len(self.result.corporate_actions)

    def summary(self) -> str:
        """Human-readable report: verdict, counts, then every error and warning."""
        verdict = "OK" if self.ok else "INVALID"
        lines = [
            f"{self.file_name}: {verdict} ({self.importer_id or 'no importer'})",
            (
                f"  transactions: {self.txn_count}, positions: {self.position_count}, "
                f"corporate actions: {self.corporate_action_count}"
            ),
            f"  errors: {len(self.errors)}, warnings: {len(self.warnings)}",
        ]
        lines += [f"  error   {issue}" for issue in self.errors]
        lines += [f"  warning {issue}" for issue in self.warnings]
        return "\n".join(lines)


def validate_import(file: ImportFile, importer: BrokerImporter | None = None) -> ValidationReport:
    """Validate ``file`` with ``importer`` (default: the canonical importer)."""
    importer = importer or CanonicalImporter()
    if not _safe_can_parse(importer, file):
        hint = (
            "expected a cashu-import CSV (header with format_version and record columns) or "
            "JSON (object with format cashU-import); see docs/import-format.md"
            if isinstance(importer, CanonicalImporter)
            else "the mapped columns or the extension do not match the file"
        )
        return ValidationReport(
            file_name=file.name,
            importer_id=None,
            errors=(
                ImportWarning(
                    message=f"Not recognized by the {importer.broker_id} importer: {hint}",
                    blocking=True,
                    kind=ImportWarningKind.IMPORTER_ERROR,
                ),
            ),
        )
    try:
        result = importer.parse(file)
    except Exception as error:  # noqa: BLE001 - an importer bug is reported, never raised
        return ValidationReport(
            file_name=file.name,
            importer_id=None,
            errors=(
                ImportWarning(
                    message=f"Importer {importer.broker_id} failed: {error}",
                    blocking=True,
                    kind=ImportWarningKind.IMPORTER_ERROR,
                ),
            ),
        )
    errors = [w for w in result.warnings if w.blocking]
    warnings = [w for w in result.warnings if not w.blocking]
    for txn in result.txns:
        errors.extend(semantic_issues(txn, has_instrument=txn.instrument_named()))
    return ValidationReport(
        file_name=file.name,
        importer_id=importer.broker_id,
        errors=tuple(_dedupe(errors)),
        warnings=tuple(warnings),
        result=result,
    )


def validate_import_file(
    path: str | PathLike[str],
    *,
    mapping: CsvMapping | str | PathLike[str] | None = None,
) -> ValidationReport:
    """Validate the file at ``path`` (no database, nothing written).

    Without ``mapping`` the file must be in the canonical ``cashu-import`` format. With ``mapping``
    (a :class:`CsvMapping`, or the path of a mapping YAML file) it is checked as a generic CSV export.
    Raises ``OSError`` when the file cannot be read and ``CsvMappingError`` for an invalid mapping.
    """
    file_path = Path(path)
    size = file_path.stat().st_size
    if size > MAX_FILE_BYTES:
        return ValidationReport(
            file_name=file_path.name,
            importer_id=None,
            errors=(
                ImportWarning(
                    message=f"File is too large ({size} bytes, max {MAX_FILE_BYTES})",
                    blocking=True,
                    kind=ImportWarningKind.FILE_FORMAT,
                ),
            ),
        )
    file = ImportFile(file_path.name, file_path.read_bytes())
    importer: BrokerImporter | None = None
    if isinstance(mapping, CsvMapping):
        importer = GenericCsvImporter(mapping)
    elif mapping is not None:
        importer = GenericCsvImporter(
            CsvMapping.from_yaml(Path(mapping).read_text(encoding="utf-8"))
        )
    return validate_import(file, importer)


def _safe_can_parse(importer: BrokerImporter, file: ImportFile) -> bool:
    try:
        return bool(importer.can_parse(file))
    except Exception:  # noqa: BLE001
        return False


def _dedupe(issues: list[ImportWarning]) -> list[ImportWarning]:
    seen: set[ImportWarning] = set()
    unique: list[ImportWarning] = []
    for issue in issues:
        if issue not in seen:
            seen.add(issue)
            unique.append(issue)
    return unique


__all__ = ["MAX_FILE_BYTES", "ValidationReport", "validate_import", "validate_import_file"]
