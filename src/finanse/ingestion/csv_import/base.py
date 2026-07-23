"""Generic delimited-statement parsing engine shared by all bank CSV importers.

Bank exports differ in encoding, delimiter, preamble junk, column names and
number/date formats — but the *shape* is always "find a header row, map columns
to fields, parse Polish-formatted amounts and dates". That machinery lives here;
each bank importer only supplies a small `ColumnMap` + a few conventions.
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

from ...models import Bank, Source
from ..normalize import RawTransaction

# Encodings Polish banks commonly use, in order of likelihood.
DEFAULT_ENCODINGS = ("utf-8-sig", "cp1250", "iso-8859-2", "utf-8")
DEFAULT_DELIMITERS = (";", ",", "\t")

_DATE_FORMATS = ("%Y-%m-%d", "%d.%m.%Y", "%d-%m-%Y", "%Y/%m/%d", "%d/%m/%Y")
_ACCOUNT_RE = re.compile(r"(?:PL)?\s?(?:\d[\s]?){26}")  # Polish NRB/IBAN, spaced or not


def parse_pl_amount(value: str | None) -> Decimal | None:
    """Parse '-1 234,56 PLN' / '1.234,56' / '123,45' -> Decimal. None if empty."""
    if value is None:
        return None
    s = value.strip()
    if not s:
        return None
    # drop currency codes / letters and stray symbols, keep digits, sign, separators
    s = re.sub(r"[^\d,.\-+]", "", s)
    if not s or s in {"-", "+"}:
        return None
    # Polish convention: ',' decimal, '.'/space thousands. Normalize to '.' decimal.
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    return Decimal(s)


def parse_pl_date(value: str | None) -> date | None:
    if not value:
        return None
    s = value.strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def find_account_number(text: str) -> str | None:
    m = _ACCOUNT_RE.search(text)
    if not m:
        return None
    digits = re.sub(r"\s+", "", m.group(0))
    return digits


@dataclass
class ColumnMap:
    """Header-substring candidates for each logical field (case-insensitive)."""

    booking_date: tuple[str, ...]
    amount: tuple[str, ...] = ()
    value_date: tuple[str, ...] = ()
    counterparty: tuple[str, ...] = ()
    description: tuple[str, ...] = ()
    title: tuple[str, ...] = ()
    counterparty_iban: tuple[str, ...] = ()
    currency: tuple[str, ...] = ()
    balance: tuple[str, ...] = ()
    debit: tuple[str, ...] = ()   # separate outflow column (positive magnitude)
    credit: tuple[str, ...] = ()  # separate inflow column


@dataclass
class ParsedStatement:
    bank: Bank
    account_number: str | None = None
    account_name: str | None = None
    currency: str = "PLN"
    transactions: list[RawTransaction] = field(default_factory=list)
    # (date, balance) snapshots derived from a running-balance column, if present.
    balances: list[tuple[date, Decimal]] = field(default_factory=list)


def _read_text(path: Path, encodings: tuple[str, ...]) -> str:
    last_err: Exception | None = None
    for enc in encodings:
        try:
            return path.read_text(encoding=enc)
        except (UnicodeDecodeError, LookupError) as e:
            last_err = e
    raise last_err or UnicodeDecodeError("unknown", b"", 0, 1, "cannot decode file")


def _sniff_delimiter(lines: list[str], delimiters: tuple[str, ...]) -> str:
    best, best_count = delimiters[0], -1
    for d in delimiters:
        count = max((ln.count(d) for ln in lines[:50]), default=0)
        if count > best_count:
            best, best_count = d, count
    return best


def _match_header(row: list[str], colmap: ColumnMap) -> dict[str, int] | None:
    """Return field->column-index if this row looks like the header."""
    lowered = [c.strip().lower() for c in row]
    mapping: dict[str, int] = {}
    for f in (
        "booking_date", "value_date", "amount", "counterparty", "description",
        "title", "counterparty_iban", "currency", "balance", "debit", "credit",
    ):
        candidates = getattr(colmap, f, ())
        for idx, cell in enumerate(lowered):
            if cell and any(cand in cell for cand in candidates):
                mapping[f] = idx
                break
    # Header must at least locate a date and some amount signal.
    has_date = "booking_date" in mapping
    has_amount = "amount" in mapping or ("debit" in mapping and "credit" in mapping) or "debit" in mapping or "credit" in mapping
    return mapping if has_date and has_amount else None


class DelimitedImporter:
    """Base class: concrete importers set `bank`, `colmap`, and conventions."""

    bank: Bank
    colmap: ColumnMap
    encodings: tuple[str, ...] = DEFAULT_ENCODINGS
    delimiters: tuple[str, ...] = DEFAULT_DELIMITERS
    default_currency: str = "PLN"
    # header substrings that identify this bank's export (for auto-detection)
    signature: tuple[str, ...] = ()

    def match_score(self, text: str) -> int:
        """How strongly this file looks like this bank's export (# signature hits)."""
        low = text.lower()
        return sum(1 for sig in self.signature if sig.lower() in low)

    def parse(self, path: Path) -> ParsedStatement:
        text = _read_text(Path(path), self.encodings)
        lines = text.splitlines()
        delimiter = _sniff_delimiter(lines, self.delimiters)

        reader = list(csv.reader(io.StringIO(text), delimiter=delimiter))
        header_idx: int | None = None
        mapping: dict[str, int] | None = None
        for i, row in enumerate(reader):
            m = _match_header(row, self.colmap)
            if m:
                header_idx, mapping = i, m
                break
        if header_idx is None or mapping is None:
            raise ValueError(
                f"{self.bank.value}: could not locate a transaction header row in {path.name}"
            )

        account_number, currency = self.extract_meta(text)
        stmt = ParsedStatement(
            bank=self.bank,
            account_number=account_number,
            currency=currency,
        )

        for row in reader[header_idx + 1:]:
            rt = self._row_to_txn(row, mapping, currency)
            if rt is not None:
                stmt.transactions.append(rt)
                bal = self._row_balance(row, mapping)
                if bal is not None:
                    stmt.balances.append((rt.booking_date, bal))

        return stmt

    # --- overridable hooks ---

    def extract_meta(self, text: str) -> tuple[str | None, str]:
        """Return (account_number, account_currency) parsed from the file.

        Default scans for the first account number and uses the bank's default
        currency; banks whose statements declare currency/account in a preamble
        override this.
        """
        return find_account_number(text), self.default_currency

    # --- row helpers (overridable) ---

    def _cell(self, row: list[str], mapping: dict[str, int], field_name: str) -> str | None:
        idx = mapping.get(field_name)
        if idx is None or idx >= len(row):
            return None
        val = row[idx].strip()
        return val or None

    def _amount(self, row: list[str], mapping: dict[str, int]) -> Decimal | None:
        if "amount" in mapping:
            return parse_pl_amount(self._cell(row, mapping, "amount"))
        debit = parse_pl_amount(self._cell(row, mapping, "debit"))
        credit = parse_pl_amount(self._cell(row, mapping, "credit"))
        if credit is not None and credit != 0:
            return abs(credit)
        if debit is not None and debit != 0:
            return -abs(debit)
        return None

    def _row_balance(self, row: list[str], mapping: dict[str, int]) -> Decimal | None:
        return parse_pl_amount(self._cell(row, mapping, "balance")) if "balance" in mapping else None

    def _row_to_txn(
        self, row: list[str], mapping: dict[str, int], default_currency: str
    ) -> RawTransaction | None:
        booking = parse_pl_date(self._cell(row, mapping, "booking_date"))
        amount = self._amount(row, mapping)
        if booking is None or amount is None:
            return None  # skip preamble/footer/blank rows

        description = self._cell(row, mapping, "description") or self._cell(row, mapping, "title")
        currency = self._cell(row, mapping, "currency") or default_currency
        return RawTransaction(
            booking_date=booking,
            value_date=parse_pl_date(self._cell(row, mapping, "value_date")),
            amount=amount,
            currency=currency,
            counterparty_name=self._cell(row, mapping, "counterparty"),
            counterparty_iban=self._cell(row, mapping, "counterparty_iban"),
            description=description,
            reference=self._cell(row, mapping, "title"),
            source=Source.CSV,
            raw={"row": row},
        )
