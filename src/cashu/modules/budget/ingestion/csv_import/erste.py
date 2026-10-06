"""Erste Bank Polska (formerly Santander Bank Polska) CSV export importer.

Real format (verified): UTF-8 (BOM), comma-delimited, quoted fields, comma
decimal, **no header row**. The first row is an account summary carrying the
own IBAN (apostrophe-guarded in col 2) and current balance; the rest are
transactions in this fixed column order:

    booking_date, value_date, title, counterparty_name, counterparty_account,
    amount, balance_after, type_code[, trailing]

Dates are DD-MM-YYYY (the summary row's first field is the ISO export date).
Legacy Santander exports share this shape and land in the same `erste`
account (account numbers didn't change in the rebrand).
"""

from __future__ import annotations

import csv
import io
import re
from pathlib import Path

from cashu.core.models import Source

from ..normalize import RawTransaction
from .base import (
    DelimitedImporter,
    ParsedStatement,
    _read_text,
    find_account_number,
    parse_pl_amount,
    parse_pl_date,
)


class ErsteImporter(DelimitedImporter):
    bank = "erste"  # institution id (core.institutions)
    encodings = ("utf-8-sig", "cp1250", "iso-8859-2", "utf-8")
    signature = ("santander bank polska", "erste bank", "bzwbk")

    def match_score(self, text: str) -> int:
        score = super().match_score(text)
        # Structural signal: exports carry no bank name, but the first row is
        # comma-delimited with an apostrophe-guarded account number in a cell.
        for line in text.splitlines():
            if not line.strip():
                continue
            cells = line.split(",")
            if len(cells) >= 7 and any(
                c.strip().startswith("'") and find_account_number(c) for c in cells
            ):
                score += 2
            break
        return score

    def _row_to_txn(self, row: list[str], currency: str) -> RawTransaction | None:
        if len(row) < 6:
            return None
        booking = parse_pl_date(row[0].strip().lstrip("'"))
        amount = parse_pl_amount(row[5])
        if booking is None or amount is None:
            return None

        def cell(i: int) -> str | None:
            return row[i].strip() or None if i < len(row) else None

        return RawTransaction(
            booking_date=booking,
            value_date=parse_pl_date(row[1]) if len(row) > 1 else None,
            amount=amount,
            currency=currency,
            counterparty_name=cell(3),
            counterparty_iban=cell(4),
            description=cell(2),
            reference=cell(2),
            source=Source.CSV,
            raw={"row": row},
        )

    def parse(self, path: str | Path) -> ParsedStatement:
        text = _read_text(Path(path), self.encodings)
        rows = [r for r in csv.reader(io.StringIO(text)) if r and any(c.strip() for c in r)]

        stmt = ParsedStatement(bank=self.bank, currency=self.default_currency)
        start = 0

        # Optional leading summary row: col2 = own IBAN, col4 = currency,
        # col6 = current balance, col0 = ISO export date.
        if rows:
            first = rows[0]
            own = find_account_number(first[2]) if len(first) > 2 else None
            if own and first[2].strip().startswith("'"):
                stmt.account_number = own
                if len(first) > 4 and re.fullmatch(r"[A-Za-z]{3}", first[4].strip()):
                    stmt.currency = first[4].strip().upper()
                bal = parse_pl_amount(first[6]) if len(first) > 6 else None
                bdate = parse_pl_date(first[0]) if first else None
                if bal is not None and bdate is not None:
                    stmt.balances.append((bdate, bal))
                start = 1

        for row in rows[start:]:
            rt = self._row_to_txn(row, stmt.currency)
            if rt is None:
                stmt.skipped_rows += 1  # blank rows are filtered out above
            if rt is not None:
                stmt.transactions.append(rt)
                if len(row) > 6:
                    bal = parse_pl_amount(row[6])
                    if bal is not None:
                        stmt.balances.append((rt.booking_date, bal))

        if not stmt.account_number:
            stmt.account_number = find_account_number(text)
        return stmt
