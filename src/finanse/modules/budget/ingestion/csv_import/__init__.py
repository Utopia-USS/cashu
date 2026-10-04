"""CSV / statement importers, with bank auto-detection."""

from __future__ import annotations

from pathlib import Path

from finanse.core.models import Bank

from .base import DelimitedImporter, ParsedStatement, _read_text
from .erste import ErsteImporter
from .mbank import MBankImporter
from .pekao import PekaoImporter

_REGISTRY: dict[Bank, DelimitedImporter] = {
    Bank.MBANK: MBankImporter(),
    Bank.ERSTE: ErsteImporter(),
    Bank.PEKAO: PekaoImporter(),
}


def get_importer(bank: Bank) -> DelimitedImporter:
    return _REGISTRY[bank]


def detect_importer(path: str | Path) -> DelimitedImporter | None:
    """Guess the bank from the file's content signature (best-scoring wins)."""
    path = Path(path)
    text = _read_text(path, DelimitedImporter.encodings)
    best: DelimitedImporter | None = None
    best_score = 0
    for importer in _REGISTRY.values():
        score = importer.match_score(text)
        if score > best_score:
            best, best_score = importer, score
    return best


def parse_file(path: str | Path, bank: Bank | None = None) -> ParsedStatement:
    """Parse a statement file, auto-detecting the bank unless one is given."""
    path = Path(path)
    importer = get_importer(bank) if bank else detect_importer(path)
    if importer is None:
        raise ValueError(
            f"Could not auto-detect the bank for {path.name}. "
            f"Pass the bank explicitly (--bank mbank|erste)."
        )
    return importer.parse(path)


__all__ = [
    "ParsedStatement",
    "DelimitedImporter",
    "get_importer",
    "detect_importer",
    "parse_file",
]
