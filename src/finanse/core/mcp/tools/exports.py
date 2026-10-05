"""Local export files for the MCP import tools: path checks, small readers (CSV / TSV / JSON / XLSX with the
standard library) and ``inspect``: the structure of a file with every value masked.

``inspect`` is what lets a cloud agent write a parser without seeing the data: sheet and column names,
the inferred type and format of each column (decimal / thousands separators, date pattern, sign),
empty shares, row counts, and sample rows where numbers become a format mask (``-N NNN,NN``), dates
their pattern (``DD.MM.YYYY``), identifiers ``[identifier]`` and free text ``<text: 2 words>``. Only
short code-like values of low-cardinality columns (transaction types, currencies, tickers, ISINs) are
shown as they are, never in columns whose header suggests a name or a description.

Paths: a regular file (symlinks resolved), extension csv / tsv / txt / json / xlsx, at most 20 MB, no
hidden directory on the way (``~/.ssh`` ...), and nothing inside the finanse data dir except the bound
profile's own folder (``profiles/<slug>/``: extensions, interview notes).
"""

from __future__ import annotations

import csv
import io
import json
import os
import re
import unicodedata
import zipfile
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from xml.etree import ElementTree as ET

from finanse.core import paths

from .. import labels as L
from ..names import fold, looks_like_person
from ..redaction import isin_valid
from ..registry import ToolError

ALLOWED = ("csv", "tsv", "txt", "json", "xlsx")
MAX_BYTES = 20 * 1024 * 1024
MAX_XLSX_UNCOMPRESSED = 200 * 1024 * 1024
MAX_ROWS = 200_000
MAX_COLUMNS = 200


# --------------------------------------------------------------------------- #
# Paths
# --------------------------------------------------------------------------- #


def inside(path: Path, root: Path) -> bool:
    """``path`` is ``root`` or below it, compared case- and Unicode-normalization-insensitively (macOS
    and Windows file systems are; ``resolve()`` keeps the spelling it was given)."""

    def key(value: Path) -> str:
        return unicodedata.normalize("NFC", os.path.normcase(str(value))).casefold()

    p, r = key(path), key(root)
    r = r.rstrip(os.sep)
    return p == r or p.startswith(r + os.sep)


def checked_local_file(
    raw: str, slug: str, allowed: tuple[str, ...], *, profile_only: bool = False
) -> Path:
    """A regular file with an allowed extension, outside hidden files / directories, the finanse data
    dir (except the bound profile's own folder) and the legacy repo data dir. ``profile_only``: only
    the profile's folder (mapping files)."""
    if not raw or "\x00" in raw:
        raise ToolError("path is required")
    try:
        path = Path(raw).expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        raise ToolError("file not found", "not_found") from None
    if not path.is_file():
        raise ToolError("not a regular file")
    ext = path.suffix.lower().lstrip(".")
    if ext not in allowed:
        raise ToolError(f"unsupported file type; allowed: {', '.join(allowed)}")
    if any(part.startswith(".") for part in path.parts[1:]):
        raise ToolError("hidden files and files inside hidden directories are not read")
    from finanse.modules.investments.service import files

    own = files.profile_dir(slug).resolve()
    if profile_only and not inside(path, own):
        raise ToolError(
            "this file must be in the profile's folder (profiles/<slug>/ in the data dir)"
        )
    if inside(path, paths.data_dir().resolve()) and not inside(path, own):
        raise ToolError(
            "files inside the finanse data dir are not read (except the profile folder)"
        )
    if inside(path, paths.LEGACY_DIR.resolve()):
        raise ToolError("files inside the legacy data folder are not read")
    return path


def checked_path(raw: str, slug: str) -> Path:
    path = checked_local_file(raw, slug, ALLOWED)
    if path.stat().st_size > MAX_BYTES:
        raise ToolError(f"file is too large (max {MAX_BYTES // (1024 * 1024)} MB)")
    return path


# --------------------------------------------------------------------------- #
# Readers
# --------------------------------------------------------------------------- #


@dataclass
class Table:
    name: str
    rows: list[list[str]]
    kinds: list[list[str]] = field(default_factory=list)
    """Per cell: "" or a type the reader already knows (xlsx: "number", "date", "bool")."""


@dataclass
class FileInfo:
    extension: str
    encoding: str | None = None
    delimiter: str | None = None
    tables: list[Table] = field(default_factory=list)
    structure: list[dict] = field(default_factory=list)
    """JSON without a table shape: top-level keys and their types."""


def _decode(data: bytes) -> tuple[str, str]:
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8", errors="replace"), "utf-8-sig"
    try:
        return data.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        return data.decode("cp1250", errors="replace"), "windows-1250"


def _sniff_delimiter(text: str) -> str:
    """The delimiter that splits the most lines into the same number (> 1) of cells (broker exports
    often start with a few metadata lines, which confuse ``csv.Sniffer``)."""
    lines = [ln for ln in text.splitlines()[:300] if ln.strip()]
    best, best_score = ",", 0
    for delimiter in (";", ",", "\t", "|"):
        widths = Counter(
            len(row) for row in csv.reader(io.StringIO("\n".join(lines)), delimiter=delimiter)
        )
        widths.pop(1, None)
        widths.pop(0, None)
        if not widths:
            continue
        width, freq = widths.most_common(1)[0]
        score = freq * 1000 + width
        if score > best_score:
            best, best_score = delimiter, score
    return best


def _read_csv(data: bytes, ext: str) -> FileInfo:
    text, encoding = _decode(data)
    delimiter = "\t" if ext == "tsv" else _sniff_delimiter(text)
    rows = []
    for i, row in enumerate(csv.reader(io.StringIO(text), delimiter=delimiter)):
        if i >= MAX_ROWS:
            break
        rows.append([c.strip() for c in row[:MAX_COLUMNS]])
    return FileInfo(ext, encoding, delimiter, [Table("csv", rows)])


def _read_json(data: bytes) -> FileInfo:
    text, encoding = _decode(data)
    try:
        doc = json.loads(text)
    except ValueError:
        raise ToolError("the JSON file cannot be parsed", "invalid_file") from None
    info = FileInfo("json", encoding)

    def table(name: str, items: list) -> Table | None:
        dicts = [x for x in items[:MAX_ROWS] if isinstance(x, dict)]
        if not dicts:
            return None
        cols: list[str] = []
        for d in dicts:
            for k in d:
                if k not in cols and len(cols) < MAX_COLUMNS:
                    cols.append(str(k))
        rows = [cols] + [[_json_cell(d.get(c)) for c in cols] for d in dicts]
        return Table(name, rows)

    if isinstance(doc, list):
        t = table("records", doc)
        if t:
            info.tables.append(t)
    elif isinstance(doc, dict):
        for key, value in doc.items():
            if isinstance(value, list):
                t = table(str(key), value)
                if t:
                    info.tables.append(t)
                    continue
            info.structure.append({"key": str(key), "type": type(value).__name__})
    return info


def _json_cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return "<nested>"
    return str(value)


_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_DATE_FORMAT_IDS = set(range(14, 23)) | {45, 46, 47}


def _col_index(ref: str) -> int:
    letters = re.match(r"[A-Z]+", ref or "")
    n = 0
    for ch in letters.group(0) if letters else "A":
        n = n * 26 + ord(ch) - 64
    return n - 1


def _read_xlsx(data: bytes) -> FileInfo:
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ToolError("the XLSX file cannot be opened", "invalid_file") from None
    if sum(i.file_size for i in zf.infolist()) > MAX_XLSX_UNCOMPRESSED:
        raise ToolError("the XLSX file is too large when unpacked")
    try:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in zf.namelist():
            root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for si in root.findall("m:si", _NS):
                shared.append("".join(t.text or "" for t in si.iter(f"{{{_NS['m']}}}t")))
        date_styles: set[int] = set()
        if "xl/styles.xml" in zf.namelist():
            styles = ET.fromstring(zf.read("xl/styles.xml"))
            custom = {
                int(n.get("numFmtId")): (n.get("formatCode") or "").lower()
                for n in styles.findall("m:numFmts/m:numFmt", _NS)
            }
            for i, xf in enumerate(styles.findall("m:cellXfs/m:xf", _NS)):
                fid = int(xf.get("numFmtId") or 0)
                code = re.sub(r'"[^"]*"|\[[^\]]*\]', "", custom.get(fid, ""))
                if fid in _DATE_FORMAT_IDS or (
                    code
                    and re.search(r"[dy]|m{1,2}(?![^;]*0)", code)
                    and not re.search(r"0[.,]0", code)
                ):
                    date_styles.add(i)
        workbook = ET.fromstring(zf.read("xl/workbook.xml"))
        rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
        targets = {r.get("Id"): r.get("Target") for r in rels}
        info = FileInfo("xlsx")
        for sheet in workbook.findall("m:sheets/m:sheet", _NS):
            target = targets.get(sheet.get(f"{{{_REL_NS}}}id"), "")
            target = target.lstrip("/")
            target = target if target.startswith("xl/") else f"xl/{target}"
            if target not in zf.namelist():
                continue
            rows: list[list[str]] = []
            kinds: list[list[str]] = []
            root = ET.fromstring(zf.read(target))
            for row in root.iter(f"{{{_NS['m']}}}row"):
                if len(rows) >= MAX_ROWS:
                    break
                values: dict[int, tuple[str, str]] = {}
                for c in row.findall("m:c", _NS):
                    idx = _col_index(c.get("r") or "")
                    if idx >= MAX_COLUMNS:
                        continue
                    t = c.get("t") or "n"
                    v = c.find("m:v", _NS)
                    raw = v.text if v is not None and v.text is not None else ""
                    if t == "s":
                        values[idx] = (
                            shared[int(raw)] if raw.isdigit() and int(raw) < len(shared) else "",
                            "",
                        )
                    elif t == "inlineStr":
                        values[idx] = (
                            "".join(x.text or "" for x in c.iter(f"{{{_NS['m']}}}t")),
                            "",
                        )
                    elif t == "b":
                        values[idx] = ("TRUE" if raw == "1" else "FALSE", "bool")
                    elif t in ("str", "e"):
                        values[idx] = (raw, "")
                    elif raw:
                        style = int(c.get("s") or 0)
                        if style in date_styles:
                            try:
                                day = date(1899, 12, 30) + timedelta(days=float(raw))
                                values[idx] = (day.isoformat(), "date")
                            except (ValueError, OverflowError):
                                values[idx] = (raw, "number")
                        else:
                            values[idx] = (raw, "number")
                width = max(values) + 1 if values else 0
                rows.append([values.get(i, ("", ""))[0].strip() for i in range(width)])
                kinds.append([values.get(i, ("", ""))[1] for i in range(width)])
            info.tables.append(Table(sheet.get("name") or "sheet", rows, kinds))
        return info
    except (KeyError, ET.ParseError, ValueError):
        raise ToolError("the XLSX file cannot be read", "invalid_file") from None


def read(path: Path) -> FileInfo:
    data = path.read_bytes()
    ext = path.suffix.lower().lstrip(".")
    if ext == "xlsx":
        return _read_xlsx(data)
    if ext == "json":
        return _read_json(data)
    return _read_csv(data, ext)


# --------------------------------------------------------------------------- #
# Type inference and masking
# --------------------------------------------------------------------------- #

_IBAN = re.compile(r"^[A-Z]{2}\d{2}[A-Z0-9 ]{11,40}$")
_DIGITS = re.compile(r"\d")
_ISIN = re.compile(r"^[A-Z]{2}[A-Z0-9]{9}\d$")
_CURRENCIES = frozenset(
    """
    PLN EUR USD GBP CHF JPY NOK SEK DKK HUF CZK CAD AUD HKD CNY SGD NZD TRY RON BGN ILS ZAR MXN BRL
    INR KRW
    """.split()  # noqa: SIM905 - a code list reads better as text
)
_SYMBOL = re.compile(r"^[A-Z0-9][A-Z0-9.\-:]{0,11}$")
_NUMBER = re.compile(r"^[-+−]?(?:\d{1,3}(?:([   '.,])\d{3})*|\d+)(?:([.,])(\d+))?$")
_DATE_PATTERNS = [
    (re.compile(r"^\d{4}-\d{2}-\d{2}$"), "YYYY-MM-DD"),
    (re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?"), "YYYY-MM-DD HH:MM[:SS]"),
    (re.compile(r"^\d{2}\.\d{2}\.\d{4}$"), "DD.MM.YYYY"),
    (re.compile(r"^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}(:\d{2})?$"), "DD.MM.YYYY HH:MM[:SS]"),
    (re.compile(r"^\d{2}/\d{2}/\d{4}$"), "DD/MM/YYYY or MM/DD/YYYY"),
    (re.compile(r"^\d{2}-\d{2}-\d{4}$"), "DD-MM-YYYY"),
    (re.compile(r"^\d{4}/\d{2}/\d{2}$"), "YYYY/MM/DD"),
    (re.compile(r"^\d{4}\.\d{2}\.\d{2}$"), "YYYY.MM.DD"),
    (re.compile(r"^\d{8}$"), "YYYYMMDD?"),
]
_BOOL = {"TRUE", "FALSE", "TAK", "NIE", "YES", "NO"}
_NAMEISH_HEADER = re.compile(
    r"name|nazw|imi|owner|wlasc|właśc|klient|client|holder|opis|descr|title|tytu|comment|komentarz|"
    r"note|uwag|adres|address|odbior|nadaw|payee|counterpart|kontrahent|iban|account|rachun|konto|"
    r"number|numer|nr\b|pesel|nip|email|phone|telefon",
    re.IGNORECASE,
)


# Transaction-type words of broker exports (folded, prefixes): shown as column values.
_VOCAB = (
    "KUPNO",
    "SPRZEDAZ",
    "WPLATA",
    "WYPLATA",
    "DYWIDEND",
    "ODSETK",
    "PROWIZJ",
    "OPLATA",
    "PODATEK",
    "PRZELEW",
    "ZAKUP",
    "SPRZEDANO",
    "KUPIONO",
    "ZLECENIE",
    "WYMIANA",
    "KONWERSJA",
    "KOREKTA",
    "BUY",
    "SELL",
    "DEPOSIT",
    "WITHDRAW",
    "DIVIDEND",
    "INTEREST",
    "FEE",
    "COMMISSION",
    "TAX",
    "TRANSFER",
    "SPLIT",
    "EXCHANGE",
    "CONVERSION",
    "ADJUSTMENT",
    "CASH",
    "STOCK",
    "ETF",
    "BOND",
    "KAUF",
    "VERKAUF",
    "EINZAHLUNG",
    "AUSZAHLUNG",
    "GEBUEHR",
    "STEUER",
    "ZINS",
    "OPEN",
    "CLOSE",
    "LONG",
    "SHORT",
    "CREDIT",
    "DEBIT",
    "IN",
    "OUT",
    "YES",
    "NO",
    "TAK",
    "NIE",
    "TRUE",
    "FALSE",
)


def _showable(value: str) -> bool:
    folded = fold(value).strip()
    words = folded.split()
    if not words or len(value) > 24 or len(words) > 3:
        return False
    if isin_valid(value) or value in _CURRENCIES or value.upper() in _BOOL:
        return True
    if all(any(w.startswith(v) for v in _VOCAB) for w in words):
        return True
    # a short upper-case code: a ticker or a type code (BUY, CDR, EUNL), never mixed case
    return len(words) == 1 and value.isupper() and len(value) <= 6 and not looks_like_person(value)


def _date_pattern(value: str) -> str | None:
    for regex, name in _DATE_PATTERNS:
        if regex.match(value):
            return name
    return None


def _number_format(value: str) -> tuple[str | None, str | None, int] | None:
    """(thousands separator, decimal separator, decimals) of a number, None when not a number."""
    v = value.replace("−", "-")
    m = _NUMBER.match(v)
    if not m:
        return None
    thousands, decimal_sep, decimals = m.group(1), m.group(2), m.group(3)
    if thousands and decimal_sep and thousands == decimal_sep:
        return None
    return thousands, decimal_sep, len(decimals or "")


def _is_identifier(value: str) -> bool:
    compact = value.replace(" ", "").replace("-", "")
    if _IBAN.match(value.replace(" ", "")) and len(compact) >= 15 and not _ISIN.match(compact):
        return True
    return (
        len(_DIGITS.findall(value)) >= 9 and not _date_pattern(value) and not _ISIN.match(compact)
    )


def _cell_kind(value: str, hint: str) -> str:
    if not value:
        return "empty"
    if hint == "date":
        return "date"
    if hint == "bool" or value.upper() in _BOOL:
        return "boolean"
    if hint == "number":
        return "decimal" if "." in value or "e" in value.lower() else "integer"
    if _date_pattern(value):
        return "date"
    fmt = _number_format(value)
    if fmt is not None:
        if _is_identifier(value) and not fmt[1]:
            return "identifier"
        return "decimal" if fmt[1] else "integer"
    if _is_identifier(value):
        return "identifier"
    if isin_valid(value):
        return "isin"
    if value in _CURRENCIES:
        return "currency_code"
    if _SYMBOL.match(value):
        return "code"
    return "text"


def _mask(value: str, kind: str, column: dict) -> str:
    if not value:
        return ""
    if kind in ("integer", "decimal"):
        sign = "-" if value.lstrip().startswith(("-", "−")) else ""
        fmt = _number_format(value) or (None, None, 0)
        body = "N" + (f"{column.get('thousands') or ''}NNN" if column.get("thousands") else "")
        if fmt[1]:
            body += fmt[1] + "N" * min(fmt[2], 8)
        return sign + body
    if kind == "date":
        return _date_pattern(value) or "<date>"
    if kind == "boolean":
        return value.upper()
    if kind in ("isin", "currency_code", "code") and value in column.get("shown", ()):
        return value
    if kind == "identifier":
        return "[identifier]"
    words = len(value.split())
    return f"<text: {words} word{'s' if words != 1 else ''}>"


def _safe_label(text: str) -> str:
    """A header, sheet name or JSON key as shown: masked when it looks like data rather than a label
    (a person's name, 4+ digits, or longer than 48 characters), e.g. a headerless file's first row."""
    if looks_like_person(text) or len(_DIGITS.findall(text or "")) >= 4 or len(text or "") > 48:
        return _mask(text, "text", {})
    return text


def _header_row(rows: list[list[str]]) -> int:
    """Index of the header row: the first of the first 30 rows whose filled width matches the
    typical width of the rows below it and whose cells are mostly not numbers or dates."""
    widths = Counter(sum(1 for c in r if c) for r in rows[:200] if any(r))
    common = widths.most_common(1)[0][0] if widths else 0
    for i, row in enumerate(rows[:30]):
        filled = [c for c in row if c]
        if not filled or len(filled) < max(1, common - 1):
            continue
        kinds = [_cell_kind(c, "") for c in filled]
        texty = sum(1 for k in kinds if k in ("text", "code", "currency_code"))
        datay = sum(1 for k in kinds if k in ("date", "integer", "decimal", "identifier", "isin"))
        if texty >= max(1, len(filled) * 0.6) and datay == 0:
            return i
    return -1  # no label row: every row is data, columns get generic names


def _describe(table: Table, max_samples: int) -> dict:
    rows = table.rows
    if not rows:
        return {
            "name": L.text(_safe_label(table.name)),
            "rows": L.count(0),
            "columns": [],
            "samples": [],
        }
    header_at = _header_row(rows)
    header = rows[header_at] if header_at >= 0 else []
    body = rows[header_at + 1 :]
    body_kinds = table.kinds[header_at + 1 :] if table.kinds else [[] for _ in body]
    width = max([len(header)] + [len(r) for r in body[:2000]])
    columns: list[dict] = []
    for idx in range(width):
        values = [r[idx] if idx < len(r) else "" for r in body]
        hints = [k[idx] if idx < len(k) else "" for k in body_kinds]
        kinds = Counter(_cell_kind(v, h) for v, h in zip(values, hints, strict=False))
        filled = len(values) - kinds.get("empty", 0)
        kinds.pop("empty", None)
        kind = kinds.most_common(1)[0][0] if kinds else "empty"
        if "identifier" in kinds:
            kind = "identifier"
        elif "text" in kinds and kind in ("code", "currency_code", "isin"):
            kind = "text"
        name = header[idx] if idx < len(header) else f"column {idx + 1}" if header_at < 0 else ""
        col: dict = {"kind": kind, "thousands": None}
        fmt_text = None
        if kind in ("integer", "decimal"):
            seps = [_number_format(v) for v in values if v]
            thousands = {s[0] for s in seps if s and s[0]}
            decimal_seps = {s[1] for s in seps if s and s[1]}
            col["thousands"] = next(iter(thousands)) if len(thousands) == 1 else None
            fmt_text = (
                f"decimal separator {next(iter(decimal_seps)) if decimal_seps else 'none'!r}, "
                f"thousands separator {col['thousands'] or 'none'!r}"
            )
        elif kind == "date":
            patterns = Counter(
                _date_pattern(v) or ("ISO (from Excel)" if h == "date" else "?")
                for v, h in zip(values, hints, strict=False)
                if v
            )
            fmt_text = ", ".join(p for p, _ in patterns.most_common(3))
        distinct = {v for v in values if v}
        shown: list[str] = []
        enumerable = (
            kind in ("code", "currency_code", "isin", "text", "boolean")
            and not _NAMEISH_HEADER.search(name or "")
            and 0 < len(distinct) <= 12
            and filled >= 2 * len(distinct)
        )
        if enumerable:
            # Only values that cannot be a person's name: transaction-type vocabulary, short
            # upper-case codes (tickers, type codes), ISINs, currencies, booleans.
            shown = sorted(v for v in distinct if _showable(v))
            if kind == "text" and shown:
                kind = col["kind"] = "code"
        col["shown"] = set(shown)
        columns.append(col)
        col["out"] = {
            "index": L.count(idx + 1),
            "header": L.text(_safe_label(name)),
            "type": L.category(kind),
            "format": L.text(fmt_text),
            "empty_share": L.share(len(values) - filled, len(values)),
            "distinct": L.count(len(distinct)),
            "negatives": L.flag(any(v.startswith(("-", "−")) for v in values if v))
            if kind in ("integer", "decimal")
            else L.flag(None),
            "values": [L.symbol(v) if _ISIN.match(v) else L.text(v) for v in shown],
        }
    samples = []
    for r, k in list(zip(body, body_kinds, strict=False))[:max_samples]:
        row = []
        for i in range(width):
            value = r[i] if i < len(r) else ""
            hint = k[i] if i < len(k) else ""
            kind = "code" if columns[i]["kind"] == "code" else _cell_kind(value, hint)
            masked = _mask(value, kind, columns[i])
            row.append(L.symbol(masked) if _ISIN.match(masked) else L.text(masked))
        samples.append(row)
    return {
        "name": L.text(_safe_label(table.name)),
        "rows": L.count(len(body)),
        "header_row": L.count(header_at + 1 if header_at >= 0 else None),
        "preamble_rows": L.count(max(header_at, 0)),
        "preamble": [
            [L.text(_mask(c, "text", {})) for c in row] for row in rows[: max(header_at, 0)]
        ],
        "columns": [c["out"] for c in columns],
        "samples": samples,
    }


def inspect_file(path: Path, *, max_samples: int = 5) -> dict:
    info = read(path)
    return {
        "file": {
            "name": L.identifier(path.name),
            "extension": L.category(info.extension),
            "size_kb": L.count(max(1, path.stat().st_size // 1024)),
            "encoding": L.category(info.encoding),
            "delimiter": L.text({"\t": "TAB", " ": "SPACE"}.get(info.delimiter, info.delimiter)),
        },
        "sheets": [_describe(t, max_samples) for t in info.tables],
        "structure": [
            {"key": L.text(_safe_label(x["key"])), "type": L.category(x["type"])}
            for x in info.structure
        ],
        "masking": L.text(
            "numbers are shown as their format (N = digit, separators kept), dates as their pattern, "
            "identifiers as [identifier], free text as <text: n words>; only short code-like values "
            "of low-cardinality columns are shown"
        ),
    }


def inspect(raw_path: str, *, max_samples: int = 5, slug: str) -> dict:
    return inspect_file(checked_path(raw_path, slug), max_samples=max_samples)
