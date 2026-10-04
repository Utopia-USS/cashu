"""CSV / statement importers, with bank auto-detection.

Which importer reads which bank comes from the institution registry
(``finanse.core.institutions``: each bank entry names its importer class), so
adding a bank is one registry entry plus a parser config module here.
"""

from __future__ import annotations

from pathlib import Path

from finanse.core import institutions

from .base import DelimitedImporter, ParsedStatement, _read_text


def get_importer(bank: str) -> DelimitedImporter:
    """The importer of an institution id (ValueError: unknown / no CSV import)."""
    try:
        return institutions.csv_importer(bank)
    except institutions.UnknownInstitution:
        raise ValueError(
            f"Unknown bank '{bank}'. Known: {', '.join(institutions.csv_ids())}."
        ) from None


def importers() -> list[DelimitedImporter]:
    return [institutions.csv_importer(i) for i in institutions.csv_ids()]


def detect_importer(path: str | Path) -> DelimitedImporter | None:
    """Guess the bank from the file's content signature (best-scoring wins)."""
    path = Path(path)
    text = _read_text(path, DelimitedImporter.encodings)
    best: DelimitedImporter | None = None
    best_score = 0
    for importer in importers():
        score = importer.match_score(text)
        if score > best_score:
            best, best_score = importer, score
    return best


def parse_file(path: str | Path, bank: str | None = None) -> ParsedStatement:
    """Parse a statement file, auto-detecting the bank unless one is given."""
    path = Path(path)
    importer = get_importer(bank) if bank else detect_importer(path)
    if importer is None:
        raise ValueError(
            f"Could not auto-detect the bank for {path.name}. "
            f"Pass the bank explicitly (--bank {'|'.join(institutions.csv_ids())})."
        )
    return importer.parse(path)


__all__ = [
    "DelimitedImporter",
    "ParsedStatement",
    "detect_importer",
    "get_importer",
    "importers",
    "parse_file",
]
