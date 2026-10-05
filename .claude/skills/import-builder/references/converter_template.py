"""Convert <BROKER> <EXPORT KIND> exports to the finanse import format (format_version 1).

Written by the import-builder skill for profile <slug> on <YYYY-MM-DD>. Read it before you let
Claude Code run it: the finanse app never runs scripts, the agent runs this one on your computer.
Input:  <what the export looks like: file type, sheets, encoding, separator, date and number format>
Output: finanse-import CSV, see references/import-format.md of the import-builder skill.
Run:    python3 -I scripts/import_<source>.py inbox/<export file> inbox/converted/<output .csv>

Contract: Python standard library only; no network; no environment variables; reads only the export
file and writes only the output file; deterministic (the same export always gives the same rows);
error messages name the row and the field, never the cell value.

This template converts a synthetic semicolon CSV with the columns
ID;Data;Typ;Symbol;ISIN;Nazwa;Ilosc;Cena;Waluta;Prowizja;Kwota. Replace read_rows() and convert() for
the real export; keep the helpers and main().
"""

from __future__ import annotations

import csv
import datetime
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from decimal import Decimal, InvalidOperation
from pathlib import Path

SOURCE = "examplebroker"  # [a-z][a-z0-9_]*, max 32 characters; the same for every file of this broker

FIELDS = (
    "format_version,record,date,time,settle_date,type,external_ref,symbol,isin,name,exchange,quantity,"
    "price,currency,gross_amount,fee,tax,cash_amount,cash_currency,fx_rate,split_ratio,avg_price,"
    "market_value,new_symbol,new_isin,new_exchange,new_name,frozen,note,source,account_hint"
).split(",")

# Broker label -> finanse transaction type. A label that is not listed is an error, never a guess.
TYPE_MAP = {
    "kupno": "buy",
    "sprzedaz": "sell",
    "dywidenda": "dividend",
    "wplata": "deposit",
    "wyplata": "withdrawal",
    "oplata": "fee",
}


class ConvertError(Exception):
    """A problem with the export; the message names the row and the field, never the value."""


# --------------------------------------------------------------------------- #
# helpers (keep)
# --------------------------------------------------------------------------- #


def decimal_text(raw: str, row: int, field: str, *, decimal_sep: str = ",", thousands: str = " ",
                 absolute: bool = False) -> str:
    """Broker number text -> canonical decimal text ('1 234,50' -> '1234.50'). Empty -> ''."""
    text = (raw or "").strip().replace(" ", " ")
    if not text:
        return ""
    if thousands:
        text = text.replace(thousands, "")
    if decimal_sep != ".":
        text = text.replace(decimal_sep, ".")
    try:
        value = Decimal(text)
    except InvalidOperation:
        raise ConvertError(f"row {row}: {field}: not a number") from None
    if absolute:
        value = abs(value)
    return format(value, "f")


def iso_date(raw: str, row: int, field: str, formats: tuple[str, ...] = ("%d.%m.%Y", "%Y-%m-%d")) -> str:
    """Broker date text (or an Excel serial number) -> YYYY-MM-DD."""
    text = (raw or "").strip()
    if re.fullmatch(r"\d{5}(\.\d+)?", text):  # Excel serial date (1900 system)
        return (datetime.date(1899, 12, 30) + datetime.timedelta(days=int(float(text)))).isoformat()
    for fmt in formats:
        try:
            return datetime.datetime.strptime(text.split(" ")[0], fmt).date().isoformat()
        except ValueError:
            continue
    raise ConvertError(f"row {row}: {field}: unrecognised date format")


def fold(text: str) -> str:
    """Lower-case and strip Polish diacritics, for matching broker labels."""
    table = str.maketrans("ąćęłńóśźżĄĆĘŁŃÓŚŹŻ", "acelnoszzACELNOSZZ")
    return (text or "").strip().translate(table).lower()


def read_csv(path: str, *, encoding: str = "utf-8-sig", delimiter: str = ";") -> list[list[str]]:
    with open(path, encoding=encoding, newline="") as f:
        return [row for row in csv.reader(f, delimiter=delimiter) if any(cell.strip() for cell in row)]


def read_xlsx(path: str) -> dict[str, list[list[str]]]:
    """All sheets of an .xlsx as rows of strings (standard library only). Dates stay Excel serials."""
    ns = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
          "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}

    def col_index(ref: str) -> int:
        n = 0
        for ch in re.match(r"[A-Z]+", ref).group():
            n = n * 26 + ord(ch) - 64
        return n - 1

    z = zipfile.ZipFile(path)
    shared: list[str] = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("x:si", ns):
            shared.append("".join(t.text or "" for t in si.iter(f"{{{ns['x']}}}t")))
    workbook = ET.fromstring(z.read("xl/workbook.xml"))
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    out: dict[str, list[list[str]]] = {}
    for sheet in workbook.find("x:sheets", ns):
        target = rels[sheet.get(f"{{{ns['r']}}}id")].lstrip("/")
        target = target if target.startswith("xl/") else "xl/" + target
        rows: list[list[str]] = []
        for row in ET.fromstring(z.read(target)).iter(f"{{{ns['x']}}}row"):
            values: dict[int, str] = {}
            for c in row.findall("x:c", ns):
                kind, v = c.get("t"), c.find("x:v", ns)
                if kind == "s":
                    value = shared[int(v.text)]
                elif kind == "inlineStr":
                    value = "".join(t.text or "" for t in c.iter(f"{{{ns['x']}}}t"))
                else:
                    value = v.text if v is not None else ""
                values[col_index(c.get("r"))] = value
            if values:
                rows.append([values.get(i, "") for i in range(max(values) + 1)])
        out[sheet.get("name")] = rows
    return out


def write_csv(records: list[dict[str, str]], out_path: str) -> None:
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS, lineterminator="\n")
        writer.writeheader()
        for rec in records:
            row = {k: "" for k in FIELDS}
            row.update(rec)
            row["format_version"] = "1"
            writer.writerow(row)


# --------------------------------------------------------------------------- #
# export-specific part (replace)
# --------------------------------------------------------------------------- #


def read_rows(path: str) -> list[list[str]]:
    return read_csv(path, encoding="utf-8-sig", delimiter=";")


def convert(rows: list[list[str]]) -> list[dict[str, str]]:
    if not rows:
        raise ConvertError("file: no rows")
    header = [fold(h) for h in rows[0]]
    expected = ["id", "data", "typ", "symbol", "isin", "nazwa", "ilosc", "cena", "waluta", "prowizja", "kwota"]
    missing = [h for h in expected if h not in header]
    if missing:
        raise ConvertError(f"header: missing columns {', '.join(missing)}")
    col = {h: header.index(h) for h in expected}
    records: list[dict[str, str]] = []
    for i, raw in enumerate(rows[1:]):
        cell = lambda name: raw[col[name]].strip() if col[name] < len(raw) else ""  # noqa: E731
        label = fold(cell("typ"))
        if label not in TYPE_MAP:
            raise ConvertError(f"row {i}: typ: unknown transaction label (add it to TYPE_MAP)")
        kind = TYPE_MAP[label]
        rec = {
            "record": "txn",
            "date": iso_date(cell("data"), i, "data"),
            "type": kind,
            "external_ref": cell("id"),  # only a stable broker id; never a row number
            "currency": cell("waluta").upper(),
            "cash_amount": decimal_text(cell("kwota"), i, "kwota"),  # signed as booked by the broker
            "fee": decimal_text(cell("prowizja"), i, "prowizja", absolute=True),
        }
        if kind in ("buy", "sell", "dividend"):
            rec.update(symbol=cell("symbol"), isin=cell("isin").upper(), name=cell("nazwa"))
        if kind in ("buy", "sell"):
            rec.update(quantity=decimal_text(cell("ilosc"), i, "ilosc", absolute=True),
                       price=decimal_text(cell("cena"), i, "cena", absolute=True))
        records.append(rec)
    if records:
        records[0]["source"] = SOURCE
    return records


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(f"usage: python3 {Path(argv[0]).name} <export file> <output .csv>", file=sys.stderr)
        return 2
    try:
        records = convert(read_rows(argv[1]))
    except ConvertError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    write_csv(records, argv[2])
    print(f"{len(records)} records written", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
