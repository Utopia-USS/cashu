# Copy shipped with this skill, generated from the cashU sources; do not edit it here.
"""Example cashU connector (kind file, module investments): the made-up ExampleBroker JSON account
history -> cashu-import v1 JSON (import-format.md, JSON variant).

Protocol (connectors.md): one JSON request on stdin, one JSON response on stdout, logs on stderr.
Python standard library only. Error messages name the row and the field, never a value from the file.

The input: {"broker": "ExampleBroker", "export_version": 2, "operations": [...], "holdings": {...}}.
Every operation becomes one `txn` record (external_ref = the broker's stable operation id), every
holding a `position` record (the broker's snapshot, used by the reconciliation).
"""

import json
import sys
from decimal import Decimal, InvalidOperation

SOURCE = "examplebroker"
BROKER = "ExampleBroker"
EXPORT_VERSIONS = (2,)

# Broker operation kind -> cashU transaction type. An unknown kind is an error, never a guess.
TYPES = {
    "CASH_IN": "deposit",
    "CASH_OUT": "withdrawal",
    "BUY": "buy",
    "SELL": "sell",
    "DIVIDEND": "dividend",
    "ACCOUNT_FEE": "fee",
}
TRADES = ("buy", "sell")


class ConnectorError(Exception):
    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind
        self.message = message


def reply(payload, code=0):
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.flush()
    sys.exit(code)


def load(path):
    try:
        with open(path, "rb") as f:
            return json.loads(f.read().decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError):
        raise ConnectorError("bad_file", "the file is not UTF-8 JSON") from None


def number(op, key, row, *, required=True):
    raw = op.get(key)
    if raw in (None, ""):
        if required:
            raise ConnectorError("bad_file", f"row {row}: field {key}: missing")
        return None
    try:
        return str(Decimal(str(raw)))
    except InvalidOperation:
        raise ConnectorError("bad_file", f"row {row}: field {key}: not a number") from None


def text(op, key, row, *, required=True):
    value = str(op.get(key) or "").strip()
    if required and not value:
        raise ConnectorError("bad_file", f"row {row}: field {key}: missing")
    return value or None


def instrument(op, row):
    return {
        "symbol": text(op, "ticker", row),
        "isin": text(op, "isin", row, required=False),
        "name": text(op, "name", row, required=False),
        "exchange": text(op, "market", row, required=False),
    }


def txn(op, row):
    if not isinstance(op, dict):
        raise ConnectorError("bad_file", f"row {row}: not an object")
    kind = text(op, "kind", row)
    if kind not in TYPES:
        raise ConnectorError("bad_file", f"row {row}: field kind: unknown operation kind")
    stamp = text(op, "time", row)
    record = {
        "record": "txn",
        "date": stamp[:10],
        "time": stamp[11:19] or None,
        "type": TYPES[kind],
        "external_ref": text(op, "id", row),
        "currency": text(op, "currency", row),
    }
    if record["type"] in TRADES:
        record.update(instrument(op, row))
        record.update({
            "quantity": number(op, "units", row),
            "price": number(op, "unit_price", row),
            "fee": number(op, "commission", row, required=False),
            "cash_amount": number(op, "settled", row),
            "cash_currency": text(op, "settled_currency", row),
        })
        if record["cash_currency"] != record["currency"]:
            record["fx_rate"] = number(op, "fx", row)
    elif record["type"] == "dividend":
        record.update(instrument(op, row))
        record.update({
            "gross_amount": number(op, "gross", row),
            "tax": number(op, "withholding", row, required=False),
            "cash_amount": number(op, "settled", row),
            "cash_currency": text(op, "settled_currency", row),
        })
    else:  # deposit, withdrawal, fee: cash only, already signed by the broker
        record["cash_amount"] = number(op, "amount", row)
    return {k: v for k, v in record.items() if v is not None}


def positions(holdings):
    as_of = str(holdings.get("as_of") or "")
    out = []
    for row, item in enumerate(holdings.get("items") or []):
        record = {"record": "position", "date": as_of, **instrument(item, row)}
        record.update({
            "quantity": number(item, "units", row),
            "currency": text(item, "currency", row),
            "avg_price": number(item, "avg_price", row, required=False),
        })
        out.append({k: v for k, v in record.items() if v is not None})
    return out


def detect(path):
    try:
        data = load(path)
    except (OSError, ConnectorError):
        return {"match": False, "confidence": 0.0}
    if isinstance(data, dict) and data.get("broker") == BROKER and "operations" in data:
        return {"match": True, "confidence": 0.95}
    return {"match": False, "confidence": 0.0}


def convert(path):
    data = load(path)
    if not isinstance(data, dict) or data.get("broker") != BROKER:
        raise ConnectorError("bad_file", "not an ExampleBroker export")
    if data.get("export_version") not in EXPORT_VERSIONS:
        raise ConnectorError("unsupported_version", "export_version 2 only")
    operations = data.get("operations")
    if not isinstance(operations, list):
        raise ConnectorError("bad_file", "operations: missing")
    records = [txn(op, row) for row, op in enumerate(operations)]
    records.sort(key=lambda r: (r["date"], r.get("time", "")))  # oldest first, stable
    records += positions(data.get("holdings") or {})
    print(f"converted {len(records)} records", file=sys.stderr)  # counts only, never values
    return {"document": {"format": "cashu-import", "format_version": 1, "source": SOURCE,
                         "records": records}}


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
            reply(convert(path))
        raise ConnectorError("internal", f"unknown command {command}")
    except ConnectorError as e:
        reply({"error": {"kind": e.kind, "message": e.message}}, 1)
    except OSError:
        reply({"error": {"kind": "bad_file", "message": "the file cannot be read"}}, 1)


if __name__ == "__main__":
    main()
