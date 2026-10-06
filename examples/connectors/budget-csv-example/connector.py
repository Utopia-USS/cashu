"""Example finanse connector (kind file, module budget): the made-up Przykladowy Bank CSV statement ->
finanse-budget-import v1 JSON (docs/budget-import-format.md).

Protocol (docs/connectors.md): one JSON request on stdin, one JSON response on stdout, logs on stderr.
Python standard library only. Error messages name the row and the column, never a value from the file.

The input: a short preamble (bank name, account number, period), a blank line, then a `;` separated
table with the header below. Dates DD.MM.YYYY, amounts with a decimal comma and spaces as thousands
separators, UTF-8 or cp1250.
"""

import csv
import io
import json
import re
import sys
from decimal import Decimal, InvalidOperation

SOURCE = "przykladowy_bank"
MARKER = "Przykladowy Bank"
HEADER = [
    "Data operacji", "Data waluty", "Typ operacji", "Tytul", "Kontrahent", "Rachunek kontrahenta",
    "Kwota", "Waluta", "Saldo po operacji", "Identyfikator",
]


class ConnectorError(Exception):
    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind
        self.message = message


def reply(payload, code=0):
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.flush()
    sys.exit(code)


def read_text(path):
    with open(path, "rb") as f:
        raw = f.read()
    for encoding in ("utf-8-sig", "cp1250"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ConnectorError("bad_file", "the file is neither UTF-8 nor cp1250")


def split_table(text):
    """(preamble rows, header row index, all rows) of the statement."""
    rows = list(csv.reader(io.StringIO(text), delimiter=";"))
    for index, row in enumerate(rows):
        if [cell.strip() for cell in row] == HEADER:
            return rows[:index], index, rows
    raise ConnectorError("bad_file", "the transaction table header was not found")


def iso_date(raw, row, column):
    match = re.fullmatch(r"(\d{2})\.(\d{2})\.(\d{4})", raw.strip())
    if not match:
        raise ConnectorError("bad_file", f"row {row}: column {column}: not a DD.MM.YYYY date")
    day, month, year = match.groups()
    return f"{year}-{month}-{day}"


def amount(raw, row, column):
    text = raw.strip().replace(" ", "").replace(" ", "").replace(",", ".")
    try:
        value = Decimal(text)
    except InvalidOperation:
        raise ConnectorError("bad_file", f"row {row}: column {column}: not a number") from None
    return str(value.quantize(Decimal("0.01")))


def account_number(raw):
    text = re.sub(r"[\s-]", "", raw or "")
    return text or None


def detect(path):
    try:
        head = read_text(path)[:4096]
    except (OSError, ConnectorError):
        return {"match": False, "confidence": 0.0}
    has_marker = head.startswith(MARKER)
    has_header = ";".join(HEADER) in head
    if has_marker and has_header:
        return {"match": True, "confidence": 0.95}
    if has_header:
        return {"match": True, "confidence": 0.6}
    return {"match": False, "confidence": 0.0}


def convert(path, request):
    preamble, header_index, rows = split_table(read_text(path))
    account = {"currency": (request.get("account") or {}).get("currency") or "PLN"}
    for line in preamble:
        if len(line) >= 3 and line[0].strip() == "Rachunek":
            account["iban"] = account_number(line[1])
            account["currency"] = line[2].strip().upper() or account["currency"]

    transactions = []
    for offset, line in enumerate(rows[header_index + 1:], start=1):
        if not any(cell.strip() for cell in line):
            continue
        if len(line) != len(HEADER):
            raise ConnectorError("bad_file", f"row {offset}: expected {len(HEADER)} columns")
        cell = dict(zip(HEADER, (c.strip() for c in line)))
        transactions.append({
            "booking_date": iso_date(cell["Data operacji"], offset, "Data operacji"),
            "value_date": iso_date(cell["Data waluty"], offset, "Data waluty")
            if cell["Data waluty"] else None,
            "amount": amount(cell["Kwota"], offset, "Kwota"),
            "currency": cell["Waluta"].upper(),
            "counterparty_name": cell["Kontrahent"] or None,
            "counterparty_iban": account_number(cell["Rachunek kontrahenta"]),
            "description": cell["Typ operacji"] or None,
            "reference": cell["Tytul"] or None,
            "transaction_id": cell["Identyfikator"] or None,
            "balance_after": amount(cell["Saldo po operacji"], offset, "Saldo po operacji")
            if cell["Saldo po operacji"] else None,
        })
    transactions.sort(key=lambda t: t["booking_date"])  # stable: same-day order is kept
    print(f"converted {len(transactions)} rows", file=sys.stderr)  # counts only, never values
    return {
        "document": {
            "format": "finanse-budget-import",
            "format_version": 1,
            "source": SOURCE,
            "account": account,
            "transactions": transactions,
        }
    }


def main():
    try:
        request = json.load(sys.stdin)
    except ValueError:
        reply({"error": {"kind": "internal", "message": "the request is not JSON"}}, 1)
    if request.get("api_version") != 1:
        reply({"error": {"kind": "unsupported_version", "message": "api_version 1 only"}}, 1)
    command = request.get("command")
    path = (request.get("file") or {}).get("path")
    try:
        if command == "detect":
            reply(detect(path))
        if command == "convert":
            reply(convert(path, request))
        raise ConnectorError("internal", f"unknown command {command}")
    except ConnectorError as e:
        reply({"error": {"kind": e.kind, "message": e.message}}, 1)
    except OSError:
        reply({"error": {"kind": "bad_file", "message": "the file cannot be read"}}, 1)


if __name__ == "__main__":
    main()
