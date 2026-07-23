"""Bank Pekao S.A. CSV export importer.

Real format (verified): UTF-8, ';'-delimited, WITH a header row. Account numbers
are apostrophe-guarded (``'38124…``). Amounts are signed Polish format. There is
no running-balance column. Columns:

    Data księgowania;Data waluty;Nadawca / Odbiorca;Adres nadawcy / odbiorcy;
    Rachunek źródłowy;Rachunek docelowy;Tytułem;Kwota operacji;Waluta;
    Numer referencyjny;Typ operacji;Kategoria

Unlike mBank/Erste there is no single "counterparty account" column — each row
carries a *source* and *destination* account. The statement's own account is the
one common to (nearly) every row; the counterparty is the other side (source for
inflows, destination for outflows).
"""

from __future__ import annotations

import csv
import io
from collections import Counter
from pathlib import Path

from ...models import Bank, Source
from ..normalize import RawTransaction
from .base import (
    DelimitedImporter,
    ParsedStatement,
    _read_text,
    parse_pl_amount,
    parse_pl_date,
)


def _acct(cell: str | None) -> str | None:
    """Strip Pekao's apostrophe guard + spaces from an account-number cell."""
    if not cell:
        return None
    s = cell.strip().lstrip("'").replace(" ", "")
    return s or None


class PekaoImporter(DelimitedImporter):
    bank = Bank.PEKAO
    encodings = ("utf-8-sig", "utf-8", "cp1250", "iso-8859-2")
    delimiters = (";", ",")
    signature = ("rachunek źródłowy", "rachunek docelowy", "numer referencyjny", "typ operacji")

    _COLS = {
        "booking": ("data księgowania", "data ksiegowania"),
        "value": ("data waluty",),
        "counterparty": ("nadawca / odbiorca", "nadawca/odbiorca"),
        "source": ("rachunek źródłowy", "rachunek zrodlowy"),
        "dest": ("rachunek docelowy",),
        "title": ("tytułem", "tytulem"),
        "amount": ("kwota operacji", "kwota"),
        "currency": ("waluta",),
        "type": ("typ operacji",),
    }

    def _find_header(self, rows: list[list[str]]) -> tuple[int | None, dict[str, int]]:
        for i, row in enumerate(rows):
            low = [c.strip().lower() for c in row]
            idx: dict[str, int] = {}
            for field, cands in self._COLS.items():
                for j, cell in enumerate(low):
                    if cell and any(c in cell for c in cands):
                        idx[field] = j
                        break
            if {"booking", "amount", "source", "dest"} <= idx.keys():
                return i, idx
        return None, {}

    def parse(self, path: str | Path) -> ParsedStatement:
        text = _read_text(Path(path), self.encodings)
        rows = [r for r in csv.reader(io.StringIO(text), delimiter=";") if any(c.strip() for c in r)]
        hidx, idx = self._find_header(rows)
        if hidx is None:
            raise ValueError(f"pekao: could not locate a header row in {Path(path).name}")
        data = rows[hidx + 1:]

        # Own account = the one appearing most across source/destination columns.
        counter: Counter[str] = Counter()
        for row in data:
            for f in ("source", "dest"):
                a = _acct(row[idx[f]]) if idx[f] < len(row) else None
                if a:
                    counter[a] += 1
        own = counter.most_common(1)[0][0] if counter else None

        stmt = ParsedStatement(bank=self.bank, account_number=own, currency=self.default_currency)
        for row in data:
            def cell(field: str) -> str | None:
                j = idx.get(field)
                return (row[j].strip() or None) if j is not None and j < len(row) else None

            booking = parse_pl_date(cell("booking"))
            amount = parse_pl_amount(cell("amount"))
            if booking is None or amount is None:
                continue
            src, dst = _acct(cell("source")), _acct(cell("dest"))
            cp_iban = (dst if src == own else src) if own else (dst or src)
            title = cell("title")
            stmt.transactions.append(
                RawTransaction(
                    booking_date=booking,
                    value_date=parse_pl_date(cell("value")),
                    amount=amount,
                    currency=cell("currency") or self.default_currency,
                    counterparty_name=cell("counterparty"),
                    counterparty_iban=cp_iban,
                    description=title,
                    reference=title,
                    source=Source.CSV,
                    raw={"row": row, "type": cell("type")},
                )
            )
        return stmt
